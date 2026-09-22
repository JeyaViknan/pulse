"""Stages 9–11 — train, calibrate, set τ and export the artefact (SPEC §6.4, §7.3).

* Supervision: the terminal outcome Y only, applied to every prefix. ``probability_trajectory``
  is never read anywhere in the pipeline.
* Loss: binary cross-entropy over positions, with the prefix weighting treated as a tuned
  hyperparameter whose sensitivity is reported.
* Batching by conversation.
* Selection and early stopping on early-regime discrimination on ``val_select`` (report §6.7),
  not terminal accuracy.
* Temperature and τ fitted on ``val_fit``; π̂ is the training positive rate.
* The leakage suite runs before export; a failure blocks it.
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import time
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from sklearn.metrics import average_precision_score, roc_auc_score

from pulse.data.split import SPLITS_PATH
from pulse.eda.phase0 import load_decisions
from pulse.features.build import INTERROGATIVE_PATH, SCALARS_PATH, conversation_bounds
from pulse.features.encoder import EMBEDDINGS_PATH, META_PATH, TURN_INDEX_PATH, open_embeddings
from pulse.features.scalars import Scaler, feature_names, scalar_features
from pulse.model.artifact import ConversationInputs, Predictor, save_artifact
from pulse.model.calibration import (
    TAU_QUANTILE,
    expected_calibration_error,
    fit_tau,
    fit_temperature,
    sigmoid,
)
from pulse.model.causal_transformer import CausalTransformer, ModelConfig, attention_mask, bce_per_position
from pulse.model.leakage import run_suite
from pulse.paths import DEFAULT_ARTIFACT, REPORTS_DIR
from pulse.serve.models import DEFAULT_ASR_MODEL, ENCODER_NAME

SEED = 20260922
ARTEFACT_VERSION = "pulse_v1"


@dataclass(frozen=True)
class TrainConfig:
    prefix_weighting: str = "conversation"  # "conversation": 1/T per turn; "early": ∝ 1/t
    augment_rate: float = 0.0  # share of training conversations with random turns removed
    drop_rate: float = 0.15  # per-turn removal probability in an augmented conversation
    epochs: int = 12
    patience: int = 3
    batch_size: int = 128
    learning_rate: float = 1e-3
    weight_decay: float = 0.01
    seed: int = SEED
    model: ModelConfig = field(default_factory=ModelConfig)

    def to_json(self) -> dict[str, object]:
        data = asdict(self)
        data["model"] = self.model.to_json()
        return data


# ---------------------------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------------------------


class Corpus:
    """Memory-mapped turn arrays with per-conversation bounds, in split-file order."""

    def __init__(self) -> None:
        for path in (SPLITS_PATH, TURN_INDEX_PATH, EMBEDDINGS_PATH, SCALARS_PATH, INTERROGATIVE_PATH):
            if not path.exists():
                raise FileNotFoundError(f"{path} is missing — run the earlier pipeline stages first.")
        self.splits = pd.read_parquet(SPLITS_PATH)
        index = pd.read_parquet(TURN_INDEX_PATH)
        self.starts, self.counts = conversation_bounds(index)
        first_ids = index["conversation_id"].to_numpy()[self.starts]
        if len(first_ids) != len(self.splits) or not np.array_equal(first_ids, self.splits["conversation_id"].to_numpy()):
            raise RuntimeError("turn index and split table are not aligned")
        self.speakers = index["speaker"].to_numpy().astype(np.int64)
        self.n_words = index["n_words"].to_numpy().astype(np.int64)
        self.embeddings = open_embeddings(len(index))
        self.scalars_raw = np.load(SCALARS_PATH, mmap_mode="r")
        self.interrogative = np.load(INTERROGATIVE_PATH)
        self.labels = self.splits["outcome"].to_numpy().astype(np.float32)
        self.include_f8 = bool(load_decisions()["f8_retained"])
        self.feature_names = feature_names(self.include_f8)

    def members(self, split: str) -> np.ndarray:
        return np.flatnonzero(self.splits["split"].to_numpy() == split)

    def rows(self, conversation: int) -> slice:
        start = int(self.starts[conversation])
        return slice(start, start + int(self.counts[conversation]))

    def inputs(self, conversation: int) -> ConversationInputs:
        rows = self.rows(conversation)
        return ConversationInputs(
            speakers=self.speakers[rows],
            n_words=self.n_words[rows],
            interrogative=self.interrogative[rows],
            embeddings=np.asarray(self.embeddings[rows], dtype=np.float32),
        )

    def fit_scaler(self) -> Scaler:
        train_rows = np.concatenate([np.arange(self.rows(c).start, self.rows(c).stop) for c in self.members("train")])
        return Scaler.fit(self.feature_names, np.asarray(self.scalars_raw[train_rows], dtype=np.float64))


@dataclass
class Batch:
    embeddings: torch.Tensor
    roles: torch.Tensor
    scalars: torch.Tensor
    positions: torch.Tensor
    valid: torch.Tensor
    labels: torch.Tensor
    weights: torch.Tensor

    def to(self, device: torch.device) -> Batch:
        return Batch(*(getattr(self, name).to(device) for name in self.__dataclass_fields__))


def position_weights(count: int, scheme: str) -> np.ndarray:
    if scheme == "conversation":
        weights = np.ones(count)
    elif scheme == "early":
        weights = 1.0 / np.arange(1, count + 1)
    else:
        raise ValueError(f"unknown prefix weighting {scheme!r}")
    return weights / weights.sum()


def make_batch(
    corpus: Corpus,
    conversations: np.ndarray,
    scaler: Scaler,
    config: TrainConfig,
    rng: np.random.Generator | None,
) -> Batch:
    items: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
    for conversation in conversations:
        rows = corpus.rows(int(conversation))
        count = rows.stop - rows.start
        augment = rng is not None and config.augment_rate > 0 and count >= 3 and rng.random() < config.augment_rate
        if augment:
            assert rng is not None
            keep = rng.random(count) >= config.drop_rate
            keep[rng.integers(count)] = True  # never remove every turn
            inputs = corpus.inputs(int(conversation))
            speakers = inputs.speakers[keep]
            embeddings = inputs.embeddings[keep]
            raw = scalar_features(
                speakers, inputs.n_words[keep], inputs.interrogative[keep], embeddings, corpus.include_f8
            )
        else:
            speakers = corpus.speakers[rows]
            embeddings = np.asarray(corpus.embeddings[rows], dtype=np.float32)
            raw = np.asarray(corpus.scalars_raw[rows], dtype=np.float32)
        items.append((speakers, embeddings, scaler.transform(raw)))

    size = len(items)
    length = max(len(item[0]) for item in items)
    embeddings = np.zeros((size, length, corpus.embeddings.shape[1]), dtype=np.float32)
    roles = np.zeros((size, length), dtype=np.int64)
    scalars = np.zeros((size, length, len(corpus.feature_names)), dtype=np.float32)
    positions = np.ones((size, length), dtype=np.int64)
    valid = np.zeros((size, length), dtype=bool)
    weights = np.zeros((size, length), dtype=np.float32)
    for slot, (speakers, vectors, features) in enumerate(items):
        count = len(speakers)
        embeddings[slot, :count] = vectors
        roles[slot, :count] = speakers
        scalars[slot, :count] = features
        positions[slot, :count] = np.arange(1, count + 1)
        valid[slot, :count] = True
        weights[slot, :count] = position_weights(count, config.prefix_weighting)
    labels = np.repeat(corpus.labels[conversations][:, None], length, axis=1)
    return Batch(
        torch.from_numpy(embeddings),
        torch.from_numpy(roles),
        torch.from_numpy(scalars),
        torch.from_numpy(positions),
        torch.from_numpy(valid),
        torch.from_numpy(labels),
        torch.from_numpy(weights),
    )


# ---------------------------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------------------------


@torch.no_grad()
def predict_logits(
    model: CausalTransformer,
    corpus: Corpus,
    conversations: np.ndarray,
    scaler: Scaler,
    config: TrainConfig,
    device: torch.device,
) -> list[np.ndarray]:
    model.eval()
    paths: list[np.ndarray] = []
    for start in range(0, len(conversations), 512):
        chunk = conversations[start : start + 512]
        batch = make_batch(corpus, chunk, scaler, config, rng=None).to(device)
        logits, _ = model(batch.embeddings, batch.roles, batch.scalars, batch.positions, attention_mask(batch.valid))
        logits = logits.float().cpu().numpy()
        for slot, conversation in enumerate(chunk):
            paths.append(logits[slot, : int(corpus.counts[conversation])].astype(np.float64))
    return paths


def discrimination(scores: np.ndarray, labels: np.ndarray, metric: str) -> float:
    if len(np.unique(labels)) < 2:
        return float("nan")
    if metric == "pr_auc":
        return float(average_precision_score(labels, scores))
    return float(roc_auc_score(labels, scores))


def by_position(paths: list[np.ndarray], labels: np.ndarray, metric: str, max_turn: int) -> list[dict[str, float]]:
    rows = []
    for turn in range(1, max_turn + 1):
        members = [index for index, path in enumerate(paths) if len(path) >= turn]
        if len(members) < 50:
            break
        scores = np.array([paths[index][turn - 1] for index in members])
        rows.append(
            {
                "t": turn,
                "n": len(members),
                metric: discrimination(scores, labels[members], metric),
                "positive_rate": float(labels[members].mean()),
            }
        )
    return rows


def early_regime(paths: list[np.ndarray], labels: np.ndarray, metric: str, turns: int) -> float:
    values = [row[metric] for row in by_position(paths, labels, metric, turns)]
    return float(np.nanmean(values)) if values else float("nan")


def calibration_report(
    probabilities: list[np.ndarray], labels: np.ndarray
) -> dict[str, float | dict[str, float]]:
    """ECE overall and per tercile of relative position t/T (an evaluation axis only)."""
    flat_p = np.concatenate(probabilities)
    flat_y = np.concatenate([np.full(len(path), labels[index]) for index, path in enumerate(probabilities)])
    relative = np.concatenate([np.arange(1, len(path) + 1) / len(path) for path in probabilities])
    terciles = {}
    for name, low, high in (("early", 0.0, 1 / 3), ("middle", 1 / 3, 2 / 3), ("late", 2 / 3, 1.0 + 1e-9)):
        members = (relative > low) & (relative <= high)
        terciles[name] = expected_calibration_error(flat_p[members], flat_y[members])
    return {
        "ece": expected_calibration_error(flat_p, flat_y),
        "ece_by_tercile": terciles,
        "brier": float(np.mean((flat_p - flat_y) ** 2)),
    }


# ---------------------------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------------------------


def best_device() -> torch.device:
    return torch.device("mps" if torch.backends.mps.is_available() else "cpu")


def train_one(
    corpus: Corpus,
    scaler: Scaler,
    config: TrainConfig,
    metric: str,
    early_turns: int,
    device: torch.device,
) -> tuple[CausalTransformer, dict[str, object]]:
    torch.manual_seed(config.seed)
    rng = np.random.default_rng(config.seed)
    model = CausalTransformer(config.model).to(device)
    optimiser = torch.optim.AdamW(model.parameters(), lr=config.learning_rate, weight_decay=config.weight_decay)
    train = corpus.members("train")
    select = corpus.members("val_select")
    steps_per_epoch = math.ceil(len(train) / config.batch_size)
    total_steps = steps_per_epoch * config.epochs
    warmup = max(1, steps_per_epoch // 2)
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimiser,
        lambda step: min(1.0, (step + 1) / warmup) * 0.5 * (1 + math.cos(math.pi * min(step, total_steps) / total_steps)),
    )

    history: list[dict[str, float]] = []
    best_score = -math.inf
    best_state: dict[str, torch.Tensor] | None = None
    best_epoch = 0
    stale = 0
    for epoch in range(1, config.epochs + 1):
        model.train()
        started = time.perf_counter()
        order = rng.permutation(train)
        running = 0.0
        for step in range(steps_per_epoch):
            members = order[step * config.batch_size : (step + 1) * config.batch_size]
            batch = make_batch(corpus, members, scaler, config, rng).to(device)
            logits, _ = model(batch.embeddings, batch.roles, batch.scalars, batch.positions, attention_mask(batch.valid))
            losses = bce_per_position(logits, batch.labels) * batch.weights
            loss = losses.sum() / len(members)
            optimiser.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimiser.step()
            scheduler.step()
            running += float(loss.detach())

        paths = predict_logits(model, corpus, select, scaler, config, device)
        score = early_regime(paths, corpus.labels[select], metric, early_turns)
        terminal = discrimination(np.array([path[-1] for path in paths]), corpus.labels[select], metric)
        history.append(
            {
                "epoch": epoch,
                "train_loss": running / steps_per_epoch,
                f"val_select_early_{metric}": score,
                f"val_select_terminal_{metric}": terminal,
                "seconds": time.perf_counter() - started,
            }
        )
        print(
            f"    epoch {epoch:2d}  loss {running / steps_per_epoch:.4f}  early {metric} {score:.4f}  "
            f"terminal {terminal:.4f}  ({time.perf_counter() - started:.0f}s)",
            flush=True,
        )
        if score > best_score + 1e-4:
            best_score, best_epoch, stale = score, epoch, 0
            best_state = copy.deepcopy({key: value.detach().cpu() for key, value in model.state_dict().items()})
        else:
            stale += 1
            if stale >= config.patience:
                break

    assert best_state is not None
    model = CausalTransformer(config.model)
    model.load_state_dict(best_state)
    return model, {"best_epoch": best_epoch, f"best_val_select_early_{metric}": best_score, "history": history}


def first_turn_baseline(corpus: Corpus, metric: str) -> float:
    """B7 / EDA-09: logistic regression on the first turn only — the priming lens (report §7)."""
    from sklearn.linear_model import LogisticRegression

    def design(members: np.ndarray) -> np.ndarray:
        starts = corpus.starts[members]
        vectors = np.asarray(corpus.embeddings[starts], dtype=np.float32)
        return np.hstack([vectors, corpus.speakers[starts, None].astype(np.float32)])

    train, select = corpus.members("train"), corpus.members("val_select")
    classifier = LogisticRegression(max_iter=2000, C=1.0)
    classifier.fit(design(train), corpus.labels[train])
    return discrimination(classifier.decision_function(design(select)), corpus.labels[select], metric)


def run(configs: list[TrainConfig], output: Path) -> None:
    device = best_device()
    corpus = Corpus()
    decisions = load_decisions()
    metric = str(decisions["primary_metric"])
    median_turns = float(np.median(corpus.counts[corpus.members("train")]))
    early_turns = max(1, math.ceil(median_turns / 2))
    base_rate = float(corpus.labels[corpus.members("train")].mean())
    configs = [replace(config, model=replace(config.model, n_scalars=len(corpus.feature_names))) for config in configs]
    print(
        f"device {device} · features {len(corpus.feature_names)} (F8 {'on' if corpus.include_f8 else 'off'}) · "
        f"metric {metric} · early regime t ≤ {early_turns} · π̂ {base_rate:.4f}",
        flush=True,
    )

    scaler = corpus.fit_scaler()
    sweep: list[dict[str, object]] = []
    best: tuple[float, CausalTransformer, TrainConfig, dict[str, object]] | None = None
    for number, config in enumerate(configs, start=1):
        print(
            f"[{number}/{len(configs)}] prefix weighting {config.prefix_weighting}, "
            f"augmentation {config.augment_rate}",
            flush=True,
        )
        model, result = train_one(corpus, scaler, config, metric, early_turns, device)
        score = float(result[f"best_val_select_early_{metric}"])  # type: ignore[arg-type]
        sweep.append({"config": config.to_json(), **result})
        if best is None or score > best[0]:
            best = (score, model, config, result)
    assert best is not None
    _, model, config, result = best
    model = model.cpu().eval()
    print(f"selected: prefix weighting {config.prefix_weighting}, augmentation {config.augment_rate}", flush=True)

    # Calibration and τ on val_fit only.
    fit_members = corpus.members("val_fit")
    fit_logits = predict_logits(model, corpus, fit_members, scaler, config, torch.device("cpu"))
    fit_labels = corpus.labels[fit_members]
    flat_logits = np.concatenate(fit_logits)
    flat_labels = np.concatenate([np.full(len(path), fit_labels[index]) for index, path in enumerate(fit_logits)])
    temperature = fit_temperature(flat_logits, flat_labels)
    uncalibrated = [sigmoid(path) for path in fit_logits]
    calibrated = [sigmoid(path / temperature) for path in fit_logits]
    tau = fit_tau(calibrated, base_rate)

    select_members = corpus.members("val_select")
    select_logits = predict_logits(model, corpus, select_members, scaler, config, torch.device("cpu"))
    select_labels = corpus.labels[select_members]
    max_turn = int(corpus.counts.max())
    turning_points = np.mean(
        [np.sum(np.abs(np.diff(np.concatenate([[base_rate], path]))) >= tau) for path in calibrated]
    )

    predictor = Predictor(
        model=model,
        scaler=scaler,
        temperature=temperature,
        base_rate=base_rate,
        tau=tau,
        include_f8=corpus.include_f8,
        config={"version": ARTEFACT_VERSION},
    )

    print("running leakage suite…", flush=True)
    sample = corpus.members("val_select")[:400]
    leakage = run_suite(predictor, [corpus.inputs(int(c)) for c in sample], corpus.splits, seed=SEED)
    print(f"leakage suite passed: {leakage.to_json()}", flush=True)

    b7 = first_turn_baseline(corpus, metric)
    encoder_meta = json.loads(META_PATH.read_text()) if META_PATH.exists() else {}
    config_json = {
        "version": ARTEFACT_VERSION,
        "created": datetime.now(UTC).isoformat(timespec="seconds"),
        "encoder": ENCODER_NAME,
        "encoder_revisions": encoder_meta.get("encoder_revisions_in_cache", []),
        "embedding_dtype": "float16",
        "features": list(corpus.feature_names),
        "include_f8": corpus.include_f8,
        "positional": "learned embedding of the absolute turn index t (never t/T)",
        "model": config.model.to_json(),
        "parameters": model.parameter_count(),
        "training": config.to_json(),
        "selection": {"metric": metric, "early_regime_turns": early_turns, "partition": "val_select"},
        "tau_rule": f"quantile {TAU_QUANTILE} of |m_t| over val_fit turns",
        "asr_default": DEFAULT_ASR_MODEL,
    }
    metrics = {
        "selection_metric": f"mean {metric} over turns 1…{early_turns} on val_select",
        "selected": {
            "prefix_weighting": config.prefix_weighting,
            "augment_rate": config.augment_rate,
            **{key: value for key, value in result.items() if key != "history"},
        },
        "sensitivity": [
            {
                "prefix_weighting": entry["config"]["prefix_weighting"],  # type: ignore[index]
                "augment_rate": entry["config"]["augment_rate"],  # type: ignore[index]
                "best_epoch": entry["best_epoch"],
                f"val_select_early_{metric}": entry[f"best_val_select_early_{metric}"],
                "history": entry["history"],
            }
            for entry in sweep
        ],
        "val_select": {
            f"early_{metric}": early_regime(select_logits, select_labels, metric, early_turns),
            f"terminal_{metric}": discrimination(
                np.array([path[-1] for path in select_logits]), select_labels, metric
            ),
            f"{metric}_by_position": by_position(select_logits, select_labels, metric, max_turn),
            "b0_base_rate": 0.5 if metric == "auroc" else float(select_labels.mean()),
            "b7_first_turn_only": b7,
        },
        "val_fit": {
            "temperature": temperature,
            "uncalibrated": calibration_report(uncalibrated, fit_labels),
            "calibrated": calibration_report(calibrated, fit_labels),
            "tau": tau,
            "mean_turning_points_per_conversation": float(turning_points),
        },
        "base_rate": base_rate,
        "partitions": {
            name: int(len(corpus.members(name))) for name in ("train", "val_select", "val_fit", "test")
        },
        "leakage_suite": leakage.to_json(),
        "test": "not evaluated — consumed once by pulse-evaluate",
    }
    predictor.config.update(config_json)
    save_artifact(output, model, scaler, temperature, base_rate, tau, config_json, metrics)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    (REPORTS_DIR / "training_metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")
    print(json.dumps({key: metrics[key] for key in ("selected", "val_fit", "base_rate")}, indent=2))
    print(f"exported {output}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--weightings", nargs="+", default=["conversation", "early"])
    parser.add_argument("--augment-rates", nargs="+", type=float, default=[0.0, 0.3])
    parser.add_argument("--d-model", type=int, default=128)
    parser.add_argument("--layers", type=int, default=3)
    args = parser.parse_args()
    model = ModelConfig(d_model=args.d_model, n_layers=args.layers)
    configs = [
        TrainConfig(prefix_weighting=weighting, augment_rate=rate, epochs=args.epochs, model=model)
        for weighting in args.weightings
        for rate in args.augment_rates
    ]
    run(configs, args.output)


if __name__ == "__main__":
    main()

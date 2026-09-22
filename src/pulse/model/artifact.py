"""The serving artefact (SPEC §6.5) and the predictor that runs it.

``artifacts/pulse_v1/`` is the only thing the backend loads::

    model.pt           sequence model + head weights
    config.json        architecture, encoder name, feature list, version
    scaler.json        scalar-feature statistics — fitted on train only
    calibration.json   temperature
    thresholds.json    tau (turning points), base_rate (π̂)
    metrics.json       validation results the artefact was selected on
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from pulse.features.scalars import Scaler, feature_names, scalar_features
from pulse.model.causal_transformer import CausalTransformer, ModelConfig, attention_mask


@dataclass(frozen=True)
class ConversationInputs:
    """Per-turn inputs for one conversation; every array has length T."""

    speakers: np.ndarray  # int, 0 = dealer, 1 = customer
    n_words: np.ndarray  # int
    interrogative: np.ndarray  # bool
    embeddings: np.ndarray  # float32 (T, 384), unit norm, float16-rounded

    def __len__(self) -> int:
        return len(self.speakers)


class Predictor:
    """Runs the causal model over a conversation's cached turn vectors."""

    def __init__(
        self,
        model: CausalTransformer,
        scaler: Scaler,
        temperature: float,
        base_rate: float,
        tau: float,
        include_f8: bool,
        config: dict[str, object],
    ) -> None:
        self.model = model.eval()
        self.scaler = scaler
        self.temperature = temperature
        self.base_rate = base_rate
        self.tau = tau
        self.include_f8 = include_f8
        self.config = config
        if tuple(scaler.names) != feature_names(include_f8):
            raise ValueError("scaler features do not match the artefact's feature list")

    @property
    def version(self) -> str:
        return str(self.config["version"])

    def features(self, inputs: ConversationInputs, visible: np.ndarray | None = None) -> np.ndarray:
        raw = scalar_features(
            inputs.speakers, inputs.n_words, inputs.interrogative, inputs.embeddings, self.include_f8, visible
        )
        return self.scaler.transform(raw)

    @torch.no_grad()
    def logits(self, inputs: ConversationInputs, visible: np.ndarray | None = None) -> np.ndarray:
        """Uncalibrated logit at every position 1…T."""
        count = len(inputs)
        if count == 0:
            return np.zeros(0, dtype=np.float64)
        embeddings = torch.as_tensor(inputs.embeddings, dtype=torch.float32).unsqueeze(0)
        roles = torch.as_tensor(inputs.speakers, dtype=torch.long).unsqueeze(0)
        scalars = torch.as_tensor(self.features(inputs, visible)).unsqueeze(0)
        positions = torch.arange(1, count + 1).unsqueeze(0)
        valid = torch.ones(1, count, dtype=torch.bool)
        visible_tensor = None if visible is None else torch.as_tensor(visible, dtype=torch.bool).unsqueeze(0)
        logits, _ = self.model(embeddings, roles, scalars, positions, attention_mask(valid, visible_tensor))
        return logits.squeeze(0).double().numpy()

    def probabilities(self, inputs: ConversationInputs, visible: np.ndarray | None = None) -> np.ndarray:
        """Calibrated p_t at every position: sigmoid(logit / temperature)."""
        return 1.0 / (1.0 + np.exp(-self.logits(inputs, visible) / self.temperature))

    def counterfactual(self, inputs: ConversationInputs, masked_turn: int) -> np.ndarray:
        """Ghost path p′_1…p′_T with turn ``masked_turn`` (one-based) removed.

        Turn k is hidden from attention at every position and from every running feature.
        At position k itself nothing was said, so p′_k = p′_{k−1} (p′_0 = π̂). Positions before
        k are computed from identical inputs and so equal the real path.
        """
        count = len(inputs)
        if not 1 <= masked_turn <= count:
            raise ValueError(f"turn {masked_turn} is outside 1…{count}")
        visible = np.ones(count, dtype=bool)
        visible[masked_turn - 1] = False
        path = self.probabilities(inputs, visible)
        path[masked_turn - 1] = path[masked_turn - 2] if masked_turn > 1 else self.base_rate
        return path


def save_artifact(
    directory: Path,
    model: CausalTransformer,
    scaler: Scaler,
    temperature: float,
    base_rate: float,
    tau: float,
    config: dict[str, object],
    metrics: dict[str, object],
) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), directory / "model.pt")
    (directory / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    (directory / "scaler.json").write_text(json.dumps(scaler.to_json(), indent=2) + "\n")
    (directory / "calibration.json").write_text(
        json.dumps({"method": "temperature", "temperature": temperature, "fitted_on": "val_fit"}, indent=2) + "\n"
    )
    (directory / "thresholds.json").write_text(json.dumps({"tau": tau, "base_rate": base_rate}, indent=2) + "\n")
    (directory / "metrics.json").write_text(json.dumps(metrics, indent=2) + "\n")


def load_artifact(directory: Path) -> Predictor:
    if not directory.exists():
        raise FileNotFoundError(f"No artefact at {directory}. Train one with `uv run pulse-train`.")
    config = json.loads((directory / "config.json").read_text())
    model = CausalTransformer(ModelConfig(**config["model"]))
    model.load_state_dict(torch.load(directory / "model.pt", map_location="cpu", weights_only=True))
    scaler = Scaler.from_json(json.loads((directory / "scaler.json").read_text()))
    calibration = json.loads((directory / "calibration.json").read_text())
    thresholds = json.loads((directory / "thresholds.json").read_text())
    return Predictor(
        model=model,
        scaler=scaler,
        temperature=float(calibration["temperature"]),
        base_rate=float(thresholds["base_rate"]),
        tau=float(thresholds["tau"]),
        include_f8=bool(config["include_f8"]),
        config=config,
    )

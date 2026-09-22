"""Save a real Corpus A conversation as a Replay session, scored by the shipped artefact.

SPEC §9 asks for prepared sessions "saved from a real run of the final artefact, not
hand-authored values". This command takes a genuine conversation from a validation
partition (never train, never test), sends every turn through the same path a typed turn
takes live — encoder, cached vectors, causal model, calibration — and saves the result.
The session is labelled as a corpus conversation, not live audio.

    uv run pulse-import-session --pick closed
    uv run pulse-import-session --pick lost
    uv run pulse-import-session --pick recovery
    uv run pulse-import-session --conversation-id saas-7-conv-32
"""

from __future__ import annotations

import argparse
import os
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from pulse.data.parse import TURNS_PATH
from pulse.paths import DEFAULT_ARTIFACT, SESSIONS_DIR

ALLOWED_PARTITIONS = ("val_select", "val_fit")
PICKS = ("closed", "lost", "recovery")


def pick_conversation(kind: str, partition: str, artifact: Path, seed: int) -> str:
    """Chooses a conversation by its real outcome and the artefact's real trajectory."""
    from pulse.model.artifact import load_artifact
    from pulse.train.train import Corpus

    predictor = load_artifact(artifact)
    corpus = Corpus()
    members = np.random.default_rng(seed).permutation(corpus.members(partition))
    base, tau = predictor.base_rate, predictor.tau
    for member in members:
        count = int(corpus.counts[member])
        if not 8 <= count <= 14:
            continue
        path = predictor.probabilities(corpus.inputs(int(member)))
        movement = np.diff(np.concatenate([[base], path]))
        outcome = int(corpus.labels[member])
        drops = np.flatnonzero(movement <= -tau)
        rises = np.flatnonzero(movement >= tau)
        if kind == "closed" and outcome == 1 and path[-1] >= 0.75 and len(rises) and not len(drops):
            return str(corpus.splits["conversation_id"].iloc[member])
        if kind == "lost" and outcome == 0 and path[-1] <= 0.25 and len(drops):
            return str(corpus.splits["conversation_id"].iloc[member])
        if (
            kind == "recovery"
            and outcome == 1
            and path[-1] >= 0.6
            and len(drops)
            and len(rises)
            and rises.max() > drops.min()
            and path.min() <= base - tau / 2
        ):
            return str(corpus.splits["conversation_id"].iloc[member])
    raise SystemExit(f"No {kind} conversation matched in {partition}.")


def import_conversation(conversation_id: str, artifact: Path, sessions: Path, label: str | None) -> Path:
    from pulse.data.split import SPLITS_PATH
    from pulse.features.encoder import TurnEncoder
    from pulse.model.artifact import load_artifact
    from pulse.serve.models import DEFAULT_ASR_MODEL
    from pulse.serve.session import SessionStore

    splits = pd.read_parquet(SPLITS_PATH)
    row = splits[splits["conversation_id"] == conversation_id]
    if row.empty:
        raise SystemExit(f"Unknown conversation {conversation_id!r}.")
    partition = str(row["split"].iloc[0])
    if partition not in ALLOWED_PARTITIONS:
        raise SystemExit(f"{conversation_id} is in {partition}; only {ALLOWED_PARTITIONS} may be imported.")
    outcome = int(row["outcome"].iloc[0])

    turns = pq.read_table(
        TURNS_PATH, columns=["conversation_id", "t", "speaker", "text"], filters=[("conversation_id", "=", conversation_id)]
    ).to_pandas().sort_values("t")

    predictor = load_artifact(artifact)
    encoder = TurnEncoder(offline=True)
    store = SessionStore(predictor, sessions, DEFAULT_ASR_MODEL)
    session = store.create()
    for speaker_code, text in zip(turns["speaker"], turns["text"], strict=True):
        started = time.perf_counter()
        encode_started = time.perf_counter()
        embedding = encoder.encode([text])[0]
        encode_ms = (time.perf_counter() - encode_started) * 1000
        session.add_turn("dealer" if speaker_code == 0 else "customer", text, embedding, None, encode_ms, started)

    record = store.save(session, now=datetime.now())
    saved = store.load(str(record["name"]))
    name = f"corpus-{conversation_id}"
    saved["name"] = name
    saved["title"] = f"Corpus A {conversation_id} — {label or ('closed' if outcome else 'lost')}"
    saved["description"] = (
        f"Real Corpus A conversation from the {partition} partition (recorded outcome: "
        f"{'closed' if outcome else 'not closed'}), entered as typed turns and scored by "
        f"{predictor.version}. Not live audio."
    )
    (sessions / f"{record['name']}.json").unlink()
    path = store.write(saved)
    print(f"saved {path}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--conversation-id")
    group.add_argument("--pick", choices=PICKS)
    parser.add_argument("--partition", default="val_select", choices=ALLOWED_PARTITIONS)
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument("--sessions", type=Path, default=SESSIONS_DIR)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"
    conversation_id = args.conversation_id or pick_conversation(args.pick, args.partition, args.artifact, args.seed)
    import_conversation(conversation_id, args.artifact, args.sessions, args.pick)


if __name__ == "__main__":
    main()

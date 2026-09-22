"""Stage 7 — causal scalar features for every turn (SPEC §7.3).

Computes F6 from the turn text and the raw F3–F8 block per conversation, in memmap row order.
Scaling statistics are fitted later, on the training partition only.
"""

from __future__ import annotations

import argparse
import time

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from pulse.data.parse import TURNS_PATH
from pulse.eda.phase0 import load_decisions
from pulse.features.encoder import TURN_INDEX_PATH, open_embeddings
from pulse.features.scalars import feature_names, scalar_features
from pulse.paths import PROCESSED_DIR
from pulse.text import is_interrogative

INTERROGATIVE_PATH = PROCESSED_DIR / "interrogative.npy"
SCALARS_PATH = PROCESSED_DIR / "scalars_raw.npy"


def conversation_bounds(index: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """Start row and turn count of each conversation, in memmap order."""
    starts = np.flatnonzero(index["t"].to_numpy() == 1)
    counts = np.diff(np.append(starts, len(index)))
    return starts, counts


def build() -> None:
    include_f8 = bool(load_decisions()["f8_retained"])
    index = pd.read_parquet(TURN_INDEX_PATH)
    embeddings = open_embeddings(len(index))

    started = time.perf_counter()
    texts = pq.read_table(TURNS_PATH, columns=["conversation_id", "t", "text"]).to_pandas()
    texts = index[["conversation_id", "t"]].merge(texts, on=["conversation_id", "t"], how="left")["text"]
    interrogative = np.fromiter((is_interrogative(text) for text in texts), dtype=bool, count=len(texts))
    del texts
    np.save(INTERROGATIVE_PATH, interrogative)
    print(f"F6: {interrogative.mean():.1%} of turns interrogative ({time.perf_counter() - started:.0f}s)")

    speakers = index["speaker"].to_numpy()
    n_words = index["n_words"].to_numpy()
    starts, counts = conversation_bounds(index)
    names = feature_names(include_f8)
    out = np.zeros((len(index), len(names)), dtype=np.float32)
    for start, count in zip(starts, counts, strict=True):
        rows = slice(start, start + count)
        out[rows] = scalar_features(
            speakers[rows], n_words[rows], interrogative[rows], np.asarray(embeddings[rows], dtype=np.float32), include_f8
        )
    np.save(SCALARS_PATH, out)
    print(f"scalars {names} for {len(index):,} turns ({time.perf_counter() - started:.0f}s)")


def main() -> None:
    argparse.ArgumentParser(description=__doc__).parse_args()
    build()


if __name__ == "__main__":
    main()

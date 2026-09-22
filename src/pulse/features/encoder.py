"""F1 turn encoder and stage 6 — encode every turn once into a float16 memory-map (SPEC §7.3).

The encoder is ``all-MiniLM-L6-v2``, frozen. Vectors are unit-normalised and stored as
float16; the server rounds its vectors to float16 in the same way, so a turn has exactly the
same representation in training and live.
"""

from __future__ import annotations

import argparse
import json
import time

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from pulse.data.parse import TURNS_PATH
from pulse.data.split import SPLITS_PATH
from pulse.paths import PROCESSED_DIR
from pulse.serve.models import ENCODER_NAME, load_encoder

EMBED_DIM = 384
EMBEDDINGS_PATH = PROCESSED_DIR / "embeddings.f16"
TURN_INDEX_PATH = PROCESSED_DIR / "turn_index.parquet"
PROGRESS_PATH = PROCESSED_DIR / "embeddings.progress.json"
META_PATH = PROCESSED_DIR / "embeddings.meta.json"
CHUNK = 8192


def best_device() -> str:
    import torch

    return "mps" if torch.backends.mps.is_available() else "cpu"


class TurnEncoder:
    """Frozen sentence encoder producing the F1 block for one or more turns."""

    def __init__(self, device: str | None = None, offline: bool = True) -> None:
        self.device = device or best_device()
        self.model = load_encoder(self.device, offline=offline)
        dimension = self.model.get_embedding_dimension()
        if dimension != EMBED_DIM:
            raise RuntimeError(f"{ENCODER_NAME} produced {dimension}-d vectors, expected {EMBED_DIM}")

    def encode(self, texts: list[str], batch_size: int = 64) -> np.ndarray:
        vectors = self.model.encode(
            texts,
            batch_size=batch_size,
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        # Round through float16 exactly as the training memory-map does.
        return np.asarray(vectors, dtype=np.float16).astype(np.float32)


def build_turn_index() -> pd.DataFrame:
    """Turns of the deduplicated conversations, in split-file order, with memmap row numbers."""
    splits = pd.read_parquet(SPLITS_PATH, columns=["conversation_id"])
    order = pd.Series(np.arange(len(splits)), index=splits["conversation_id"])
    turns = pq.read_table(TURNS_PATH, columns=["conversation_id", "t", "speaker", "n_words"]).to_pandas()
    turns = turns[turns["conversation_id"].isin(order.index)]
    turns["conversation_order"] = order.loc[turns["conversation_id"]].to_numpy()
    turns = turns.sort_values(["conversation_order", "t"]).reset_index(drop=True)
    turns["row"] = np.arange(len(turns), dtype=np.int64)
    return turns.drop(columns="conversation_order")


def encode_corpus(batch_size: int) -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    if TURN_INDEX_PATH.exists():
        index = pd.read_parquet(TURN_INDEX_PATH)
    else:
        index = build_turn_index()
        index.to_parquet(TURN_INDEX_PATH, index=False)
    total = len(index)

    # Texts in memmap row order (the index is already sorted that way).
    texts_table = pq.read_table(TURNS_PATH, columns=["conversation_id", "t", "text"]).to_pandas()
    texts = index[["conversation_id", "t"]].merge(texts_table, on=["conversation_id", "t"], how="left")["text"]
    del texts_table
    if texts.isna().any():
        raise RuntimeError("turn index and turn texts disagree")
    texts_list = texts.tolist()
    del texts

    done = json.loads(PROGRESS_PATH.read_text())["rows"] if PROGRESS_PATH.exists() else 0
    mode = "r+" if EMBEDDINGS_PATH.exists() and done > 0 else "w+"
    memmap = np.memmap(EMBEDDINGS_PATH, dtype=np.float16, mode=mode, shape=(total, EMBED_DIM))

    encoder = TurnEncoder(offline=True)
    print(f"encoding {total - done:,} of {total:,} turns on {encoder.device}", flush=True)
    started = time.perf_counter()
    start_done = done
    while done < total:
        end = min(done + CHUNK, total)
        memmap[done:end] = encoder.encode(texts_list[done:end], batch_size=batch_size).astype(np.float16)
        memmap.flush()
        done = end
        PROGRESS_PATH.write_text(json.dumps({"rows": done}))
        rate = (done - start_done) / max(time.perf_counter() - started, 1e-6)
        remaining = (total - done) / max(rate, 1e-6)
        print(f"  {done:,}/{total:,}  {rate:,.0f} turns/s  ~{remaining / 60:.0f} min left", flush=True)

    from huggingface_hub import scan_cache_dir

    revisions = [
        revision.commit_hash
        for repo in scan_cache_dir().repos
        if repo.repo_id == ENCODER_NAME
        for revision in repo.revisions
    ]
    META_PATH.write_text(
        json.dumps(
            {
                "encoder": ENCODER_NAME,
                "encoder_revisions_in_cache": revisions,
                "dimension": EMBED_DIM,
                "dtype": "float16",
                "normalised": True,
                "rows": total,
            },
            indent=2,
        )
    )
    print(f"done: {total:,} turns in {(time.perf_counter() - started) / 60:.1f} min → {EMBEDDINGS_PATH}")


def open_embeddings(rows: int) -> np.memmap:
    return np.memmap(EMBEDDINGS_PATH, dtype=np.float16, mode="r", shape=(rows, EMBED_DIM))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--batch-size", type=int, default=256)
    args = parser.parse_args()
    encode_corpus(args.batch_size)


if __name__ == "__main__":
    main()


"""Stage 4 — deduplicate and split into train / val-select / val-fit / test (report §7.1).

* The unit of partition is the conversation; prefixes are expanded only after assignment.
* Exact duplicates are resolved first (EDA-03).
* Stratified by outcome and length band (EDA-01, EDA-02).
* Grouped by ``company_id`` when EDA-04 requires it, so no company spans two partitions.
* 80 / 10 / 10, with validation halved into ``val_select`` (model selection) and ``val_fit``
  (temperature and τ). The seed is fixed and recorded.
"""

from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedGroupKFold, StratifiedKFold

from pulse.data.parse import CONVERSATIONS_PATH
from pulse.eda.phase0 import load_decisions
from pulse.paths import PROCESSED_DIR, REPORTS_DIR

SPLITS_PATH = PROCESSED_DIR / "splits.parquet"
REPORT_PATH = REPORTS_DIR / "split_report.json"
SEED = 20260922
PARTITIONS = ("train", "val_select", "val_fit", "test")


def deduplicate(conversations: pd.DataFrame) -> tuple[pd.DataFrame, dict[str, int]]:
    labels_per_hash = conversations.groupby("content_hash")["outcome"].transform("nunique")
    conflicting = conversations[labels_per_hash > 1]
    kept = conversations[labels_per_hash == 1].drop_duplicates("content_hash", keep="first")
    return kept, {
        "input": len(conversations),
        "dropped_conflicting_label_copies": len(conflicting),
        "dropped_redundant_copies": len(conversations) - len(conflicting) - len(kept),
        "kept": len(kept),
    }


def stratum(conversations: pd.DataFrame, band_edges: list[int]) -> np.ndarray:
    band = np.digitize(conversations["n_turns"].to_numpy(), band_edges)
    return conversations["outcome"].to_numpy() * (len(band_edges) + 1) + band


def assign(conversations: pd.DataFrame, grouped: bool, band_edges: list[int]) -> pd.Series:
    y = stratum(conversations, band_edges)
    groups = conversations["company_id"].to_numpy()
    index = np.arange(len(conversations))

    # Ten folds: eight train, one validation, one test.
    if grouped:
        folds = StratifiedGroupKFold(n_splits=10, shuffle=True, random_state=SEED).split(index, y, groups)
    else:
        folds = StratifiedKFold(n_splits=10, shuffle=True, random_state=SEED).split(index, y)
    fold_of = np.empty(len(conversations), dtype=int)
    for fold, (_, held) in enumerate(folds):
        fold_of[held] = fold

    split = np.where(fold_of == 8, "val", np.where(fold_of == 9, "test", "train")).astype(object)

    # Halve validation, respecting the same grouping and stratification.
    val = np.flatnonzero(split == "val")
    if grouped:
        halves = StratifiedGroupKFold(n_splits=2, shuffle=True, random_state=SEED).split(val, y[val], groups[val])
    else:
        halves = StratifiedKFold(n_splits=2, shuffle=True, random_state=SEED).split(val, y[val])
    select_positions, fit_positions = next(iter(halves))
    split[val[select_positions]] = "val_select"
    split[val[fit_positions]] = "val_fit"
    return pd.Series(split, index=conversations.index, name="split")


def describe(conversations: pd.DataFrame) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    for name in PARTITIONS:
        part = conversations[conversations["split"] == name]
        out[name] = {
            "conversations": len(part),
            "share": len(part) / len(conversations),
            "positive_rate": float(part["outcome"].mean()),
            "median_turns": float(part["n_turns"].median()),
            "companies": int(part["company_id"].nunique()),
        }
    return out


def run() -> dict[str, object]:
    decisions = load_decisions()
    grouped = bool(decisions["grouped_split"])
    band_edges = [int(edge) for edge in decisions["length_band_edges"]]  # type: ignore[union-attr]

    conversations, dedup = deduplicate(pd.read_parquet(CONVERSATIONS_PATH))
    conversations = conversations.reset_index(drop=True)
    conversations["split"] = assign(conversations, grouped, band_edges)

    # Hygiene checks: a conversation or (when grouped) a company in exactly one partition.
    assert conversations["conversation_id"].is_unique
    companies_per_partition = conversations.groupby("company_id")["split"].nunique()
    if grouped:
        assert int(companies_per_partition.max()) == 1, "a company appears in more than one partition"

    conversations[["conversation_id", "company_id", "outcome", "n_turns", "split"]].to_parquet(SPLITS_PATH, index=False)
    report = {
        "seed": SEED,
        "grouped_by_company": grouped,
        "stratified_by": ["outcome", f"length band edges {band_edges}"],
        "deduplication": dedup,
        "partitions": describe(conversations),
        "companies_spanning_partitions": int((companies_per_partition > 1).sum()),
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return report


def main() -> None:
    argparse.ArgumentParser(description=__doc__).parse_args()
    run()


if __name__ == "__main__":
    main()

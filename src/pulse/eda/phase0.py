"""Stage 3 — Phase 0 EDA and the decisions it gates (report §4, SPEC §7.3).

Each check computes a quantity and applies the rule fixed in advance in the report:

* EDA-01 class balance → primary discrimination metric (AUROC, or PR-AUC under skew).
* EDA-02 length distribution → length bands for stratification, position range.
* EDA-03 exact duplicates → resolved before splitting.
* EDA-04 company concentration → grouped split if conversations recur under one company.
* EDA-06 speaker alternation → F8 retained only if same-speaker runs genuinely occur.

The decisions are written to ``reports/eda_phase0.json`` and read by the split and feature
stages, so no later stage re-decides them.
"""

from __future__ import annotations

import argparse
import json

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from pulse.data.parse import CONVERSATIONS_PATH, TURNS_PATH
from pulse.paths import REPORTS_DIR

REPORT_PATH = REPORTS_DIR / "eda_phase0.json"

#: EDA-01: below this minority share, PR-AUC replaces AUROC as the primary metric.
IMBALANCE_MINORITY_SHARE = 0.30
#: EDA-04: grouped split when the median company contributes at least this many conversations.
GROUPING_MEDIAN_CONVERSATIONS = 10
#: EDA-06: F8 retained only if at least this share of adjacent turn pairs share a speaker.
ALTERNATION_VARIANCE_SHARE = 0.01


def quantiles(values: np.ndarray) -> dict[str, float]:
    points = [0, 1, 5, 25, 50, 75, 95, 99, 100]
    return {f"p{p}": float(np.percentile(values, p)) for p in points}


def run() -> dict[str, object]:
    conversations = pd.read_parquet(CONVERSATIONS_PATH)
    turns = pq.read_table(TURNS_PATH, columns=["conversation_id", "t", "speaker", "n_words"]).to_pandas()

    # EDA-01 — class balance.
    positive_rate = float(conversations["outcome"].mean())
    minority = min(positive_rate, 1 - positive_rate)
    primary_metric = "pr_auc" if minority < IMBALANCE_MINORITY_SHARE else "auroc"

    # EDA-02 — length.
    n_turns = conversations["n_turns"].to_numpy()
    length_quantiles = quantiles(n_turns)
    band_edges = sorted({int(length_quantiles["p25"]), int(length_quantiles["p50"]), int(length_quantiles["p75"])})
    length_matches = float((conversations["conversation_length"] == conversations["n_turns"]).mean())
    by_length = conversations.groupby("n_turns")["outcome"].agg(["count", "mean"]).reset_index()

    # EDA-03 — exact duplicates after normalisation.
    duplicate_groups = conversations.groupby("content_hash")
    group_sizes = duplicate_groups.size()
    duplicated_hashes = group_sizes[group_sizes > 1]
    conflicting = int((duplicate_groups["outcome"].nunique() > 1).sum())

    # EDA-04 — company concentration.
    per_company = conversations.groupby("company_id").size()
    company_median = float(per_company.median())
    grouped_split = company_median >= GROUPING_MEDIAN_CONVERSATIONS
    company_outcome = conversations.groupby("company_id")["outcome"].mean()

    # EDA-06 — speaker alternation.
    ordered = turns.sort_values(["conversation_id", "t"])
    same_conversation = ordered["conversation_id"].to_numpy()[1:] == ordered["conversation_id"].to_numpy()[:-1]
    same_speaker = ordered["speaker"].to_numpy()[1:] == ordered["speaker"].to_numpy()[:-1]
    adjacent_pairs = int(same_conversation.sum())
    same_speaker_share = float((same_speaker & same_conversation).sum() / max(adjacent_pairs, 1))
    f8_retained = same_speaker_share >= ALTERNATION_VARIANCE_SHARE
    first_speaker = ordered.groupby("conversation_id")["speaker"].first().value_counts().to_dict()

    report = {
        "conversations": len(conversations),
        "turns": len(turns),
        "eda_01_class_balance": {
            "positive_rate": positive_rate,
            "rule": f"PR-AUC primary if minority share < {IMBALANCE_MINORITY_SHARE}",
        },
        "eda_02_length": {
            "n_turns": length_quantiles,
            "conversation_length_equals_parsed_turns": length_matches,
            "outcome_rate_by_length": by_length.to_dict(orient="records"),
            "words_per_turn": quantiles(turns["n_words"].to_numpy()),
        },
        "eda_03_duplicates": {
            "unique_conversations": int(len(group_sizes)),
            "duplicated_fingerprints": int(len(duplicated_hashes)),
            "redundant_copies": int((duplicated_hashes - 1).sum()),
            "fingerprints_with_conflicting_outcomes": conflicting,
            "rule": "exact duplicates (normalised case and whitespace) keep one copy; conflicting-label groups are dropped",
        },
        "eda_04_company": {
            "companies": int(len(per_company)),
            "conversations_per_company": quantiles(per_company.to_numpy()),
            "largest_company_share": float(per_company.max() / len(conversations)),
            "company_outcome_rate": quantiles(company_outcome.to_numpy()),
            "rule": f"grouped split if median conversations per company ≥ {GROUPING_MEDIAN_CONVERSATIONS}",
        },
        "eda_06_alternation": {
            "adjacent_pairs": adjacent_pairs,
            "same_speaker_share": same_speaker_share,
            "first_speaker_counts": {("dealer" if k == 0 else "customer"): int(v) for k, v in first_speaker.items()},
            "rule": f"F8 retained if same-speaker share ≥ {ALTERNATION_VARIANCE_SHARE}",
        },
        "decisions": {
            "primary_metric": primary_metric,
            "length_band_edges": band_edges,
            "grouped_split": bool(grouped_split),
            "f8_retained": bool(f8_retained),
        },
    }
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")
    summary = {key: value for key, value in report.items() if key != "eda_02_length"}
    print(json.dumps(summary, indent=2))
    return report


def load_decisions() -> dict[str, object]:
    if not REPORT_PATH.exists():
        raise FileNotFoundError(f"{REPORT_PATH} not found — run pulse-eda first.")
    return json.loads(REPORT_PATH.read_text())["decisions"]


def main() -> None:
    argparse.ArgumentParser(description=__doc__).parse_args()
    run()


if __name__ == "__main__":
    main()

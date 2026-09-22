"""Leakage suite (SPEC §7.4). Runs on every model build; a failure blocks export.

1. Future invariance: replace every turn after t with turns from an unrelated conversation;
   p_1…p_t must be unchanged to numerical tolerance.
2. Forbidden fields: no model input is derived from ``probability_trajectory``,
   ``conversation_length``, ``customer_engagement``, ``sales_effectiveness`` or ``full_text``.
3. Partition hygiene: no conversation id appears in more than one partition.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from pulse.data.acquire import ADMITTED_COLUMNS, FORBIDDEN_COLUMNS
from pulse.features.scalars import BASE_FEATURES, F8_FEATURES
from pulse.model.artifact import ConversationInputs, Predictor

#: Everything the model receives, per turn. Checked against the forbidden list below.
MODEL_INPUT_FIELDS = ("embedding", "speaker", "n_words", "interrogative", "turn_index")
#: Whole-conversation or label-derived fields that must never reach the model.
FORBIDDEN_INPUTS = FORBIDDEN_COLUMNS + ("conversation_length", "outcome")

TOLERANCE = 1e-6


class LeakageError(AssertionError):
    pass


@dataclass
class LeakageReport:
    future_invariance_cases: int
    future_invariance_max_difference: float
    forbidden_fields_checked: tuple[str, ...]
    conversations_checked_for_partition_overlap: int

    def to_json(self) -> dict[str, object]:
        return {
            "future_invariance_cases": self.future_invariance_cases,
            "future_invariance_max_difference": self.future_invariance_max_difference,
            "tolerance": TOLERANCE,
            "forbidden_fields_checked": list(self.forbidden_fields_checked),
            "conversations_checked_for_partition_overlap": self.conversations_checked_for_partition_overlap,
            "passed": True,
        }


def splice(prefix: ConversationInputs, donor: ConversationInputs, keep: int) -> ConversationInputs:
    """First ``keep`` turns of ``prefix`` followed by the donor's turns from ``keep`` on."""
    return ConversationInputs(
        speakers=np.concatenate([prefix.speakers[:keep], donor.speakers[keep:]]),
        n_words=np.concatenate([prefix.n_words[:keep], donor.n_words[keep:]]),
        interrogative=np.concatenate([prefix.interrogative[:keep], donor.interrogative[keep:]]),
        embeddings=np.concatenate([prefix.embeddings[:keep], donor.embeddings[keep:]]),
    )


def check_future_invariance(
    predictor: Predictor, conversations: list[ConversationInputs], seed: int = 0, cases: int = 200
) -> tuple[int, float]:
    rng = np.random.default_rng(seed)
    eligible = [index for index, conversation in enumerate(conversations) if len(conversation) >= 3]
    if len(eligible) < 2:
        raise LeakageError("not enough conversations to test future invariance")
    worst = 0.0
    checked = 0
    for _ in range(cases):
        index, donor_index = rng.choice(eligible, size=2, replace=False)
        original = conversations[index]
        donor = conversations[donor_index]
        length = min(len(original), len(donor))
        if length < 3:
            continue
        keep = int(rng.integers(1, length))
        trimmed = ConversationInputs(
            original.speakers[:length], original.n_words[:length], original.interrogative[:length], original.embeddings[:length]
        )
        donor = ConversationInputs(
            donor.speakers[:length], donor.n_words[:length], donor.interrogative[:length], donor.embeddings[:length]
        )
        baseline = predictor.probabilities(trimmed)
        altered = predictor.probabilities(splice(trimmed, donor, keep))
        difference = float(np.max(np.abs(baseline[:keep] - altered[:keep])))
        worst = max(worst, difference)
        checked += 1
        if difference > TOLERANCE:
            raise LeakageError(f"p_1…p_{keep} changed by {difference:.3g} when later turns were replaced")
        if np.allclose(baseline[keep:], altered[keep:]) and not np.allclose(trimmed.embeddings[keep:], donor.embeddings[keep:]):
            # Positions after the splice must react to the new turns; otherwise the test is vacuous.
            raise LeakageError("later positions ignored replaced turns — the invariance test would be vacuous")
    return checked, worst


def check_forbidden_inputs(feature_list: tuple[str, ...]) -> tuple[str, ...]:
    for field in FORBIDDEN_INPUTS:
        if field in MODEL_INPUT_FIELDS or field in feature_list:
            raise LeakageError(f"forbidden field {field!r} is a model input")
    for column in FORBIDDEN_COLUMNS:
        if column in ADMITTED_COLUMNS:
            raise LeakageError(f"forbidden column {column!r} is read from the corpus")
    unknown = set(feature_list) - set(BASE_FEATURES) - set(F8_FEATURES)
    if unknown:
        raise LeakageError(f"unrecognised model features {sorted(unknown)}")
    return FORBIDDEN_INPUTS


def check_partitions(splits: pd.DataFrame) -> int:
    if not splits["conversation_id"].is_unique:
        raise LeakageError("a conversation id appears more than once in the split table")
    per_id = splits.groupby("conversation_id")["split"].nunique()
    if int(per_id.max()) > 1:
        raise LeakageError("a conversation id appears in more than one partition")
    return len(splits)


def run_suite(
    predictor: Predictor, conversations: list[ConversationInputs], splits: pd.DataFrame, seed: int = 0
) -> LeakageReport:
    cases, worst = check_future_invariance(predictor, conversations, seed=seed)
    fields = check_forbidden_inputs(tuple(predictor.scaler.names))
    checked = check_partitions(splits)
    return LeakageReport(cases, worst, fields, checked)

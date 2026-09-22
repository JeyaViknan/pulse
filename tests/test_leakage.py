"""Leakage suite (SPEC §7.4) — on a synthetic artefact always, and on the shipped one when present."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from pulse.data.acquire import ADMITTED_COLUMNS, FORBIDDEN_COLUMNS
from pulse.model.artifact import Predictor, load_artifact
from pulse.model.leakage import (
    LeakageError,
    check_forbidden_inputs,
    check_future_invariance,
    check_partitions,
)
from pulse.paths import DEFAULT_ARTIFACT

from .conftest import random_conversation


def test_future_turns_never_change_earlier_estimates(tiny_predictor: Predictor) -> None:
    rng = np.random.default_rng(3)
    conversations = [random_conversation(rng, int(rng.integers(3, 20))) for _ in range(40)]
    cases, worst = check_future_invariance(tiny_predictor, conversations, cases=100)
    assert cases > 50
    assert worst <= 1e-6


def test_counterfactual_differs_only_from_the_masked_turn_on(tiny_predictor: Predictor) -> None:
    rng = np.random.default_rng(4)
    conversation = random_conversation(rng, 10)
    real = tiny_predictor.probabilities(conversation)
    for k in range(1, 11):
        ghost = tiny_predictor.counterfactual(conversation, k)
        np.testing.assert_array_equal(ghost[: k - 1], real[: k - 1])
        expected_at_k = ghost[k - 2] if k > 1 else tiny_predictor.base_rate
        assert ghost[k - 1] == expected_at_k
        if k < 10:
            assert not np.allclose(ghost[k:], real[k:])


def test_no_forbidden_field_is_read_or_used() -> None:
    assert not set(ADMITTED_COLUMNS) & set(FORBIDDEN_COLUMNS)
    assert not any(column.startswith("embedding_") for column in ADMITTED_COLUMNS)
    check_forbidden_inputs(("log_turn_index", "drift"))
    with pytest.raises(LeakageError):
        check_forbidden_inputs(("log_turn_index", "conversation_length"))


def test_partitions_must_be_disjoint() -> None:
    good = pd.DataFrame({"conversation_id": ["a", "b", "c"], "split": ["train", "val_fit", "test"]})
    assert check_partitions(good) == 3
    bad = pd.DataFrame({"conversation_id": ["a", "a"], "split": ["train", "test"]})
    with pytest.raises(LeakageError):
        check_partitions(bad)


@pytest.mark.skipif(not DEFAULT_ARTIFACT.exists(), reason="no shipped artefact")
def test_shipped_artefact_passes_the_suite() -> None:
    from pulse.data.split import SPLITS_PATH

    predictor = load_artifact(DEFAULT_ARTIFACT)
    rng = np.random.default_rng(5)
    conversations = [random_conversation(rng, int(rng.integers(3, 24))) for _ in range(60)]
    _, worst = check_future_invariance(predictor, conversations, cases=150)
    assert worst <= 1e-6
    check_forbidden_inputs(tuple(predictor.scaler.names))
    if SPLITS_PATH.exists():
        check_partitions(pd.read_parquet(SPLITS_PATH))
        splits = pd.read_parquet(SPLITS_PATH)
        companies = splits.groupby("company_id")["split"].nunique()
        assert int(companies.max()) == 1, "a company spans partitions"

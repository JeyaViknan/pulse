"""Causal scalar features and text features (report §5)."""

from __future__ import annotations

import numpy as np
import pytest

from pulse.features.scalars import feature_names, scalar_features
from pulse.text import is_interrogative, word_count

from .conftest import random_conversation


def features(conversation, visible=None):  # noqa: ANN001, ANN201
    return scalar_features(
        conversation.speakers,
        conversation.n_words,
        conversation.interrogative,
        conversation.embeddings,
        include_f8=True,
        visible=visible,
    )


def test_features_are_causal() -> None:
    rng = np.random.default_rng(1)
    conversation = random_conversation(rng, 12)
    other = random_conversation(rng, 12)
    full = features(conversation)
    for keep in range(1, 12):
        spliced = type(conversation)(
            np.concatenate([conversation.speakers[:keep], other.speakers[keep:]]),
            np.concatenate([conversation.n_words[:keep], other.n_words[keep:]]),
            np.concatenate([conversation.interrogative[:keep], other.interrogative[keep:]]),
            np.concatenate([conversation.embeddings[:keep], other.embeddings[keep:]]),
        )
        np.testing.assert_array_equal(features(spliced)[:keep], full[:keep])


def test_prefix_aggregates_count_the_current_turn() -> None:
    speakers = np.array([1, 0, 0, 1])
    n_words = np.array([4, 6, 2, 8])
    vectors = np.eye(4, 384, dtype=np.float32)
    values = scalar_features(speakers, n_words, np.zeros(4, bool), vectors, include_f8=True)
    names = feature_names(True)
    column = {name: values[:, index] for index, name in enumerate(names)}
    np.testing.assert_allclose(column["dealer_turn_share"], [0, 0.5, 2 / 3, 0.5])
    np.testing.assert_allclose(column["dealer_word_share"], [0, 0.6, 8 / 12, 8 / 20])
    np.testing.assert_allclose(column["log_turn_index"], np.log1p([1, 2, 3, 4]))
    np.testing.assert_allclose(column["has_history"], [0, 1, 1, 1])
    np.testing.assert_allclose(column["drift"], [0, 1, 1, 1], atol=1e-6)  # orthogonal turns
    np.testing.assert_allclose(column["log_run_length"], np.log1p([1, 1, 2, 1]))
    np.testing.assert_allclose(column["speaker_changed"], [0, 1, 0, 1])


def test_masking_a_turn_removes_it_from_later_aggregates() -> None:
    rng = np.random.default_rng(2)
    conversation = random_conversation(rng, 8)
    masked = 3  # zero-based position of the removed turn
    visible = np.ones(8, bool)
    visible[masked] = False
    with_mask = features(conversation, visible)

    keep = np.arange(8) != masked
    removed = type(conversation)(
        conversation.speakers[keep], conversation.n_words[keep], conversation.interrogative[keep], conversation.embeddings[keep]
    )
    without_turn = scalar_features(
        removed.speakers,
        removed.n_words,
        removed.interrogative,
        removed.embeddings,
        include_f8=True,
        turn_index=np.arange(1, 9)[keep],  # absolute positions are kept under masking
    )
    np.testing.assert_allclose(with_mask[keep], without_turn, rtol=1e-6, atol=1e-6)
    np.testing.assert_array_equal(with_mask[:masked], features(conversation)[:masked])


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("What does the pricing look like for a team of ten", True),
        ("how soon could we get started", True),
        ("Do you integrate with Salesforce", True),
        ("so can we do a pilot first", True),
        ("That makes sense, we need something like that.", False),
        ("I think we're all set for now.", False),
        ("It works with CI/CD tools, right", True),
        ("Sounds good?", False),  # a question mark alone is not lexical evidence
    ],
)
def test_interrogative_is_lexical(text: str, expected: bool) -> None:
    assert is_interrogative(text) is expected


def test_word_count_ignores_punctuation_and_emoji() -> None:
    assert word_count("Hey, quick q... I've been hearing about $5000/month 😅") == 9

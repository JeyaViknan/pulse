"""Causal scalar features F3–F8 (report §5, SPEC §6.2).

Every value at position t is a function of turns 1…t only. The same function serves training
and the live server, so a feature cannot be computed one way offline and another way live.

``visible`` supports counterfactual replay: a turn marked invisible is removed from every
running statistic (counts, shares, the drift reference mean, the alternation state) exactly
as it is removed from attention, so no information about it reaches any other position.

Features, in order:

* F3  ``log_turn_index``         log(1 + t), the absolute one-based turn index
* F4  ``log_dealer_turns``       log(1 + dealer turns so far)
*     ``log_customer_turns``     log(1 + customer turns so far)
*     ``log_dealer_words``       log(1 + dealer words so far)
*     ``log_customer_words``     log(1 + customer words so far)
*     ``dealer_turn_share``      dealer share of turns so far
*     ``dealer_word_share``      dealer share of words so far (0.5 when no words yet)
* F5  ``log_words``              log(1 + words in the current turn)
* F6  ``interrogative``          lexical question indicator (never ``?``)
* F7  ``drift``                  1 − cos(current turn, mean of earlier turns); 0 without history
*     ``has_history``            validity flag for F7 (and F8): 1 if an earlier turn exists
* F8  ``log_run_length``         log(1 + consecutive turns by the current speaker)  [if retained]
*     ``speaker_changed``        1 if the previous turn was by the other speaker   [if retained]
"""

from __future__ import annotations

import numpy as np

BASE_FEATURES = (
    "log_turn_index",
    "log_dealer_turns",
    "log_customer_turns",
    "log_dealer_words",
    "log_customer_words",
    "dealer_turn_share",
    "dealer_word_share",
    "log_words",
    "interrogative",
    "drift",
    "has_history",
)
F8_FEATURES = ("log_run_length", "speaker_changed")

DEALER = 0


def feature_names(include_f8: bool) -> tuple[str, ...]:
    return BASE_FEATURES + (F8_FEATURES if include_f8 else ())


def scalar_features(
    speakers: np.ndarray,
    n_words: np.ndarray,
    interrogative: np.ndarray,
    embeddings: np.ndarray,
    include_f8: bool,
    visible: np.ndarray | None = None,
    turn_index: np.ndarray | None = None,
) -> np.ndarray:
    """Raw (unscaled) features for one conversation, shape ``(T, n_features)``.

    ``speakers`` uses 0 for the dealer and 1 for the customer. ``embeddings`` are the
    unit-norm F1 vectors, shape ``(T, 384)``. ``turn_index`` defaults to 1…T.
    """
    count = len(speakers)
    if count == 0:
        return np.zeros((0, len(feature_names(include_f8))), dtype=np.float32)
    visible_mask = np.ones(count, dtype=bool) if visible is None else visible.astype(bool)
    index = np.arange(1, count + 1) if turn_index is None else turn_index
    weight = visible_mask.astype(np.float64)

    is_dealer = (speakers == DEALER).astype(np.float64)
    words = n_words.astype(np.float64)

    def prefix(values: np.ndarray) -> np.ndarray:
        """Sum over visible earlier turns plus the current turn."""
        exclusive = np.concatenate([[0.0], np.cumsum(values * weight)[:-1]])
        return exclusive + values

    dealer_turns = prefix(is_dealer)
    customer_turns = prefix(1.0 - is_dealer)
    dealer_words = prefix(words * is_dealer)
    customer_words = prefix(words * (1.0 - is_dealer))
    total_words = dealer_words + customer_words

    # Drift from the mean of visible earlier turns.
    vectors = embeddings.astype(np.float64)
    earlier_sum = np.concatenate([np.zeros((1, vectors.shape[1])), np.cumsum(vectors * weight[:, None], axis=0)[:-1]])
    earlier_count = np.concatenate([[0.0], np.cumsum(weight)[:-1]])
    has_history = earlier_count > 0
    norms = np.linalg.norm(earlier_sum, axis=1)
    cosine = np.einsum("ij,ij->i", vectors, earlier_sum) / np.maximum(norms, 1e-12)
    drift = np.where(has_history & (norms > 1e-12), 1.0 - cosine, 0.0)

    columns = [
        np.log1p(index.astype(np.float64)),
        np.log1p(dealer_turns),
        np.log1p(customer_turns),
        np.log1p(dealer_words),
        np.log1p(customer_words),
        dealer_turns / (dealer_turns + customer_turns),
        np.where(total_words > 0, dealer_words / np.maximum(total_words, 1.0), 0.5),
        np.log1p(words),
        interrogative.astype(np.float64),
        drift,
        has_history.astype(np.float64),
    ]

    if include_f8:
        run_length = np.ones(count)
        changed = np.zeros(count)
        previous_speaker: int | None = None
        current_run = 0
        for position in range(count):
            speaker = int(speakers[position])
            run = current_run + 1 if speaker == previous_speaker else 1
            run_length[position] = run
            changed[position] = 1.0 if previous_speaker is not None and speaker != previous_speaker else 0.0
            if visible_mask[position]:
                previous_speaker, current_run = speaker, run
        columns += [np.log1p(run_length), changed]

    return np.stack(columns, axis=1).astype(np.float32)


class Scaler:
    """Per-feature standardisation fitted on the training partition only (SPEC §6.5)."""

    def __init__(self, names: tuple[str, ...], mean: np.ndarray, std: np.ndarray) -> None:
        self.names = names
        self.mean = mean.astype(np.float32)
        self.std = np.where(std > 1e-6, std, 1.0).astype(np.float32)

    @classmethod
    def fit(cls, names: tuple[str, ...], values: np.ndarray) -> Scaler:
        return cls(names, values.mean(axis=0), values.std(axis=0))

    def transform(self, values: np.ndarray) -> np.ndarray:
        return ((values - self.mean) / self.std).astype(np.float32)

    def to_json(self) -> dict[str, object]:
        return {
            "features": list(self.names),
            "mean": [float(value) for value in self.mean],
            "std": [float(value) for value in self.std],
            "fitted_on": "train",
        }

    @classmethod
    def from_json(cls, data: dict[str, object]) -> Scaler:
        names = tuple(data["features"])  # type: ignore[arg-type]
        return cls(names, np.asarray(data["mean"], dtype=np.float32), np.asarray(data["std"], dtype=np.float32))

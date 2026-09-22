"""Post-hoc temperature scaling and turning-point threshold (SPEC §6.1, report §6.4, §7.1.2).

Both are fitted on ``val_fit`` only — never on the partition used for model selection, and
never on test.
"""

from __future__ import annotations

import numpy as np
import torch

#: τ is the q-quantile of |m_t| over all val-fit turns: the size of movement that only the
#: largest (1 − q) share of turns reach. Fixed here, before any test evaluation (O3).
TAU_QUANTILE = 0.90


def fit_temperature(logits: np.ndarray, labels: np.ndarray) -> float:
    """Temperature T > 0 minimising the negative log-likelihood of sigmoid(logit / T)."""
    x = torch.as_tensor(logits, dtype=torch.float64)
    y = torch.as_tensor(labels, dtype=torch.float64)
    log_temperature = torch.zeros(1, dtype=torch.float64, requires_grad=True)
    optimiser = torch.optim.LBFGS([log_temperature], lr=0.5, max_iter=200, line_search_fn="strong_wolfe")

    def closure() -> torch.Tensor:
        optimiser.zero_grad()
        loss = torch.nn.functional.binary_cross_entropy_with_logits(x / log_temperature.exp(), y)
        loss.backward()
        return loss

    optimiser.step(closure)
    return float(log_temperature.exp().item())


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-values))


def momentum_paths(paths: list[np.ndarray], base_rate: float) -> list[np.ndarray]:
    """m_t = p_t − p_{t−1} with p_0 = π̂, for each conversation's probability path."""
    return [np.diff(np.concatenate([[base_rate], path])) for path in paths]


def fit_tau(paths: list[np.ndarray], base_rate: float, quantile: float = TAU_QUANTILE) -> float:
    movements = np.concatenate([np.abs(m) for m in momentum_paths(paths, base_rate)])
    return float(np.quantile(movements, quantile))


def expected_calibration_error(probabilities: np.ndarray, labels: np.ndarray, bins: int = 10) -> float:
    """ECE with equal-mass bins (report §7.3.3)."""
    if len(probabilities) == 0:
        return float("nan")
    order = np.argsort(probabilities, kind="stable")
    total = 0.0
    for chunk in np.array_split(order, bins):
        if len(chunk):
            total += len(chunk) * abs(float(probabilities[chunk].mean()) - float(labels[chunk].mean()))
    return total / len(probabilities)

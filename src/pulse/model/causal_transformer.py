"""Causal turn-level Transformer (SPEC §6, report §6).

Input per turn: the frozen 384-d F1 vector, a learned speaker-role embedding (F2) and the
projected scalar block (F3–F8), concatenated and projected to ``d_model``; a learned
embedding of the absolute turn index t is added. Never t/T or any whole-conversation field.

Attention is restricted by an explicit mask: position q may attend to position k only if
k ≤ q (causality) and k is visible. Counterfactual replay removes a turn by marking it
invisible, which is the same operation as enforcing causality.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import torch
import torch.nn.functional as F
from torch import nn


@dataclass(frozen=True)
class ModelConfig:
    embed_dim: int = 384
    n_scalars: int = 11
    role_dim: int = 16
    scalar_dim: int = 16
    d_model: int = 128
    n_layers: int = 3
    n_heads: int = 4
    ff_mult: int = 4
    dropout: float = 0.1
    max_position: int = 48

    def to_json(self) -> dict[str, object]:
        return asdict(self)


def attention_mask(valid: torch.Tensor, visible: torch.Tensor | None = None) -> torch.Tensor:
    """Boolean mask ``(B, T, T)``: ``mask[b, q, k]`` is True when query q may attend to key k.

    ``valid`` marks real (non-padding) positions. ``visible`` marks turns that exist in the
    replayed conversation; invisible turns are hidden from every other position. Every
    position may always attend to itself, so no attention row is empty.
    """
    batch, length = valid.shape
    causal = torch.ones(length, length, dtype=torch.bool, device=valid.device).tril()
    keys = valid if visible is None else valid & visible
    mask = causal.unsqueeze(0) & keys.unsqueeze(1)
    eye = torch.eye(length, dtype=torch.bool, device=valid.device).unsqueeze(0)
    return mask | eye


class Block(nn.Module):
    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        self.n_heads = config.n_heads
        self.norm_attention = nn.LayerNorm(config.d_model)
        self.qkv = nn.Linear(config.d_model, 3 * config.d_model)
        self.out = nn.Linear(config.d_model, config.d_model)
        self.norm_ff = nn.LayerNorm(config.d_model)
        self.ff = nn.Sequential(
            nn.Linear(config.d_model, config.ff_mult * config.d_model),
            nn.GELU(),
            nn.Dropout(config.dropout),
            nn.Linear(config.ff_mult * config.d_model, config.d_model),
        )
        self.dropout = nn.Dropout(config.dropout)

    def forward(
        self, x: torch.Tensor, mask: torch.Tensor, return_attention: bool = False
    ) -> tuple[torch.Tensor, torch.Tensor | None]:
        batch, length, width = x.shape
        head_dim = width // self.n_heads
        q, k, v = self.qkv(self.norm_attention(x)).split(width, dim=-1)
        q, k, v = (tensor.view(batch, length, self.n_heads, head_dim).transpose(1, 2) for tensor in (q, k, v))

        scores = (q @ k.transpose(-2, -1)) / head_dim**0.5
        scores = scores.masked_fill(~mask.unsqueeze(1), float("-inf"))
        weights = torch.softmax(scores, dim=-1)
        attended = self.dropout(weights) @ v if self.training else weights @ v
        attended = attended.transpose(1, 2).reshape(batch, length, width)

        x = x + self.dropout(self.out(attended))
        x = x + self.dropout(self.ff(self.norm_ff(x)))
        return x, (weights if return_attention else None)


class CausalTransformer(nn.Module):
    def __init__(self, config: ModelConfig) -> None:
        super().__init__()
        if config.d_model % config.n_heads:
            raise ValueError("d_model must be divisible by n_heads")
        self.config = config
        self.role = nn.Embedding(2, config.role_dim)
        self.scalars = nn.Linear(config.n_scalars, config.scalar_dim)
        self.project = nn.Linear(config.embed_dim + config.role_dim + config.scalar_dim, config.d_model)
        # Index 0 is unused; turn indices beyond max_position share the last embedding.
        self.position = nn.Embedding(config.max_position + 1, config.d_model)
        self.input_dropout = nn.Dropout(config.dropout)
        self.blocks = nn.ModuleList(Block(config) for _ in range(config.n_layers))
        self.norm = nn.LayerNorm(config.d_model)
        self.head = nn.Linear(config.d_model, 1)

    def forward(
        self,
        embeddings: torch.Tensor,
        roles: torch.Tensor,
        scalars: torch.Tensor,
        positions: torch.Tensor,
        mask: torch.Tensor,
        return_attention: bool = False,
    ) -> tuple[torch.Tensor, list[torch.Tensor]]:
        """Returns one logit per position ``(B, T)`` and, optionally, per-layer attention."""
        features = torch.cat([embeddings, self.role(roles), self.scalars(scalars)], dim=-1)
        x = self.project(features) + self.position(positions.clamp(1, self.config.max_position))
        x = self.input_dropout(x)
        attention: list[torch.Tensor] = []
        for block in self.blocks:
            x, weights = block(x, mask, return_attention)
            if weights is not None:
                attention.append(weights)
        return self.head(self.norm(x)).squeeze(-1), attention

    def parameter_count(self) -> int:
        return sum(parameter.numel() for parameter in self.parameters() if parameter.requires_grad)


def bce_per_position(logits: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
    return F.binary_cross_entropy_with_logits(logits, labels, reduction="none")

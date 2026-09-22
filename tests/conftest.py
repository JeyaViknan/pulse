"""Shared fixtures.

The API and synthetic leakage tests run against a small, randomly initialised artefact
written through the real export path, with a deterministic stand-in for the sentence encoder
and for Whisper, so they run in seconds and need neither the corpus nor the model cache.
Tests that exercise the shipped artefact are skipped when it is absent.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest
import torch

from pulse.features.scalars import Scaler, feature_names
from pulse.model.artifact import ConversationInputs, Predictor, load_artifact, save_artifact
from pulse.model.causal_transformer import CausalTransformer, ModelConfig


class HashEncoder:
    """Deterministic unit vectors derived from the text — a test double for MiniLM."""

    def encode(self, texts: list[str], batch_size: int = 64) -> np.ndarray:
        vectors = []
        for text in texts:
            seed = int.from_bytes(hashlib.sha256(text.encode()).digest()[:8], "little")
            vector = np.random.default_rng(seed).standard_normal(384)
            vectors.append(vector / np.linalg.norm(vector))
        return np.asarray(vectors, dtype=np.float16).astype(np.float32)


@dataclass(frozen=True)
class FakeTranscript:
    text: str
    audio_seconds: float
    elapsed_ms: float


class ScriptedTranscriber:
    """Returns the audio payload decoded as UTF-8 text — a test double for Whisper."""

    model_name = "test"

    def transcribe(self, audio: bytes) -> FakeTranscript:
        return FakeTranscript(audio.decode("utf-8").strip(), 1.0, 5.0)


@pytest.fixture(scope="session")
def tiny_artifact(tmp_path_factory: pytest.TempPathFactory) -> Path:
    torch.manual_seed(0)
    names = feature_names(include_f8=True)
    config = ModelConfig(n_scalars=len(names), d_model=32, n_layers=2, n_heads=4, dropout=0.0, max_position=16)
    model = CausalTransformer(config)
    scaler = Scaler(names, np.zeros(len(names)), np.ones(len(names)))
    directory = tmp_path_factory.mktemp("artifact") / "pulse_test"
    save_artifact(
        directory,
        model,
        scaler,
        temperature=1.3,
        base_rate=0.5,
        tau=0.05,
        config={
            "version": "pulse_test",
            "encoder": "sentence-transformers/all-MiniLM-L6-v2",
            "features": list(names),
            "include_f8": True,
            "model": config.to_json(),
        },
        metrics={},
    )
    return directory


@pytest.fixture(scope="session")
def tiny_predictor(tiny_artifact: Path) -> Predictor:
    return load_artifact(tiny_artifact)


def random_conversation(rng: np.random.Generator, length: int) -> ConversationInputs:
    vectors = rng.standard_normal((length, 384))
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    return ConversationInputs(
        speakers=rng.integers(0, 2, length),
        n_words=rng.integers(1, 40, length),
        interrogative=rng.random(length) < 0.3,
        embeddings=vectors.astype(np.float16).astype(np.float32),
    )

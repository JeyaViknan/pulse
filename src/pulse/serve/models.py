"""Download and load the pretrained components (SPEC §3: all models cached in advance).

``pulse-fetch-models`` is the only command that needs the network. After it has run, the
server loads everything with ``local_files_only`` and never contacts a remote host.
"""

from __future__ import annotations

import argparse
import time
from collections.abc import Callable
from typing import TYPE_CHECKING, TypeVar

if TYPE_CHECKING:
    from faster_whisper import WhisperModel
    from sentence_transformers import SentenceTransformer

#: Frozen turn encoder (SPEC §6.1).
ENCODER_NAME = "sentence-transformers/all-MiniLM-L6-v2"
#: English-only Whisper models permitted on 8 GB of RAM (SPEC §3).
ASR_MODELS = ("base.en", "small.en")
DEFAULT_ASR_MODEL = "base.en"

#: Files the sentence-transformers loader needs; the repository also holds ONNX and OpenVINO
#: exports that Pulse never uses.
ENCODER_FILES = [
    "config.json",
    "config_sentence_transformers.json",
    "modules.json",
    "sentence_bert_config.json",
    "model.safetensors",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
    "1_Pooling/config.json",
    "2_Normalize/*",
    "README.md",
]

T = TypeVar("T")


def _retry(action: Callable[[], T], label: str, attempts: int = 8) -> T:
    for attempt in range(1, attempts + 1):
        try:
            return action()
        except Exception as error:
            if attempt == attempts:
                raise
            delay = min(30.0, 3.0 * attempt)
            print(f"{label}: {type(error).__name__}; retry {attempt}/{attempts - 1} in {delay:.0f}s", flush=True)
            time.sleep(delay)
    raise AssertionError("unreachable")


def fetch(asr_models: list[str]) -> None:
    from faster_whisper import download_model
    from huggingface_hub import snapshot_download

    path = _retry(lambda: snapshot_download(ENCODER_NAME, allow_patterns=ENCODER_FILES), ENCODER_NAME)
    print(f"encoder  {ENCODER_NAME} → {path}")
    for name in asr_models:
        path = _retry(lambda name=name: download_model(name), f"whisper {name}")
        print(f"whisper  {name} → {path}")


def load_encoder(device: str, offline: bool = True) -> SentenceTransformer:
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(ENCODER_NAME, device=device, local_files_only=offline)


def load_whisper(name: str, offline: bool = True, threads: int = 4) -> WhisperModel:
    from faster_whisper import WhisperModel

    if name not in ASR_MODELS:
        raise ValueError(f"ASR model must be one of {ASR_MODELS}, got {name!r}")
    return WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads, local_files_only=offline)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asr", nargs="+", default=[DEFAULT_ASR_MODEL], choices=ASR_MODELS)
    args = parser.parse_args()
    fetch(args.asr)


if __name__ == "__main__":
    main()

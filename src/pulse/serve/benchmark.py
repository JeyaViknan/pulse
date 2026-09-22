"""Per-stage latency on this machine (SPEC M0 ASR choice, M5 latency record, report R4/O5).

    uv run pulse-benchmark recording1.webm recording2.webm ...

Times Whisper transcription for each ASR setting, the turn encoder on each available device,
and the causal model over conversations of increasing length. Results are written to
``reports/latency_benchmark.json``. Run it with nothing else heavy running.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import time
from pathlib import Path

import numpy as np

from pulse.paths import DEFAULT_ARTIFACT, REPORTS_DIR

REPEATS = 3


def summarise(values: list[float]) -> dict[str, float]:
    ordered = sorted(values)
    return {
        "median_ms": round(statistics.median(ordered), 1),
        "p95_ms": round(ordered[min(len(ordered) - 1, int(np.ceil(0.95 * len(ordered))) - 1)], 1),
        "max_ms": round(ordered[-1], 1),
        "n": len(ordered),
    }


def benchmark_asr(files: list[Path], models: list[str]) -> list[dict[str, object]]:
    from pulse.serve.asr import Transcriber

    audio = [path.read_bytes() for path in files]
    results = []
    for model in models:
        for threads in (4, 8):
            transcriber = Transcriber(model, offline=True, threads=threads)
            transcriber.warm_up()
            for beam in (1, 5):
                transcriber.beam_size = beam
                timings, seconds, texts = [], [], []
                for _ in range(REPEATS):
                    for clip in audio:
                        result = transcriber.transcribe(clip)
                        timings.append(result.elapsed_ms)
                        seconds.append(result.audio_seconds)
                        texts.append(result.text)
                entry = {
                    "model": model,
                    "cpu_threads": threads,
                    "beam_size": beam,
                    "audio_seconds_mean": round(float(np.mean(seconds)), 2),
                    **summarise(timings),
                    "real_time_factor": round(float(np.mean(timings)) / 1000 / float(np.mean(seconds)), 3),
                    "sample_transcripts": texts[: len(audio)],
                }
                print(
                    f"asr {model} threads={threads} beam={beam}: median {entry['median_ms']} ms, "
                    f"p95 {entry['p95_ms']} ms",
                    flush=True,
                )
                results.append(entry)
            del transcriber
    return results


def benchmark_encoder(sentences: list[str]) -> list[dict[str, object]]:
    import torch

    from pulse.features.encoder import TurnEncoder

    devices = ["cpu"] + (["mps"] if torch.backends.mps.is_available() else [])
    results = []
    for device in devices:
        encoder = TurnEncoder(device=device, offline=True)
        encoder.encode(["warm up"])
        timings = []
        for _ in range(REPEATS * 5):
            for sentence in sentences:
                started = time.perf_counter()
                encoder.encode([sentence])
                timings.append((time.perf_counter() - started) * 1000)
        results.append({"device": device, **summarise(timings)})
        print(f"encoder {device}: median {results[-1]['median_ms']} ms", flush=True)
    return results


def benchmark_model(artifact: Path) -> list[dict[str, object]]:
    from pulse.model.artifact import ConversationInputs, load_artifact

    predictor = load_artifact(artifact)
    rng = np.random.default_rng(0)
    results = []
    for length in (1, 5, 10, 20, 30):
        vectors = rng.standard_normal((length, 384))
        vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
        inputs = ConversationInputs(
            speakers=rng.integers(0, 2, length),
            n_words=rng.integers(3, 40, length),
            interrogative=rng.random(length) < 0.3,
            embeddings=vectors.astype(np.float32),
        )
        predictor.probabilities(inputs)
        timings = []
        for _ in range(30):
            started = time.perf_counter()
            predictor.probabilities(inputs)
            timings.append((time.perf_counter() - started) * 1000)
        counterfactual = []
        for _ in range(10):
            started = time.perf_counter()
            predictor.counterfactual(inputs, max(1, length // 2))
            counterfactual.append((time.perf_counter() - started) * 1000)
        results.append({"turns": length, "estimate": summarise(timings), "counterfactual": summarise(counterfactual)})
        print(f"model T={length}: median {results[-1]['estimate']['median_ms']} ms", flush=True)
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("audio", nargs="+", type=Path, help="recorded turns (webm, m4a or wav)")
    parser.add_argument("--asr", nargs="+", default=["base.en"])
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"

    sentences = [
        "Hi, thanks for taking the call today.",
        "We have been struggling with scheduling across our stores, so I am interested.",
        "That is more than we expected for a team our size.",
        "What if we started with a three month pilot on your two busiest stores?",
    ]
    report = {
        "machine": {"platform": platform.platform(), "processor": platform.processor(), "cpus": os.cpu_count()},
        "asr": benchmark_asr(args.audio, args.asr),
        "encoder": benchmark_encoder(sentences),
        "model": benchmark_model(args.artifact),
    }
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORTS_DIR / "latency_benchmark.json"
    path.write_text(json.dumps(report, indent=2) + "\n")
    print(f"wrote {path}")


if __name__ == "__main__":
    main()

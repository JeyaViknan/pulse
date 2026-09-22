"""Stage 12 — evaluate the exported artefact on the Corpus A test partition (report §7).

The test partition is consumed once: the first run writes ``reports/test_evaluation.json``
and every run is appended to ``reports/test_log.jsonl``. A second evaluation is refused
unless ``--force`` is given, and the log records that it was forced.
"""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

from pulse.model.artifact import load_artifact
from pulse.paths import DEFAULT_ARTIFACT, REPORTS_DIR
from pulse.train.train import Corpus, by_position, calibration_report, discrimination, early_regime

RESULT_PATH = REPORTS_DIR / "test_evaluation.json"
LOG_PATH = REPORTS_DIR / "test_log.jsonl"


def evaluate(artifact: Path, force: bool) -> dict[str, object]:
    if RESULT_PATH.exists() and not force:
        raise SystemExit(f"{RESULT_PATH} exists: the test partition has already been consumed. Use --force to re-run.")
    predictor = load_artifact(artifact)
    corpus = Corpus()
    metric = str(predictor.config["selection"]["metric"])  # type: ignore[index]
    early_turns = int(predictor.config["selection"]["early_regime_turns"])  # type: ignore[index]
    members = corpus.members("test")
    labels = corpus.labels[members]

    logits = [predictor.logits(corpus.inputs(int(member))) for member in members]
    probabilities = [1.0 / (1.0 + np.exp(-path / predictor.temperature)) for path in logits]
    movements = [np.diff(np.concatenate([[predictor.base_rate], path])) for path in probabilities]

    result = {
        "artefact_version": predictor.version,
        "evaluated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "conversations": len(members),
        f"early_{metric}": early_regime(logits, labels, metric, early_turns),
        f"terminal_{metric}": discrimination(np.array([path[-1] for path in logits]), labels, metric),
        f"{metric}_by_position": by_position(logits, labels, metric, int(corpus.counts.max())),
        "calibration": calibration_report(probabilities, labels),
        "mean_turning_points_per_conversation": float(
            np.mean([np.sum(np.abs(m) >= predictor.tau) for m in movements])
        ),
        "forced_rerun": bool(RESULT_PATH.exists()),
    }
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    RESULT_PATH.write_text(json.dumps(result, indent=2) + "\n")
    with LOG_PATH.open("a") as log:
        log.write(json.dumps({key: result[key] for key in ("artefact_version", "evaluated_at", "forced_rerun")}) + "\n")
    print(json.dumps({key: value for key, value in result.items() if not key.endswith("by_position")}, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    evaluate(args.artifact, args.force)


if __name__ == "__main__":
    main()

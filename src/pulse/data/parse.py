"""Stage 2 — parse conversations into one row per turn (SPEC §7.3).

The ``conversation`` field is a JSON list of ``{"speaker": ..., "message": ...}`` objects
(verified in M0). ``sales_rep`` maps to the dealer role and ``customer`` to the customer
role. A conversation that cannot be parsed completely is excluded as a whole, never
truncated, and every exclusion is counted by reason.

About 6% of conversations contain a ``system`` turn such as ``--- a week later ---``: a scene
break joining two separate calls. Pulse scores one call at a time, so these multi-session
conversations are excluded rather than merged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from pulse.data.acquire import OUTPUT_PATH as CORPUS_PATH
from pulse.paths import PROCESSED_DIR, REPORTS_DIR
from pulse.text import word_count

DEALER, CUSTOMER = 0, 1
SPEAKER_CODES = {"sales_rep": DEALER, "customer": CUSTOMER}

TURNS_PATH = PROCESSED_DIR / "turns.parquet"
CONVERSATIONS_PATH = PROCESSED_DIR / "conversations.parquet"
REPORT_PATH = REPORTS_DIR / "parse_report.json"

TURN_SCHEMA = pa.schema(
    [
        ("conversation_id", pa.string()),
        ("t", pa.int32()),
        ("speaker", pa.int8()),
        ("text", pa.string()),
        ("n_words", pa.int32()),
    ]
)


def parse_conversation(raw: str | None) -> tuple[list[tuple[int, str]] | None, str | None, Counter[str]]:
    """Returns ``(turns, failure_reason, speaker_labels)``; ``turns`` is None on failure."""
    labels: Counter[str] = Counter()
    if raw is None:
        return None, "missing", labels
    try:
        items = json.loads(raw)
    except json.JSONDecodeError:
        return None, "invalid_json", labels
    if not isinstance(items, list) or not items:
        return None, "not_a_list_or_empty", labels

    turns: list[tuple[int, str]] = []
    for item in items:
        if not isinstance(item, dict):
            return None, "turn_not_an_object", labels
        speaker = item.get("speaker")
        message = item.get("message")
        labels[str(speaker)] += 1
        if speaker == "system":
            return None, "multi_session_scene_break", labels
        if speaker not in SPEAKER_CODES:
            return None, "unknown_speaker", labels
        if not isinstance(message, str) or not message.strip():
            return None, "empty_message", labels
        turns.append((SPEAKER_CODES[speaker], " ".join(message.split())))
    return turns, None, labels


def content_hash(turns: list[tuple[int, str]]) -> str:
    """Normalised fingerprint of a conversation, for exact-duplicate detection (EDA-03)."""
    canonical = "\n".join(f"{speaker}:{' '.join(text.lower().split())}" for speaker, text in turns)
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()


def parse(corpus: Path = CORPUS_PATH) -> dict[str, object]:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    failures: Counter[str] = Counter()
    labels: Counter[str] = Counter()
    conversations: dict[str, list] = {
        "conversation_id": [],
        "company_id": [],
        "outcome": [],
        "conversation_length": [],
        "n_turns": [],
        "content_hash": [],
    }
    total_turns = 0
    source = pq.ParquetFile(corpus)

    with pq.ParquetWriter(TURNS_PATH, TURN_SCHEMA, compression="zstd") as writer:
        for batch in source.iter_batches(batch_size=5_000):
            columns = batch.to_pydict()
            turn_rows: dict[str, list] = {name: [] for name in TURN_SCHEMA.names}
            for conversation_id, company_id, raw, outcome, length in zip(
                columns["conversation_id"],
                columns["company_id"],
                columns["conversation"],
                columns["outcome"],
                columns["conversation_length"],
                strict=True,
            ):
                turns, failure, seen = parse_conversation(raw)
                labels.update(seen)
                if turns is None or outcome not in (0, 1):
                    failures[failure or "invalid_outcome"] += 1
                    continue
                conversations["conversation_id"].append(conversation_id)
                conversations["company_id"].append(company_id)
                conversations["outcome"].append(int(outcome))
                conversations["conversation_length"].append(length)
                conversations["n_turns"].append(len(turns))
                conversations["content_hash"].append(content_hash(turns))
                for t, (speaker, text) in enumerate(turns, start=1):
                    turn_rows["conversation_id"].append(conversation_id)
                    turn_rows["t"].append(t)
                    turn_rows["speaker"].append(speaker)
                    turn_rows["text"].append(text)
                    turn_rows["n_words"].append(word_count(text))
                total_turns += len(turns)
            writer.write_table(pa.table(turn_rows, schema=TURN_SCHEMA))

    pq.write_table(pa.table(conversations), CONVERSATIONS_PATH, compression="zstd")
    report = {
        "source_rows": source.metadata.num_rows,
        "parsed_conversations": len(conversations["conversation_id"]),
        "excluded_conversations": sum(failures.values()),
        "exclusions_by_reason": dict(failures),
        "turns": total_turns,
        "speaker_labels": dict(labels),
        "speaker_mapping": {"sales_rep": "dealer", "customer": "customer"},
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", type=Path, default=CORPUS_PATH)
    args = parser.parse_args()
    parse(args.corpus)


if __name__ == "__main__":
    main()

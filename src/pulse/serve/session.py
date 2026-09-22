"""Live sessions, counterfactual replay, summaries and the session store (SPEC §5.2–5.5).

Per turn, transcription and encoding happen once and the turn vector is cached. The causal
model is then re-run over the cached vectors (SPEC §5.2, REPORT-SYNC note): at 10–30 turns
this costs milliseconds, and because the model is causal the estimates for earlier turns are
unchanged by construction.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np

from pulse.model.artifact import ConversationInputs, Predictor
from pulse.text import is_interrogative, word_count

SPEAKERS = ("dealer", "customer")
SPEAKER_CODE = {"dealer": 0, "customer": 1}
SESSION_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class SessionError(Exception):
    """A request that cannot be served in the session's current state."""


@dataclass
class Timings:
    asr: float | None
    encode: float
    model: float
    total: float

    def to_json(self) -> dict[str, float | None]:
        return {
            "asr": None if self.asr is None else round(self.asr, 1),
            "encode": round(self.encode, 1),
            "model": round(self.model, 1),
            "total": round(self.total, 1),
        }


@dataclass
class TurnRecord:
    t: int
    speaker: str
    text: str
    n_words: int
    interrogative: bool
    embedding: np.ndarray
    p: float
    m: float
    turning_point: bool
    timings: Timings


@dataclass
class Session:
    id: str
    predictor: Predictor
    turns: list[TurnRecord] = field(default_factory=list)
    ended: bool = False
    created: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def base_rate(self) -> float:
        return self.predictor.base_rate

    @property
    def tau(self) -> float:
        return self.predictor.tau

    def inputs(self) -> ConversationInputs:
        return ConversationInputs(
            speakers=np.array([SPEAKER_CODE[turn.speaker] for turn in self.turns], dtype=np.int64),
            n_words=np.array([turn.n_words for turn in self.turns], dtype=np.int64),
            interrogative=np.array([turn.interrogative for turn in self.turns], dtype=bool),
            embeddings=np.stack([turn.embedding for turn in self.turns]).astype(np.float32)
            if self.turns
            else np.zeros((0, 384), dtype=np.float32),
        )

    def add_turn(
        self, speaker: str, text: str, embedding: np.ndarray, asr_ms: float | None, encode_ms: float, started: float
    ) -> TurnRecord:
        """Scores a new turn from the cached vectors; returns the stored record."""
        if speaker not in SPEAKER_CODE:
            raise SessionError(f"Unknown speaker {speaker!r}.")
        if self.ended:
            raise SessionError("The call has ended. Start a new call to add turns.")
        record = TurnRecord(
            t=len(self.turns) + 1,
            speaker=speaker,
            text=text,
            n_words=word_count(text),
            interrogative=is_interrogative(text),
            embedding=embedding.astype(np.float32),
            p=float("nan"),
            m=float("nan"),
            turning_point=False,
            timings=Timings(asr_ms, encode_ms, 0.0, 0.0),
        )
        self.turns.append(record)
        try:
            model_started = time.perf_counter()
            path = self.predictor.probabilities(self.inputs())
            model_ms = (time.perf_counter() - model_started) * 1000
        except Exception:
            self.turns.pop()
            raise
        previous = self.turns[-2].p if len(self.turns) > 1 else self.base_rate
        record.p = float(path[-1])
        record.m = record.p - previous
        record.turning_point = abs(record.m) >= self.tau
        record.timings = Timings(asr_ms, encode_ms, model_ms, (time.perf_counter() - started) * 1000)
        return record

    def remove_last_turn(self) -> int:
        if self.ended:
            raise SessionError("The call has ended.")
        if not self.turns:
            raise SessionError("There is no turn to remove.")
        self.turns.pop()
        return len(self.turns)

    def counterfactual(self, masked_turn: int) -> tuple[list[float], float]:
        """Ghost path p′_1…p′_T with turn k masked in the real model, and δ_k = p_T − p′_T."""
        if not 1 <= masked_turn <= len(self.turns):
            raise SessionError(f"Turn {masked_turn} does not exist.")
        path = self.predictor.counterfactual(self.inputs(), masked_turn)
        return [float(value) for value in path], self.turns[-1].p - float(path[-1])

    def summary(self) -> dict[str, object]:
        """Summary card data, built only from the values computed live (SPEC §4.4)."""
        if not self.turns:
            raise SessionError("The call has no turns yet.")
        return summarise(
            [(turn.t, turn.speaker, turn.text, turn.m, turn.turning_point, turn.n_words) for turn in self.turns],
            final_p=self.turns[-1].p,
            base_rate=self.base_rate,
        )


def summarise(
    turns: list[tuple[int, str, str, float, bool, int]], final_p: float, base_rate: float
) -> dict[str, object]:
    total_movement = final_p - base_rate
    momentum_sum = float(sum(turn[3] for turn in turns))
    if abs(momentum_sum - total_movement) > 1e-9:
        raise AssertionError("momentum does not decompose the total movement")
    ranked = sorted(turns, key=lambda turn: (-abs(turn[3]), turn[0]))[:3]
    dealer_turns = sum(1 for turn in turns if turn[1] == "dealer")
    dealer_words = sum(turn[5] for turn in turns if turn[1] == "dealer")
    words = sum(turn[5] for turn in turns)
    return {
        "final_p": final_p,
        "base_rate": base_rate,
        "total_movement": total_movement,
        "largest_movements": [{"t": t, "speaker": speaker, "text": text, "m": m} for t, speaker, text, m, _, _ in ranked],
        "dealer_turn_share": dealer_turns / len(turns),
        "dealer_word_share": dealer_words / words if words else 0.0,
        "turning_points": sum(1 for turn in turns if turn[4]),
        "turn_count": len(turns),
    }


class SessionStore:
    """Live sessions in memory; saved sessions as JSON files under ``sessions/`` (SPEC §5.5)."""

    def __init__(self, predictor: Predictor, directory: Path, asr_model: str) -> None:
        self.predictor = predictor
        self.directory = directory
        self.asr_model = asr_model
        self.live: dict[str, Session] = {}
        self._lock = threading.Lock()

    def create(self) -> Session:
        session = Session(id=uuid.uuid4().hex, predictor=self.predictor)
        with self._lock:
            # Single presenter, single call (N5): keep only a handful of recent sessions in memory.
            if len(self.live) >= 16:
                oldest = min(self.live.values(), key=lambda item: item.created)
                del self.live[oldest.id]
            self.live[session.id] = session
        return session

    def get(self, session_id: str) -> Session:
        session = self.live.get(session_id)
        if session is None:
            raise KeyError(session_id)
        return session

    def save(self, session: Session, now: datetime | None = None) -> dict[str, object]:
        if not session.turns:
            raise SessionError("Nothing to save: the call has no turns yet.")
        moment = (now or datetime.now()).astimezone()
        name = f"call-{moment:%Y%m%d-%H%M%S}"
        record = {
            "name": name,
            "title": f"Call · {moment:%d %b %Y, %H:%M:%S}",
            "description": None,
            "artefact_version": session.predictor.version,
            "asr_model": self.asr_model,
            "base_rate": session.base_rate,
            "tau": session.tau,
            "saved_at": moment.isoformat(timespec="seconds"),
            "turns": [
                {
                    "t": turn.t,
                    "speaker": turn.speaker,
                    "text": turn.text,
                    "p": turn.p,
                    "m": turn.m,
                    "turning_point": turn.turning_point,
                    "timings_ms": turn.timings.to_json(),
                }
                for turn in session.turns
            ],
            "summary": session.summary(),
        }
        self.write(record)
        return listing(record)

    def write(self, record: dict[str, object]) -> Path:
        name = str(record["name"])
        if not SESSION_NAME.match(name):
            raise SessionError(f"Invalid session name {name!r}.")
        self.directory.mkdir(parents=True, exist_ok=True)
        path = self.directory / f"{name}.json"
        path.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n")
        return path

    def list(self) -> list[dict[str, object]]:
        if not self.directory.exists():
            return []
        records = []
        for path in self.directory.glob("*.json"):
            try:
                records.append(listing(json.loads(path.read_text())))
            except (json.JSONDecodeError, KeyError):
                continue
        return sorted(records, key=lambda record: str(record["saved_at"]), reverse=True)

    def load(self, name: str) -> dict[str, object]:
        if not SESSION_NAME.match(name):
            raise KeyError(name)
        path = self.directory / f"{name}.json"
        if not path.exists():
            raise KeyError(name)
        return json.loads(path.read_text())


def listing(record: dict[str, object]) -> dict[str, object]:
    return {
        "name": record["name"],
        "title": record["title"],
        "turn_count": len(record["turns"]),  # type: ignore[arg-type]
        "saved_at": record["saved_at"],
    }

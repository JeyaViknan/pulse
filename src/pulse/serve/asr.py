"""Local speech recognition with faster-whisper (SPEC §5.2 step 2, §8).

Audio arrives as the browser recorded it (WebM/Opus in Chrome, MP4/AAC in Safari, or WAV)
and is decoded and resampled to 16 kHz mono with PyAV. Nothing leaves the machine.
"""

from __future__ import annotations

import io
import time
from dataclasses import dataclass

import numpy as np

from pulse.serve.models import DEFAULT_ASR_MODEL, load_whisper

SAMPLE_RATE = 16_000
#: Segments Whisper itself considers probably silent are discarded (guards against the
#: well-known hallucinations on silence, such as "Thank you.").
NO_SPEECH_THRESHOLD = 0.6
LOW_CONFIDENCE_LOGPROB = -1.0


class TranscriptionError(Exception):
    pass


@dataclass(frozen=True)
class Transcript:
    text: str
    audio_seconds: float
    elapsed_ms: float


class Transcriber:
    def __init__(
        self, model_name: str = DEFAULT_ASR_MODEL, offline: bool = True, beam_size: int = 5, threads: int = 4
    ) -> None:
        self.model_name = model_name
        self.beam_size = beam_size
        self.model = load_whisper(model_name, offline=offline, threads=threads)

    def decode(self, audio: bytes) -> np.ndarray:
        from faster_whisper import decode_audio

        if not audio:
            raise TranscriptionError("No audio was received.")
        try:
            return decode_audio(io.BytesIO(audio), sampling_rate=SAMPLE_RATE)
        except Exception as error:  # PyAV raises several container/codec errors
            raise TranscriptionError(f"The recording could not be decoded ({type(error).__name__}).") from error

    def transcribe(self, audio: bytes) -> Transcript:
        started = time.perf_counter()
        waveform = self.decode(audio)
        seconds = len(waveform) / SAMPLE_RATE
        if seconds < 0.2:
            raise TranscriptionError("The recording was too short. Hold the key while speaking.")
        segments, _ = self.model.transcribe(
            waveform,
            language="en",
            beam_size=self.beam_size,
            condition_on_previous_text=False,
            without_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        parts = [
            segment.text.strip()
            for segment in segments
            if not (segment.no_speech_prob > NO_SPEECH_THRESHOLD and segment.avg_logprob < LOW_CONFIDENCE_LOGPROB)
        ]
        text = " ".join(part for part in parts if part).strip()
        return Transcript(text=text, audio_seconds=seconds, elapsed_ms=(time.perf_counter() - started) * 1000)

    def warm_up(self) -> None:
        silence = np.zeros(SAMPLE_RATE, dtype=np.float32)
        segments, _ = self.model.transcribe(silence, language="en", beam_size=1, vad_filter=False)
        list(segments)

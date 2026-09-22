"""FastAPI backend: WebSocket turn pipeline and REST endpoints (SPEC §5.4).

WebSocket ``/ws/session/{id}`` — client → server
    ``turn_audio``  JSON ``{type, speaker, mime_type}`` followed by one binary frame of audio
    ``turn_text``   ``{type, speaker, text}``
    ``end_call``    ``{type}``

WebSocket — server → client
    ``status``    ``{state: "transcribing" | "updating" | "idle"}``
    ``turn``      ``{t, speaker, text}``
    ``estimate``  ``{t, p, m, turning_point, timings_ms: {asr, encode, model, total}}``
    ``error``     ``{stage, message}`` — the session continues

REST
    POST   /session                        → {id, base_rate, tau}
    POST   /session/{id}/counterfactual    {mask: [k]} → {path, delta_T}
    GET    /session/{id}/summary           summary card data
    POST   /session/{id}/save              persist to sessions/ as JSON
    DELETE /session/{id}/turns/last        delete-last-turn (SPEC §9)
    GET    /sessions · GET /sessions/{name}
    GET    /health

Everything runs locally. ``pulse-serve`` switches the Hugging Face libraries to offline mode
before any model is loaded, so the server never contacts the network.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from pulse.model.artifact import Predictor
from pulse.serve.session import SPEAKERS, Session, SessionError, SessionStore

MAX_AUDIO_BYTES = 20 * 1024 * 1024
MAX_TEXT_CHARS = 2_000


class Encoder(Protocol):
    def encode(self, texts: list[str], batch_size: int = ...) -> np.ndarray: ...


class SpeechToText(Protocol):
    model_name: str

    def transcribe(self, audio: bytes) -> Any: ...


class CounterfactualRequest(BaseModel):
    mask: list[int]


@dataclass
class Runtime:
    predictor: Predictor
    encoder: Encoder
    transcriber: SpeechToText | None
    store: SessionStore
    encoder_name: str


def create_app(runtime: Runtime, web_dist: Path | None = None) -> FastAPI:
    app = FastAPI(title="Pulse", docs_url=None, redoc_url=None)
    app.state.runtime = runtime
    predictor, store = runtime.predictor, runtime.store

    def session_or_404(session_id: str) -> Session:
        try:
            return store.get(session_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="Unknown session.") from None

    @app.get("/health")
    def health() -> dict[str, object]:
        return {
            "status": "ok" if runtime.transcriber is not None else "degraded",
            "artefact_version": predictor.version,
            "encoder": runtime.encoder_name,
            "asr_model": runtime.transcriber.model_name if runtime.transcriber else None,
            "base_rate": predictor.base_rate,
            "tau": predictor.tau,
        }

    @app.post("/session")
    def create_session() -> dict[str, object]:
        session = store.create()
        return {"id": session.id, "base_rate": session.base_rate, "tau": session.tau}

    @app.post("/session/{session_id}/counterfactual")
    def counterfactual(session_id: str, request: CounterfactualRequest) -> dict[str, object]:
        session = session_or_404(session_id)
        if len(request.mask) != 1:
            raise HTTPException(status_code=422, detail="Mask exactly one turn.")
        with session.lock:
            try:
                path, delta = session.counterfactual(request.mask[0])
            except SessionError as error:
                raise HTTPException(status_code=409, detail=str(error)) from None
        return {"path": path, "delta_T": delta}

    @app.get("/session/{session_id}/summary")
    def summary(session_id: str) -> dict[str, object]:
        session = session_or_404(session_id)
        with session.lock:
            try:
                return session.summary()
            except SessionError as error:
                raise HTTPException(status_code=409, detail=str(error)) from None

    @app.post("/session/{session_id}/save")
    def save(session_id: str) -> dict[str, object]:
        session = session_or_404(session_id)
        with session.lock:
            try:
                return store.save(session)
            except SessionError as error:
                raise HTTPException(status_code=409, detail=str(error)) from None

    @app.delete("/session/{session_id}/turns/last")
    def delete_last_turn(session_id: str) -> dict[str, object]:
        session = session_or_404(session_id)
        with session.lock:
            try:
                return {"turn_count": session.remove_last_turn()}
            except SessionError as error:
                raise HTTPException(status_code=409, detail=str(error)) from None

    @app.get("/sessions")
    def list_sessions() -> list[dict[str, object]]:
        return store.list()

    @app.get("/sessions/{name}")
    def load_session(name: str) -> dict[str, object]:
        try:
            return store.load(name)
        except KeyError:
            raise HTTPException(status_code=404, detail="No saved session with that name.") from None

    @app.websocket("/ws/session/{session_id}")
    async def live(socket: WebSocket, session_id: str) -> None:
        await socket.accept()
        try:
            session = store.get(session_id)
        except KeyError:
            await socket.send_json({"type": "error", "stage": "session", "message": "Unknown session."})
            await socket.close(code=4404)
            return

        pending_audio: tuple[str, float] | None = None
        try:
            while True:
                message = await socket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    if pending_audio is None:
                        await send_error(socket, "protocol", "Audio arrived without a turn_audio message.")
                        continue
                    speaker, received = pending_audio
                    pending_audio = None
                    await process_audio(socket, runtime, session, speaker, message["bytes"], received)
                    continue

                try:
                    data = json.loads(message.get("text") or "")
                except json.JSONDecodeError:
                    await send_error(socket, "protocol", "Messages must be JSON.")
                    continue
                kind = data.get("type")
                if kind == "turn_audio":
                    speaker = data.get("speaker")
                    if speaker not in SPEAKERS:
                        await send_error(socket, "input", "Speaker must be dealer or customer.")
                        continue
                    pending_audio = (speaker, time.perf_counter())
                elif kind == "turn_text":
                    await process_text(socket, runtime, session, data.get("speaker"), data.get("text"))
                elif kind == "end_call":
                    session.ended = True
                else:
                    await send_error(socket, "protocol", f"Unknown message type {kind!r}.")
        except WebSocketDisconnect:
            pass

    if web_dist is not None and (web_dist / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=web_dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def frontend(path: str) -> FileResponse:
            candidate = (web_dist / path).resolve()
            if path and candidate.is_file() and web_dist.resolve() in candidate.parents:
                return FileResponse(candidate)
            return FileResponse(web_dist / "index.html")

    return app


async def send_error(socket: WebSocket, stage: str, message: str) -> None:
    await socket.send_json({"type": "error", "stage": stage, "message": message})


async def send_status(socket: WebSocket, state: str) -> None:
    await socket.send_json({"type": "status", "state": state})


def turn_message(turn: Any) -> dict[str, object]:
    return {"type": "turn", "t": turn.t, "speaker": turn.speaker, "text": turn.text}


def estimate_message(turn: Any) -> dict[str, object]:
    return {
        "type": "estimate",
        "t": turn.t,
        "p": turn.p,
        "m": turn.m,
        "turning_point": turn.turning_point,
        "timings_ms": turn.timings.to_json(),
    }


async def score(
    socket: WebSocket,
    runtime: Runtime,
    session: Session,
    speaker: str,
    text: str,
    asr_ms: float | None,
    started: float,
) -> None:
    """Encode once, run the model over the cached vectors, emit turn and estimate."""
    encode_started = time.perf_counter()
    embedding = (await run_in_threadpool(runtime.encoder.encode, [text]))[0]
    encode_ms = (time.perf_counter() - encode_started) * 1000

    def add() -> Any:
        with session.lock:
            return session.add_turn(speaker, text, embedding, asr_ms, encode_ms, started)

    turn = await run_in_threadpool(add)
    await socket.send_json(turn_message(turn))
    await socket.send_json(estimate_message(turn))


async def process_text(socket: WebSocket, runtime: Runtime, session: Session, speaker: object, text: object) -> None:
    started = time.perf_counter()
    if speaker not in SPEAKERS:
        await send_error(socket, "input", "Speaker must be dealer or customer.")
        return
    if not isinstance(text, str) or not text.strip():
        await send_error(socket, "input", "Type something before sending the turn.")
        return
    if session.ended:
        await send_error(socket, "session", "The call has ended. Start a new call to add turns.")
        return
    cleaned = " ".join(text.split())[:MAX_TEXT_CHARS]
    await send_status(socket, "updating")
    try:
        await score(socket, runtime, session, str(speaker), cleaned, None, started)
    except SessionError as error:
        await send_error(socket, "session", str(error))
    except Exception as error:  # the session continues after a failed turn
        await send_error(socket, "model", f"Scoring failed: {type(error).__name__}.")
    finally:
        await send_status(socket, "idle")


async def process_audio(
    socket: WebSocket, runtime: Runtime, session: Session, speaker: str, audio: bytes, started: float
) -> None:
    if session.ended:
        await send_error(socket, "session", "The call has ended. Start a new call to add turns.")
        return
    if runtime.transcriber is None:
        await send_error(socket, "asr", "Speech recognition is not available. Type the turn instead.")
        return
    if len(audio) > MAX_AUDIO_BYTES:
        await send_error(socket, "asr", "The recording is too long.")
        return

    from pulse.serve.asr import TranscriptionError

    await send_status(socket, "transcribing")
    try:
        transcript = await run_in_threadpool(runtime.transcriber.transcribe, audio)
        if not transcript.text:
            await send_error(socket, "asr", "No speech was detected. Hold the key while speaking, or type the turn.")
            return
        await send_status(socket, "updating")
        await score(socket, runtime, session, speaker, transcript.text, transcript.elapsed_ms, started)
    except TranscriptionError as error:
        await send_error(socket, "asr", str(error))
    except SessionError as error:
        await send_error(socket, "session", str(error))
    except Exception as error:
        await send_error(socket, "model", f"Processing failed: {type(error).__name__}.")
    finally:
        await send_status(socket, "idle")


def build_runtime(
    artifact: Path, sessions: Path, asr_model: str, encoder_device: str | None, beam_size: int = 5
) -> Runtime:
    from pulse.features.encoder import TurnEncoder
    from pulse.model.artifact import load_artifact
    from pulse.serve.asr import Transcriber
    from pulse.serve.models import ENCODER_NAME

    predictor = load_artifact(artifact)
    if predictor.config.get("encoder") != ENCODER_NAME:
        raise RuntimeError(f"artefact expects encoder {predictor.config.get('encoder')!r}")
    print(f"artefact {predictor.version}: π̂ = {predictor.base_rate:.4f}, τ = {predictor.tau:.4f}", flush=True)
    encoder = TurnEncoder(device=encoder_device, offline=True)
    encoder.encode(["warm up"])
    print(f"encoder  {ENCODER_NAME} on {encoder.device}", flush=True)
    transcriber = Transcriber(asr_model, offline=True, beam_size=beam_size)
    transcriber.warm_up()
    print(f"asr      faster-whisper {asr_model} (int8, CPU, beam {beam_size})", flush=True)
    store = SessionStore(predictor, sessions, asr_model)
    return Runtime(predictor, encoder, transcriber, store, ENCODER_NAME)


def main() -> None:
    from pulse.paths import DEFAULT_ARTIFACT, SESSIONS_DIR, WEB_DIST_DIR
    from pulse.serve.models import ASR_MODELS, DEFAULT_ASR_MODEL

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--artifact", type=Path, default=DEFAULT_ARTIFACT)
    parser.add_argument("--sessions", type=Path, default=SESSIONS_DIR)
    parser.add_argument("--asr", default=DEFAULT_ASR_MODEL, choices=ASR_MODELS)
    parser.add_argument(
        "--encoder-device",
        default=None,
        help="mps or cpu (default: mps when available — the device the training vectors were encoded on)",
    )
    parser.add_argument("--beam-size", type=int, default=5, help="Whisper beam size; 1 is greedy and slightly faster")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    # Offline by construction: no model may be fetched while serving.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    import uvicorn

    runtime = build_runtime(args.artifact, args.sessions, args.asr, args.encoder_device, args.beam_size)
    app = create_app(runtime, WEB_DIST_DIR)
    if (WEB_DIST_DIR / "index.html").exists():
        print(f"open     http://{args.host}:{args.port}", flush=True)
    else:
        print("frontend not built — run `npm run build` in web/, or use the Vite dev server", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", ws_max_size=MAX_AUDIO_BYTES + 1024)


if __name__ == "__main__":
    main()

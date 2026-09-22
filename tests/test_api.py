"""API contract (SPEC §5.4, §13) exercised end to end through FastAPI's test client."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from pulse.model.artifact import Predictor
from pulse.serve.app import Runtime, create_app
from pulse.serve.session import SessionStore

from .conftest import HashEncoder, ScriptedTranscriber


@pytest.fixture
def client(tiny_predictor: Predictor, tmp_path: Path) -> TestClient:
    store = SessionStore(tiny_predictor, tmp_path / "sessions", "test")
    runtime = Runtime(tiny_predictor, HashEncoder(), ScriptedTranscriber(), store, "hash-encoder")
    return TestClient(create_app(runtime))


def receive_until_idle(socket) -> list[dict]:  # noqa: ANN001
    messages = []
    while True:
        message = socket.receive_json()
        messages.append(message)
        if message["type"] == "status" and message["state"] == "idle":
            return messages


def send_audio(socket, speaker: str, spoken: str) -> list[dict]:  # noqa: ANN001
    socket.send_text(json.dumps({"type": "turn_audio", "speaker": speaker, "mime_type": "audio/webm"}))
    socket.send_bytes(spoken.encode())
    return receive_until_idle(socket)


def send_text(socket, speaker: str, text: str) -> list[dict]:  # noqa: ANN001
    socket.send_text(json.dumps({"type": "turn_text", "speaker": speaker, "text": text}))
    return receive_until_idle(socket)


def test_health_and_session_creation(client: TestClient, tiny_predictor: Predictor) -> None:
    health = client.get("/health").json()
    assert health["artefact_version"] == "pulse_test"
    created = client.post("/session").json()
    assert created["base_rate"] == tiny_predictor.base_rate
    assert created["tau"] == tiny_predictor.tau


def test_live_call_end_to_end(client: TestClient, tiny_predictor: Predictor) -> None:
    session = client.post("/session").json()
    lines = [
        ("dealer", "Hi, thanks for taking the call today."),
        ("customer", "Sure. We have been struggling with scheduling."),
        ("customer", "But honestly this is more than we expected to pay."),
        ("dealer", "What if we started with a pilot on two stores?"),
    ]
    estimates = []
    with client.websocket_connect(f"/ws/session/{session['id']}") as socket:
        for index, (speaker, text) in enumerate(lines, start=1):
            messages = send_audio(socket, speaker, text) if index % 2 else send_text(socket, speaker, text)
            kinds = [m["type"] if m["type"] != "status" else f"status:{m['state']}" for m in messages]
            if index % 2:
                assert kinds == ["status:transcribing", "status:updating", "turn", "estimate", "status:idle"]
            else:
                assert kinds == ["status:updating", "turn", "estimate", "status:idle"]
            turn = next(m for m in messages if m["type"] == "turn")
            estimate = next(m for m in messages if m["type"] == "estimate")
            assert (turn["t"], turn["speaker"], turn["text"]) == (index, speaker, text)
            assert set(estimate["timings_ms"]) == {"asr", "encode", "model", "total"}  # P9
            assert (estimate["timings_ms"]["asr"] is None) == (index % 2 == 0)
            estimates.append(estimate)

    # P4: momentum from the base rate, markers exactly where |m| ≥ τ.
    previous = tiny_predictor.base_rate
    for estimate in estimates:
        assert estimate["m"] == pytest.approx(estimate["p"] - previous, abs=1e-12)
        assert estimate["turning_point"] == (abs(estimate["m"]) >= tiny_predictor.tau)
        previous = estimate["p"]

    # P5: the ghost path equals the real path before k and differs from k on.
    real = [estimate["p"] for estimate in estimates]
    ghost = client.post(f"/session/{session['id']}/counterfactual", json={"mask": [3]}).json()
    assert len(ghost["path"]) == 4
    # Earlier positions are recomputed over the full sequence; causality makes them equal up to
    # floating-point summation order.
    assert ghost["path"][:2] == pytest.approx(real[:2], abs=1e-6)
    assert ghost["path"][2] == ghost["path"][1]
    assert abs(ghost["path"][3] - real[3]) > 1e-9
    assert ghost["delta_T"] == pytest.approx(real[-1] - ghost["path"][-1], abs=1e-12)

    # P6: the summary reconciles with the live values.
    summary = client.get(f"/session/{session['id']}/summary").json()
    assert summary["final_p"] == pytest.approx(real[-1])
    assert summary["total_movement"] == pytest.approx(sum(e["m"] for e in estimates), abs=1e-9)
    assert summary["turn_count"] == 4
    assert summary["turning_points"] == sum(e["turning_point"] for e in estimates)
    assert summary["dealer_turn_share"] == pytest.approx(0.5)
    assert len(summary["largest_movements"]) == 3

    # P7: save and load reproduce the stored values exactly.
    saved = client.post(f"/session/{session['id']}/save").json()
    assert saved["turn_count"] == 4
    listing = client.get("/sessions").json()
    assert [item["name"] for item in listing] == [saved["name"]]
    loaded = client.get(f"/sessions/{saved['name']}").json()
    assert [turn["p"] for turn in loaded["turns"]] == real
    assert loaded["artefact_version"] == "pulse_test"
    assert loaded["summary"] == summary


def test_typed_turn_matches_transcribed_turn(client: TestClient) -> None:
    """P8: the same words produce the same estimate whether spoken or typed."""
    text = "That sounds interesting, how soon could we start?"
    results = []
    for mode in ("audio", "text"):
        session = client.post("/session").json()
        with client.websocket_connect(f"/ws/session/{session['id']}") as socket:
            messages = send_audio(socket, "customer", text) if mode == "audio" else send_text(socket, "customer", text)
        results.append(next(m for m in messages if m["type"] == "estimate")["p"])
    assert results[0] == results[1]


def test_errors_keep_the_session_alive(client: TestClient) -> None:
    session = client.post("/session").json()
    with client.websocket_connect(f"/ws/session/{session['id']}") as socket:
        silent = send_audio(socket, "dealer", "   ")
        assert any(m["type"] == "error" and m["stage"] == "asr" for m in silent)
        assert not any(m["type"] == "turn" for m in silent)

        socket.send_text(json.dumps({"type": "turn_text", "speaker": "narrator", "text": "hello"}))
        assert socket.receive_json()["stage"] == "input"

        ok = send_text(socket, "dealer", "Hello there.")
        assert next(m for m in ok if m["type"] == "turn")["t"] == 1


def test_delete_last_turn_and_end_call(client: TestClient) -> None:
    session = client.post("/session").json()
    with client.websocket_connect(f"/ws/session/{session['id']}") as socket:
        send_text(socket, "dealer", "Hello.")
        send_text(socket, "dealer", "Oops, wrong button.")
        assert client.delete(f"/session/{session['id']}/turns/last").json() == {"turn_count": 1}
        again = send_text(socket, "customer", "Hi, go ahead.")
        assert next(m for m in again if m["type"] == "turn")["t"] == 2
        socket.send_text(json.dumps({"type": "end_call"}))
        socket.send_text(json.dumps({"type": "turn_text", "speaker": "dealer", "text": "One more thing."}))
        rejected = socket.receive_json()
        assert (rejected["type"], rejected["stage"]) == ("error", "session")


def test_invalid_requests_are_rejected(client: TestClient) -> None:
    session = client.post("/session").json()
    assert client.post(f"/session/{session['id']}/counterfactual", json={"mask": [1]}).status_code == 409
    assert client.post(f"/session/{session['id']}/counterfactual", json={"mask": [1, 2]}).status_code == 422
    assert client.get(f"/session/{session['id']}/summary").status_code == 409
    assert client.post(f"/session/{session['id']}/save").status_code == 409
    assert client.post("/session/unknown/counterfactual", json={"mask": [1]}).status_code == 404
    assert client.get("/sessions/..%2Fpyproject").status_code == 404


def test_estimates_for_earlier_turns_never_change(client: TestClient, tiny_predictor: Predictor) -> None:
    """The live path re-runs the model over cached vectors; causality keeps history fixed."""
    session_info = client.post("/session").json()
    with client.websocket_connect(f"/ws/session/{session_info['id']}") as socket:
        for text in ["One.", "Two, please.", "Three and more words here.", "Four?"]:
            send_text(socket, "customer", text)
    session = client.app.state.runtime.store.get(session_info["id"])  # type: ignore[attr-defined]
    recomputed = tiny_predictor.probabilities(session.inputs())
    np.testing.assert_allclose(recomputed, [turn.p for turn in session.turns], rtol=0, atol=1e-6)

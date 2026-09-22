# Pulse — web interface

Browser interface for Pulse: live push-to-talk capture, the speaker-tagged transcript, the
probability path with momentum and turning points, counterfactual replay, the end-of-call
summary and Replay mode. The product is specified in [`../SPEC.md`](../SPEC.md); how to run
the whole system is in the [repository README](../README.md).

The interface computes no model output. Transcripts, probabilities, momentum, turning points,
counterfactual paths and summaries all come from the local Pulse server over the contract in
`src/types/contract.ts`; the interface only lays them out.

## Commands

Requires Node 20.19+ (or 22.12+).

```bash
npm ci              # install exact dependency versions
npm run build       # type-check and build into dist/ — the Pulse server serves this
npm run dev         # development server on :5173, proxying to the Pulse server on :8000
npm run typecheck   # strict TypeScript, application and tests
npm run lint        # oxlint
npm test            # unit tests (Vitest)
```

`npm run dev` expects `uv run pulse-serve` to be running. Set `PULSE_BACKEND` to proxy to a
server elsewhere than `http://127.0.0.1:8000`.

## Controls

| Action | How |
| --- | --- |
| Speak a turn | Hold **F** for the dealer or **J** for the customer (or hold the on-screen button) while speaking; release to send. One speaker at a time; the other key is ignored while one is held. |
| Type a turn | Type in *or type a turn*, choose Dealer or Customer, press **Enter**. Same pipeline, without transcription. |
| Undo last turn | Removes the most recent turn, e.g. after pressing the wrong key. |
| Inspect a turn | Hover the chart, or focus it and use **←/→**, **Home**, **End**. |
| Counterfactual replay | Select a transcript turn or a chart point. Select it again, or press **Esc**, to return. |
| End the call | **End call** (or **Summary** in the header) shows the summary card; the call can then be saved. |
| Replay mode | **Replay** in the header. Pick a saved session, then play, step or change speed. |
| Latency overlay | Press **L** to show per-stage timings (hidden by default). |

The microphone is requested when the page loads, so the permission prompt never interrupts a
turn. Presses shorter than 0.3 s are discarded as accidental, and recording continues for a
fraction of a second after release so the last word is not clipped.

## Structure

```
src/
  types/pulse.ts          domain types used by the interface (camelCase)
  types/contract.ts       wire types for the WebSocket and REST contract (snake_case, SPEC §5.4–5.5)
  services/
    pulseService.ts       PulseService and LiveSession interfaces — the boundary components use
    apiService.ts         PulseApiService: REST + one WebSocket per call to the local server
    contractMapping.ts    wire ⇄ domain conversion
    recorder.ts           MediaRecorder-based push-to-talk capture
  state/liveSession.ts    live-call state machine (pure reducer)
  hooks/                  useLiveSession, usePlayback, useKeyboardPushToTalk, useElementSize
  components/             header, transcript, SVG chart, readouts, controls, latency overlay
  styles/tokens.css       colour, type and spacing tokens
```

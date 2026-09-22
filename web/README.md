# Pulse — web interface

Browser interface for Pulse: a turn-by-turn estimate of the probability that a two-person
sales conversation ends in a close, with momentum, turning points and counterfactual replay.
The product is specified in [`../SPEC.md`](../SPEC.md).

This package is the interface only. Until the FastAPI backend exists it runs against an
in-browser mock service, so every screen and state can be exercised without a model.

> **The numbers shown are not model output.** The mock service scores turns with a small
> keyword heuristic so that the interface has something to draw. It is not trained,
> calibrated or evaluated, and its values must not be reported as results. The header shows
> a **Mock model** badge whenever it is in use.

## Commands

Requires Node 20.19+ (or 22.12+).

```bash
npm ci              # install exact dependency versions
npm run dev         # development server at http://localhost:5173
npm run typecheck   # strict TypeScript, application and tests
npm run lint        # oxlint
npm test            # unit tests (Vitest)
npm run build       # type-check and production build into dist/
npm run preview     # serve the production build
```

## Using the interface

| Action | How |
| --- | --- |
| Speak a turn | Hold **F** for the dealer or **J** for the customer, or hold the on-screen button. One speaker at a time; the other key is ignored while one is held. |
| Type a turn | Type in *or type a turn*, choose Dealer or Customer, press **Enter**. Same pipeline as speech, without transcription. |
| Inspect a turn | Hover the chart, or focus it and use **←/→**, **Home**, **End**. |
| Counterfactual replay | Select a transcript turn or a chart point. Select it again, or press **Esc**, to return. |
| End the call | **End call** (or **Summary** in the header) shows the summary card; the call can then be saved. |
| Replay mode | **Replay** in the header. Pick a saved session, then play, step or change speed. |

The interface moves through six explicit states, shown in the header: *Idle*, *Listening*,
*Transcribing*, *Updating*, *Replaying* and *Summary*. New turns are blocked while one is
being transcribed or scored.

With the mock service, spoken turns take their text from the recovery scenario in
`src/data/demoScripts.ts`, in order per speaker. Holding F, J, J, F reproduces the live part
of the demo: interest, a price objection (a turning point), then a recovery. Replay mode
lists three scenarios — a successful close, a lost deal and a recovery — plus any call saved
during the session.

## Structure

```
src/
  types/pulse.ts          domain types used by the interface (camelCase)
  types/contract.ts       wire types for the WebSocket and REST contract (snake_case, SPEC §5.4–5.5)
  services/
    pulseService.ts       PulseService and LiveSession interfaces — the only boundary components use
    contractMapping.ts    wire ⇄ domain conversion for a real API client
    recorder.ts           Recorder interface and the simulated recorder
    index.ts              createRuntime(): chooses the service and recorder
    mock/                 MockPulseService and the placeholder scoring heuristic
  state/liveSession.ts    live-call state machine (pure reducer)
  hooks/                  useLiveSession, usePlayback, useKeyboardPushToTalk, useElementSize
  components/             header, transcript, SVG chart, readouts, controls
  data/demoScripts.ts     scenario transcripts for the mock service
  styles/tokens.css       colour, type and spacing tokens
```

The interface never computes model outputs. Probability, momentum, turning points, the
counterfactual path and the summary all arrive from the service and are displayed as
received. The only arithmetic in the interface is layout.

## Connecting the backend

Everything above the `PulseService` interface stays unchanged. To switch from the mock:

1. **Implement `PulseApiService`** in `src/services/` against `PulseService`. REST paths are
   in `ROUTES` (`src/types/contract.ts`); convert payloads with the functions in
   `contractMapping.ts`. `startSession()` should `POST /session`, open
   `/ws/session/{id}`, and return a `LiveSession` that maps each server message with
   `fromWireServerMessage`.
2. **Implement a microphone recorder** with `MediaRecorder` behind the `Recorder` interface.
3. **Select both in `createRuntime()`** (`src/services/index.ts`).

Points to confirm with the backend when it is built:

- **Audio framing.** `turn_audio` is sent as a JSON envelope followed by one binary frame
  (`WireClientMessage` in `contract.ts`). This is a proposal.
- **Saved-session summary.** `GET /sessions/{name}` is expected to include `summary`, which
  extends SPEC §5.5 so that Replay mode needs no further request.
- **Counterfactual path.** `path` covers turns 1…T of the replay, with the masked turn
  carrying the previous value (p′ₖ = p′ₖ₋₁). `delta_T` is p_T − p′_T.
- **Counterfactuals in Replay mode.** There is no endpoint for replaying a saved session, so
  counterfactual replay is available during a live call only.
- **Base rate and τ.** The mock uses 0.40 and 0.20 as placeholders. The real values come
  from `POST /session`.

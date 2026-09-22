import type {
  Counterfactual,
  Estimate,
  Health,
  ProcessingState,
  SavedSession,
  SavedSessionRef,
  SessionInfo,
  Speaker,
  Summary,
  Turn,
} from '../types/pulse'

/** Events pushed by the backend during a live call. Mirrors the server → client WebSocket messages. */
export type SessionEvent =
  | { type: 'status'; state: ProcessingState }
  | { type: 'turn'; turn: Turn }
  | { type: 'estimate'; estimate: Estimate }
  | { type: 'error'; stage: string; message: string }

export type SessionListener = (event: SessionEvent) => void

/**
 * A live call. Mirrors the client → server WebSocket messages:
 * `sendAudio` → `turn_audio`, `sendText` → `turn_text`, `endCall` → `end_call`.
 */
export interface LiveSession {
  readonly info: SessionInfo
  subscribe(listener: SessionListener): () => void
  sendAudio(speaker: Speaker, audio: Blob): void
  sendText(speaker: Speaker, text: string): void
  endCall(): void
  close(): void
}

/**
 * Everything the interface needs from the backend. Implemented by `PulseApiService`, which
 * speaks the contract in `types/contract.ts` to the local FastAPI server.
 */
export interface PulseService {
  health(): Promise<Health>
  startSession(): Promise<LiveSession>
  counterfactual(sessionId: string, maskedTurn: number): Promise<Counterfactual>
  summary(sessionId: string): Promise<Summary>
  /** Removes the most recent turn (wrong button pressed); resolves with the remaining turn count. */
  deleteLastTurn(sessionId: string): Promise<number>
  saveSession(sessionId: string): Promise<SavedSessionRef>
  listSessions(): Promise<SavedSessionRef[]>
  loadSession(name: string): Promise<SavedSession>
}

/**
 * Domain types used by the Pulse interface.
 *
 * Components depend only on these types. Wire formats exchanged with the
 * backend live in `contract.ts` and are converted in `services/contractMapping.ts`.
 */

/** Speaker identity. Determined by which push-to-talk control was held — never inferred from audio. */
export type Speaker = 'dealer' | 'customer'

/**
 * Interface phase.
 *
 * Live flow:        idle → listening → transcribing → updating → idle
 * Typed turn:       idle → updating → idle
 * Counterfactual:   idle → replaying → idle
 * End of call:      idle → summary
 */
export type Phase = 'idle' | 'listening' | 'transcribing' | 'updating' | 'replaying' | 'summary'

/** Processing state reported by the backend over the live channel. */
export type ProcessingState = 'transcribing' | 'updating' | 'idle'

/** Returned when a session is created. `baseRate` is π̂ (the anchor p_0); `tau` is the turning-point threshold. */
export interface SessionInfo {
  id: string
  baseRate: number
  tau: number
}

/** One turn of the conversation. `t` is 1-based. */
export interface Turn {
  t: number
  speaker: Speaker
  text: string
}

/** Per-stage processing time for one turn. `asrMs` is null for typed turns, which skip transcription. */
export interface StageTimings {
  asrMs: number | null
  encodeMs: number
  modelMs: number
  totalMs: number
}

/**
 * The model's output after turn `t`.
 * `probability` is p_t; `momentum` is m_t = p_t − p_(t−1), with p_0 = base rate.
 * `turningPoint` is decided by the backend (|m_t| ≥ τ) — the interface never recomputes it.
 */
export interface Estimate {
  t: number
  probability: number
  momentum: number
  turningPoint: boolean
  timings: StageTimings
}

/**
 * Counterfactual replay result: the same conversation re-evaluated with one turn masked.
 *
 * `path` is aligned to turn indices 1…T. Entries before the masked turn equal the real
 * path; the entry at the masked turn equals the entry before it, because a removed turn
 * contributes nothing. `deltaT` is δ_k = p_T − p′_T, the masked turn's effect on the
 * final estimate.
 */
export interface Counterfactual {
  maskedTurn: number
  path: number[]
  deltaT: number
}

/** One of the largest movements of a call, quoted in the summary. */
export interface MovementHighlight {
  t: number
  speaker: Speaker
  text: string
  momentum: number
}

/** End-of-call summary. Built by the backend from values already computed during the call. */
export interface Summary {
  finalProbability: number
  baseRate: number
  /** p_T − π̂. Equals the sum of every m_t. */
  totalMovement: number
  /** Up to three turns with the largest |m_t|, largest first. */
  largestMovements: MovementHighlight[]
  /** Dealer share of turns, 0–1. */
  dealerTurnShare: number
  /** Dealer share of words, 0–1. */
  dealerWordShare: number
  turningPointCount: number
  turnCount: number
}

/** A saved session as listed in Replay mode. */
export interface SavedSessionRef {
  name: string
  title: string
  turnCount: number
  savedAt: string
}

/** A saved session, replayed from stored values without re-running transcription or the model. */
export interface SavedSession {
  name: string
  title: string
  description: string | null
  artefactVersion: string
  baseRate: number
  tau: number
  turns: Turn[]
  estimates: Estimate[]
  summary: Summary
}

/** Backend health. `modelKind` tells the interface whether estimates come from the trained artefact. */
export interface Health {
  status: 'ok' | 'degraded'
  modelKind: 'mock' | 'trained'
  artefactVersion: string
}

/**
 * Live-call state machine.
 *
 *   idle ──hold──▶ listening ──release──▶ transcribing ──▶ updating ──▶ idle
 *   idle ──type───────────────────────────────────────▶ updating ──▶ idle
 *   idle ──select turn──▶ replaying ──dismiss──▶ idle
 *   idle ──end call──▶ summary
 *
 * A pure reducer: the hook in `hooks/useLiveSession.ts` performs the side effects.
 * Server-reported estimates, turning points and summaries are stored as received — the
 * interface never recomputes model outputs.
 */
import type { SessionEvent } from '../services/pulseService'
import type { Counterfactual, Estimate, Phase, SessionInfo, Speaker, Summary, Turn } from '../types/pulse'

export interface CounterfactualView {
  turn: number
  status: 'loading' | 'ready' | 'error'
  result: Counterfactual | null
  error: string | null
}

export interface Notice {
  id: number
  kind: 'error' | 'info'
  message: string
}

export interface LiveState {
  phase: Phase
  session: SessionInfo | null
  connection: 'connecting' | 'ready' | 'failed'
  turns: Turn[]
  estimates: Estimate[]
  /** Speaker whose push-to-talk control is held. */
  recordingSpeaker: Speaker | null
  /** Speaker of a turn sent but not yet returned by the backend. */
  pendingSpeaker: Speaker | null
  counterfactual: CounterfactualView | null
  summary: Summary | null
  summaryStatus: 'idle' | 'loading' | 'ready' | 'error'
  callEnded: boolean
  notice: Notice | null
}

export const initialLiveState: LiveState = {
  phase: 'idle',
  session: null,
  connection: 'connecting',
  turns: [],
  estimates: [],
  recordingSpeaker: null,
  pendingSpeaker: null,
  counterfactual: null,
  summary: null,
  summaryStatus: 'idle',
  callEnded: false,
  notice: null,
}

export type LiveAction =
  | { type: 'reset' }
  | { type: 'session-started'; session: SessionInfo }
  | { type: 'session-failed'; message: string }
  | { type: 'recording-started'; speaker: Speaker }
  | { type: 'recording-stopped' }
  | { type: 'recording-cancelled' }
  | { type: 'text-submitted'; speaker: Speaker }
  | { type: 'server-event'; event: SessionEvent }
  | { type: 'turn-failed'; message: string }
  | { type: 'counterfactual-requested'; turn: number }
  | { type: 'counterfactual-loaded'; sessionId: string; result: Counterfactual }
  | { type: 'counterfactual-failed'; sessionId: string; turn: number; message: string }
  | { type: 'counterfactual-dismissed' }
  | { type: 'call-ended' }
  | { type: 'summary-loaded'; sessionId: string; summary: Summary }
  | { type: 'summary-failed'; sessionId: string; message: string }
  | { type: 'notice'; kind: Notice['kind']; message: string }
  | { type: 'notice-dismissed' }

/** A new turn may start from idle, or from a counterfactual view (which it dismisses). */
export function canStartTurn(state: LiveState): boolean {
  return state.session !== null && !state.callEnded && (state.phase === 'idle' || state.phase === 'replaying')
}

export function isProcessing(state: LiveState): boolean {
  return state.phase === 'transcribing' || state.phase === 'updating'
}

export function canEndCall(state: LiveState): boolean {
  return canStartTurn(state) && state.estimates.length > 0
}

/** What selecting a turn should do: open its counterfactual, close it (second click), or nothing. */
export function selectionIntent(state: LiveState, turn: number): 'request' | 'dismiss' | 'ignore' {
  if (state.counterfactual?.turn === turn && state.phase === 'replaying') return 'dismiss'
  const scored = state.estimates.some((estimate) => estimate.t === turn)
  if (!scored || state.callEnded || (state.phase !== 'idle' && state.phase !== 'replaying')) return 'ignore'
  return 'request'
}

let noticeSequence = 0

function withNotice(state: LiveState, kind: Notice['kind'], message: string): LiveState {
  noticeSequence += 1
  return { ...state, notice: { id: noticeSequence, kind, message } }
}

function upsertByTurn<T extends { t: number }>(items: readonly T[], item: T): T[] {
  const others = items.filter((existing) => existing.t !== item.t)
  return [...others, item].sort((a, b) => a.t - b.t)
}

function applyServerEvent(state: LiveState, event: SessionEvent): LiveState {
  switch (event.type) {
    case 'status': {
      if (!isProcessing(state)) return state
      if (event.state === 'idle') return { ...state, phase: 'idle', pendingSpeaker: null }
      return { ...state, phase: event.state }
    }
    case 'turn':
      return { ...state, turns: upsertByTurn(state.turns, event.turn), pendingSpeaker: null }
    case 'estimate':
      return { ...state, estimates: upsertByTurn(state.estimates, event.estimate) }
    case 'error': {
      const next = isProcessing(state) ? { ...state, phase: 'idle' as const, pendingSpeaker: null } : state
      return withNotice(next, 'error', event.message)
    }
  }
}

export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'reset':
      return initialLiveState

    case 'session-started':
      return { ...initialLiveState, session: action.session, connection: 'ready' }

    case 'session-failed':
      return withNotice({ ...state, connection: 'failed' }, 'error', action.message)

    case 'recording-started':
      if (!canStartTurn(state)) return state
      return { ...state, phase: 'listening', recordingSpeaker: action.speaker, counterfactual: null }

    case 'recording-stopped':
      if (state.phase !== 'listening') return state
      return { ...state, phase: 'transcribing', pendingSpeaker: state.recordingSpeaker, recordingSpeaker: null }

    case 'recording-cancelled':
      if (state.phase !== 'listening') return state
      return { ...state, phase: 'idle', recordingSpeaker: null }

    case 'text-submitted':
      if (!canStartTurn(state)) return state
      return { ...state, phase: 'updating', pendingSpeaker: action.speaker, counterfactual: null }

    case 'server-event':
      return applyServerEvent(state, action.event)

    case 'turn-failed': {
      const next = isProcessing(state) ? { ...state, phase: 'idle' as const, pendingSpeaker: null } : state
      return withNotice(next, 'error', action.message)
    }

    case 'counterfactual-requested':
      if (selectionIntent(state, action.turn) !== 'request') return state
      return {
        ...state,
        phase: 'replaying',
        counterfactual: { turn: action.turn, status: 'loading', result: null, error: null },
      }

    case 'counterfactual-loaded':
      if (state.session?.id !== action.sessionId || state.counterfactual?.turn !== action.result.maskedTurn) return state
      return { ...state, counterfactual: { ...state.counterfactual, status: 'ready', result: action.result } }

    case 'counterfactual-failed':
      if (state.session?.id !== action.sessionId || state.counterfactual?.turn !== action.turn) return state
      return { ...state, counterfactual: { ...state.counterfactual, status: 'error', error: action.message } }

    case 'counterfactual-dismissed':
      if (state.phase !== 'replaying') return state
      return { ...state, phase: 'idle', counterfactual: null }

    case 'call-ended':
      if (!canEndCall(state)) return state
      return { ...state, phase: 'summary', callEnded: true, counterfactual: null, summaryStatus: 'loading' }

    case 'summary-loaded':
      if (state.session?.id !== action.sessionId) return state
      return { ...state, summary: action.summary, summaryStatus: 'ready' }

    case 'summary-failed':
      if (state.session?.id !== action.sessionId) return state
      return withNotice({ ...state, summaryStatus: 'error' }, 'error', action.message)

    case 'notice':
      return withNotice(state, action.kind, action.message)

    case 'notice-dismissed':
      return { ...state, notice: null }
  }
}

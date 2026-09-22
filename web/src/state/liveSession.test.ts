import { describe, expect, it } from 'vitest'
import type { Estimate, SessionInfo } from '../types/pulse'
import {
  canEndCall,
  canStartTurn,
  initialLiveState,
  liveReducer,
  selectionIntent,
  type LiveAction,
  type LiveState,
} from './liveSession'

const SESSION: SessionInfo = { id: 's1', baseRate: 0.4, tau: 0.2 }

function estimate(t: number, probability: number, momentum: number, turningPoint = false): Estimate {
  return { t, probability, momentum, turningPoint, timings: { asrMs: null, encodeMs: 1, modelMs: 1, totalMs: 2 } }
}

function run(actions: LiveAction[], from: LiveState = initialLiveState): LiveState {
  return actions.reduce(liveReducer, from)
}

const started = run([{ type: 'session-started', session: SESSION }])

/** A session with two scored turns, idle. */
const twoTurns = run(
  [
    { type: 'text-submitted', speaker: 'dealer' },
    { type: 'server-event', event: { type: 'turn', turn: { t: 1, speaker: 'dealer', text: 'Hello' } } },
    { type: 'server-event', event: { type: 'estimate', estimate: estimate(1, 0.4, 0) } },
    { type: 'server-event', event: { type: 'status', state: 'idle' } },
    { type: 'text-submitted', speaker: 'customer' },
    { type: 'server-event', event: { type: 'turn', turn: { t: 2, speaker: 'customer', text: 'Too expensive' } } },
    { type: 'server-event', event: { type: 'estimate', estimate: estimate(2, 0.15, -0.25, true) } },
    { type: 'server-event', event: { type: 'status', state: 'idle' } },
  ],
  started,
)

describe('live session — push-to-talk flow', () => {
  it('moves idle → listening → transcribing → updating → idle', () => {
    const listening = liveReducer(started, { type: 'recording-started', speaker: 'dealer' })
    expect(listening.phase).toBe('listening')
    expect(listening.recordingSpeaker).toBe('dealer')

    const transcribing = liveReducer(listening, { type: 'recording-stopped' })
    expect(transcribing.phase).toBe('transcribing')
    expect(transcribing.pendingSpeaker).toBe('dealer')

    const updating = run(
      [
        { type: 'server-event', event: { type: 'turn', turn: { t: 1, speaker: 'dealer', text: 'Hi' } } },
        { type: 'server-event', event: { type: 'status', state: 'updating' } },
      ],
      transcribing,
    )
    expect(updating.phase).toBe('updating')
    expect(updating.turns).toHaveLength(1)

    const idle = run(
      [
        { type: 'server-event', event: { type: 'estimate', estimate: estimate(1, 0.4, 0) } },
        { type: 'server-event', event: { type: 'status', state: 'idle' } },
      ],
      updating,
    )
    expect(idle.phase).toBe('idle')
    expect(idle.estimates).toHaveLength(1)
    expect(idle.pendingSpeaker).toBeNull()
  })

  it('ignores a second speaker while one is recording', () => {
    const listening = liveReducer(started, { type: 'recording-started', speaker: 'dealer' })
    const next = liveReducer(listening, { type: 'recording-started', speaker: 'customer' })
    expect(next).toBe(listening)
  })

  it('blocks new turns while a turn is being processed', () => {
    const updating = liveReducer(started, { type: 'text-submitted', speaker: 'dealer' })
    expect(updating.phase).toBe('updating')
    expect(liveReducer(updating, { type: 'recording-started', speaker: 'customer' })).toBe(updating)
    expect(liveReducer(updating, { type: 'text-submitted', speaker: 'customer' })).toBe(updating)
  })

  it('does not start a turn before a session exists', () => {
    expect(canStartTurn(initialLiveState)).toBe(false)
    expect(liveReducer(initialLiveState, { type: 'recording-started', speaker: 'dealer' })).toBe(initialLiveState)
  })

  it('returns to idle and raises a notice when the backend reports an error mid-turn', () => {
    const transcribing = run(
      [{ type: 'recording-started', speaker: 'customer' }, { type: 'recording-stopped' }],
      started,
    )
    const failed = liveReducer(transcribing, {
      type: 'server-event',
      event: { type: 'error', stage: 'asr', message: 'Transcription failed' },
    })
    expect(failed.phase).toBe('idle')
    expect(failed.notice?.message).toBe('Transcription failed')
  })

  it('stores estimates exactly as the backend reports them', () => {
    const turning = twoTurns.estimates.find((item) => item.t === 2)
    expect(turning).toMatchObject({ probability: 0.15, momentum: -0.25, turningPoint: true })
  })
})

describe('live session — counterfactual replay', () => {
  it('enters replaying on selecting a scored turn and leaves it on dismiss', () => {
    expect(selectionIntent(twoTurns, 2)).toBe('request')
    const replaying = liveReducer(twoTurns, { type: 'counterfactual-requested', turn: 2 })
    expect(replaying.phase).toBe('replaying')
    expect(replaying.counterfactual).toMatchObject({ turn: 2, status: 'loading' })

    const dismissed = liveReducer(replaying, { type: 'counterfactual-dismissed' })
    expect(dismissed.phase).toBe('idle')
    expect(dismissed.counterfactual).toBeNull()
  })

  it('treats a second click on the same turn as dismiss', () => {
    const replaying = liveReducer(twoTurns, { type: 'counterfactual-requested', turn: 2 })
    expect(selectionIntent(replaying, 2)).toBe('dismiss')
    expect(selectionIntent(replaying, 1)).toBe('request')
  })

  it('ignores turns that have no estimate yet', () => {
    expect(selectionIntent(twoTurns, 3)).toBe('ignore')
  })

  it('applies a result only for the turn and session it was requested for', () => {
    const replaying = liveReducer(twoTurns, { type: 'counterfactual-requested', turn: 2 })
    const stale = liveReducer(replaying, {
      type: 'counterfactual-loaded',
      sessionId: 's1',
      result: { maskedTurn: 1, path: [0.4, 0.2], deltaT: 0.1 },
    })
    expect(stale).toBe(replaying)

    const otherSession = liveReducer(replaying, {
      type: 'counterfactual-loaded',
      sessionId: 'old',
      result: { maskedTurn: 2, path: [0.4, 0.4], deltaT: -0.25 },
    })
    expect(otherSession).toBe(replaying)

    const loaded = liveReducer(replaying, {
      type: 'counterfactual-loaded',
      sessionId: 's1',
      result: { maskedTurn: 2, path: [0.4, 0.4], deltaT: -0.25 },
    })
    expect(loaded.counterfactual).toMatchObject({ status: 'ready', result: { deltaT: -0.25 } })
  })

  it('lets a new turn start from replaying, dismissing the replay', () => {
    const replaying = liveReducer(twoTurns, { type: 'counterfactual-requested', turn: 2 })
    const listening = liveReducer(replaying, { type: 'recording-started', speaker: 'dealer' })
    expect(listening.phase).toBe('listening')
    expect(listening.counterfactual).toBeNull()
  })
})

describe('live session — end of call', () => {
  it('cannot end a call before any turn is scored', () => {
    expect(canEndCall(started)).toBe(false)
    expect(liveReducer(started, { type: 'call-ended' })).toBe(started)
  })

  it('moves to summary and stops accepting turns', () => {
    const summary = liveReducer(twoTurns, { type: 'call-ended' })
    expect(summary.phase).toBe('summary')
    expect(summary.callEnded).toBe(true)
    expect(summary.summaryStatus).toBe('loading')
    expect(canStartTurn(summary)).toBe(false)
    expect(selectionIntent(summary, 1)).toBe('ignore')
  })

  it('stores the summary only for the current session', () => {
    const summary = liveReducer(twoTurns, { type: 'call-ended' })
    const payload = {
      finalProbability: 0.15,
      baseRate: 0.4,
      totalMovement: -0.25,
      largestMovements: [],
      dealerTurnShare: 0.5,
      dealerWordShare: 0.5,
      turningPointCount: 1,
      turnCount: 2,
    }
    expect(liveReducer(summary, { type: 'summary-loaded', sessionId: 'old', summary: payload })).toBe(summary)
    expect(liveReducer(summary, { type: 'summary-loaded', sessionId: 's1', summary: payload }).summaryStatus).toBe('ready')
  })
})

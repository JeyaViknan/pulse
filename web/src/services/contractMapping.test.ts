import { describe, expect, it } from 'vitest'
import type { WireSavedSession } from '../types/contract'
import {
  fromWireCounterfactual,
  fromWireSavedSession,
  fromWireServerMessage,
  fromWireSession,
  toWireAudioEnvelope,
  toWireTextMessage,
} from './contractMapping'

describe('contract mapping', () => {
  it('maps the session response', () => {
    expect(fromWireSession({ id: 'abc', base_rate: 0.38, tau: 0.15 })).toEqual({ id: 'abc', baseRate: 0.38, tau: 0.15 })
  })

  it('maps an estimate message, keeping the backend turning-point decision', () => {
    const event = fromWireServerMessage({
      type: 'estimate',
      t: 4,
      p: 0.31,
      m: -0.21,
      turning_point: true,
      timings_ms: { asr: 640, encode: 18, model: 4, total: 662 },
    })
    expect(event).toEqual({
      type: 'estimate',
      estimate: {
        t: 4,
        probability: 0.31,
        momentum: -0.21,
        turningPoint: true,
        timings: { asrMs: 640, encodeMs: 18, modelMs: 4, totalMs: 662 },
      },
    })
  })

  it('maps status, turn and error messages', () => {
    expect(fromWireServerMessage({ type: 'status', state: 'transcribing' })).toEqual({ type: 'status', state: 'transcribing' })
    expect(fromWireServerMessage({ type: 'turn', t: 1, speaker: 'customer', text: 'Hi' })).toEqual({
      type: 'turn',
      turn: { t: 1, speaker: 'customer', text: 'Hi' },
    })
    expect(fromWireServerMessage({ type: 'error', stage: 'asr', message: 'x' })).toEqual({
      type: 'error',
      stage: 'asr',
      message: 'x',
    })
  })

  it('builds client messages', () => {
    expect(toWireTextMessage('dealer', 'Hello')).toEqual({ type: 'turn_text', speaker: 'dealer', text: 'Hello' })
    expect(toWireAudioEnvelope('customer', new Blob([], { type: 'audio/wav' }))).toEqual({
      type: 'turn_audio',
      speaker: 'customer',
      mime_type: 'audio/wav',
    })
  })

  it('maps a counterfactual response', () => {
    expect(fromWireCounterfactual(3, { path: [0.4, 0.58, 0.58], delta_T: -0.27 })).toEqual({
      maskedTurn: 3,
      path: [0.4, 0.58, 0.58],
      deltaT: -0.27,
    })
  })

  it('maps a saved session into turns, estimates and summary', () => {
    const wire: WireSavedSession = {
      name: 'call-1',
      title: 'Call',
      description: null,
      artefact_version: 'pulse_v1',
      base_rate: 0.4,
      tau: 0.2,
      turns: [
        {
          t: 1,
          speaker: 'dealer',
          text: 'Hello',
          p: 0.4,
          m: 0,
          turning_point: false,
          timings_ms: { asr: null, encode: 10, model: 2, total: 12 },
        },
      ],
      summary: {
        final_p: 0.4,
        base_rate: 0.4,
        total_movement: 0,
        largest_movements: [],
        dealer_turn_share: 1,
        dealer_word_share: 1,
        turning_points: 0,
        turn_count: 1,
      },
    }
    const session = fromWireSavedSession(wire)
    expect(session.turns).toEqual([{ t: 1, speaker: 'dealer', text: 'Hello' }])
    expect(session.estimates[0]).toMatchObject({ t: 1, probability: 0.4, turningPoint: false })
    expect(session.summary).toMatchObject({ finalProbability: 0.4, turnCount: 1, turningPointCount: 0 })
  })
})

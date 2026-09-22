import { describe, expect, it } from 'vitest'
import type { Turn } from '../../types/pulse'
import { counterfactualPath, probabilityPath, summarise, toEstimates, turnEffect } from './mockModel'

const BASE = 0.4
const TAU = 0.2
const noTimings = () => ({ asrMs: null, encodeMs: 0, modelMs: 0, totalMs: 0 })

const turns: Turn[] = [
  { t: 1, speaker: 'dealer', text: 'Thanks for your time today.' },
  { t: 2, speaker: 'customer', text: "Sure, I'm interested." },
  { t: 3, speaker: 'customer', text: "That's more than we expected." },
  { t: 4, speaker: 'dealer', text: 'What if we started with a pilot?' },
  { t: 5, speaker: 'customer', text: 'That could work.' },
]

describe('mock model', () => {
  it('is causal: the estimate after turn t ignores every later turn', () => {
    const real = probabilityPath(turns, BASE)
    const alteredFuture = turns.map((turn) =>
      turn.t > 2 ? { ...turn, text: 'Not interested, no thanks. Too expensive.' } : turn,
    )
    const altered = probabilityPath(alteredFuture, BASE)
    expect(altered.slice(0, 2)).toEqual(real.slice(0, 2))
    expect(altered[2]).not.toBe(real[2])
  })

  it('stays at the base rate for a turn with no cues', () => {
    expect(turnEffect({ speaker: 'dealer', text: 'Thanks for your time today.' })).toBe(0)
    expect(probabilityPath([turns[0]!], BASE)[0]).toBeCloseTo(BASE, 10)
  })

  it('scores objections down and interest up', () => {
    expect(turnEffect({ speaker: 'customer', text: "That's more than we expected." })).toBeLessThan(0)
    expect(turnEffect({ speaker: 'customer', text: "I'm interested." })).toBeGreaterThan(0)
  })

  it('derives momentum from the base rate and flags turning points by τ', () => {
    const estimates = toEstimates(probabilityPath(turns, BASE), BASE, TAU, noTimings)
    expect(estimates[0]?.momentum).toBeCloseTo(estimates[0]!.probability - BASE, 10)
    for (const [index, estimate] of estimates.entries()) {
      const previous = index === 0 ? BASE : estimates[index - 1]!.probability
      expect(estimate.momentum).toBeCloseTo(estimate.probability - previous, 10)
      expect(estimate.turningPoint).toBe(Math.abs(estimate.momentum) >= TAU)
    }
  })

  it('momentum sums exactly to p_T − π̂', () => {
    const estimates = toEstimates(probabilityPath(turns, BASE), BASE, TAU, noTimings)
    const total = estimates.reduce((sum, estimate) => sum + estimate.momentum, 0)
    expect(total).toBeCloseTo(estimates.at(-1)!.probability - BASE, 10)
  })

  it('counterfactual path matches before the masked turn and holds flat at it', () => {
    const real = probabilityPath(turns, BASE)
    const ghost = counterfactualPath(turns, BASE, 3)
    expect(ghost.slice(0, 2)).toEqual(real.slice(0, 2))
    expect(ghost[2]).toBeCloseTo(ghost[1]!, 10)
    expect(ghost.at(-1)).toBeGreaterThan(real.at(-1)!)
  })

  it('summarises the three largest movements and speaker shares', () => {
    const estimates = toEstimates(probabilityPath(turns, BASE), BASE, TAU, noTimings)
    const summary = summarise(turns, estimates, BASE)
    expect(summary.turnCount).toBe(5)
    expect(summary.largestMovements).toHaveLength(3)
    const magnitudes = summary.largestMovements.map((movement) => Math.abs(movement.momentum))
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a))
    expect(summary.dealerTurnShare).toBeCloseTo(2 / 5, 10)
    expect(summary.totalMovement).toBeCloseTo(summary.finalProbability - BASE, 10)
    expect(summary.turningPointCount).toBe(estimates.filter((estimate) => estimate.turningPoint).length)
  })
})

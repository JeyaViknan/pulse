import { describe, expect, it } from 'vitest'
import { counterfactualPath, probabilityPath, toEstimates } from '../services/mock/mockModel'
import type { Turn } from '../types/pulse'
import { LIVE_DEMO_SCRIPT, LOST_DEAL, RECOVERY, SUCCESSFUL_CLOSE, type DemoScript } from './demoScripts'

const BASE = 0.4
const TAU = 0.2

function score(script: DemoScript) {
  const turns: Turn[] = script.turns.map((turn, index) => ({ t: index + 1, ...turn }))
  const estimates = toEstimates(probabilityPath(turns, BASE), BASE, TAU, () => ({
    asrMs: null,
    encodeMs: 0,
    modelMs: 0,
    totalMs: 0,
  }))
  return { turns, estimates }
}

/** These scenarios exist to demonstrate specific interface behaviour; guard their shapes. */
describe('demo scenarios', () => {
  it('A — successful close rises to a high estimate through at least one upward turning point', () => {
    const { estimates } = score(SUCCESSFUL_CLOSE)
    const final = estimates.at(-1)!.probability
    expect(final).toBeGreaterThan(BASE + 0.4)
    expect(estimates.some((estimate) => estimate.turningPoint && estimate.momentum > 0)).toBe(true)
    expect(estimates.some((estimate) => estimate.turningPoint && estimate.momentum < 0)).toBe(false)
  })

  it('B — lost deal falls well below the base rate after a downward turning point', () => {
    const { estimates } = score(LOST_DEAL)
    expect(estimates.at(-1)!.probability).toBeLessThan(BASE - 0.25)
    const drop = estimates.find((estimate) => estimate.turningPoint && estimate.momentum < 0)
    expect(drop).toBeDefined()
    expect(estimates.slice(drop!.t).every((estimate) => estimate.probability < BASE)).toBe(true)
  })

  it('C — recovery drops sharply, then recovers above the base rate', () => {
    const { estimates } = score(RECOVERY)
    const drop = estimates.find((estimate) => estimate.turningPoint && estimate.momentum < 0)
    const recovery = estimates.find((estimate) => estimate.turningPoint && estimate.momentum > 0)
    expect(drop).toBeDefined()
    expect(recovery).toBeDefined()
    expect(recovery!.t).toBeGreaterThan(drop!.t)
    expect(estimates.at(-1)!.probability).toBeGreaterThan(BASE)
  })

  it('live demo flow (Dealer, Customer, Customer, Dealer): objection is the turning point, then partial recovery', () => {
    const order = ['dealer', 'customer', 'customer', 'dealer'] as const
    const queues = {
      dealer: LIVE_DEMO_SCRIPT.turns.filter((turn) => turn.speaker === 'dealer').map((turn) => turn.text),
      customer: LIVE_DEMO_SCRIPT.turns.filter((turn) => turn.speaker === 'customer').map((turn) => turn.text),
    }
    const turns: Turn[] = order.map((speaker, index) => ({ t: index + 1, speaker, text: queues[speaker].shift()! }))
    const estimates = toEstimates(probabilityPath(turns, BASE), BASE, TAU, () => ({
      asrMs: null,
      encodeMs: 0,
      modelMs: 0,
      totalMs: 0,
    }))

    const [, interest, objection, response] = estimates
    expect(interest!.momentum).toBeGreaterThan(0)
    expect(objection!.turningPoint).toBe(true)
    expect(objection!.momentum).toBeLessThan(0)
    expect(response!.probability).toBeGreaterThan(objection!.probability)
    expect(response!.probability).toBeLessThan(interest!.probability)

    const ghost = counterfactualPath(turns, BASE, 3)
    expect(ghost.at(-1)!).toBeGreaterThan(response!.probability)
  })
})

import { describe, expect, it } from 'vitest'
import { MIN_TURN_SPAN, nearestTurn, plotArea, scaleX, scaleY, separateLabels, turnSpan, xTicks } from './chartGeometry'

const plot = plotArea(800, 400, { top: 20, right: 60, bottom: 40, left: 40 })

describe('chart geometry', () => {
  it('spans at least the minimum number of turns', () => {
    expect(turnSpan(2)).toBe(MIN_TURN_SPAN)
    expect(turnSpan(15)).toBe(15)
  })

  it('maps probability 1 to the top and 0 to the bottom, clamping outside values', () => {
    expect(scaleY(1, plot)).toBe(plot.top)
    expect(scaleY(0, plot)).toBe(plot.bottom)
    expect(scaleY(1.4, plot)).toBe(plot.top)
    expect(scaleY(-0.2, plot)).toBe(plot.bottom)
  })

  it('snaps a pointer to the nearest existing turn', () => {
    const span = turnSpan(5)
    expect(nearestTurn(scaleX(3, plot, span) + 4, plot, span, 5)).toBe(3)
    expect(nearestTurn(plot.left, plot, span, 5)).toBe(1)
    expect(nearestTurn(plot.right, plot, span, 5)).toBe(5)
    expect(nearestTurn(plot.left, plot, span, 0)).toBeNull()
  })

  it('thins x ticks as the call grows', () => {
    expect(xTicks(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(xTicks(20)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
  })

  it('separates overlapping end labels symmetrically', () => {
    const [a, b] = separateLabels(100, 104, 18)
    expect(b - a).toBeCloseTo(18, 10)
    expect((a + b) / 2).toBeCloseTo(102, 10)
    expect(separateLabels(100, 200, 18)).toEqual([100, 200])
  })
})

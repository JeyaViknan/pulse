/** Pure layout arithmetic for the probability chart. */

export interface Margin {
  top: number
  right: number
  bottom: number
  left: number
}

export interface Plot {
  left: number
  top: number
  width: number
  height: number
  right: number
  bottom: number
}

export interface Point {
  x: number
  y: number
}

/** Right margin leaves room for end-of-line value labels. */
export const CHART_MARGIN: Margin = { top: 20, right: 64, bottom: 40, left: 52 }

/**
 * The x-axis always spans at least this many turns, so the first few points of a new call
 * are not stretched across the whole width.
 */
export const MIN_TURN_SPAN = 8

export const Y_TICKS: readonly number[] = [0, 0.25, 0.5, 0.75, 1]

export function plotArea(width: number, height: number, margin: Margin = CHART_MARGIN): Plot {
  const plotWidth = Math.max(0, width - margin.left - margin.right)
  const plotHeight = Math.max(0, height - margin.top - margin.bottom)
  return {
    left: margin.left,
    top: margin.top,
    width: plotWidth,
    height: plotHeight,
    right: margin.left + plotWidth,
    bottom: margin.top + plotHeight,
  }
}

export function turnSpan(turnCount: number): number {
  return Math.max(MIN_TURN_SPAN, turnCount)
}

/** x for turn index t, where t = 0 is the start of the call (the base-rate anchor). */
export function scaleX(t: number, plot: Plot, span: number): number {
  return plot.left + (t / span) * plot.width
}

export function scaleY(probability: number, plot: Plot): number {
  const clamped = Math.min(1, Math.max(0, probability))
  return plot.top + (1 - clamped) * plot.height
}

/** Turn nearest to a pointer x-position, clamped to turns that exist. */
export function nearestTurn(pointerX: number, plot: Plot, span: number, turnCount: number): number | null {
  if (turnCount === 0 || plot.width === 0) return null
  const raw = ((pointerX - plot.left) / plot.width) * span
  return Math.min(turnCount, Math.max(1, Math.round(raw)))
}

/** Tick positions from 0 to `span`, thinned as the call grows. */
export function xTicks(span: number): number[] {
  const step = span <= 12 ? 1 : span <= 24 ? 2 : 5
  const ticks: number[] = []
  for (let t = 0; t <= span; t += step) ticks.push(t)
  return ticks
}

export function linePath(points: readonly Point[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
}

/** Spreads two label positions apart vertically when they would overlap. */
export function separateLabels(a: number, b: number, minGap: number): [number, number] {
  const gap = Math.abs(a - b)
  if (gap >= minGap) return [a, b]
  const shift = (minGap - gap) / 2
  return a <= b ? [a - shift, b + shift] : [a + shift, b - shift]
}

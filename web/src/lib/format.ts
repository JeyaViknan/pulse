const MINUS = '−'

/** A probability as shown throughout the interface, e.g. `0.48`. */
export function formatProbability(value: number): string {
  return value.toFixed(2)
}

/** A signed movement with a true minus sign, e.g. `+0.18`, `−0.26`, `0.00`. */
export function formatSigned(value: number, digits = 2): string {
  const rounded = Number(value.toFixed(digits))
  if (rounded === 0) return (0).toFixed(digits)
  return `${rounded > 0 ? '+' : MINUS}${Math.abs(rounded).toFixed(digits)}`
}

/** A 0–1 share as a whole percentage, e.g. `62%`. */
export function formatShare(value: number): string {
  return `${Math.round(value * 100)}%`
}

export type Direction = 'up' | 'down' | 'flat'

export function directionOf(value: number, digits = 2): Direction {
  const rounded = Number(value.toFixed(digits))
  if (rounded > 0) return 'up'
  if (rounded < 0) return 'down'
  return 'flat'
}

/** Arrow glyph that restates direction so it never depends on colour alone. */
export const DIRECTION_GLYPH: Record<Direction, string> = {
  up: '▲',
  down: '▼',
  flat: '–',
}

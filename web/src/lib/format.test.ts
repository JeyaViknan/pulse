import { describe, expect, it } from 'vitest'
import { directionOf, formatProbability, formatShare, formatSigned } from './format'

describe('format', () => {
  it('formats probabilities to two decimals', () => {
    expect(formatProbability(0.4)).toBe('0.40')
    expect(formatProbability(0.4861)).toBe('0.49')
  })

  it('formats signed movement with a true minus sign and an unsigned zero', () => {
    expect(formatSigned(0.177)).toBe('+0.18')
    expect(formatSigned(-0.276)).toBe('−0.28')
    expect(formatSigned(-0.001)).toBe('0.00')
  })

  it('treats movement that rounds to zero as flat', () => {
    expect(directionOf(0.004)).toBe('flat')
    expect(directionOf(-0.2)).toBe('down')
    expect(directionOf(0.2)).toBe('up')
  })

  it('formats shares as whole percentages', () => {
    expect(formatShare(0.625)).toBe('63%')
  })
})

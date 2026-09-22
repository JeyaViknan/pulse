import { DIRECTION_GLYPH, directionOf, formatProbability, formatSigned } from '../../lib/format'
import { SPEAKER_LABEL } from '../../lib/speakers'
import type { Estimate, Speaker } from '../../types/pulse'
import styles from './ProbabilityChart.module.css'

interface ChartTooltipProps {
  estimate: Estimate
  speaker: Speaker | null
  ghostProbability: number | null
  maskedTurn: number | null
  /** Anchor point in the chart canvas, in pixels. */
  x: number
  y: number
  /** Flip to the left of the anchor near the right edge. */
  alignLeft: boolean
}

/** Value-first readout for the turn under the crosshair. */
export function ChartTooltip({ estimate, speaker, ghostProbability, maskedTurn, x, y, alignLeft }: ChartTooltipProps) {
  const direction = directionOf(estimate.momentum)
  return (
    <div
      className={styles.tooltip}
      data-align={alignLeft ? 'left' : 'right'}
      style={{ left: x, top: y }}
      role="presentation"
    >
      <div className={styles.tooltipLabel}>
        Turn {estimate.t}
        {speaker && ` · ${SPEAKER_LABEL[speaker]}`}
      </div>
      <div className={styles.tooltipValue}>{formatProbability(estimate.probability)}</div>
      <div className={styles.tooltipRow}>
        <span>Momentum</span>
        <strong data-direction={direction}>
          {formatSigned(estimate.momentum)} <span aria-hidden="true">{DIRECTION_GLYPH[direction]}</span>
        </strong>
      </div>
      {estimate.turningPoint && <div className={styles.tooltipTurning}>◆ Turning point</div>}
      {ghostProbability !== null && maskedTurn !== null && (
        <div className={styles.tooltipRow}>
          <span>Without turn {maskedTurn}</span>
          <strong>{formatProbability(ghostProbability)}</strong>
        </div>
      )}
    </div>
  )
}

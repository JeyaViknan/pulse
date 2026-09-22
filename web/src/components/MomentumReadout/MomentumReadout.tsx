import { formatProbability } from '../../lib/format'
import { SPEAKER_LABEL } from '../../lib/speakers'
import type { Estimate, Turn } from '../../types/pulse'
import { Movement } from '../shared/Movement'
import { Stat } from '../shared/Stat'
import styles from '../shared/panel.module.css'

interface MomentumReadoutProps {
  estimate: Estimate | null
  turn: Turn | null
  baseRate: number | null
  tau: number | null
  isLatest: boolean
}

/** Probability, momentum and turning-point status for the turn in focus. */
export function MomentumReadout({ estimate, turn, baseRate, tau, isLatest }: MomentumReadoutProps) {
  if (!estimate) {
    return (
      <section className={styles.panel} aria-label="Momentum">
        <p className={styles.message}>
          The estimate appears after the first turn
          {baseRate !== null && <>, starting from the base rate of {formatProbability(baseRate)}</>}.
        </p>
      </section>
    )
  }

  return (
    <section className={styles.panel} aria-labelledby="readout-heading">
      <header className={styles.panelHeading}>
        <h2 id="readout-heading" className={styles.panelTitle}>
          {isLatest ? 'Latest turn' : 'Turn'} <strong>{estimate.t}</strong>
          {turn && ` · ${SPEAKER_LABEL[turn.speaker]}`}
        </h2>
      </header>

      <dl className={styles.stats}>
        <Stat label="Probability of close" value={formatProbability(estimate.probability)} size="large" />
        <Stat
          label="Momentum"
          value={<Movement value={estimate.momentum} />}
          size="large"
          detail="Change since the previous turn"
        />
        <Stat
          label="Turning point"
          value={estimate.turningPoint ? '◆ Yes' : 'No'}
          size="large"
          detail={tau !== null ? `When the change is at least ${formatProbability(tau)}` : undefined}
        />
      </dl>

      {turn && (
        <p className={styles.quote}>
          <strong>{SPEAKER_LABEL[turn.speaker]}:</strong> “{turn.text}”
        </p>
      )}
    </section>
  )
}

import { formatProbability, formatShare } from '../../lib/format'
import { SPEAKER_INITIAL, SPEAKER_LABEL } from '../../lib/speakers'
import type { Summary } from '../../types/pulse'
import { Movement } from '../shared/Movement'
import { Stat } from '../shared/Stat'
import panel from '../shared/panel.module.css'
import styles from './SummaryCard.module.css'

interface SummaryCardProps {
  summary: Summary | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  title: string
}

/** End-of-call summary. Every value comes from the backend; nothing is re-scored. */
export function SummaryCard({ summary, status, title }: SummaryCardProps) {
  return (
    <section className={panel.panel} aria-labelledby="summary-heading" aria-live="polite">
      <header className={panel.panelHeading}>
        <h2 id="summary-heading" className={panel.panelTitle}>
          {title}
        </h2>
        {summary && (
          <span className={styles.meta}>
            {summary.turnCount} turns · {summary.turningPointCount}{' '}
            {summary.turningPointCount === 1 ? 'turning point' : 'turning points'}
          </span>
        )}
      </header>

      {status === 'loading' && <p className={panel.message}>Preparing the summary…</p>}
      {status === 'error' && <p className={panel.message}>The summary is unavailable.</p>}

      {summary && (
        <>
          <dl className={panel.stats}>
            <Stat label="Final estimate" value={formatProbability(summary.finalProbability)} size="large" />
            <Stat label="Base rate" value={formatProbability(summary.baseRate)} size="large" />
            <Stat
              label="Total movement"
              value={<Movement value={summary.totalMovement} />}
              size="large"
              detail="Final minus base rate"
            />
            <Stat
              label="Dealer share"
              value={formatShare(summary.dealerTurnShare)}
              detail={`of turns · ${formatShare(summary.dealerWordShare)} of words`}
            />
          </dl>

          {summary.largestMovements.length > 0 && (
            <div>
              <h3 className={styles.listTitle}>Largest movements</h3>
              <ol className={styles.list}>
                {summary.largestMovements.map((movement) => (
                  <li key={movement.t} className={styles.item}>
                    <span className={styles.turn}>Turn {movement.t}</span>
                    <span className={styles.speaker} aria-label={SPEAKER_LABEL[movement.speaker]}>
                      {SPEAKER_INITIAL[movement.speaker]}
                    </span>
                    <span className={styles.text}>“{movement.text}”</span>
                    <span className={styles.value}>
                      <Movement value={movement.momentum} />
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </section>
  )
}

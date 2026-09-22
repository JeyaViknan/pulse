import type { Estimate } from '../../types/pulse'
import styles from './LatencyOverlay.module.css'

interface LatencyOverlayProps {
  estimates: Estimate[]
  onClose: () => void
}

function ms(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`
}

function percentile(values: number[], share: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? null
}

/**
 * Developer latency overlay (SPEC.md P9): the per-stage timings the server reported for the
 * latest turn, and the median and p95 of end-to-end time across the call. Hidden by default.
 */
export function LatencyOverlay({ estimates, onClose }: LatencyOverlayProps) {
  const latest = estimates.at(-1) ?? null
  const totals = estimates.map((estimate) => estimate.timings.totalMs)
  const spoken = estimates.filter((estimate) => estimate.timings.asrMs !== null)

  return (
    <aside className={styles.overlay} aria-label="Latency">
      <header className={styles.heading}>
        <span>Latency</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Hide latency overlay">
          L
        </button>
      </header>
      {latest ? (
        <dl className={styles.rows}>
          <dt>Turn {latest.t} · ASR</dt>
          <dd>{ms(latest.timings.asrMs)}</dd>
          <dt>Encode</dt>
          <dd>{ms(latest.timings.encodeMs)}</dd>
          <dt>Model</dt>
          <dd>{ms(latest.timings.modelMs)}</dd>
          <dt>Total</dt>
          <dd>{ms(latest.timings.totalMs)}</dd>
          <dt className={styles.divider}>Median total</dt>
          <dd className={styles.divider}>{ms(percentile(totals, 0.5))}</dd>
          <dt>p95 total</dt>
          <dd>{ms(percentile(totals, 0.95))}</dd>
          <dt>Turns · spoken</dt>
          <dd>
            {estimates.length} · {spoken.length}
          </dd>
        </dl>
      ) : (
        <p className={styles.empty}>No turns yet.</p>
      )}
    </aside>
  )
}

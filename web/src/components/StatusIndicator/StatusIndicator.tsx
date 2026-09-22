import styles from './StatusIndicator.module.css'

export type StatusTone = 'idle' | 'active' | 'busy' | 'replaying' | 'done'

interface StatusIndicatorProps {
  /** The state name, e.g. "Listening". */
  label: string
  /** What the state refers to, e.g. "Dealer" or "Without turn 3". */
  detail: string | null
  tone: StatusTone
}

/** Names the current interface state so the audience can always read what the system is doing. */
export function StatusIndicator({ label, detail, tone }: StatusIndicatorProps) {
  return (
    <div className={styles.status} data-tone={tone} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
      {detail && <span className={styles.detail}>{detail}</span>}
    </div>
  )
}

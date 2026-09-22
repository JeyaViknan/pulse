import type { ReactNode } from 'react'
import styles from './Header.module.css'

export type AppMode = 'live' | 'playback'

interface HeaderProps {
  mode: AppMode
  onModeChange: (mode: AppMode) => void
  /** Mode switching is locked while a turn is being recorded or processed. */
  modeLocked: boolean
  status: ReactNode
  summaryEnabled: boolean
  summaryActive: boolean
  summaryHint: string
  onSummary: () => void
  isMockModel: boolean
}

export function Header({
  mode,
  onModeChange,
  modeLocked,
  status,
  summaryEnabled,
  summaryActive,
  summaryHint,
  onSummary,
  isMockModel,
}: HeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.lead}>
        <span className={styles.wordmark}>Pulse</span>
        {status}
      </div>

      <div className={styles.actions}>
        {isMockModel && (
          <span
            className={styles.mockBadge}
            title="Estimates come from a scripted stand-in, not the trained model. For interface demonstration only."
          >
            Mock model
          </span>
        )}

        <div className={styles.modes} role="group" aria-label="Mode">
          <button
            type="button"
            className={styles.mode}
            aria-pressed={mode === 'live'}
            disabled={modeLocked && mode !== 'live'}
            onClick={() => onModeChange('live')}
          >
            <span className={styles.liveDot} aria-hidden="true" />
            Live
          </button>
          <button
            type="button"
            className={styles.mode}
            aria-pressed={mode === 'playback'}
            disabled={modeLocked && mode !== 'playback'}
            onClick={() => onModeChange('playback')}
          >
            Replay
          </button>
        </div>

        <button
          type="button"
          className={styles.summary}
          aria-pressed={summaryActive}
          disabled={!summaryEnabled}
          title={summaryHint}
          onClick={onSummary}
        >
          Summary
        </button>
      </div>
    </header>
  )
}

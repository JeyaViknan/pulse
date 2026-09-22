import type { ReactNode } from 'react'
import type { Health } from '../../types/pulse'
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
  /** What the server has loaded; null while unknown or unreachable. */
  health: Health | null
  serverReachable: boolean
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
  health,
  serverReachable,
}: HeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.lead}>
        <span className={styles.wordmark}>Pulse</span>
        {status}
      </div>

      <div className={styles.actions}>
        {health && (
          <span
            className={styles.artefact}
            title={`Model artefact ${health.artefactVersion} · encoder ${health.encoder} · speech ${
              health.asrModel ? `Whisper ${health.asrModel}` : 'unavailable'
            } · base rate ${health.baseRate.toFixed(3)} · τ ${health.tau.toFixed(3)}`}
          >
            {health.artefactVersion}
          </span>
        )}
        {!serverReachable && <span className={styles.offline}>Server offline</span>}

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

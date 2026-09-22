import { useId } from 'react'
import { PLAYBACK_SPEEDS, type PlaybackControls } from '../../hooks/usePlayback'
import styles from './ReplayControls.module.css'

interface ReplayControlsProps {
  playback: PlaybackControls
}

/** Transport for Replay mode: choose a saved session, then step or play through it. */
export function ReplayControls({ playback }: ReplayControlsProps) {
  const selectId = useId()
  const { sessions, session, position, total, isPlaying, speed, loading } = playback
  const noSession = session === null

  return (
    <div className={styles.controls}>
      <label htmlFor={selectId} className={styles.label}>
        Session
      </label>
      <select
        id={selectId}
        className={styles.select}
        value={session?.name ?? ''}
        disabled={loading || sessions.length === 0}
        onChange={(event) => void playback.load(event.target.value)}
      >
        {sessions.length === 0 && <option value="">No saved sessions</option>}
        {sessions.map((item) => (
          <option key={item.name} value={item.name}>
            {item.title} ({item.turnCount} turns)
          </option>
        ))}
      </select>

      <div className={styles.transport} role="group" aria-label="Playback">
        <button type="button" className={styles.button} disabled={noSession || position === 0} onClick={playback.stepBack}>
          <span aria-hidden="true">◀</span> Back
        </button>
        {isPlaying ? (
          <button type="button" className={styles.primary} onClick={playback.pause}>
            Pause
          </button>
        ) : (
          <button type="button" className={styles.primary} disabled={noSession} onClick={playback.play}>
            {position >= total && total > 0 ? 'Play again' : 'Play'}
          </button>
        )}
        <button
          type="button"
          className={styles.button}
          disabled={noSession || position >= total}
          onClick={playback.stepForward}
        >
          Next <span aria-hidden="true">▶</span>
        </button>
      </div>

      <div className={styles.speeds} role="group" aria-label="Playback speed">
        {PLAYBACK_SPEEDS.map((option) => (
          <button
            key={option}
            type="button"
            className={styles.speed}
            aria-pressed={speed === option}
            onClick={() => playback.setSpeed(option)}
          >
            {option}×
          </button>
        ))}
      </div>

      <span className={styles.position} aria-live="polite">
        Turn {position} of {total}
      </span>

      {playback.error && (
        <p className={styles.error} role="alert">
          {playback.error}
        </p>
      )}
    </div>
  )
}

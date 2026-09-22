import type { KeyboardEvent, PointerEvent } from 'react'
import { SPEAKERS, SPEAKER_KEY, SPEAKER_LABEL } from '../../lib/speakers'
import type { Speaker } from '../../types/pulse'
import styles from './PushToTalkControls.module.css'

interface PushToTalkControlsProps {
  recordingSpeaker: Speaker | null
  /** True while a turn is being transcribed or scored. */
  busy: boolean
  /** False when no turn may start at all (no session, or the call has ended). */
  available: boolean
  onPress: (speaker: Speaker) => void
  onRelease: (speaker: Speaker) => void
}

/**
 * Hold-to-talk controls. The control that is held determines the speaker; there is no
 * diarisation. Each also responds to its keyboard key (see `useKeyboardPushToTalk`) and, when
 * focused, to holding Space or Enter.
 */
export function PushToTalkControls({ recordingSpeaker, busy, available, onPress, onRelease }: PushToTalkControlsProps) {
  return (
    <div className={styles.controls} role="group" aria-label="Push to talk">
      {SPEAKERS.map((speaker) => {
        const recording = recordingSpeaker === speaker
        const blocked = !available || busy || (recordingSpeaker !== null && !recording)

        const press = () => {
          if (!blocked) onPress(speaker)
        }
        const release = () => {
          if (recording) onRelease(speaker)
        }

        const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          press()
        }
        const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== ' ' && event.key !== 'Enter') return
          event.preventDefault()
          if (!event.repeat) press()
        }
        const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== ' ' && event.key !== 'Enter') return
          event.preventDefault()
          release()
        }

        return (
          <button
            key={speaker}
            type="button"
            className={styles.button}
            data-speaker={speaker}
            data-recording={recording}
            data-busy={busy}
            aria-pressed={recording}
            aria-disabled={blocked && !recording}
            onPointerDown={handlePointerDown}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
            onKeyDown={handleKeyDown}
            onKeyUp={handleKeyUp}
            onContextMenu={(event) => event.preventDefault()}
          >
            <span className={styles.indicator} aria-hidden="true" />
            <span className={styles.text}>
              {recording ? (
                <>
                  Recording <span className={styles.speaker}>{SPEAKER_LABEL[speaker]}</span>
                </>
              ) : (
                <>
                  Hold <kbd className={styles.key}>{SPEAKER_KEY[speaker].toUpperCase()}</kbd>
                  <span className={styles.dash} aria-hidden="true">
                    —
                  </span>
                  <span className={styles.speaker}>{SPEAKER_LABEL[speaker]}</span>
                </>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

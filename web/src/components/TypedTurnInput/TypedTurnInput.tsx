import { useId, useState, type FormEvent } from 'react'
import { SPEAKERS, SPEAKER_LABEL, otherSpeaker } from '../../lib/speakers'
import type { Speaker } from '../../types/pulse'
import styles from './TypedTurnInput.module.css'

interface TypedTurnInputProps {
  disabled: boolean
  /** Returns true when the turn was accepted. */
  onSubmit: (speaker: Speaker, text: string) => boolean
}

/**
 * Fallback for when the microphone cannot be used. A typed turn follows the same path as a
 * spoken one, skipping only transcription. The speaker alternates after each turn, as
 * conversations usually do, and can be changed before sending.
 */
export function TypedTurnInput({ disabled, onSubmit }: TypedTurnInputProps) {
  const [text, setText] = useState('')
  const [speaker, setSpeaker] = useState<Speaker>('dealer')
  const inputId = useId()

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (disabled || text.trim().length === 0) return
    if (onSubmit(speaker, text)) {
      setText('')
      setSpeaker(otherSpeaker(speaker))
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <label htmlFor={inputId} className={styles.label}>
        or type a turn
      </label>
      <input
        id={inputId}
        className={styles.input}
        type="text"
        value={text}
        placeholder="Type what was said, then press Enter"
        autoComplete="off"
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Submit explicitly rather than relying on implicit form submission; skip IME composition.
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          event.preventDefault()
          event.currentTarget.form?.requestSubmit()
        }}
      />
      <div className={styles.speakers} role="group" aria-label="Speaker for the typed turn">
        {SPEAKERS.map((option) => (
          <button
            key={option}
            type="button"
            className={styles.speaker}
            aria-pressed={speaker === option}
            disabled={disabled}
            onClick={() => setSpeaker(option)}
          >
            {SPEAKER_LABEL[option]}
          </button>
        ))}
      </div>
      <button type="submit" className={styles.send} disabled={disabled || text.trim().length === 0}>
        Send
      </button>
    </form>
  )
}

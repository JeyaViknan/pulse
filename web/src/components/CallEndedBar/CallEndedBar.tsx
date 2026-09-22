import { useState } from 'react'
import styles from './CallEndedBar.module.css'

interface CallEndedBarProps {
  /** Resolves true when the session was saved. */
  onSave: () => Promise<boolean>
  onNewCall: () => void
}

/** Replaces the push-to-talk controls once the call has ended. */
export function CallEndedBar({ onSave, onNewCall }: CallEndedBarProps) {
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')

  const save = async () => {
    setSaveState('saving')
    setSaveState((await onSave()) ? 'saved' : 'idle')
  }

  return (
    <div className={styles.bar}>
      <p className={styles.message}>
        <strong>Call ended.</strong> The summary uses only values computed during the call.
      </p>
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={saveState !== 'idle'} onClick={() => void save()}>
          {saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Save session'}
        </button>
        <button type="button" className={styles.primary} onClick={onNewCall}>
          New call
        </button>
      </div>
    </div>
  )
}

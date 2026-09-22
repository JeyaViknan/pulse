import { useEffect } from 'react'
import type { Notice } from '../../state/liveSession'
import styles from './NoticeBar.module.css'

const DISMISS_AFTER_MS: Record<Notice['kind'], number> = { info: 5000, error: 8000 }

interface NoticeBarProps {
  notice: Notice | null
  onDismiss: () => void
}

/** A single, self-dismissing message. Errors never interrupt the call. */
export function NoticeBar({ notice, onDismiss }: NoticeBarProps) {
  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(onDismiss, DISMISS_AFTER_MS[notice.kind])
    return () => window.clearTimeout(timer)
  }, [notice, onDismiss])

  if (!notice) return null

  return (
    <div className={styles.notice} data-kind={notice.kind} role={notice.kind === 'error' ? 'alert' : 'status'}>
      <span>{notice.message}</span>
      <button type="button" className={styles.dismiss} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  )
}

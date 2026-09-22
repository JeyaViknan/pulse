import { useEffect, useMemo, useRef } from 'react'
import { SPEAKER_INITIAL, SPEAKER_LABEL } from '../../lib/speakers'
import type { Estimate, Speaker, Turn } from '../../types/pulse'
import styles from './TranscriptPanel.module.css'
import { TranscriptTurn } from './TranscriptTurn'

export interface PendingTurn {
  speaker: Speaker
  /** e.g. "Listening…", "Transcribing…" */
  label: string
  recording: boolean
}

interface TranscriptPanelProps {
  turns: Turn[]
  estimates: Estimate[]
  selectedTurn: number | null
  highlightTurn: number | null
  onHighlightTurn: (turn: number | null) => void
  /** Omitted when turns cannot be selected, e.g. in Replay mode. */
  onSelectTurn?: (turn: number) => void
  pending: PendingTurn | null
  emptyHint: string
  footnote: string | null
}

export function TranscriptPanel({
  turns,
  estimates,
  selectedTurn,
  highlightTurn,
  onHighlightTurn,
  onSelectTurn,
  pending,
  emptyHint,
  footnote,
}: TranscriptPanelProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const estimateByTurn = useMemo(() => new Map(estimates.map((estimate) => [estimate.t, estimate])), [estimates])

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
  }, [turns.length, pending?.label])

  return (
    <section className={styles.panel} aria-labelledby="transcript-heading">
      <header className={styles.heading}>
        <h2 id="transcript-heading" className={styles.title}>
          Transcript
        </h2>
        <span className={styles.count}>
          {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
        </span>
      </header>

      <div ref={listRef} className={styles.scroller}>
        {turns.length === 0 && !pending ? (
          <p className={styles.empty}>{emptyHint}</p>
        ) : (
          <ol className={styles.list}>
            {turns.map((turn) => (
              <TranscriptTurn
                key={turn.t}
                turn={turn}
                estimate={estimateByTurn.get(turn.t)}
                selected={selectedTurn === turn.t}
                highlighted={highlightTurn === turn.t}
                onSelect={onSelectTurn ? () => onSelectTurn(turn.t) : undefined}
                onHighlight={(on) => onHighlightTurn(on ? turn.t : null)}
              />
            ))}
            {pending && (
              <li className={styles.item}>
                <div className={styles.row} data-pending="true">
                  <span className={styles.number}>{turns.length + 1}</span>
                  <span className={styles.badge} data-speaker={pending.speaker} aria-hidden="true">
                    {SPEAKER_INITIAL[pending.speaker]}
                  </span>
                  <span className={styles.pendingLabel} data-recording={pending.recording}>
                    <span className="sr-only">{SPEAKER_LABEL[pending.speaker]}: </span>
                    {pending.label}
                  </span>
                </div>
              </li>
            )}
          </ol>
        )}
      </div>

      {footnote && <p className={styles.footnote}>{footnote}</p>}
    </section>
  )
}

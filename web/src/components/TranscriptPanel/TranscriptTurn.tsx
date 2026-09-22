import { DIRECTION_GLYPH, directionOf, formatSigned } from '../../lib/format'
import { SPEAKER_INITIAL, SPEAKER_LABEL } from '../../lib/speakers'
import type { Estimate, Turn } from '../../types/pulse'
import styles from './TranscriptPanel.module.css'

interface TranscriptTurnProps {
  turn: Turn
  estimate: Estimate | undefined
  /** This turn is masked in the counterfactual replay. */
  selected: boolean
  highlighted: boolean
  onSelect?: () => void
  onHighlight: (highlighted: boolean) => void
}

function Movement({ estimate }: { estimate: Estimate | undefined }) {
  if (!estimate) {
    return (
      <span className={styles.movementPending} aria-label="Estimate pending">
        …
      </span>
    )
  }
  const direction = directionOf(estimate.momentum)
  if (!estimate.turningPoint) {
    return <span className={styles.movementQuiet}>{formatSigned(estimate.momentum)}</span>
  }
  return (
    <span className={styles.movementTurning} data-direction={direction}>
      <span className={styles.diamond} aria-hidden="true">
        ◆
      </span>
      <span className={styles.movementValue}>
        {formatSigned(estimate.momentum)}
        <span className={styles.glyph} aria-hidden="true">
          {DIRECTION_GLYPH[direction]}
        </span>
      </span>
      <span className="sr-only">turning point</span>
    </span>
  )
}

export function TranscriptTurn({ turn, estimate, selected, highlighted, onSelect, onHighlight }: TranscriptTurnProps) {
  const content = (
    <>
      <span className={styles.number}>{turn.t}</span>
      <span className={styles.badge} data-speaker={turn.speaker} aria-hidden="true">
        {SPEAKER_INITIAL[turn.speaker]}
      </span>
      <span className={styles.text}>
        <span className="sr-only">{SPEAKER_LABEL[turn.speaker]}: </span>
        <span className={styles.utterance}>{turn.text}</span>
        {selected && <span className={styles.removedTag}>Removed in replay</span>}
      </span>
      <Movement estimate={estimate} />
    </>
  )

  const rowProps = {
    className: styles.row,
    'data-selected': selected,
    'data-highlighted': highlighted,
    'data-turning': estimate?.turningPoint ?? false,
    onMouseEnter: () => onHighlight(true),
    onMouseLeave: () => onHighlight(false),
  }

  return (
    <li className={styles.item}>
      {onSelect && estimate ? (
        <button
          type="button"
          {...rowProps}
          aria-pressed={selected}
          onClick={onSelect}
          onFocus={() => onHighlight(true)}
          onBlur={() => onHighlight(false)}
          title={selected ? 'Restore this turn' : 'Replay the call without this turn'}
        >
          {content}
        </button>
      ) : (
        <div {...rowProps}>{content}</div>
      )}
    </li>
  )
}

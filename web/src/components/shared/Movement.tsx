import { DIRECTION_GLYPH, directionOf, formatSigned } from '../../lib/format'
import styles from './panel.module.css'

/** A signed movement with its direction glyph, so direction never depends on colour alone. */
export function Movement({ value }: { value: number }) {
  const direction = directionOf(value)
  return (
    <span className={styles.movement} data-direction={direction}>
      {formatSigned(value)}
      <span className={styles.movementGlyph} aria-hidden="true">
        {DIRECTION_GLYPH[direction]}
      </span>
    </span>
  )
}

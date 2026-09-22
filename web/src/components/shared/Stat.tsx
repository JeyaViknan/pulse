import type { ReactNode } from 'react'
import styles from './panel.module.css'

interface StatProps {
  label: ReactNode
  value: ReactNode
  detail?: ReactNode
  size?: 'large' | 'medium'
}

/** A labelled figure: label above, value below, optional qualifier. */
export function Stat({ label, value, detail, size = 'medium' }: StatProps) {
  return (
    <div className={styles.stat}>
      <dt className={styles.statLabel}>{label}</dt>
      <dd className={styles.statValue} data-size={size}>
        {value}
      </dd>
      {detail && <dd className={styles.statDetail}>{detail}</dd>}
    </div>
  )
}

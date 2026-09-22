import type { ReactNode } from 'react'
import styles from './AppShell.module.css'

interface AppShellProps {
  header: ReactNode
  transcript: ReactNode
  chart: ReactNode
  detail: ReactNode
  footer: ReactNode
}

/** Single-screen layout: transcript on the left, chart and detail on the right, controls below. */
export function AppShell({ header, transcript, chart, detail, footer }: AppShellProps) {
  return (
    <div className={styles.shell}>
      {header}
      <main className={styles.main}>
        <div className={styles.transcript}>{transcript}</div>
        <div className={styles.analysis}>
          <div className={styles.chart}>{chart}</div>
          <div className={styles.detail}>{detail}</div>
        </div>
      </main>
      <footer className={styles.footer}>{footer}</footer>
    </div>
  )
}

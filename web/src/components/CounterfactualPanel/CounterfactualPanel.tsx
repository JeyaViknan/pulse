import { formatProbability } from '../../lib/format'
import { SPEAKER_LABEL } from '../../lib/speakers'
import type { CounterfactualView } from '../../state/liveSession'
import type { Turn } from '../../types/pulse'
import { Movement } from '../shared/Movement'
import { Stat } from '../shared/Stat'
import styles from '../shared/panel.module.css'

interface CounterfactualPanelProps {
  view: CounterfactualView
  maskedTurn: Turn | null
  /** p_T with every turn included. */
  realFinal: number | null
  onDismiss: () => void
}

/** What the conversation would look like had one turn never happened. */
export function CounterfactualPanel({ view, maskedTurn, realFinal, onDismiss }: CounterfactualPanelProps) {
  const ghostFinal = view.result?.path.at(-1) ?? null

  return (
    <section className={styles.panel} aria-labelledby="counterfactual-heading" aria-live="polite">
      <header className={styles.panelHeading}>
        <h2 id="counterfactual-heading" className={styles.panelTitle}>
          Replaying without turn <strong>{view.turn}</strong>
        </h2>
        <button type="button" className={styles.ghostButton} onClick={onDismiss}>
          Back to live view <kbd>Esc</kbd>
        </button>
      </header>

      {maskedTurn && (
        <p className={styles.quote}>
          <strong>{SPEAKER_LABEL[maskedTurn.speaker]}:</strong> “{maskedTurn.text}”
        </p>
      )}

      {view.status === 'loading' && <p className={styles.message}>Re-running the model without turn {view.turn}…</p>}

      {view.status === 'error' && (
        <p className={styles.message}>The replay could not be computed. {view.error}</p>
      )}

      {view.status === 'ready' && view.result && (
        <>
          <dl className={styles.stats}>
            <Stat
              label="Final, as it happened"
              value={realFinal === null ? '—' : formatProbability(realFinal)}
              size="large"
            />
            <Stat
              label={`Final without turn ${view.turn}`}
              value={ghostFinal === null ? '—' : formatProbability(ghostFinal)}
              size="large"
            />
            <Stat
              label={`Effect of turn ${view.turn} on the final`}
              value={<Movement value={view.result.deltaT} />}
              size="large"
            />
          </dl>
          <p className={styles.hint}>
            Same model, re-run with turn {view.turn} masked out. Turns before it are unchanged.
          </p>
        </>
      )}
    </section>
  )
}

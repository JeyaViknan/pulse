import { useMemo, type KeyboardEvent, type MouseEvent } from 'react'
import { useElementSize } from '../../hooks/useElementSize'
import { directionOf, formatProbability, formatSigned } from '../../lib/format'
import { SPEAKER_LABEL } from '../../lib/speakers'
import type { Counterfactual, Estimate, Turn } from '../../types/pulse'
import { ChartTooltip } from './ChartTooltip'
import {
  Y_TICKS,
  linePath,
  nearestTurn,
  plotArea,
  scaleX,
  scaleY,
  separateLabels,
  turnSpan,
  xTicks,
  type Point,
} from './chartGeometry'
import styles from './ProbabilityChart.module.css'

interface ProbabilityChartProps {
  turns: Turn[]
  estimates: Estimate[]
  baseRate: number | null
  /** A loaded counterfactual draws the ghost path. */
  counterfactual: Counterfactual | null
  /** Turn masked in the counterfactual view (may be set while the replay is still loading). */
  selectedTurn: number | null
  highlightTurn: number | null
  onHighlightTurn: (turn: number | null) => void
  /** Omitted when turns cannot be selected, e.g. in Replay mode. */
  onSelectTurn?: (turn: number) => void
  emptyMessage: string
}

const DIAMOND = 7
const TOOLTIP_FLIP_MARGIN = 220

function diamondPath(x: number, y: number, size: number): string {
  return `M${x},${y - size} L${x + size},${y} L${x},${y + size} L${x - size},${y} Z`
}

export function ProbabilityChart({
  turns,
  estimates,
  baseRate,
  counterfactual,
  selectedTurn,
  highlightTurn,
  onHighlightTurn,
  onSelectTurn,
  emptyMessage,
}: ProbabilityChartProps) {
  const { ref, width, height } = useElementSize<HTMLDivElement>()
  const plot = plotArea(width, height)
  const span = turnSpan(estimates.length)
  const x = (t: number) => scaleX(t, plot, span)
  const y = (p: number) => scaleY(p, plot)

  const speakerByTurn = useMemo(() => new Map(turns.map((turn) => [turn.t, turn.speaker])), [turns])
  const lastEstimate = estimates.at(-1) ?? null
  const interactive = estimates.length > 0
  const canSelect = interactive && onSelectTurn !== undefined

  const realPoints: Point[] =
    baseRate === null
      ? []
      : [{ x: x(0), y: y(baseRate) }, ...estimates.map((estimate) => ({ x: x(estimate.t), y: y(estimate.probability) }))]

  const ghostPoints: Point[] = []
  if (counterfactual && baseRate !== null) {
    const k = counterfactual.maskedTurn
    const anchor = k === 1 ? baseRate : (estimates[k - 2]?.probability ?? baseRate)
    ghostPoints.push({ x: x(k - 1), y: y(anchor) })
    counterfactual.path.forEach((probability, index) => {
      const t = index + 1
      if (t >= k) ghostPoints.push({ x: x(t), y: y(probability) })
    })
  }
  const ghostFinal = counterfactual?.path.at(-1) ?? null

  const [realLabelY, ghostLabelY] =
    lastEstimate && ghostFinal !== null
      ? separateLabels(y(lastEstimate.probability), y(ghostFinal), 18)
      : [lastEstimate ? y(lastEstimate.probability) : 0, 0]

  const highlighted = highlightTurn === null ? null : (estimates.find((estimate) => estimate.t === highlightTurn) ?? null)
  const stepWidth = plot.width / span

  const turnAtPointer = (event: MouseEvent<SVGRectElement>): number | null => {
    const bounds = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    if (!bounds) return null
    return nearestTurn(event.clientX - bounds.left, plot, span, estimates.length)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return
    const current = highlightTurn ?? estimates.length
    const moves: Record<string, number> = {
      ArrowLeft: Math.max(1, current - 1),
      ArrowRight: Math.min(estimates.length, current + 1),
      Home: 1,
      End: estimates.length,
    }
    const target = moves[event.key]
    if (target !== undefined) {
      event.preventDefault()
      onHighlightTurn(target)
    } else if ((event.key === 'Enter' || event.key === ' ') && onSelectTurn) {
      event.preventDefault()
      onSelectTurn(current)
    }
  }

  const ghostAtHighlight =
    counterfactual && highlighted && highlighted.t >= counterfactual.maskedTurn
      ? (counterfactual.path[highlighted.t - 1] ?? null)
      : null

  return (
    <section className={styles.panel} aria-labelledby="chart-heading">
      <header className={styles.heading}>
        <h2 id="chart-heading" className={styles.title}>
          Probability of close
        </h2>
        <ul className={styles.legend} aria-label="Legend">
          <li>
            <span className={styles.keyReal} aria-hidden="true" />
            Estimate
          </li>
          {baseRate !== null && (
            <li>
              <span className={styles.keyBase} aria-hidden="true" />
              Base rate {formatProbability(baseRate)}
            </li>
          )}
          {counterfactual && (
            <li>
              <span className={styles.keyGhost} aria-hidden="true" />
              Without turn {counterfactual.maskedTurn}
            </li>
          )}
        </ul>
      </header>

      <div
        ref={ref}
        className={styles.canvas}
        tabIndex={interactive ? 0 : -1}
        role="group"
        aria-label={
          canSelect
            ? 'Probability chart. Left and right arrow keys move between turns; Enter replays the call without the highlighted turn.'
            : 'Probability chart. Left and right arrow keys move between turns.'
        }
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (interactive && highlightTurn === null) onHighlightTurn(estimates.length)
        }}
        onBlur={() => onHighlightTurn(null)}
      >
        {width > 0 && height > 0 && baseRate !== null && (
          <svg className={styles.svg} width={width} height={height} aria-hidden="true">
            {Y_TICKS.map((tick) => (
              <g key={tick}>
                <line className={styles.grid} x1={plot.left} x2={plot.right} y1={y(tick)} y2={y(tick)} />
                <text className={styles.tick} x={plot.left - 10} y={y(tick)} dy="0.32em" textAnchor="end">
                  {tick.toFixed(2)}
                </text>
              </g>
            ))}

            {xTicks(span).map((tick) => (
              <text key={tick} className={styles.tick} x={x(tick)} y={plot.bottom + 20} textAnchor="middle">
                {tick}
              </text>
            ))}
            <text className={styles.axisTitle} x={plot.right} y={plot.bottom + 36} textAnchor="end">
              Turn
            </text>

            {selectedTurn !== null && selectedTurn <= estimates.length && (
              <g>
                <rect
                  className={styles.maskBand}
                  x={x(selectedTurn) - stepWidth / 2}
                  y={plot.top}
                  width={stepWidth}
                  height={plot.height}
                />
                <text className={styles.maskLabel} x={x(selectedTurn)} y={plot.top + 14} textAnchor="middle">
                  Turn {selectedTurn} removed
                </text>
              </g>
            )}

            <line className={styles.baseRate} x1={plot.left} x2={plot.right} y1={y(baseRate)} y2={y(baseRate)} />

            {ghostPoints.length > 1 && <path className={styles.ghost} d={linePath(ghostPoints)} />}
            {realPoints.length > 1 && <path className={styles.line} d={linePath(realPoints)} />}

            <circle className={styles.anchor} cx={x(0)} cy={y(baseRate)} r={4} />

            {highlighted && (
              <line
                className={styles.crosshair}
                x1={x(highlighted.t)}
                x2={x(highlighted.t)}
                y1={plot.top}
                y2={plot.bottom}
              />
            )}

            {estimates.map((estimate) => {
              const cx = x(estimate.t)
              const cy = y(estimate.probability)
              const isMasked = estimate.t === selectedTurn
              if (estimate.turningPoint) {
                return (
                  <path
                    key={estimate.t}
                    className={styles.turningPoint}
                    data-direction={directionOf(estimate.momentum)}
                    data-masked={isMasked}
                    d={diamondPath(cx, cy, DIAMOND)}
                  />
                )
              }
              return (
                <circle key={estimate.t} className={styles.point} data-masked={isMasked} cx={cx} cy={cy} r={4.5} />
              )
            })}

            {highlighted && (
              <circle className={styles.focusRing} cx={x(highlighted.t)} cy={y(highlighted.probability)} r={10} />
            )}

            {lastEstimate && (
              <text className={styles.endLabel} x={x(lastEstimate.t) + 12} y={realLabelY} dy="0.32em">
                {formatProbability(lastEstimate.probability)}
              </text>
            )}
            {lastEstimate && ghostFinal !== null && (
              <text className={styles.ghostLabel} x={x(lastEstimate.t) + 12} y={ghostLabelY} dy="0.32em">
                {formatProbability(ghostFinal)}
              </text>
            )}

            {interactive && (
              <rect
                className={styles.hitArea}
                data-selectable={canSelect}
                x={plot.left}
                y={plot.top}
                width={plot.width}
                height={plot.height}
                onPointerMove={(event) => onHighlightTurn(turnAtPointer(event))}
                onPointerLeave={() => onHighlightTurn(null)}
                onClick={(event) => {
                  const turn = turnAtPointer(event)
                  if (turn !== null && onSelectTurn) onSelectTurn(turn)
                }}
              />
            )}
          </svg>
        )}

        {!interactive && <p className={styles.empty}>{emptyMessage}</p>}

        {highlighted && width > 0 && (
          <ChartTooltip
            estimate={highlighted}
            speaker={speakerByTurn.get(highlighted.t) ?? null}
            ghostProbability={ghostAtHighlight}
            maskedTurn={counterfactual?.maskedTurn ?? null}
            x={x(highlighted.t)}
            y={y(highlighted.probability)}
            alignLeft={x(highlighted.t) > width - TOOLTIP_FLIP_MARGIN}
          />
        )}
      </div>

      <table className="sr-only">
        <caption>Estimated probability of close after each turn</caption>
        <thead>
          <tr>
            <th scope="col">Turn</th>
            <th scope="col">Speaker</th>
            <th scope="col">Probability</th>
            <th scope="col">Momentum</th>
            <th scope="col">Turning point</th>
          </tr>
        </thead>
        <tbody>
          {estimates.map((estimate) => {
            const speaker = speakerByTurn.get(estimate.t)
            return (
              <tr key={estimate.t}>
                <td>{estimate.t}</td>
                <td>{speaker ? SPEAKER_LABEL[speaker] : ''}</td>
                <td>{formatProbability(estimate.probability)}</td>
                <td>{formatSigned(estimate.momentum)}</td>
                <td>{estimate.turningPoint ? 'Yes' : 'No'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

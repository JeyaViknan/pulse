/**
 * MOCK MODEL — interface demonstration only.
 *
 * A deterministic keyword heuristic standing in for the Pulse backend until the trained
 * artefact exists. It is not the Pulse model: it is not trained, not calibrated and not
 * evaluated, and none of its numbers may be reported as results. Its only purpose is to
 * drive the interface end to end with plausible behaviour.
 *
 * Like the real model it is causal by construction: the estimate after turn t depends
 * only on turns 1…t. Each turn shifts the log-odds by a fixed amount for every cue it
 * contains, starting from the base rate.
 */
import type { Estimate, MovementHighlight, Speaker, StageTimings, Summary, Turn } from '../../types/pulse'

interface Cue {
  pattern: RegExp
  weight: number
}

type TurnText = Pick<Turn, 'speaker' | 'text'>

const CUSTOMER_CUES: readonly Cue[] = [
  { pattern: /\b(sounds? (good|great)|that works|could work|makes sense|love (that|this)|perfect)\b/, weight: 0.6 },
  { pattern: /\b(interested|interesting)\b/, weight: 0.45 },
  { pattern: /\b(demo|trial|pilot)\b/, weight: 0.3 },
  { pattern: /\b(next steps?|move forward|get started|send it over)\b/, weight: 0.8 },
  { pattern: /\b(budget (is )?(approved|allocated|signed off)|we have (the )?budget)\b/, weight: 0.7 },
  { pattern: /\b(how (soon|quickly)|when (can|could) we (start|begin))\b/, weight: 0.45 },
  { pattern: /\b(been (looking|struggling)|we need (something|a better))\b/, weight: 0.3 },
  { pattern: /\b(too expensive|expensive|more than we (expected|budgeted|planned)|(over|out of) (our )?budget|too much)\b/, weight: -1.15 },
  { pattern: /\b(not sure|unsure|hesitant|skeptical|sceptical)\b/, weight: -0.45 },
  { pattern: /\b(not (a )?priority|not right now|next (quarter|year)|circle back|revisit (this )?later)\b/, weight: -0.85 },
  { pattern: /\b(competitor|another vendor|cheaper (option|alternative)|already (use|using|have) (a|another))\b/, weight: -0.6 },
  { pattern: /\b(no budget|budget freeze|can'?t justify|cannot justify)\b/, weight: -1.0 },
  { pattern: /\b(just|only) (exploring|looking|browsing)\b/, weight: -0.35 },
  { pattern: /\b(need to (check|talk|run it by)|get back to you|loop in)\b/, weight: -0.25 },
  { pattern: /\b(not interested|no thanks)\b/, weight: -1.3 },
]

const DEALER_CUES: readonly Cue[] = [
  { pattern: /\b(fair point|good question|i understand|understood|that makes sense)\b/, weight: 0.15 },
  { pattern: /\b(pilot|trial|free (month|trial))\b/, weight: 0.3 },
  { pattern: /\b(onboarding (is )?included|no set-?up fee|only pay|pay only)\b/, weight: 0.3 },
  { pattern: /\b(annual (plan|pricing)|discount)\b/, weight: 0.3 },
  { pattern: /\b(price is (fixed|firm)|non-negotiable|can'?t (offer|do|move)|no flexibility)\b/, weight: -0.55 },
  { pattern: /\b(sign today|limited time|act now)\b/, weight: -0.3 },
]

export const MOCK_ARTEFACT_VERSION = 'mock-0'

const logit = (p: number): number => Math.log(p / (1 - p))
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))

/** Log-odds shift contributed by one turn. */
export function turnEffect(turn: TurnText): number {
  const cues = turn.speaker === 'customer' ? CUSTOMER_CUES : DEALER_CUES
  const text = turn.text.toLowerCase()
  return cues.reduce((sum, cue) => (cue.pattern.test(text) ? sum + cue.weight : sum), 0)
}

/** p_1 … p_T. Entry t depends only on turns 1…t. */
export function probabilityPath(turns: readonly TurnText[], baseRate: number): number[] {
  let z = logit(baseRate)
  return turns.map((turn) => {
    z += turnEffect(turn)
    return sigmoid(z)
  })
}

/**
 * p′_1 … p′_T with turn `maskedTurn` (1-based) removed. Entries before the masked turn equal
 * the real path; the masked turn contributes nothing, so p′_k = p′_(k−1).
 */
export function counterfactualPath(turns: readonly TurnText[], baseRate: number, maskedTurn: number): number[] {
  let z = logit(baseRate)
  return turns.map((turn, index) => {
    if (index + 1 !== maskedTurn) z += turnEffect(turn)
    return sigmoid(z)
  })
}

/** Builds the estimate for every turn: momentum from the previous probability (p_0 = base rate) and the τ rule. */
export function toEstimates(
  path: readonly number[],
  baseRate: number,
  tau: number,
  timings: (t: number) => StageTimings,
): Estimate[] {
  return path.map((probability, index) => {
    const previous = index === 0 ? baseRate : (path[index - 1] ?? baseRate)
    const momentum = probability - previous
    return {
      t: index + 1,
      probability,
      momentum,
      turningPoint: Math.abs(momentum) >= tau,
      timings: timings(index + 1),
    }
  })
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function shareOf(speaker: Speaker, turns: readonly Turn[], measure: (turn: Turn) => number): number {
  const total = turns.reduce((sum, turn) => sum + measure(turn), 0)
  if (total === 0) return 0
  const part = turns.filter((turn) => turn.speaker === speaker).reduce((sum, turn) => sum + measure(turn), 0)
  return part / total
}

/** End-of-call summary from values already computed during the call. No further scoring. */
export function summarise(turns: readonly Turn[], estimates: readonly Estimate[], baseRate: number): Summary {
  const finalProbability = estimates.at(-1)?.probability ?? baseRate
  const largestMovements: MovementHighlight[] = [...estimates]
    .filter((estimate) => estimate.momentum !== 0)
    .sort((a, b) => Math.abs(b.momentum) - Math.abs(a.momentum) || a.t - b.t)
    .slice(0, 3)
    .flatMap((estimate) => {
      const turn = turns.find((candidate) => candidate.t === estimate.t)
      return turn ? [{ t: turn.t, speaker: turn.speaker, text: turn.text, momentum: estimate.momentum }] : []
    })

  return {
    finalProbability,
    baseRate,
    totalMovement: finalProbability - baseRate,
    largestMovements,
    dealerTurnShare: shareOf('dealer', turns, () => 1),
    dealerWordShare: shareOf('dealer', turns, (turn) => wordCount(turn.text)),
    turningPointCount: estimates.filter((estimate) => estimate.turningPoint).length,
    turnCount: turns.length,
  }
}

/**
 * In-browser stand-in for the Pulse backend. Implements `PulseService` with the same event
 * sequence the WebSocket contract defines, using the mock model for estimates and the demo
 * script for "transcripts". Replace with a `PulseApiService` once the FastAPI backend exists.
 */
import { DEMO_SCRIPTS, LIVE_DEMO_SCRIPT, type DemoScript } from '../../data/demoScripts'
import { SPEAKER_LABEL } from '../../lib/speakers'
import type {
  Counterfactual,
  Estimate,
  Health,
  SavedSession,
  SavedSessionRef,
  SessionInfo,
  Speaker,
  StageTimings,
  Summary,
  Turn,
} from '../../types/pulse'
import type { LiveSession, PulseService, SessionEvent, SessionListener } from '../pulseService'
import { MOCK_ARTEFACT_VERSION, counterfactualPath, probabilityPath, summarise, toEstimates } from './mockModel'

export interface MockPulseServiceOptions {
  /** π̂ reported to the interface. Placeholder until EDA-01 measures the real class balance. */
  baseRate?: number
  /** Turning-point threshold τ. Placeholder until it is fitted on validation data. */
  tau?: number
  /** Simulated transcription time for a push-to-talk turn. */
  transcribeMs?: number
  /** Simulated encoding + model time for every turn. */
  updateMs?: number
  /** Supplies transcripts for audio turns, in order per speaker. */
  liveScript?: DemoScript
  /** Injectable delay so tests can run without real timers. */
  wait?: (ms: number) => Promise<void>
  /** Injectable clock for saved-session names. */
  now?: () => Date
}

const DEFAULTS = {
  baseRate: 0.4,
  tau: 0.2,
  transcribeMs: 750,
  updateMs: 350,
} as const

const SIMULATED_ENCODE_MS = 18
const SIMULATED_MODEL_MS = 4
const DEMO_SAVED_AT = '2026-09-22T09:00:00.000Z'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function timingsFor(asrMs: number | null): StageTimings {
  return {
    asrMs,
    encodeMs: SIMULATED_ENCODE_MS,
    modelMs: SIMULATED_MODEL_MS,
    totalMs: (asrMs ?? 0) + SIMULATED_ENCODE_MS + SIMULATED_MODEL_MS,
  }
}

class MockLiveSession implements LiveSession {
  readonly info: SessionInfo
  readonly turns: Turn[] = []
  readonly estimates: Estimate[] = []
  private readonly listeners = new Set<SessionListener>()
  private readonly queues: Record<Speaker, string[]>
  private readonly transcribeMs: number
  private readonly updateMs: number
  private readonly wait: (ms: number) => Promise<void>
  private busy = false
  private ended = false
  private closed = false

  constructor(
    info: SessionInfo,
    script: DemoScript,
    transcribeMs: number,
    updateMs: number,
    wait: (ms: number) => Promise<void>,
  ) {
    this.info = info
    this.transcribeMs = transcribeMs
    this.updateMs = updateMs
    this.wait = wait
    this.queues = {
      dealer: script.turns.filter((turn) => turn.speaker === 'dealer').map((turn) => turn.text),
      customer: script.turns.filter((turn) => turn.speaker === 'customer').map((turn) => turn.text),
    }
  }

  get isEnded(): boolean {
    return this.ended
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  sendAudio(speaker: Speaker, _audio: Blob): void {
    void this.process(speaker, null)
  }

  sendText(speaker: Speaker, text: string): void {
    void this.process(speaker, text)
  }

  endCall(): void {
    this.ended = true
  }

  close(): void {
    this.closed = true
    this.listeners.clear()
  }

  private emit(event: SessionEvent): void {
    if (this.closed) return
    for (const listener of [...this.listeners]) listener(event)
  }

  /** `typedText` is null for audio turns, which take their text from the script. */
  private async process(speaker: Speaker, typedText: string | null): Promise<void> {
    if (this.closed) return
    if (this.ended) {
      this.emit({ type: 'error', stage: 'session', message: 'The call has ended. Start a new call to add turns.' })
      return
    }
    if (this.busy) {
      this.emit({ type: 'error', stage: 'session', message: 'Still processing the previous turn.' })
      return
    }

    const fromAudio = typedText === null
    let text: string | undefined

    if (fromAudio) {
      this.busy = true
      this.emit({ type: 'status', state: 'transcribing' })
      await this.wait(this.transcribeMs)
      if (this.closed) return
      text = this.queues[speaker].shift()
      if (text === undefined) {
        this.busy = false
        this.emit({
          type: 'error',
          stage: 'asr',
          message: `The mock script has no more ${SPEAKER_LABEL[speaker]} lines. Type the turn instead.`,
        })
        this.emit({ type: 'status', state: 'idle' })
        return
      }
    } else {
      text = typedText.trim()
      if (text.length === 0) {
        this.emit({ type: 'error', stage: 'input', message: 'Type something before sending the turn.' })
        return
      }
      this.busy = true
    }

    const turn: Turn = { t: this.turns.length + 1, speaker, text }
    this.turns.push(turn)
    if (!fromAudio) this.emit({ type: 'status', state: 'updating' })
    this.emit({ type: 'turn', turn })
    if (fromAudio) this.emit({ type: 'status', state: 'updating' })

    await this.wait(this.updateMs)
    if (this.closed) return

    const path = probabilityPath(this.turns, this.info.baseRate)
    const estimate = toEstimates(path, this.info.baseRate, this.info.tau, () =>
      timingsFor(fromAudio ? this.transcribeMs : null),
    ).at(-1)
    if (estimate) {
      this.estimates.push(estimate)
      this.emit({ type: 'estimate', estimate })
    }
    this.busy = false
    this.emit({ type: 'status', state: 'idle' })
  }
}

function scoreScript(script: DemoScript, baseRate: number, tau: number): SavedSession {
  const turns: Turn[] = script.turns.map((turn, index) => ({ t: index + 1, ...turn }))
  const estimates = toEstimates(probabilityPath(turns, baseRate), baseRate, tau, () => timingsFor(null))
  return {
    name: script.name,
    title: script.title,
    description: script.description,
    artefactVersion: MOCK_ARTEFACT_VERSION,
    baseRate,
    tau,
    turns,
    estimates,
    summary: summarise(turns, estimates, baseRate),
  }
}

function toRef(session: SavedSession, savedAt: string): SavedSessionRef {
  return { name: session.name, title: session.title, turnCount: session.turns.length, savedAt }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export class MockPulseService implements PulseService {
  private readonly baseRate: number
  private readonly tau: number
  private readonly transcribeMs: number
  private readonly updateMs: number
  private readonly liveScript: DemoScript
  private readonly wait: (ms: number) => Promise<void>
  private readonly now: () => Date
  private readonly sessions = new Map<string, MockLiveSession>()
  private readonly saved = new Map<string, { session: SavedSession; savedAt: string }>()
  private sequence = 0

  constructor(options: MockPulseServiceOptions = {}) {
    this.baseRate = options.baseRate ?? DEFAULTS.baseRate
    this.tau = options.tau ?? DEFAULTS.tau
    this.transcribeMs = options.transcribeMs ?? DEFAULTS.transcribeMs
    this.updateMs = options.updateMs ?? DEFAULTS.updateMs
    this.liveScript = options.liveScript ?? LIVE_DEMO_SCRIPT
    this.wait = options.wait ?? sleep
    this.now = options.now ?? (() => new Date())

    for (const script of DEMO_SCRIPTS) {
      this.saved.set(script.name, { session: scoreScript(script, this.baseRate, this.tau), savedAt: DEMO_SAVED_AT })
    }
  }

  health(): Promise<Health> {
    return Promise.resolve({ status: 'ok', modelKind: 'mock', artefactVersion: MOCK_ARTEFACT_VERSION })
  }

  startSession(): Promise<LiveSession> {
    this.sequence += 1
    const info: SessionInfo = { id: `mock-${this.sequence}`, baseRate: this.baseRate, tau: this.tau }
    const session = new MockLiveSession(info, this.liveScript, this.transcribeMs, this.updateMs, this.wait)
    this.sessions.set(info.id, session)
    return Promise.resolve(session)
  }

  async counterfactual(sessionId: string, maskedTurn: number): Promise<Counterfactual> {
    const session = this.requireSession(sessionId)
    const scored = session.estimates.length
    if (!Number.isInteger(maskedTurn) || maskedTurn < 1 || maskedTurn > scored) {
      throw new Error(`Turn ${maskedTurn} has no estimate to replay.`)
    }
    await this.wait(this.updateMs)
    const turns = session.turns.slice(0, scored)
    const path = counterfactualPath(turns, this.baseRate, maskedTurn)
    const realFinal = session.estimates.at(-1)?.probability ?? this.baseRate
    const ghostFinal = path.at(-1) ?? this.baseRate
    return { maskedTurn, path, deltaT: realFinal - ghostFinal }
  }

  summary(sessionId: string): Promise<Summary> {
    const session = this.requireSession(sessionId)
    return Promise.resolve(summarise(session.turns.slice(0, session.estimates.length), session.estimates, this.baseRate))
  }

  saveSession(sessionId: string): Promise<SavedSessionRef> {
    const session = this.requireSession(sessionId)
    const turns = session.turns.slice(0, session.estimates.length)
    if (turns.length === 0) return Promise.reject(new Error('Nothing to save: the call has no turns yet.'))

    const time = this.now()
    const stamp = `${time.getFullYear()}${pad(time.getMonth() + 1)}${pad(time.getDate())}-${pad(time.getHours())}${pad(time.getMinutes())}${pad(time.getSeconds())}`
    const saved: SavedSession = {
      name: `call-${stamp}`,
      title: `Live call · ${pad(time.getHours())}:${pad(time.getMinutes())}`,
      description: null,
      artefactVersion: MOCK_ARTEFACT_VERSION,
      baseRate: this.baseRate,
      tau: this.tau,
      turns,
      estimates: [...session.estimates],
      summary: summarise(turns, session.estimates, this.baseRate),
    }
    const savedAt = time.toISOString()
    this.saved.set(saved.name, { session: saved, savedAt })
    return Promise.resolve(toRef(saved, savedAt))
  }

  listSessions(): Promise<SavedSessionRef[]> {
    return Promise.resolve([...this.saved.values()].map(({ session, savedAt }) => toRef(session, savedAt)))
  }

  loadSession(name: string): Promise<SavedSession> {
    const entry = this.saved.get(name)
    if (!entry) return Promise.reject(new Error(`No saved session named “${name}”.`))
    return Promise.resolve(structuredClone(entry.session))
  }

  private requireSession(sessionId: string): MockLiveSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session “${sessionId}”.`)
    return session
  }
}

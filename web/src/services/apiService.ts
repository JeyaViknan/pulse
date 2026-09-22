/**
 * `PulseService` over the local FastAPI backend: REST for requests, one WebSocket per call.
 * All payloads are converted with `contractMapping.ts`; nothing here computes model output.
 */
import {
  ROUTES,
  type WireCounterfactualResponse,
  type WireCreateSessionResponse,
  type WireDeleteTurnResponse,
  type WireErrorBody,
  type WireHealth,
  type WireSaveResponse,
  type WireSavedSession,
  type WireServerMessage,
  type WireSessionListItem,
  type WireSummary,
} from '../types/contract'
import type {
  Counterfactual,
  Health,
  SavedSession,
  SavedSessionRef,
  SessionInfo,
  Speaker,
  Summary,
} from '../types/pulse'
import {
  fromWireCounterfactual,
  fromWireHealth,
  fromWireSavedSession,
  fromWireServerMessage,
  fromWireSession,
  fromWireSessionRef,
  fromWireSummary,
  toWireAudioEnvelope,
  toWireTextMessage,
} from './contractMapping'
import type { LiveSession, PulseService, SessionEvent, SessionListener } from './pulseService'

const CONNECT_TIMEOUT_MS = 8000

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/** Minimal WebSocket surface used here, so tests can substitute a fake. */
export interface SocketLike {
  readonly readyState: number
  binaryType: BinaryType
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
}

export interface ApiServiceOptions {
  /** Origin of the backend, e.g. `http://127.0.0.1:8000`. Defaults to the page's origin. */
  baseUrl?: string
  fetch?: typeof fetch
  createSocket?: (url: string) => SocketLike
}

const SOCKET_OPEN = 1

class ApiLiveSession implements LiveSession {
  readonly info: SessionInfo
  private readonly socket: SocketLike
  private readonly listeners = new Set<SessionListener>()
  private closedByClient = false

  constructor(info: SessionInfo, socket: SocketLike) {
    this.info = info
    this.socket = socket
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      try {
        this.emit(fromWireServerMessage(JSON.parse(event.data) as WireServerMessage))
      } catch {
        this.emit({ type: 'error', stage: 'protocol', message: 'Received a message the interface does not understand.' })
      }
    }
    socket.onclose = () => {
      if (!this.closedByClient) {
        this.emit({ type: 'error', stage: 'connection', message: 'Lost the connection to the Pulse server.' })
      }
    }
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  sendAudio(speaker: Speaker, audio: Blob): void {
    audio.arrayBuffer().then(
      (buffer) => {
        if (!this.ensureOpen()) return
        // Envelope first, then exactly one binary frame (see WireClientMessage).
        this.socket.send(JSON.stringify(toWireAudioEnvelope(speaker, audio)))
        this.socket.send(buffer)
      },
      () => this.emit({ type: 'error', stage: 'audio', message: 'The recording could not be read.' }),
    )
  }

  sendText(speaker: Speaker, text: string): void {
    if (!this.ensureOpen()) return
    this.socket.send(JSON.stringify(toWireTextMessage(speaker, text)))
  }

  endCall(): void {
    if (this.socket.readyState === SOCKET_OPEN) this.socket.send(JSON.stringify({ type: 'end_call' }))
  }

  close(): void {
    this.closedByClient = true
    this.listeners.clear()
    this.socket.close()
  }

  private ensureOpen(): boolean {
    if (this.socket.readyState === SOCKET_OPEN) return true
    this.emit({ type: 'error', stage: 'connection', message: 'Not connected to the Pulse server. Start a new call.' })
    return false
  }

  private emit(event: SessionEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

export class PulseApiService implements PulseService {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly createSocket: (url: string) => SocketLike

  constructor(options: ApiServiceOptions = {}) {
    this.baseUrl = (options.baseUrl ?? window.location.origin).replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? window.fetch.bind(window)
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url))
  }

  async health(): Promise<Health> {
    return fromWireHealth(await this.request<WireHealth>('GET', ROUTES.health()))
  }

  async startSession(): Promise<LiveSession> {
    const info = fromWireSession(await this.request<WireCreateSessionResponse>('POST', ROUTES.createSession()))
    const socket = this.createSocket(this.socketUrl(ROUTES.liveSocket(info.id)))
    socket.binaryType = 'arraybuffer'
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close()
        reject(new Error('The live connection did not open.'))
      }, CONNECT_TIMEOUT_MS)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error('The live connection could not be opened.'))
      }
    })
    socket.onopen = null
    socket.onerror = null
    return new ApiLiveSession(info, socket)
  }

  async counterfactual(sessionId: string, maskedTurn: number): Promise<Counterfactual> {
    const response = await this.request<WireCounterfactualResponse>('POST', ROUTES.counterfactual(sessionId), {
      mask: [maskedTurn],
    })
    return fromWireCounterfactual(maskedTurn, response)
  }

  async summary(sessionId: string): Promise<Summary> {
    return fromWireSummary(await this.request<WireSummary>('GET', ROUTES.summary(sessionId)))
  }

  async deleteLastTurn(sessionId: string): Promise<number> {
    return (await this.request<WireDeleteTurnResponse>('DELETE', ROUTES.lastTurn(sessionId))).turn_count
  }

  async saveSession(sessionId: string): Promise<SavedSessionRef> {
    return fromWireSessionRef(await this.request<WireSaveResponse>('POST', ROUTES.save(sessionId)))
  }

  async listSessions(): Promise<SavedSessionRef[]> {
    return (await this.request<WireSessionListItem[]>('GET', ROUTES.sessions())).map(fromWireSessionRef)
  }

  async loadSession(name: string): Promise<SavedSession> {
    return fromWireSavedSession(await this.request<WireSavedSession>('GET', ROUTES.session(name)))
  }

  private socketUrl(path: string): string {
    const url = new URL(path, this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new ApiError(0, 'The Pulse server is not reachable. Is `uv run pulse-serve` running?')
    }
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`
      try {
        const parsed = (await response.json()) as WireErrorBody
        if (typeof parsed.detail === 'string') detail = parsed.detail
      } catch {
        // keep the status line
      }
      throw new ApiError(response.status, detail)
    }
    return (await response.json()) as T
  }
}

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from './pulseService'
import { ApiError, PulseApiService, type SocketLike } from './apiService'

class FakeSocket implements SocketLike {
  readyState = 0
  binaryType: BinaryType = 'blob'
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  readonly sent: (string | ArrayBuffer)[] = []
  readonly url: string

  constructor(url: string) {
    this.url = url
    queueMicrotask(() => {
      this.readyState = 1
      this.onopen?.(new Event('open'))
    })
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.({} as CloseEvent)
  }

  receive(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
}

interface Call {
  url: string
  method: string
  body: unknown
}

function fakeBackend(responses: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const key = `${method} ${new URL(url).pathname}`
    const response = responses[key]
    if (!response) return new Response(JSON.stringify({ detail: `no route ${key}` }), { status: 404 })
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('PulseApiService', () => {
  it('creates a session, opens the live socket and relays server messages', async () => {
    const sockets: FakeSocket[] = []
    const { fetchImpl } = fakeBackend({ 'POST /session': { body: { id: 'abc', base_rate: 0.499, tau: 0.12 } } })
    const service = new PulseApiService({
      baseUrl: 'http://127.0.0.1:8000',
      fetch: fetchImpl,
      createSocket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket
      },
    })

    const session = await service.startSession()
    expect(session.info).toEqual({ id: 'abc', baseRate: 0.499, tau: 0.12 })
    const socket = sockets[0]!
    expect(socket.url).toBe('ws://127.0.0.1:8000/ws/session/abc')
    expect(socket.binaryType).toBe('arraybuffer')

    const events: SessionEvent[] = []
    session.subscribe((event) => events.push(event))
    socket.receive({ type: 'status', state: 'updating' })
    socket.receive({ type: 'turn', t: 1, speaker: 'dealer', text: 'Hello' })
    socket.receive({
      type: 'estimate',
      t: 1,
      p: 0.52,
      m: 0.021,
      turning_point: false,
      timings_ms: { asr: null, encode: 9, model: 2, total: 12 },
    })
    expect(events.map((event) => event.type)).toEqual(['status', 'turn', 'estimate'])

    session.sendText('dealer', 'Hello')
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'turn_text', speaker: 'dealer', text: 'Hello' })

    session.sendAudio('customer', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm;codecs=opus' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(JSON.parse(socket.sent[1] as string)).toEqual({
      type: 'turn_audio',
      speaker: 'customer',
      mime_type: 'audio/webm;codecs=opus',
    })
    expect(new Uint8Array(socket.sent[2] as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]))

    session.endCall()
    expect(JSON.parse(socket.sent[3] as string)).toEqual({ type: 'end_call' })
  })

  it('reports a dropped connection, but not one the interface closed itself', async () => {
    const sockets: FakeSocket[] = []
    const { fetchImpl } = fakeBackend({ 'POST /session': { body: { id: 'x', base_rate: 0.5, tau: 0.1 } } })
    const service = new PulseApiService({
      baseUrl: 'http://localhost:8000',
      fetch: fetchImpl,
      createSocket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        return socket
      },
    })
    const first = await service.startSession()
    const events: SessionEvent[] = []
    first.subscribe((event) => events.push(event))
    sockets[0]!.close()
    expect(events).toEqual([{ type: 'error', stage: 'connection', message: 'Lost the connection to the Pulse server.' }])

    const second = await service.startSession()
    const quiet: SessionEvent[] = []
    second.subscribe((event) => quiet.push(event))
    second.close()
    expect(quiet).toEqual([])
  })

  it('maps REST responses and sends the counterfactual mask', async () => {
    const { calls, fetchImpl } = fakeBackend({
      'POST /session/abc/counterfactual': { body: { path: [0.5, 0.5, 0.71], delta_T: -0.2 } },
      'DELETE /session/abc/turns/last': { body: { turn_count: 2 } },
      'GET /sessions': { body: [{ name: 'call-1', title: 'Call', turn_count: 3, saved_at: '2026-09-22T10:00:00' }] },
    })
    const service = new PulseApiService({ baseUrl: 'http://127.0.0.1:8000', fetch: fetchImpl })

    expect(await service.counterfactual('abc', 2)).toEqual({ maskedTurn: 2, path: [0.5, 0.5, 0.71], deltaT: -0.2 })
    expect(calls[0]).toMatchObject({ method: 'POST', body: { mask: [2] } })
    expect(await service.deleteLastTurn('abc')).toBe(2)
    expect(await service.listSessions()).toEqual([
      { name: 'call-1', title: 'Call', turnCount: 3, savedAt: '2026-09-22T10:00:00' },
    ])
  })

  it('surfaces the server’s error detail', async () => {
    const { fetchImpl } = fakeBackend({
      'GET /session/abc/summary': { status: 409, body: { detail: 'The call has no turns yet.' } },
    })
    const service = new PulseApiService({ baseUrl: 'http://127.0.0.1:8000', fetch: fetchImpl })
    await expect(service.summary('abc')).rejects.toEqual(new ApiError(409, 'The call has no turns yet.'))
  })

  it('explains an unreachable server', async () => {
    const service = new PulseApiService({
      baseUrl: 'http://127.0.0.1:8000',
      fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch,
    })
    await expect(service.health()).rejects.toThrow(/not reachable/)
  })
})

import { describe, expect, it } from 'vitest'
import type { LiveSession, SessionEvent } from '../pulseService'
import { MockPulseService } from './mockPulseService'

const instant = () => Promise.resolve()

function record(session: LiveSession) {
  const events: SessionEvent[] = []
  session.subscribe((event) => events.push(event))
  return events
}

async function settle(events: SessionEvent[], idleCount: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (events.filter((event) => event.type === 'status' && event.state === 'idle').length >= idleCount) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Session did not settle')
}

describe('MockPulseService', () => {
  it('reports itself as a mock model', async () => {
    const health = await new MockPulseService({ wait: instant }).health()
    expect(health.modelKind).toBe('mock')
  })

  it('emits the contract sequence for a push-to-talk turn', async () => {
    const service = new MockPulseService({ wait: instant })
    const session = await service.startSession()
    const events = record(session)

    session.sendAudio('dealer', new Blob())
    await settle(events, 1)

    expect(events.map((event) => (event.type === 'status' ? `status:${event.state}` : event.type))).toEqual([
      'status:transcribing',
      'turn',
      'status:updating',
      'estimate',
      'status:idle',
    ])
    const turn = events.find((event) => event.type === 'turn')
    expect(turn?.type === 'turn' && turn.turn.speaker).toBe('dealer')
  })

  it('skips transcription for a typed turn', async () => {
    const service = new MockPulseService({ wait: instant })
    const session = await service.startSession()
    const events = record(session)

    session.sendText('customer', "  I'm interested.  ")
    await settle(events, 1)

    expect(events.some((event) => event.type === 'status' && event.state === 'transcribing')).toBe(false)
    const turn = events.find((event) => event.type === 'turn')
    expect(turn?.type === 'turn' && turn.turn.text).toBe("I'm interested.")
    const estimate = events.find((event) => event.type === 'estimate')
    expect(estimate?.type === 'estimate' && estimate.estimate.timings.asrMs).toBeNull()
  })

  it('reports an error once the mock script has no more lines for a speaker', async () => {
    const service = new MockPulseService({
      wait: instant,
      liveScript: { name: 'x', title: 'x', description: 'x', turns: [{ speaker: 'dealer', text: 'Hello.' }] },
    })
    const session = await service.startSession()
    const events = record(session)

    session.sendAudio('customer', new Blob())
    await settle(events, 1)

    const error = events.find((event) => event.type === 'error')
    expect(error?.type === 'error' && error.stage).toBe('asr')
    expect(events.some((event) => event.type === 'turn')).toBe(false)
  })

  it('replays a turn and reports its effect on the final estimate', async () => {
    const service = new MockPulseService({ wait: instant })
    const session = await service.startSession()
    const events = record(session)

    session.sendAudio('dealer', new Blob())
    await settle(events, 1)
    session.sendAudio('customer', new Blob())
    await settle(events, 2)
    session.sendAudio('customer', new Blob())
    await settle(events, 3)

    const estimates = events.flatMap((event) => (event.type === 'estimate' ? [event.estimate] : []))
    const result = await service.counterfactual(session.info.id, 3)
    expect(result.maskedTurn).toBe(3)
    expect(result.path).toHaveLength(3)
    expect(result.path.slice(0, 2)).toEqual(estimates.slice(0, 2).map((estimate) => estimate.probability))
    expect(result.deltaT).toBeCloseTo(estimates.at(-1)!.probability - result.path.at(-1)!, 10)
    await expect(service.counterfactual(session.info.id, 9)).rejects.toThrow()
  })

  it('summarises, saves and reloads a call', async () => {
    const service = new MockPulseService({ wait: instant, now: () => new Date(2026, 8, 22, 14, 5, 9) })
    const session = await service.startSession()
    const events = record(session)
    session.sendText('dealer', 'Hello, thanks for your time.')
    await settle(events, 1)
    session.sendText('customer', "That's more than we expected.")
    await settle(events, 2)

    const summary = await service.summary(session.info.id)
    expect(summary.turnCount).toBe(2)

    const saved = await service.saveSession(session.info.id)
    expect(saved.name).toBe('call-20260922-140509')
    expect((await service.listSessions()).map((item) => item.name)).toContain(saved.name)

    const loaded = await service.loadSession(saved.name)
    expect(loaded.turns).toHaveLength(2)
    expect(loaded.summary).toEqual(summary)
  })

  it('provides the three demo scenarios for Replay mode', async () => {
    const names = (await new MockPulseService({ wait: instant }).listSessions()).map((item) => item.name)
    expect(names).toEqual(expect.arrayContaining(['demo-close', 'demo-lost', 'demo-recovery']))
  })
})

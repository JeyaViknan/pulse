import { useCallback, useEffect, useState } from 'react'
import type { PulseService } from '../services/pulseService'
import type { SavedSession, SavedSessionRef } from '../types/pulse'

export const PLAYBACK_SPEEDS = [0.5, 1, 2] as const
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]

/** Time between turns at 1× speed. */
const STEP_MS = 1600

export interface PlaybackControls {
  sessions: SavedSessionRef[]
  session: SavedSession | null
  /** Number of turns revealed, 0…total. */
  position: number
  total: number
  isPlaying: boolean
  speed: PlaybackSpeed
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  load: (name: string) => Promise<void>
  play: () => void
  pause: () => void
  stepForward: () => void
  stepBack: () => void
  seekToEnd: () => void
  setSpeed: (speed: PlaybackSpeed) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

/**
 * Replay mode: steps through a saved session from stored values. Nothing is re-transcribed
 * or re-scored, so replay works with no microphone and no model (SPEC.md §5.5).
 */
export function usePlayback(service: PulseService): PlaybackControls {
  const [sessions, setSessions] = useState<SavedSessionRef[]>([])
  const [session, setSession] = useState<SavedSession | null>(null)
  const [position, setPosition] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<PlaybackSpeed>(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const total = session?.turns.length ?? 0
  const isPlaying = playing && position < total

  const load = useCallback(
    async (name: string) => {
      setLoading(true)
      setPlaying(false)
      try {
        setSession(await service.loadSession(name))
        setPosition(0)
        setError(null)
      } catch (caught: unknown) {
        setError(`Could not load the session: ${messageOf(caught)}`)
      } finally {
        setLoading(false)
      }
    },
    [service],
  )

  const refresh = useCallback(async () => {
    try {
      const listed = await service.listSessions()
      setSessions(listed)
      setError(null)
      const first = listed[0]
      if (first && session === null) await load(first.name)
    } catch (caught: unknown) {
      setError(`Could not list saved sessions: ${messageOf(caught)}`)
    }
  }, [service, session, load])

  useEffect(() => {
    if (!isPlaying) return undefined
    const timer = window.setTimeout(() => setPosition((value) => Math.min(value + 1, total)), STEP_MS / speed)
    return () => window.clearTimeout(timer)
  }, [isPlaying, position, total, speed])

  const play = useCallback(() => {
    if (total === 0) return
    if (position >= total) setPosition(0)
    setPlaying(true)
  }, [position, total])

  const pause = useCallback(() => setPlaying(false), [])

  const stepForward = useCallback(() => {
    setPlaying(false)
    setPosition((value) => Math.min(value + 1, total))
  }, [total])

  const stepBack = useCallback(() => {
    setPlaying(false)
    setPosition((value) => Math.max(value - 1, 0))
  }, [])

  const seekToEnd = useCallback(() => {
    setPlaying(false)
    setPosition(total)
  }, [total])

  return {
    sessions,
    session,
    position,
    total,
    isPlaying,
    speed,
    loading,
    error,
    refresh,
    load,
    play,
    pause,
    stepForward,
    stepBack,
    seekToEnd,
    setSpeed,
  }
}

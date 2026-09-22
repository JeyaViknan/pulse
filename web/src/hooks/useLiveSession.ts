import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { LiveSession, PulseService } from '../services/pulseService'
import type { Recorder } from '../services/recorder'
import {
  canEndCall,
  canStartTurn,
  initialLiveState,
  liveReducer,
  selectionIntent,
  type LiveState,
} from '../state/liveSession'
import type { SavedSessionRef, Speaker } from '../types/pulse'

export interface LiveSessionControls {
  state: LiveState
  startRecording: (speaker: Speaker) => void
  stopRecording: (speaker: Speaker) => void
  /** Returns false when the turn could not be sent (empty text, or a turn already in flight). */
  submitText: (speaker: Speaker, text: string) => boolean
  selectTurn: (turn: number) => void
  dismissCounterfactual: () => void
  endCall: () => void
  newCall: () => void
  saveSession: () => Promise<SavedSessionRef | null>
  dismissNotice: () => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

/** Owns one live call: connects to the service, relays its events and performs user actions. */
export function useLiveSession(service: PulseService, recorder: Recorder): LiveSessionControls {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState)
  const [generation, setGeneration] = useState(0)
  const sessionRef = useRef<LiveSession | null>(null)

  useEffect(() => {
    let cancelled = false
    let session: LiveSession | null = null
    let unsubscribe: (() => void) | null = null

    service.startSession().then(
      (started) => {
        if (cancelled) {
          started.close()
          return
        }
        session = started
        sessionRef.current = started
        unsubscribe = started.subscribe((event) => dispatch({ type: 'server-event', event }))
        dispatch({ type: 'session-started', session: started.info })
      },
      (error: unknown) => {
        if (!cancelled) dispatch({ type: 'session-failed', message: `Could not start a session. ${messageOf(error)}` })
      },
    )

    return () => {
      cancelled = true
      unsubscribe?.()
      session?.close()
      if (sessionRef.current === session) sessionRef.current = null
    }
  }, [service, generation])

  const startRecording = useCallback(
    (speaker: Speaker) => {
      if (!canStartTurn(state)) return
      dispatch({ type: 'recording-started', speaker })
      recorder.start().catch((error: unknown) => {
        recorder.cancel()
        dispatch({ type: 'recording-cancelled' })
        dispatch({ type: 'notice', kind: 'error', message: `Microphone unavailable: ${messageOf(error)} Type the turn instead.` })
      })
    },
    [state, recorder],
  )

  const stopRecording = useCallback(
    (speaker: Speaker) => {
      if (state.phase !== 'listening' || state.recordingSpeaker !== speaker) return
      dispatch({ type: 'recording-stopped' })
      recorder.stop().then(
        (audio) => sessionRef.current?.sendAudio(speaker, audio),
        (error: unknown) => dispatch({ type: 'turn-failed', message: `Recording failed: ${messageOf(error)}` }),
      )
    },
    [state.phase, state.recordingSpeaker, recorder],
  )

  const submitText = useCallback(
    (speaker: Speaker, text: string) => {
      const trimmed = text.trim()
      const session = sessionRef.current
      if (trimmed.length === 0 || !session || !canStartTurn(state)) return false
      dispatch({ type: 'text-submitted', speaker })
      session.sendText(speaker, trimmed)
      return true
    },
    [state],
  )

  const selectTurn = useCallback(
    (turn: number) => {
      const intent = selectionIntent(state, turn)
      if (intent === 'dismiss') {
        dispatch({ type: 'counterfactual-dismissed' })
        return
      }
      if (intent !== 'request' || !state.session) return
      const sessionId = state.session.id
      dispatch({ type: 'counterfactual-requested', turn })
      service.counterfactual(sessionId, turn).then(
        (result) => dispatch({ type: 'counterfactual-loaded', sessionId, result }),
        (error: unknown) => dispatch({ type: 'counterfactual-failed', sessionId, turn, message: messageOf(error) }),
      )
    },
    [state, service],
  )

  const dismissCounterfactual = useCallback(() => dispatch({ type: 'counterfactual-dismissed' }), [])

  const endCall = useCallback(() => {
    if (!canEndCall(state) || !state.session) return
    const sessionId = state.session.id
    sessionRef.current?.endCall()
    dispatch({ type: 'call-ended' })
    service.summary(sessionId).then(
      (summary) => dispatch({ type: 'summary-loaded', sessionId, summary }),
      (error: unknown) => dispatch({ type: 'summary-failed', sessionId, message: `Summary unavailable: ${messageOf(error)}` }),
    )
  }, [state, service])

  const newCall = useCallback(() => {
    dispatch({ type: 'reset' })
    setGeneration((value) => value + 1)
  }, [])

  const saveSession = useCallback(async () => {
    if (!state.session) return null
    try {
      const saved = await service.saveSession(state.session.id)
      dispatch({ type: 'notice', kind: 'info', message: `Saved “${saved.title}”. Open it from Replay.` })
      return saved
    } catch (error: unknown) {
      dispatch({ type: 'notice', kind: 'error', message: `Could not save the session: ${messageOf(error)}` })
      return null
    }
  }, [state.session, service])

  const dismissNotice = useCallback(() => dispatch({ type: 'notice-dismissed' }), [])

  return {
    state,
    startRecording,
    stopRecording,
    submitText,
    selectTurn,
    dismissCounterfactual,
    endCall,
    newCall,
    saveSession,
    dismissNotice,
  }
}

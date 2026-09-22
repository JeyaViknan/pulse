import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AppShell } from './components/AppShell/AppShell'
import { CallEndedBar } from './components/CallEndedBar/CallEndedBar'
import { CounterfactualPanel } from './components/CounterfactualPanel/CounterfactualPanel'
import { Header, type AppMode } from './components/Header/Header'
import { MomentumReadout } from './components/MomentumReadout/MomentumReadout'
import { NoticeBar } from './components/NoticeBar/NoticeBar'
import { ProbabilityChart } from './components/ProbabilityChart/ProbabilityChart'
import { PushToTalkControls } from './components/PushToTalkControls/PushToTalkControls'
import { ReplayControls } from './components/ReplayControls/ReplayControls'
import { StatusIndicator, type StatusTone } from './components/StatusIndicator/StatusIndicator'
import { SummaryCard } from './components/SummaryCard/SummaryCard'
import { TranscriptPanel, type PendingTurn } from './components/TranscriptPanel/TranscriptPanel'
import { TypedTurnInput } from './components/TypedTurnInput/TypedTurnInput'
import { useKeyboardPushToTalk } from './hooks/useKeyboardPushToTalk'
import { useLiveSession } from './hooks/useLiveSession'
import { usePlayback } from './hooks/usePlayback'
import { SPEAKER_LABEL } from './lib/speakers'
import { createRuntime } from './services'
import { canEndCall, canStartTurn, isProcessing, type LiveState } from './state/liveSession'
import type { Health } from './types/pulse'
import styles from './App.module.css'

interface StatusView {
  label: string
  detail: string | null
  tone: StatusTone
}

function liveStatus(state: LiveState): StatusView {
  if (state.connection === 'connecting') return { label: 'Connecting', detail: null, tone: 'busy' }
  if (state.connection === 'failed') return { label: 'Offline', detail: 'No session', tone: 'idle' }
  switch (state.phase) {
    case 'idle':
      return {
        label: 'Idle',
        detail:
          state.estimates.length === 0
            ? 'Ready for the first turn'
            : `${state.estimates.length} ${state.estimates.length === 1 ? 'turn' : 'turns'} scored`,
        tone: 'idle',
      }
    case 'listening':
      return {
        label: 'Listening',
        detail: state.recordingSpeaker ? SPEAKER_LABEL[state.recordingSpeaker] : null,
        tone: 'active',
      }
    case 'transcribing':
      return {
        label: 'Transcribing',
        detail: state.pendingSpeaker ? SPEAKER_LABEL[state.pendingSpeaker] : null,
        tone: 'busy',
      }
    case 'updating':
      return { label: 'Updating', detail: `Scoring turn ${state.estimates.length + 1}`, tone: 'busy' }
    case 'replaying':
      return { label: 'Replaying', detail: `Without turn ${state.counterfactual?.turn ?? ''}`, tone: 'replaying' }
    case 'summary':
      return { label: 'Summary', detail: 'Call ended', tone: 'done' }
  }
}

function pendingTurn(state: LiveState): PendingTurn | null {
  if (state.phase === 'listening' && state.recordingSpeaker) {
    return { speaker: state.recordingSpeaker, label: 'Listening…', recording: true }
  }
  if (state.phase === 'transcribing' && state.pendingSpeaker) {
    return { speaker: state.pendingSpeaker, label: 'Transcribing…', recording: false }
  }
  if (state.phase === 'updating' && state.pendingSpeaker) {
    return { speaker: state.pendingSpeaker, label: 'Scoring…', recording: false }
  }
  return null
}

export default function App() {
  const [runtime] = useState(createRuntime)
  const live = useLiveSession(runtime.service, runtime.recorder)
  const playback = usePlayback(runtime.service)
  const [mode, setMode] = useState<AppMode>('live')
  const [highlightTurn, setHighlightTurn] = useState<number | null>(null)
  const [health, setHealth] = useState<Health | null>(null)

  const { state } = live
  const isLive = mode === 'live'
  const turnInFlight = state.phase === 'listening' || isProcessing(state)

  useEffect(() => {
    let active = true
    runtime.service.health().then(
      (result) => {
        if (active) setHealth(result)
      },
      () => {
        if (active) setHealth(null)
      },
    )
    return () => {
      active = false
    }
  }, [runtime.service])

  useKeyboardPushToTalk({
    enabled: isLive && !state.callEnded,
    onPress: live.startRecording,
    onRelease: live.stopRecording,
  })

  const { dismissCounterfactual } = live
  useEffect(() => {
    if (!isLive || state.phase !== 'replaying') return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissCounterfactual()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isLive, state.phase, dismissCounterfactual])

  const changeMode = (next: AppMode) => {
    if (next === mode) return
    setHighlightTurn(null)
    setMode(next)
    if (next === 'playback') void playback.refresh()
  }

  // What the transcript and chart show: the live call, or the saved session up to the playback position.
  const playbackTurns = useMemo(
    () => playback.session?.turns.slice(0, playback.position) ?? [],
    [playback.session, playback.position],
  )
  const playbackEstimates = useMemo(
    () => playback.session?.estimates.filter((estimate) => estimate.t <= playback.position) ?? [],
    [playback.session, playback.position],
  )
  const turns = isLive ? state.turns : playbackTurns
  const estimates = isLive ? state.estimates : playbackEstimates
  const baseRate = isLive ? (state.session?.baseRate ?? null) : (playback.session?.baseRate ?? null)
  const tau = isLive ? (state.session?.tau ?? null) : (playback.session?.tau ?? null)

  const counterfactual = isLive && state.counterfactual?.status === 'ready' ? state.counterfactual.result : null
  const selectedTurn = isLive ? (state.counterfactual?.turn ?? null) : null
  const onSelectTurn = isLive && !state.callEnded ? live.selectTurn : undefined

  const latest = estimates.at(-1) ?? null
  const focusT = highlightTurn ?? latest?.t ?? null
  const focusEstimate = estimates.find((estimate) => estimate.t === focusT) ?? null
  const focusTurn = turns.find((turn) => turn.t === focusT) ?? null

  const status: StatusView = isLive
    ? liveStatus(state)
    : {
        label: 'Replay',
        detail: playback.session ? `${playback.session.title} · turn ${playback.position} of ${playback.total}` : 'No session',
        tone: 'replaying',
      }

  const playbackAtEnd = playback.session !== null && playback.total > 0 && playback.position >= playback.total

  let detail: ReactNode
  if (isLive && state.phase === 'summary') {
    detail = <SummaryCard summary={state.summary} status={state.summaryStatus} title="Call summary" />
  } else if (isLive && state.counterfactual) {
    const maskedTurn = state.turns.find((turn) => turn.t === state.counterfactual?.turn) ?? null
    detail = (
      <CounterfactualPanel
        view={state.counterfactual}
        maskedTurn={maskedTurn}
        realFinal={latest?.probability ?? null}
        onDismiss={dismissCounterfactual}
      />
    )
  } else if (!isLive && playbackAtEnd && playback.session) {
    detail = <SummaryCard summary={playback.session.summary} status="ready" title="Session summary" />
  } else {
    detail = (
      <MomentumReadout
        estimate={focusEstimate}
        turn={focusTurn}
        baseRate={baseRate}
        tau={tau}
        isLatest={focusT !== null && focusT === latest?.t}
      />
    )
  }

  let transcriptFootnote: string | null = null
  if (!isLive) transcriptFootnote = 'Replay shows stored values. Counterfactual replay is available during a live call.'
  else if (state.phase === 'replaying') transcriptFootnote = 'Select the same turn again, or press Esc, to restore it.'
  else if (!state.callEnded && estimates.length > 0) transcriptFootnote = 'Select a turn to replay the call without it.'

  const liveEmptyHint = 'Hold F for the dealer or J for the customer, or type a turn below.'
  const playbackEmptyHint = playback.session ? 'Press Play to step through the conversation.' : 'Choose a saved session to replay.'

  const header = (
    <Header
      mode={mode}
      onModeChange={changeMode}
      modeLocked={turnInFlight}
      status={<StatusIndicator label={status.label} detail={status.detail} tone={status.tone} />}
      summaryEnabled={isLive ? canEndCall(state) || state.phase === 'summary' : playback.total > 0}
      summaryActive={isLive ? state.phase === 'summary' : playbackAtEnd}
      summaryHint={isLive ? 'End the call and show the summary' : 'Jump to the end of the session'}
      onSummary={isLive ? live.endCall : playback.seekToEnd}
      isMockModel={health?.modelKind === 'mock'}
    />
  )

  let footer: ReactNode
  if (!isLive) {
    footer = <ReplayControls playback={playback} />
  } else if (state.callEnded) {
    footer = (
      <>
        <NoticeBar notice={state.notice} onDismiss={live.dismissNotice} />
        <CallEndedBar
          key={state.session?.id}
          onSave={async () => (await live.saveSession()) !== null}
          onNewCall={live.newCall}
        />
      </>
    )
  } else {
    footer = (
      <>
        <NoticeBar notice={state.notice} onDismiss={live.dismissNotice} />
        <PushToTalkControls
          recordingSpeaker={state.recordingSpeaker}
          busy={isProcessing(state)}
          available={state.session !== null}
          onPress={live.startRecording}
          onRelease={live.stopRecording}
        />
        <div className={styles.secondaryRow}>
          <TypedTurnInput disabled={!canStartTurn(state)} onSubmit={live.submitText} />
          <button type="button" className={styles.endCall} disabled={!canEndCall(state)} onClick={live.endCall}>
            End call
          </button>
        </div>
      </>
    )
  }

  return (
    <AppShell
      header={header}
      transcript={
        <TranscriptPanel
          turns={turns}
          estimates={estimates}
          selectedTurn={selectedTurn}
          highlightTurn={highlightTurn}
          onHighlightTurn={setHighlightTurn}
          onSelectTurn={onSelectTurn}
          pending={isLive ? pendingTurn(state) : null}
          emptyHint={isLive ? liveEmptyHint : playbackEmptyHint}
          footnote={transcriptFootnote}
        />
      }
      chart={
        <ProbabilityChart
          turns={turns}
          estimates={estimates}
          baseRate={baseRate}
          counterfactual={counterfactual}
          selectedTurn={selectedTurn}
          highlightTurn={highlightTurn}
          onHighlightTurn={setHighlightTurn}
          onSelectTurn={onSelectTurn}
          emptyMessage={isLive ? 'The probability path starts after the first turn.' : playbackEmptyHint}
        />
      }
      detail={detail}
      footer={footer}
    />
  )
}

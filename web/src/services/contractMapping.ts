/**
 * Conversion between the backend wire contract and interface domain types.
 * A `PulseApiService` uses these so that components never see snake_case payloads.
 */
import type {
  WireClientMessage,
  WireCounterfactualResponse,
  WireCreateSessionResponse,
  WireHealth,
  WireSaveResponse,
  WireSavedSession,
  WireServerMessage,
  WireSummary,
  WireTimings,
} from '../types/contract'
import type {
  Counterfactual,
  Health,
  SavedSession,
  SavedSessionRef,
  SessionInfo,
  Speaker,
  StageTimings,
  Summary,
} from '../types/pulse'
import type { SessionEvent } from './pulseService'

export function fromWireTimings(timings: WireTimings): StageTimings {
  return {
    asrMs: timings.asr,
    encodeMs: timings.encode,
    modelMs: timings.model,
    totalMs: timings.total,
  }
}

export function fromWireSession(response: WireCreateSessionResponse): SessionInfo {
  return { id: response.id, baseRate: response.base_rate, tau: response.tau }
}

export function fromWireServerMessage(message: WireServerMessage): SessionEvent {
  switch (message.type) {
    case 'status':
      return { type: 'status', state: message.state }
    case 'turn':
      return { type: 'turn', turn: { t: message.t, speaker: message.speaker, text: message.text } }
    case 'estimate':
      return {
        type: 'estimate',
        estimate: {
          t: message.t,
          probability: message.p,
          momentum: message.m,
          turningPoint: message.turning_point,
          timings: fromWireTimings(message.timings_ms),
        },
      }
    case 'error':
      return { type: 'error', stage: message.stage, message: message.message }
  }
}

export function toWireTextMessage(speaker: Speaker, text: string): WireClientMessage {
  return { type: 'turn_text', speaker, text }
}

export function toWireAudioEnvelope(speaker: Speaker, audio: Blob): WireClientMessage {
  return { type: 'turn_audio', speaker, mime_type: audio.type || 'audio/webm' }
}

export function fromWireCounterfactual(
  maskedTurn: number,
  response: WireCounterfactualResponse,
): Counterfactual {
  return { maskedTurn, path: response.path, deltaT: response.delta_T }
}

export function fromWireSummary(summary: WireSummary): Summary {
  return {
    finalProbability: summary.final_p,
    baseRate: summary.base_rate,
    totalMovement: summary.total_movement,
    largestMovements: summary.largest_movements.map((movement) => ({
      t: movement.t,
      speaker: movement.speaker,
      text: movement.text,
      momentum: movement.m,
    })),
    dealerTurnShare: summary.dealer_turn_share,
    dealerWordShare: summary.dealer_word_share,
    turningPointCount: summary.turning_points,
    turnCount: summary.turn_count,
  }
}

export function fromWireSessionRef(item: WireSaveResponse): SavedSessionRef {
  return { name: item.name, title: item.title, turnCount: item.turn_count, savedAt: item.saved_at }
}

export function fromWireSavedSession(session: WireSavedSession): SavedSession {
  return {
    name: session.name,
    title: session.title,
    description: session.description,
    artefactVersion: session.artefact_version,
    baseRate: session.base_rate,
    tau: session.tau,
    turns: session.turns.map((turn) => ({ t: turn.t, speaker: turn.speaker, text: turn.text })),
    estimates: session.turns.map((turn) => ({
      t: turn.t,
      probability: turn.p,
      momentum: turn.m,
      turningPoint: turn.turning_point,
      timings: fromWireTimings(turn.timings_ms),
    })),
    summary: fromWireSummary(session.summary),
  }
}

export function fromWireHealth(health: WireHealth): Health {
  return {
    status: health.status,
    modelKind: health.model_kind,
    artefactVersion: health.artefact_version,
  }
}

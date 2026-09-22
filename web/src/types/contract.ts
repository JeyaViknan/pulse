/**
 * Wire contract with the Pulse backend (SPEC.md §5.4 – §5.5).
 *
 * These types mirror the JSON exchanged with the FastAPI service exactly, including
 * its snake_case field names. Nothing outside `services/` should import them.
 */

export type WireSpeaker = 'dealer' | 'customer'

export interface WireTimings {
  asr: number | null
  encode: number
  model: number
  total: number
}

/* ------------------------------------------------------------------ */
/* WebSocket  /ws/session/{id}                                         */
/* ------------------------------------------------------------------ */

/**
 * Client → server.
 *
 * `turn_audio` is sent as this JSON envelope immediately followed by one binary frame
 * containing the recorded audio (WebM/Opus, MP4/AAC or WAV, as named by `mime_type`).
 */
export type WireClientMessage =
  | { type: 'turn_audio'; speaker: WireSpeaker; mime_type: string }
  | { type: 'turn_text'; speaker: WireSpeaker; text: string }
  | { type: 'end_call' }

/** Server → client. */
export type WireServerMessage =
  | { type: 'status'; state: 'transcribing' | 'updating' | 'idle' }
  | { type: 'turn'; t: number; speaker: WireSpeaker; text: string }
  | {
      type: 'estimate'
      t: number
      p: number
      m: number
      turning_point: boolean
      timings_ms: WireTimings
    }
  | { type: 'error'; stage: string; message: string }

/* ------------------------------------------------------------------ */
/* REST                                                                */
/* ------------------------------------------------------------------ */

export const ROUTES = {
  createSession: () => '/session',
  counterfactual: (id: string) => `/session/${encodeURIComponent(id)}/counterfactual`,
  summary: (id: string) => `/session/${encodeURIComponent(id)}/summary`,
  save: (id: string) => `/session/${encodeURIComponent(id)}/save`,
  lastTurn: (id: string) => `/session/${encodeURIComponent(id)}/turns/last`,
  sessions: () => '/sessions',
  session: (name: string) => `/sessions/${encodeURIComponent(name)}`,
  health: () => '/health',
  liveSocket: (id: string) => `/ws/session/${encodeURIComponent(id)}`,
} as const

/** POST /session */
export interface WireCreateSessionResponse {
  id: string
  base_rate: number
  tau: number
}

/** POST /session/{id}/counterfactual — request body */
export interface WireCounterfactualRequest {
  mask: number[]
}

/** POST /session/{id}/counterfactual — response */
export interface WireCounterfactualResponse {
  path: number[]
  delta_T: number
}

export interface WireMovement {
  t: number
  speaker: WireSpeaker
  text: string
  m: number
}

/** GET /session/{id}/summary */
export interface WireSummary {
  final_p: number
  base_rate: number
  total_movement: number
  largest_movements: WireMovement[]
  dealer_turn_share: number
  dealer_word_share: number
  turning_points: number
  turn_count: number
}

/** POST /session/{id}/save */
export interface WireSaveResponse {
  name: string
  title: string
  turn_count: number
  saved_at: string
}

/** GET /sessions — one entry */
export type WireSessionListItem = WireSaveResponse

/** DELETE /session/{id}/turns/last — delete-last-turn (SPEC.md §9) */
export interface WireDeleteTurnResponse {
  turn_count: number
}

export interface WireSavedTurn {
  t: number
  speaker: WireSpeaker
  text: string
  p: number
  m: number
  turning_point: boolean
  timings_ms: WireTimings
}

/**
 * GET /sessions/{name}
 *
 * `summary` is stored with the session so that Replay mode needs no further request
 * (an extension of SPEC.md §5.5).
 */
export interface WireSavedSession {
  name: string
  title: string
  description: string | null
  artefact_version: string
  asr_model?: string | null
  base_rate: number
  tau: number
  saved_at: string
  turns: WireSavedTurn[]
  summary: WireSummary
}

/** GET /health */
export interface WireHealth {
  status: 'ok' | 'degraded'
  artefact_version: string
  encoder: string
  asr_model: string | null
  base_rate: number
  tau: number
}

/** Error body returned by the REST endpoints. */
export interface WireErrorBody {
  detail?: string
}

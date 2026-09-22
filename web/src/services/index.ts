import { PulseApiService } from './apiService'
import type { PulseService } from './pulseService'
import { MediaRecorderRecorder, type Recorder } from './recorder'

export interface PulseRuntime {
  service: PulseService
  recorder: Recorder
}

/**
 * The backend the interface talks to: the local Pulse server on the page's own origin
 * (the server serves the built interface; in development Vite proxies to it).
 */
export function createRuntime(): PulseRuntime {
  return { service: new PulseApiService(), recorder: new MediaRecorderRecorder() }
}

import { MockPulseService } from './mock/mockPulseService'
import type { PulseService } from './pulseService'
import { SimulatedRecorder, type Recorder } from './recorder'

export interface PulseRuntime {
  service: PulseService
  recorder: Recorder
}

/**
 * Chooses the backend the interface talks to.
 *
 * Only the in-browser mock exists today. When the FastAPI backend is available, return a
 * `PulseApiService` (built on `contractMapping.ts`) and a `MediaRecorder`-backed recorder
 * here; no component needs to change.
 */
export function createRuntime(): PulseRuntime {
  return { service: new MockPulseService(), recorder: new SimulatedRecorder() }
}

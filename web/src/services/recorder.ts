/**
 * Audio capture for push-to-talk.
 *
 * The interface starts a recording when a push-to-talk control is pressed and stops it on
 * release. A `MediaRecorder`-backed implementation (16 kHz mono, SPEC.md §5.2) plugs in here
 * once the backend can transcribe audio.
 */
export interface Recorder {
  start(): Promise<void>
  /** Stops recording and resolves with the captured audio. */
  stop(): Promise<Blob>
  /** Abandons a recording without producing audio. */
  cancel(): void
}

/**
 * Stands in for a microphone while the backend is mocked. Captures nothing; the mock
 * service supplies the transcript from its demo script.
 */
export class SimulatedRecorder implements Recorder {
  private recording = false

  start(): Promise<void> {
    this.recording = true
    return Promise.resolve()
  }

  stop(): Promise<Blob> {
    this.recording = false
    return Promise.resolve(new Blob([], { type: 'audio/webm' }))
  }

  cancel(): void {
    this.recording = false
  }

  get isRecording(): boolean {
    return this.recording
  }
}

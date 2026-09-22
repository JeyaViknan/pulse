/**
 * Audio capture for push-to-talk (SPEC.md §5.2 step 1).
 *
 * The microphone stream is opened once and kept, so that a press starts recording
 * immediately rather than waiting for the device. Each press records one mono clip with the
 * browser's `MediaRecorder` (WebM/Opus in Chrome, MP4/AAC in Safari); the server decodes it
 * and resamples to 16 kHz for Whisper. Which control was held decides the speaker — the audio
 * itself carries no speaker information.
 */
export interface Recorder {
  /** Asks for microphone access ahead of the first press. */
  prepare(): Promise<void>
  start(): Promise<void>
  /** Stops recording and resolves with the captured audio. */
  stop(): Promise<Blob>
  /** Abandons a recording without producing audio. */
  cancel(): void
}

const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

/** Keeps recording briefly after release so the last syllable is not clipped. */
const RELEASE_TAIL_MS = 180

function supportedType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return PREFERRED_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
}

export class MediaRecorderRecorder implements Recorder {
  private stream: MediaStream | null = null
  private opening: Promise<MediaStream> | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private starting: Promise<void> | null = null

  prepare(): Promise<void> {
    return this.open().then(() => undefined)
  }

  start(): Promise<void> {
    this.starting = this.open().then((stream) => {
      const mimeType = supportedType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48_000 } : undefined)
      this.chunks = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data)
      }
      recorder.start()
      this.recorder = recorder
    })
    return this.starting
  }

  async stop(): Promise<Blob> {
    await this.starting
    const recorder = this.recorder
    if (!recorder || recorder.state === 'inactive') throw new Error('Nothing was recorded.')
    await new Promise((resolve) => window.setTimeout(resolve, RELEASE_TAIL_MS))
    return new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }))
        this.chunks = []
        this.recorder = null
      }
      recorder.stop()
    })
  }

  cancel(): void {
    const recorder = this.recorder
    this.recorder = null
    this.chunks = []
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null
      recorder.stop()
    }
  }

  private open(): Promise<MediaStream> {
    if (this.stream?.active) return Promise.resolve(this.stream)
    if (this.opening) return this.opening
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return Promise.reject(new Error('This browser cannot record audio.'))
    }
    this.opening = navigator.mediaDevices
      .getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      .then((stream) => {
        this.stream = stream
        return stream
      })
      .finally(() => {
        this.opening = null
      })
    return this.opening
  }
}

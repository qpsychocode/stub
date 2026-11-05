/**
 * Microphone capture: getUserMedia -> AudioContext(16 kHz) -> AudioWorklet (from a Blob URL).
 * The worklet batches ~100 ms of mono float32 samples; we forward them and report an RMS level.
 */

const BATCH = 1600
export const MAX_RECORDING_MS = 10 * 60 * 1000

const WORKLET_SRC = `
class StubCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(${BATCH})
    this.n = 0
    this.port.onmessage = (e) => {
      if (e.data === 'flush' && this.n > 0) {
        this.port.postMessage(this.buf.slice(0, this.n))
        this.n = 0
      }
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    let i = 0
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this.buf.length - this.n)
      this.buf.set(ch.subarray(i, i + take), this.n)
      this.n += take
      i += take
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice(0))
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('stub-capture', StubCapture)
`

export interface RecorderOptions {
  deviceId: string
  onBatch: (samples: Float32Array) => void
  /** Smoothed-ready RMS level, roughly 0..1. */
  onLevel: (level: number) => void
  onLimit: () => void
}

export interface Recorder {
  stop: () => Promise<void>
}

export async function startRecorder(opts: RecorderOptions): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true
    }
  })
  let ctx: AudioContext | null = null
  let url = ''
  try {
    ctx = new AudioContext({ sampleRate: 16000 })
    url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
    await ctx.audioWorklet.addModule(url)
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'stub-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(node)
    node.connect(mute)
    mute.connect(ctx.destination)

    let live = true
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!live) return
      const samples = e.data
      let sum = 0
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
      opts.onLevel(Math.sqrt(sum / Math.max(1, samples.length)))
      opts.onBatch(samples)
    }
    const limit = window.setTimeout(() => opts.onLimit(), MAX_RECORDING_MS)

    const localCtx = ctx
    return {
      stop: async () => {
        window.clearTimeout(limit)
        node.port.postMessage('flush')
        await new Promise((r) => setTimeout(r, 60))
        live = false
        try {
          source.disconnect()
          node.disconnect()
          mute.disconnect()
        } catch {
          /* already disconnected */
        }
        stream.getTracks().forEach((t) => t.stop())
        URL.revokeObjectURL(url)
        opts.onLevel(0)
        await localCtx.close().catch(() => undefined)
      }
    }
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop())
    if (url) URL.revokeObjectURL(url)
    await ctx?.close().catch(() => undefined)
    throw e
  }
}

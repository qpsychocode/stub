// Streaming recognizer logic. Used by asr-worker.ts (utilityProcess) and by the tests.
// `sherpa` is injected so this file never requires the native addon itself.
import os from 'node:os'
import type { ModelFiles } from './model.ts'

const SAMPLE_RATE = 16000
const TAIL_SECONDS = 1.2

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

export class AsrEngine {
  private rec: Any = null
  private stream: Any = null
  private lastText = ''
  private pending: Float32Array[] = []
  private pumping: Promise<void> | null = null
  private sherpa: Any
  private onPartial: (text: string) => void

  constructor(sherpa: Any, onPartial: (text: string) => void) {
    this.sherpa = sherpa
    this.onPartial = onPartial
  }

  get loaded(): boolean {
    return this.rec !== null
  }

  load(m: ModelFiles): void {
    this.cancel()
    this.rec = null
    this.rec = new this.sherpa.OnlineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: m.encoder, decoder: m.decoder, joiner: m.joiner },
        tokens: m.tokens,
        numThreads: Math.min(8, os.cpus().length),
        provider: 'cpu',
        debug: 0
      },
      decodingMethod: 'greedy_search'
    })
  }

  start(language: string): void {
    if (!this.rec) throw new Error('Модель не загружена')
    this.cancel()
    const s = this.rec.createStream()
    if (language && language !== 'auto') s.setOption('language', language)
    this.stream = s
    this.lastText = ''
  }

  /** Queue samples; decoding runs in a loop that yields to the event loop between steps. */
  push(samples: Float32Array): void {
    if (!this.stream) return
    this.pending.push(samples)
    if (!this.pumping) this.pumping = this.pump().finally(() => (this.pumping = null))
  }

  private async pump(): Promise<void> {
    while (this.pending.length > 0 && this.stream) {
      const stream = this.stream
      const chunk = this.pending.shift()!
      stream.acceptWaveform({ samples: chunk, sampleRate: SAMPLE_RATE })
      await this.decodeAvailable(stream, true)
    }
  }

  private async decodeAvailable(stream: Any, emit: boolean): Promise<void> {
    let n = 0
    while (this.stream === stream && this.rec.isReady(stream)) {
      this.rec.decode(stream)
      if (++n % 4 === 0) await yieldLoop() // let incoming pushes land
    }
    if (this.stream !== stream) return
    const text: string = this.rec.getResult(stream).text ?? ''
    if (emit && text !== this.lastText) {
      this.lastText = text
      this.onPartial(text)
    } else {
      this.lastText = text
    }
  }

  async stop(): Promise<string> {
    const stream = this.stream
    if (!stream) return ''
    if (this.pumping) await this.pumping
    // drain anything queued between pump end and now
    while (this.pending.length > 0 && this.stream === stream) {
      stream.acceptWaveform({ samples: this.pending.shift()!, sampleRate: SAMPLE_RATE })
      await this.decodeAvailable(stream, false)
    }
    if (this.stream !== stream) return ''
    stream.acceptWaveform({ samples: new Float32Array(Math.round(SAMPLE_RATE * TAIL_SECONDS)), sampleRate: SAMPLE_RATE })
    stream.inputFinished()
    await this.decodeAvailable(stream, false)
    const text = String(this.rec.getResult(stream).text ?? '').trim()
    if (this.stream === stream) this.stream = null
    this.pending = []
    this.lastText = ''
    return text
  }

  cancel(): void {
    this.stream = null
    this.pending = []
    this.lastText = ''
  }
}

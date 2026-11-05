// Runs inside utilityProcess. Owns sherpa-onnx-node; talks to main via process.parentPort.
import { createRequire } from 'node:module'
import { AsrEngine } from './asr-core.ts'
import { discoverModel } from './model.ts'

type State = 'loading' | 'ready' | 'listening' | 'finishing' | 'no-model' | 'error'
interface Status {
  state: State
  modelName: string
  modelDir: string
  message?: string
}

const port = process.parentPort
let status: Status = { state: 'loading', modelName: '', modelDir: '' }
let engine: AsrEngine | null = null

function setStatus(next: Status): void {
  status = next
  port.postMessage({ type: 'status', status })
}

function ensureEngine(): AsrEngine {
  if (!engine) {
    const req = createRequire(__filename)
    const sherpa = req('sherpa-onnx-node')
    engine = new AsrEngine(sherpa, (text) => port.postMessage({ type: 'partial', text }))
  }
  return engine
}

function load(modelDirSetting: string): void {
  setStatus({ state: 'loading', modelName: '', modelDir: '' })
  const found = discoverModel(modelDirSetting)
  if (!found.model) {
    setStatus({ state: 'no-model', modelName: '', modelDir: '', message: found.message })
    return
  }
  const m = found.model
  try {
    const e = ensureEngine()
    setStatus({ state: 'loading', modelName: m.name, modelDir: m.dir })
    e.load(m)
    setStatus({ state: 'ready', modelName: m.name, modelDir: m.dir })
  } catch (err) {
    setStatus({
      state: 'error',
      modelName: m.name,
      modelDir: m.dir,
      message: `Не удалось загрузить модель: ${(err as Error).message}`
    })
  }
}

function reply(reqId: number, ok: boolean, extra: Record<string, unknown> = {}): void {
  port.postMessage({ type: 'reply', reqId, ok, ...extra })
}

port.on('message', (e) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = e.data as { type: string; [k: string]: any }
  switch (msg.type) {
    case 'load':
      // defer so the 'loading' status is flushed before the blocking constructor
      setImmediate(() => load(String(msg.modelDir ?? '')))
      break
    case 'start': {
      try {
        if (status.state !== 'ready' || !engine) throw new Error(status.message ?? 'Модель не готова')
        engine.start(String(msg.language ?? 'auto'))
        setStatus({ ...status, state: 'listening' })
        reply(msg.reqId, true)
      } catch (err) {
        reply(msg.reqId, false, { error: (err as Error).message })
      }
      break
    }
    case 'push':
      engine?.push(msg.samples as Float32Array)
      break
    case 'stop': {
      if (!engine || (status.state !== 'listening' && status.state !== 'finishing')) {
        reply(msg.reqId, true, { text: '' })
        break
      }
      setStatus({ ...status, state: 'finishing' })
      engine
        .stop()
        .then((text) => {
          setStatus({ ...status, state: 'ready' })
          reply(msg.reqId, true, { text })
        })
        .catch((err) => {
          setStatus({ ...status, state: 'ready' })
          reply(msg.reqId, false, { error: (err as Error).message })
        })
      break
    }
    case 'cancel':
      engine?.cancel()
      if (status.state === 'listening' || status.state === 'finishing') setStatus({ ...status, state: 'ready' })
      break
  }
})

port.postMessage({ type: 'alive' })

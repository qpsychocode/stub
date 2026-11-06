// Main-side manager of the ASR utilityProcess.
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import type { AsrStatus } from '@shared/contract'

interface Pending {
  resolve: (v: { text?: string }) => void
  reject: (e: Error) => void
}

/** On macOS the speech library only finds its own dylibs through this variable. */
function workerEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'darwin') return process.env
  const base = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules') : join(app.getAppPath(), 'node_modules')
  const lib = join(base, `sherpa-onnx-darwin-${process.arch}`)
  return { ...process.env, DYLD_LIBRARY_PATH: [lib, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':') }
}

export class AsrManager {
  private child: UtilityProcess | null = null
  private status: AsrStatus = { state: 'loading', modelName: '', modelDir: '' }
  private modelDir = ''
  private nextReq = 1
  private pending = new Map<number, Pending>()
  private restarts = 0
  private disposed = false
  private statusWaiters: Array<(s: AsrStatus) => void> = []

  constructor(
    private onStatus: (s: AsrStatus) => void,
    private onPartial: (t: string) => void
  ) {}

  getStatus(): AsrStatus {
    return this.status
  }

  private setStatus(s: AsrStatus): void {
    this.status = s
    this.onStatus(s)
    if (s.state === 'ready' || s.state === 'no-model' || s.state === 'error') {
      const w = this.statusWaiters
      this.statusWaiters = []
      w.forEach((f) => f(s))
    }
  }

  private spawn(): void {
    const child = utilityProcess.fork(join(__dirname, 'asr-worker.js'), [], { serviceName: 'stub-asr', stdio: 'inherit', env: workerEnv() })
    this.child = child
    child.on('message', (m: { type: string; [k: string]: any }) => {
      switch (m.type) {
        case 'status':
          this.setStatus(m.status as AsrStatus)
          if (m.status.state === 'ready') this.restarts = 0
          break
        case 'partial':
          this.onPartial(String(m.text ?? ''))
          break
        case 'reply': {
          const p = this.pending.get(m.reqId)
          if (!p) break
          this.pending.delete(m.reqId)
          if (m.ok) p.resolve({ text: m.text })
          else p.reject(new Error(m.error || 'ASR error'))
          break
        }
      }
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      const err = new Error('Процесс распознавания завершился')
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
      if (this.disposed) return
      this.setStatus({
        state: 'error',
        modelName: this.status.modelName,
        modelDir: this.status.modelDir,
        message: `Процесс распознавания упал (код ${code}).`
      })
      if (this.restarts < 1) {
        this.restarts++
        this.load(this.modelDir)
      }
    })
  }

  /** (Re)load the model. Spawns the worker when needed. */
  load(modelDir: string): void {
    this.modelDir = modelDir
    if (!this.child) this.spawn()
    this.child!.postMessage({ type: 'load', modelDir })
  }

  reload(modelDir: string): Promise<AsrStatus> {
    return new Promise((resolve) => {
      this.statusWaiters.push(resolve)
      this.load(modelDir)
    })
  }

  private call(msg: Record<string, unknown>): Promise<{ text?: string }> {
    if (!this.child) return Promise.reject(new Error('Распознавание не запущено'))
    const reqId = this.nextReq++
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject })
      this.child!.postMessage({ ...msg, reqId })
    })
  }

  async start(language: string): Promise<void> {
    if (this.status.state !== 'ready') {
      throw new Error(this.status.message || 'Модель ещё не готова')
    }
    await this.call({ type: 'start', language })
  }

  push(samples: Float32Array): void {
    this.child?.postMessage({ type: 'push', samples })
  }

  async stop(): Promise<string> {
    const r = await this.call({ type: 'stop' })
    return r.text ?? ''
  }

  cancel(): void {
    this.child?.postMessage({ type: 'cancel' })
  }

  dispose(): void {
    this.disposed = true
    this.child?.kill()
  }
}

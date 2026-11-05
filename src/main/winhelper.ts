// Node-side client for resources/winhelper.ps1 (persistent PowerShell, JSON lines).
// No electron imports: usable from plain-Node tests.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

interface Pending {
  resolve: (v: Record<string, any>) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

export interface PasteParams {
  processNames: string[]
  titleIncludes?: string
  submit: boolean
  needle: string
}

export interface PasteReply {
  outcome: 'verified' | 'unverified' | 'not-found' | 'focus-failed'
  submitted: boolean
  windowTitle?: string
  readable?: boolean
}

export interface CursorWindow {
  hwnd: number
  proc: string
  title: string
}

const READY_TIMEOUT = 30000 // Add-Type compile on a cold machine can be slow

export class WinHelper {
  private scriptPath: string
  private proc: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private stopped = false

  constructor(scriptPath: string) {
    this.scriptPath = scriptPath
  }

  private spawnProc(): Promise<void> {
    const p = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    this.proc = p
    let stderr = ''
    p.stderr.setEncoding('utf8')
    p.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-2000)
    })

    const ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(new Error('winhelper: не запустился вовремя'))
        this.killProc(p)
      }, READY_TIMEOUT)
      const rl = createInterface({ input: p.stdout, crlfDelay: Infinity })
      rl.on('line', (line) => {
        let msg: Record<string, any>
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.ready) {
          clearTimeout(t)
          resolve()
          return
        }
        const pend = this.pending.get(msg.id)
        if (!pend) return
        this.pending.delete(msg.id)
        clearTimeout(pend.timer)
        if (msg.ok === false) pend.reject(new Error(msg.error || 'winhelper error'))
        else pend.resolve(msg)
      })
      p.once('exit', (code) => {
        clearTimeout(t)
        const err = new Error(`winhelper завершился (code ${code}) ${stderr.trim()}`.trim())
        reject(err)
        if (this.proc === p) {
          this.proc = null
          this.ready = null
        }
        for (const [id, pend] of this.pending) {
          clearTimeout(pend.timer)
          pend.reject(err)
          this.pending.delete(id)
        }
      })
      p.once('error', (e) => {
        clearTimeout(t)
        reject(e)
      })
    })
    ready.catch(() => {
      if (this.ready === ready) this.ready = null
    })
    return ready
  }

  private killProc(p: ChildProcessWithoutNullStreams): void {
    try {
      p.kill()
    } catch {
      /* ignore */
    }
  }

  private ensure(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('winhelper stopped'))
    if (!this.proc || !this.ready) this.ready = this.spawnProc()
    return this.ready
  }

  /** Start compiling early so the first real request is fast. */
  warmup(): void {
    this.ensure().catch(() => undefined)
  }

  async request(cmd: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
    await this.ensure()
    const p = this.proc
    if (!p) throw new Error('winhelper не запущен')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`winhelper: таймаут команды ${cmd}`))
        // A stuck helper is replaced on the next request.
        this.killProc(p)
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      p.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n', (err) => {
        if (err) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }

  async detect(targets: { id: string; processNames: string[]; titleIncludes?: string }[]): Promise<Record<string, boolean>> {
    const r = await this.request('detect', { targets }, 8000)
    return (r.found ?? {}) as Record<string, boolean>
  }

  async paste(params: PasteParams): Promise<PasteReply> {
    const r = await this.request('paste', { ...params }, 12000)
    return r as unknown as PasteReply
  }

  /** The top-level window under the mouse cursor. */
  async windowAtCursor(): Promise<CursorWindow | null> {
    const r = await this.request('atCursor', {}, 5000)
    return r.hwnd ? { hwnd: Number(r.hwnd), proc: String(r.proc ?? ''), title: String(r.title ?? '') } : null
  }

  /** The window a target would be sent to. */
  async find(params: { processNames: string[]; titleIncludes?: string }): Promise<number | null> {
    const r = await this.request('find', params, 5000)
    return r.hwnd ? Number(r.hwnd) : null
  }

  /** Activates the window's input and presses Ctrl+V; the caller has put the picture on the clipboard. */
  async pasteImage(hwnd: number): Promise<boolean> {
    const r = await this.request('pasteImage', { hwnd }, 12000)
    return Boolean(r.pasted)
  }

  async pasteInto(params: { hwnd: number; title: string; submit: boolean; needle: string }): Promise<PasteReply> {
    const r = await this.request('pasteInto', params, 12000)
    return r as unknown as PasteReply
  }

  async focus(hwnd: number): Promise<boolean> {
    const r = await this.request('focus', { hwnd }, 5000)
    return Boolean(r.focused)
  }

  dispose(): void {
    this.stopped = true
    if (this.proc) this.killProc(this.proc)
  }
}

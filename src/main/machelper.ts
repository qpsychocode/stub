// Node-side client for resources/machelper.js. Same surface as WinHelper; an app's id is its process id.
import { execFile } from 'node:child_process'
import type { CursorWindow, NativeHelper, PasteParams, PasteReply } from './winhelper.ts'

const NEEDS_ACCESS = /not allowed|assistive|не разреш|-1719|-25211|-1743/i

export class MacHelper implements NativeHelper {
  readonly supportsChats = false

  constructor(private scriptPath: string) {}

  private request(cmd: string, payload: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      execFile('osascript', ['-l', 'JavaScript', this.scriptPath, JSON.stringify({ cmd, ...payload })], { timeout: timeoutMs }, (e, out, err) => {
        if (e) {
          const why = String(err || e.message)
          reject(new Error(NEEDS_ACCESS.test(why) ? 'Разреши STUB в Системных настройках: Конфиденциальность и безопасность → Универсальный доступ' : why.trim().split('\n').pop() || e.message))
          return
        }
        try {
          const r = JSON.parse(out) as Record<string, any>
          if (r.ok === false) reject(new Error(String(r.error ?? 'machelper error')))
          else resolve(r)
        } catch {
          reject(new Error('machelper: непонятный ответ'))
        }
      })
    })
  }

  warmup(): void {
    /* nothing runs between requests */
  }

  dispose(): void {
    /* nothing runs between requests */
  }

  async detect(targets: { id: string; processNames: string[]; titleIncludes?: string }[]): Promise<Record<string, boolean>> {
    return ((await this.request('detect', { targets }, 8000)).found ?? {}) as Record<string, boolean>
  }

  async paste(params: PasteParams): Promise<PasteReply> {
    return (await this.request('paste', { ...params }, 12000)) as unknown as PasteReply
  }

  async windowAtCursor(): Promise<CursorWindow | null> {
    const r = await this.request('atCursor', {}, 5000)
    return r.hwnd ? { hwnd: Number(r.hwnd), proc: String(r.proc ?? ''), title: String(r.title ?? '') } : null
  }

  async find(params: { processNames: string[]; titleIncludes?: string }): Promise<number | null> {
    const r = await this.request('find', params, 5000)
    return r.hwnd ? Number(r.hwnd) : null
  }

  async listChats(): Promise<{ chats: { group: string; title: string }[]; groups: string[] }> {
    return { chats: [], groups: [] }
  }

  async openChat(): Promise<boolean> {
    return false
  }

  async pasteImage(hwnd: number): Promise<boolean> {
    return Boolean((await this.request('pasteImage', { hwnd }, 12000)).pasted)
  }

  async pasteInto(params: { hwnd: number; title: string; submit: boolean; needle: string }): Promise<PasteReply> {
    return (await this.request('pasteInto', params, 12000)) as unknown as PasteReply
  }

  async focus(hwnd: number): Promise<boolean> {
    return Boolean((await this.request('focus', { hwnd }, 5000)).focused)
  }
}

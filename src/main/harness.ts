import { app, clipboard, ClipboardItem, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { ChatList, DropRequest, DropResult, HarnessTarget, SendRequest, SendResult } from '@shared/contract'
import { getImage } from './store'
import { WinHelper, type PasteReply } from './winhelper.ts'

// Chat apps upload a pasted picture before they can send; Enter too early would leave it behind.
const IMAGE_SETTLE_MS = 1500
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Desktop, taskbar and File Explorer: nowhere to paste a prompt.
const SHELL_PROCESSES = new Set(['explorer', 'searchhost', 'shellexperiencehost', 'startmenuexperiencehost'])

const scriptPath = (): string =>
  app.isPackaged ? join(process.resourcesPath, 'winhelper.ps1') : join(app.getAppPath(), 'resources', 'winhelper.ps1')

export class Harness {
  private helper = new WinHelper(scriptPath())
  private getWindow: () => BrowserWindow | null

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow
  }

  warmup(): void {
    this.helper.warmup()
  }

  dispose(): void {
    this.helper.dispose()
  }

  async detect(targets: HarnessTarget[]): Promise<Record<string, boolean>> {
    try {
      return await this.helper.detect(
        targets.map((t) => ({ id: t.id, processNames: t.processNames, titleIncludes: t.titleIncludes }))
      )
    } catch {
      return Object.fromEntries(targets.map((t) => [t.id, false]))
    }
  }

  /** Clipboard round-trip around a paste, plus the optional return of focus to STUB. */
  private async pasteVia(text: string, images: string[], hwnd: number | null, returnFocus: boolean, paste: () => Promise<PasteReply>): Promise<PasteReply> {
    const previous = await clipboard.readText().catch(() => '')
    if (hwnd !== null) {
      for (const id of images) {
        const png = getImage(id)
        if (!png) continue
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
        if (await this.helper.pasteImage(hwnd)) await sleep(IMAGE_SETTLE_MS)
      }
    }
    await clipboard.writeText(text)
    const r = await paste()
    if (r.outcome === 'verified') {
      // Give the target time to consume the clipboard before restoring the old content.
      setTimeout(() => {
        if (previous) void clipboard.writeText(previous)
        else clipboard.clear()
      }, 1500)
    }
    if (returnFocus && (r.outcome === 'verified' || r.outcome === 'unverified')) {
      setTimeout(() => void this.focusSelf(), 600)
    }
    return r
  }

  /** A ticket was dragged out of STUB: paste into the window under the cursor and report which one it was. */
  async sendToCursor(req: DropRequest): Promise<DropResult> {
    try {
      const w = await this.helper.windowAtCursor()
      if (!w || w.hwnd === this.selfHwnd() || SHELL_PROCESSES.has(w.proc.toLowerCase())) return { outcome: 'no-window', submitted: false }
      const proc = w.proc.toLowerCase()
      const target = req.targets.find(
        (t) =>
          t.processNames.some((n) => n.trim().replace(/\.exe$/i, '').toLowerCase() === proc) &&
          (!t.titleIncludes || w.title.toLowerCase().includes(t.titleIncludes.toLowerCase()))
      )
      const r = await this.pasteVia(req.text, req.images, w.hwnd, req.returnFocus, () =>
        this.helper.pasteInto({ hwnd: w.hwnd, title: w.title, submit: target?.submit ?? false, needle: req.text.trim().slice(0, 40) })
      )
      return { outcome: r.outcome, submitted: Boolean(r.submitted), targetId: target?.id, appName: w.proc, windowTitle: w.title }
    } catch (e) {
      return { outcome: 'error', submitted: false, message: (e as Error).message }
    }
  }

  async listChats(target: HarnessTarget): Promise<ChatList> {
    try {
      const hwnd = await this.helper.find({ processNames: target.processNames, titleIncludes: target.titleIncludes || undefined })
      if (hwnd === null) return { found: false, chats: [], groups: [] }
      return { found: true, ...(await this.helper.listChats(hwnd)) }
    } catch {
      return { found: false, chats: [], groups: [] }
    }
  }

  async send(req: SendRequest): Promise<SendResult> {
    try {
      const titleIncludes = req.target.titleIncludes || undefined
      const hwnd = req.images.length > 0 || req.chat ? await this.helper.find({ processNames: req.target.processNames, titleIncludes }) : null
      if (req.chat && hwnd !== null && !(await this.helper.openChat({ hwnd, group: req.chat.group, title: req.chat.title }))) {
        // Never paste into whichever chat happens to be open: the point is that it goes to the chosen one.
        await clipboard.writeText(req.text)
        return { outcome: 'chat-not-found', submitted: false }
      }
      const r = await this.pasteVia(req.text, req.images, hwnd, req.returnFocus, () =>
        this.helper.paste({
          processNames: req.target.processNames,
          titleIncludes,
          submit: req.target.submit,
          needle: req.text.trim().slice(0, 40)
        })
      )
      return {
        outcome: r.outcome,
        submitted: Boolean(r.submitted),
        windowTitle: r.windowTitle,
        message:
          r.outcome === 'not-found'
            ? `Окно «${req.target.name}» не найдено. Текст в буфере обмена.`
            : r.outcome === 'focus-failed'
              ? `Не удалось вывести «${req.target.name}» на передний план. Текст в буфере обмена.`
              : undefined
      }
    } catch (e) {
      return { outcome: 'error', submitted: false, message: `${(e as Error).message}. Текст в буфере обмена.` }
    }
  }

  private selfHwnd(): number | null {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return null
    const buf = win.getNativeWindowHandle()
    return Number(buf.byteLength >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0)))
  }

  private async focusSelf(): Promise<void> {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return
    try {
      const hwnd = this.selfHwnd()
      if (hwnd !== null && (await this.helper.focus(hwnd))) return
    } catch {
      /* fall back below */
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

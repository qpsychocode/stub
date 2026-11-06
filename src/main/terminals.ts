// Terminals inside STUB: one PowerShell per tab through ConPTY, optionally starting an AI CLI in the project's folder.
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'
import * as pty from 'node-pty'
import type { TerminalKind } from '@shared/contract'
import { getImage } from './store'

interface Live {
  proc: pty.IPty
  buffer: string
  timer: NodeJS.Timeout | null
}

const live = new Map<string, Live>()

function onPath(names: string[]): string | null {
  const dirs = (process.env.PATH ?? '').split(';').filter(Boolean)
  for (const dir of dirs) {
    for (const n of names) {
      const f = join(dir, n)
      if (existsSync(f)) return f
    }
  }
  return null
}

/** The newest file called `name` somewhere below `root`, down to `depth` levels. */
function newestBelow(root: string, name: string, depth: number): string | null {
  let best: { file: string; at: number } | null = null
  const walk = (dir: string, left: number): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e)
      try {
        const s = statSync(p)
        if (s.isDirectory()) {
          if (left > 0) walk(p, left - 1)
        } else if (e.toLowerCase() === name && (!best || s.mtimeMs > best.at)) {
          best = { file: p, at: s.mtimeMs }
        }
      } catch {
        /* unreadable entry */
      }
    }
  }
  walk(root, depth)
  return (best as { file: string; at: number } | null)?.file ?? null
}

/** Where a CLI lives: on PATH, or the copy its desktop app keeps. */
function findCli(kind: TerminalKind): string | null {
  const local = process.env.LOCALAPPDATA ?? ''
  const roaming = process.env.APPDATA ?? ''
  switch (kind) {
    case 'claude': {
      const found = onPath(['claude.exe', 'claude.cmd'])
      if (found) return found
      const data = join(local, 'Claude-Data')
      return existsSync(data) ? newestBelow(data, 'claude.exe', 4) : null
    }
    case 'codex':
      return onPath(['codex.cmd', 'codex.exe'])
    case 'opencode': {
      const found = onPath(['opencode.cmd', 'opencode.exe'])
      if (found) return found
      const cli = join(roaming, 'ai.opencode.desktop', 'cli')
      return existsSync(cli) ? newestBelow(cli, 'opencode-cli.exe', 2) : null
    }
    case 'shell':
      return 'powershell.exe'
  }
}

export function availableTerminals(): Record<TerminalKind, boolean> {
  return { claude: findCli('claude') !== null, codex: findCli('codex') !== null, opencode: findCli('opencode') !== null, shell: true }
}

export function createTerminal(kind: TerminalKind, cwd: string, cols: number, rows: number, send: (channel: 'data' | 'exit', id: string, payload: string | number) => void): string {
  if (!existsSync(cwd)) throw new Error(`Папки нет: ${cwd}`)
  const cli = findCli(kind)
  if (!cli) throw new Error(`Программа не найдена: ${kind}`)
  const env = { ...process.env } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  // -NoExit leaves a working prompt behind when the CLI quits. npm's shims are unsigned local scripts, hence RemoteSigned for this process only.
  const args = kind === 'shell' ? ['-NoLogo'] : ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'RemoteSigned', '-Command', `& '${cli.replace(/'/g, "''")}'`]
  const proc = pty.spawn('powershell.exe', args, { name: 'xterm-256color', cols, rows, cwd, env, useConptyDll: false })
  const id = randomUUID()
  const entry: Live = { proc, buffer: '', timer: null }
  live.set(id, entry)
  proc.onData((d) => {
    // One message per frame: a CLI redrawing its screen would otherwise flood the window.
    entry.buffer += d
    entry.timer ??= setTimeout(() => {
      entry.timer = null
      const chunk = entry.buffer
      entry.buffer = ''
      send('data', id, chunk)
    }, 16)
  })
  proc.onExit(({ exitCode }) => {
    live.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.buffer) send('data', id, entry.buffer)
    send('exit', id, exitCode)
  })
  return id
}

export function writeTerminal(id: string, data: string): void {
  live.get(id)?.proc.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  if (cols > 0 && rows > 0) live.get(id)?.proc.resize(cols, rows)
}

export function killTerminal(id: string): void {
  live.get(id)?.proc.kill()
}

export const hasLiveTerminals = (): boolean => live.size > 0

export function killAllTerminals(): void {
  for (const t of live.values()) {
    try {
      t.proc.kill()
    } catch {
      /* already gone */
    }
  }
  live.clear()
}

/**
 * Types a ticket into a terminal without running it. A program in bracketed paste mode (the AI CLIs) gets one block.
 * Anything else (a bare PowerShell) gets one line: there a line break either runs the text or reorders it.
 * A terminal cannot take a picture, so each one becomes a file whose path goes into the text; the CLIs can open those.
 */
export function pasteToTerminal(id: string, text: string, images: string[], bracketed: boolean): boolean {
  const t = live.get(id)
  if (!t) return false
  const dir = join(app.getPath('userData'), 'term-images')
  const paths: string[] = []
  for (const image of images) {
    const png = getImage(image)
    if (!png) continue
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${image}.png`)
    if (!existsSync(file)) writeFileSync(file, png)
    paths.push(file)
  }
  // eslint-disable-next-line no-control-regex
  const body = [text, ...paths].join('\n').replace(/\x1b/g, '')
  t.proc.write(bracketed ? `\x1b[200~${body}\x1b[201~` : body.replace(/\s*[\r\n]+\s*/g, ' '))
  return true
}

export async function pickFolder(parent: BrowserWindow | null, title: string): Promise<string | null> {
  const opts = { title, properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
  return r.canceled ? null : r.filePaths[0] ?? null
}

/** Clones next to nothing else: into a new folder named after the repository, inside `parent`. Never overwrites. */
export function cloneRepo(url: string, parent: string): Promise<string> {
  const clean = url.trim()
  if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(clean)) return Promise.reject(new Error('Нужна ссылка на репозиторий: https://… или git@…'))
  const name = basename(clean.replace(/[/]+$/, '').replace(/\.git$/, '').replace(/:/g, '/'))
  if (!name || name === '.' || name === '..') return Promise.reject(new Error('Не понял название репозитория по ссылке'))
  const dest = join(parent, name)
  if (existsSync(dest)) return Promise.reject(new Error(`Папка уже есть: ${dest}`))
  return new Promise((resolve, reject) => {
    // "--" keeps a crafted link from being read as an option; no prompt, or a private repository would hang forever.
    execFile('git', ['clone', '--', clean, dest], { windowsHide: true, timeout: 600_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, _out, err) => {
      if (e) reject(new Error(String(err).trim().split('\n').pop() || e.message))
      else resolve(dest)
    })
  })
}

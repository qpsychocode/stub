import { execFile, spawn } from 'node:child_process'
import { BrowserWindow, session, type Session } from 'electron'
import type { HarnessLimits, LimitWindow } from '@shared/contract'

const CODEX_TIMEOUT = 20000
const CLAUDE_ORIGIN = 'https://claude.ai'
const CLAUDE_PARTITION = 'persist:claude-usage'
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

const clampPercent = (n: number): number => Math.max(0, Math.min(100, n))

function killTree(pid: number | undefined): void {
  if (pid) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
}

interface CodexWindow {
  usedPercent?: number
  windowDurationMins?: number
  resetsAt?: number | null
}

function codexWindow(w: CodexWindow | null | undefined): LimitWindow | null {
  if (!w || typeof w.usedPercent !== 'number') return null
  const kind = w.windowDurationMins === 300 ? 'five_hour' : w.windowDurationMins === 10080 ? 'weekly' : null
  if (!kind) return null
  return { kind, usedPercent: clampPercent(w.usedPercent), resetsAt: w.resetsAt ? w.resetsAt * 1000 : null }
}

/** Asks the installed Codex CLI over its app-server protocol; it uses its own login, STUB never touches the token. */
function readCodex(): Promise<HarnessLimits> {
  return new Promise((resolve) => {
    const p = spawn('codex', ['app-server'], { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let settled = false
    const done = (r: HarnessLimits): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      killTree(p.pid)
      resolve(r)
    }
    const timer = setTimeout(() => done({ status: 'error', windows: [], note: 'Codex не ответил вовремя' }), CODEX_TIMEOUT)
    const send = (o: unknown): void => void p.stdin.write(`${JSON.stringify(o)}\n`)
    p.on('error', () => done({ status: 'none', windows: [] }))
    p.on('exit', () => done({ status: 'none', windows: [] })) // not installed: cmd exits straight away
    p.stdin.on('error', () => undefined)
    let buf = ''
    p.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        let m: { id?: number; result?: { rateLimits?: { primary?: CodexWindow; secondary?: CodexWindow } }; error?: { message?: string } }
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read' })
        } else if (m.id === 2) {
          const windows = [codexWindow(m.result?.rateLimits?.primary), codexWindow(m.result?.rateLimits?.secondary)].filter((w): w is LimitWindow => w !== null)
          done(windows.length > 0 ? { status: 'ok', windows } : { status: 'error', windows: [], note: m.error?.message ?? 'Codex не вернул лимиты' })
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'stub', title: 'STUB', version: '0.1.0' } } })
  })
}

function claudeSession(): Session {
  const s = session.fromPartition(CLAUDE_PARTITION)
  s.setUserAgent(CHROME_UA)
  return s
}

function claudeWindow(kind: LimitWindow['kind'], raw: unknown): LimitWindow | null {
  const w = raw as { utilization?: unknown; resets_at?: unknown } | null | undefined
  if (!w || typeof w.utilization !== 'number') return null
  const at = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN
  return { kind, usedPercent: clampPercent(w.utilization), resetsAt: Number.isNaN(at) ? null : at }
}

/** Reads the usage page's data with STUB's own claude.ai sign-in. Not a public API: an unexpected answer is reported, never guessed at. */
async function readClaude(): Promise<HarnessLimits> {
  try {
    const s = claudeSession()
    const get = (path: string): Promise<Response> => s.fetch(`${CLAUDE_ORIGIN}${path}`, { headers: { accept: 'application/json' } })
    const orgs = await get('/api/organizations')
    if (orgs.status === 401 || orgs.status === 403) return { status: 'signin', windows: [] }
    if (!orgs.ok) return { status: 'error', windows: [], note: `claude.ai ответил ${orgs.status}` }
    const list = (await orgs.json()) as { uuid: string; capabilities?: string[] }[]
    const org = list.find((o) => o.capabilities?.includes('chat')) ?? list[0]
    if (!org) return { status: 'error', windows: [], note: 'claude.ai не вернул аккаунт' }
    const usage = await get(`/api/organizations/${org.uuid}/usage`)
    if (!usage.ok) return { status: 'error', windows: [], note: `claude.ai ответил ${usage.status}` }
    const u = (await usage.json()) as { five_hour?: unknown; seven_day?: unknown }
    const windows = [claudeWindow('five_hour', u.five_hour), claudeWindow('weekly', u.seven_day)].filter((w): w is LimitWindow => w !== null)
    return windows.length > 0 ? { status: 'ok', windows } : { status: 'error', windows: [], note: 'Непонятный ответ claude.ai' }
  } catch (e) {
    return { status: 'error', windows: [], note: (e as Error).message }
  }
}

let reading: Promise<Record<string, HarnessLimits>> | null = null

/** Keyed by harness target id. Targets with no known source are simply absent. */
export function readLimits(): Promise<Record<string, HarnessLimits>> {
  reading ??= Promise.all([readClaude(), readCodex()])
    .then(([claude, codex]) => ({ claude, codex }))
    .finally(() => {
      reading = null
    })
  return reading
}

/** Opens claude.ai in STUB's own window; resolves once the user is signed in or closes it. The session stays in STUB's profile only. */
export function signInClaude(parent: BrowserWindow | null): Promise<void> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      ...(parent ? { parent } : {}),
      width: 520,
      height: 720,
      title: 'Вход в Claude',
      autoHideMenuBar: true,
      webPreferences: { session: claudeSession() }
    })
    win.on('closed', () => resolve())
    const check = async (): Promise<void> => {
      if (win.isDestroyed()) return
      const r = await readClaude()
      if (r.status === 'ok' && !win.isDestroyed()) win.close()
    }
    win.webContents.on('did-navigate', () => void check())
    win.webContents.on('did-navigate-in-page', () => void check())
    void win.loadURL(`${CLAUDE_ORIGIN}/login`)
  })
}

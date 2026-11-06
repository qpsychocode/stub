// STUB's own updates, from the public qpsychocode/stub-releases GitHub repository.
import { app, net, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/contract'

const CHECK_EVERY_MS = 6 * 3_600_000
const SITE = 'https://stub-voice.vercel.app'
const LATEST_API = 'https://api.github.com/repos/qpsychocode/stub-releases/releases/latest'
// macOS only lets a Developer ID signed app replace itself, so there a new version is a download from the site.
const MANUAL = process.platform === 'darwin'

let state: UpdateState = { status: 'idle', current: app.getVersion() }
let emit: (s: UpdateState) => void = () => undefined

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch, current: app.getVersion() }
  emit(state)
}

export const updateState = (): UpdateState => state

/** Downloads in the background; nothing restarts without the user, except installing on a normal quit. */
export function startUpdates(onChange: (s: UpdateState) => void): void {
  emit = onChange
  if (!app.isPackaged) return
  if (MANUAL) {
    void checkForUpdates()
    setInterval(() => void checkForUpdates(), CHECK_EVERY_MS)
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  autoUpdater.on('checking-for-update', () => {
    if (state.status !== 'ready') set({ status: 'checking', message: undefined })
  })
  autoUpdater.on('update-not-available', () => set({ status: 'none' }))
  autoUpdater.on('update-available', (i) => set({ status: 'downloading', version: i.version, percent: 0 }))
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => set({ status: 'ready', version: i.version, percent: 100 }))
  autoUpdater.on('error', (e) => {
    if (state.status !== 'ready') set({ status: 'error', message: e.message.split('\n')[0] })
  })
  void checkForUpdates()
  setInterval(() => void checkForUpdates(), CHECK_EVERY_MS)
}

const isNewer = (a: string, b: string): boolean => {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}

async function checkManually(): Promise<void> {
  set({ status: 'checking', message: undefined })
  try {
    const r = await net.fetch(LATEST_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'STUB' } })
    if (!r.ok) throw new Error(String(r.status))
    const version = String(((await r.json()) as { tag_name?: string }).tag_name ?? '').replace(/^v/, '')
    set(isNewer(version, app.getVersion()) ? { status: 'manual', version } : { status: 'none' })
  } catch (e) {
    set({ status: 'error', message: (e as Error).message })
  }
}

export async function checkForUpdates(): Promise<void> {
  if (app.isPackaged && MANUAL) return checkManually()
  if (!app.isPackaged || state.status === 'ready' || state.status === 'downloading') return
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    /* reported through the 'error' event */
  }
}

export function installUpdate(): void {
  if (state.status === 'manual') void shell.openExternal(SITE)
  else if (state.status === 'ready') autoUpdater.quitAndInstall(true, true) // silent, then start the new version
}

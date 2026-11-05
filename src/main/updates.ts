// STUB's own updates, from the public qpsychocode/stub-releases GitHub repository.
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/contract'

const CHECK_EVERY_MS = 6 * 3_600_000

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

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged || state.status === 'ready' || state.status === 'downloading') return
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    /* reported through the 'error' event */
  }
}

export function installUpdate(): void {
  if (state.status === 'ready') autoUpdater.quitAndInstall(true, true) // silent, then start the new version
}

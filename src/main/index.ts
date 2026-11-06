import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, session, shell } from 'electron'
import { join } from 'node:path'
import { IPC, type AppData, type AsrStatus, type HarnessTarget, type DropRequest, type SendRequest, type TerminalKind } from '@shared/contract'
import { AsrManager } from './asr'
import { Harness } from './harness'
import { addImage, imageDataUrl } from './images'
import { readLimits, signInClaude } from './limits'
import { cancelDownload, modelsState, removeModel, startDownload } from './models'
import { availableTerminals, cloneRepo, createTerminal, hasLiveTerminals, killAllTerminals, killTerminal, pasteToTerminal, pickFolder, resizeTerminal, writeTerminal } from './terminals'
import { checkForUpdates, installUpdate, startUpdates, updateState } from './updates'
import { closeStore, dbPath, deletedTickets, loadData, saveData } from './store'

let mainWindow: BrowserWindow | null = null
let currentHotkey = ''
let quitting = false

const isDev = !app.isPackaged && Boolean(process.env['ELECTRON_RENDERER_URL'])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  void bootstrap()
}

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

function showWindow(): void {
  const w = mainWindow
  if (!w || w.isDestroyed()) return
  if (w.isMinimized()) w.restore()
  if (!w.isVisible()) w.show()
  // Briefly topmost helps Windows grant foreground to a background app.
  w.setAlwaysOnTop(true)
  w.show()
  w.focus()
  w.setAlwaysOnTop(false)
}

const asr = new AsrManager(
  (s: AsrStatus) => send(IPC.asrStatusEvt, s),
  (t: string) => send(IPC.asrPartialEvt, t)
)
const harness = new Harness(() => mainWindow)

function registerHotkey(accelerator: string): boolean {
  if (!accelerator) return false
  try {
    const ok = globalShortcut.register(accelerator, () => {
      showWindow()
      send(IPC.appHotkeyEvt)
    })
    return ok
  } catch {
    return false
  }
}

function setHotkey(accelerator: string): boolean {
  const prev = currentHotkey
  if (prev) globalShortcut.unregister(prev)
  if (registerHotkey(accelerator)) {
    currentHotkey = accelerator
    return true
  }
  // Failed: restore the previous one.
  if (prev) registerHotkey(prev)
  return false
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    frame: false,
    backgroundColor: '#E9E6DF',
    title: 'STUB',
    icon: join(app.getAppPath(), 'resources', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only needs `electron` (ipcRenderer/contextBridge), so the sandbox is kept on.
      sandbox: true
    }
  })
  mainWindow = win

  win.once('ready-to-show', () => win.show())
  win.on('maximize', () => send(IPC.winMaxEvt, true))
  win.on('unmaximize', () => send(IPC.winMaxEvt, false))
  win.on('closed', () => {
    mainWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Never navigate away from the app itself.
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!(dev && url.startsWith(dev)) && !url.startsWith('file:')) e.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function allowMedia(origin: string): boolean {
  const dev = process.env['ELECTRON_RENDERER_URL']
  return origin.startsWith('file:') || (!!dev && origin.startsWith(new URL(dev).origin))
}

function registerIpc(): void {
  ipcMain.handle(IPC.storeLoad, () => loadData())
  ipcMain.handle(IPC.storeSave, (_e, data: AppData) => saveData(data))
  ipcMain.on(IPC.storeSaveNow, (e, data: AppData) => {
    try {
      saveData(data)
      e.returnValue = true
    } catch (err) {
      console.error('[stub] save failed', err)
      e.returnValue = false
    }
  })
  ipcMain.handle(IPC.storeDeleted, () => deletedTickets())

  ipcMain.handle(IPC.asrStatus, () => asr.getStatus())
  ipcMain.handle(IPC.asrStart, (_e, language: string) => asr.start(language))
  ipcMain.on(IPC.asrPush, (_e, samples: Float32Array) => asr.push(samples))
  ipcMain.handle(IPC.asrStop, () => asr.stop())
  ipcMain.on(IPC.asrCancel, () => asr.cancel())
  ipcMain.handle(IPC.asrReload, (_e, modelDir: string) => asr.reload(modelDir ?? ''))

  ipcMain.handle(IPC.harnessSend, (_e, req: SendRequest) => harness.send(req))
  ipcMain.handle(IPC.harnessChats, (_e, target: HarnessTarget) => harness.listChats(target))
  ipcMain.handle(IPC.harnessDrop, (_e, req: DropRequest) => harness.sendToCursor(req))
  ipcMain.handle(IPC.harnessDetect, (_e, targets: HarnessTarget[]) => harness.detect(targets))

  ipcMain.handle(IPC.termAvailable, () => availableTerminals())
  ipcMain.handle(IPC.termCreate, (_e, kind: TerminalKind, cwd: string, cols: number, rows: number) =>
    createTerminal(kind, cwd, cols, rows, (channel, id, payload) => send(channel === 'data' ? IPC.termDataEvt : IPC.termExitEvt, id, payload))
  )
  ipcMain.on(IPC.termWrite, (_e, id: string, data: string) => writeTerminal(id, data))
  ipcMain.on(IPC.termResize, (_e, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
  ipcMain.on(IPC.termKill, (_e, id: string) => killTerminal(id))
  ipcMain.handle(IPC.termPaste, (_e, id: string, text: string, images: string[], bracketed: boolean) => pasteToTerminal(id, text, images, bracketed))
  ipcMain.handle(IPC.termPickFolder, () => pickFolder(mainWindow, 'STUB'))
  ipcMain.handle(IPC.termClone, (_e, url: string, parent: string) => cloneRepo(url, parent))
  ipcMain.handle(IPC.updatesState, () => updateState())
  ipcMain.on(IPC.updatesCheck, () => void checkForUpdates())
  ipcMain.on(IPC.updatesInstall, () => installUpdate())
  ipcMain.handle(IPC.modelsState, () => modelsState())
  ipcMain.on(IPC.modelsDownload, (_e, id: string) => startDownload(id, (ev) => send(IPC.modelsEvt, ev)))
  ipcMain.on(IPC.modelsCancel, (_e, id: string) => cancelDownload(id))
  ipcMain.handle(IPC.modelsRemove, (_e, dir: string) => removeModel(dir))
  ipcMain.handle(IPC.imagesAdd, (_e, bytes: Uint8Array) => addImage(bytes))
  ipcMain.handle(IPC.imagesGet, (_e, id: string) => imageDataUrl(id))
  ipcMain.handle(IPC.limitsRead, () => readLimits())
  ipcMain.handle(IPC.limitsSignInClaude, () => signInClaude(mainWindow))

  ipcMain.on(IPC.clipboardWrite, (_e, text: string) => void clipboard.writeText(String(text ?? '')))

  ipcMain.handle(IPC.appSetHotkey, (_e, accelerator: string) => setHotkey(accelerator))
  ipcMain.on(IPC.winMinimize, () => mainWindow?.minimize())
  ipcMain.on(IPC.winToggleMax, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on(IPC.winClose, () => mainWindow?.close())
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  app.setAppUserModelId('com.qpsycho.stub')

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    cb(permission === 'media' && allowMedia(details.requestingUrl))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && allowMedia(origin))

  registerIpc()
  let data: AppData
  try {
    data = await loadData()
  } catch (e) {
    // Never open an empty board over data that could not be read: it would look like everything is gone.
    dialog.showErrorBox('STUB: не удалось открыть базу', `${(e as Error).message}\n\nБаза: ${dbPath()}\nКопии по дням: папка backups рядом с ней.\n\nФайлы не изменены.`)
    app.exit(1)
    return
  }
  createWindow()

  if (!setHotkey(data.settings.hotkey || 'Control+Alt+T')) {
    console.warn('[stub] failed to register global hotkey', data.settings.hotkey)
  }

  asr.load(data.settings.modelDir)
  harness.warmup()
  startUpdates((s) => send(IPC.updatesEvt, s))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

let terminalsDrained = false
app.on('before-quit', (e) => {
  quitting = true
  // Exiting while ConPTY is still tearing its consoles down crashes the process, so give them a moment first.
  if (!terminalsDrained && hasLiveTerminals()) {
    e.preventDefault()
    terminalsDrained = true
    killAllTerminals()
    setTimeout(() => app.quit(), 700)
  }
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  asr.dispose()
  harness.dispose()
  killAllTerminals()
  closeStore()
})
app.on('window-all-closed', () => {
  if (quitting || process.platform !== 'darwin') app.quit()
})

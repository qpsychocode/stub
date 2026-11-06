import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type AgentStatus, type StubApi } from '@shared/contract'

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: StubApi = {
  store: {
    load: () => ipcRenderer.invoke(IPC.storeLoad),
    save: (data) => ipcRenderer.invoke(IPC.storeSave, data),
    saveNow: (data) => ipcRenderer.sendSync(IPC.storeSaveNow, data) as boolean,
    deleted: () => ipcRenderer.invoke(IPC.storeDeleted)
  },
  asr: {
    status: () => ipcRenderer.invoke(IPC.asrStatus),
    start: (language) => ipcRenderer.invoke(IPC.asrStart, language),
    push: (samples) => ipcRenderer.send(IPC.asrPush, samples),
    stop: () => ipcRenderer.invoke(IPC.asrStop),
    cancel: () => ipcRenderer.send(IPC.asrCancel),
    onPartial: (cb) => subscribe<[string]>(IPC.asrPartialEvt, cb),
    onStatus: (cb) => subscribe<[Parameters<typeof cb>[0]]>(IPC.asrStatusEvt, cb),
    reload: (modelDir) => ipcRenderer.invoke(IPC.asrReload, modelDir)
  },
  harness: {
    send: (req) => ipcRenderer.invoke(IPC.harnessSend, req),
    listChats: (target) => ipcRenderer.invoke(IPC.harnessChats, target),
    sendToCursor: (req) => ipcRenderer.invoke(IPC.harnessDrop, req),
    detect: (targets) => ipcRenderer.invoke(IPC.harnessDetect, targets)
  },
  terminals: {
    available: () => ipcRenderer.invoke(IPC.termAvailable),
    create: (kind, cwd, cols, rows) => ipcRenderer.invoke(IPC.termCreate, kind, cwd, cols, rows),
    write: (id, data) => ipcRenderer.send(IPC.termWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(IPC.termResize, id, cols, rows),
    kill: (id) => ipcRenderer.send(IPC.termKill, id),
    paste: (id, text, images, bracketed) => ipcRenderer.invoke(IPC.termPaste, id, text, images, bracketed),
    onData: (cb) => subscribe<[string, string]>(IPC.termDataEvt, cb),
    onExit: (cb) => subscribe<[string, number]>(IPC.termExitEvt, cb),
    pickFolder: () => ipcRenderer.invoke(IPC.termPickFolder),
    clone: (url, parent) => ipcRenderer.invoke(IPC.termClone, url, parent)
  },
  updates: {
    state: () => ipcRenderer.invoke(IPC.updatesState),
    check: () => ipcRenderer.send(IPC.updatesCheck),
    install: () => ipcRenderer.send(IPC.updatesInstall),
    onChange: (cb) => subscribe<[Parameters<typeof cb>[0]]>(IPC.updatesEvt, cb)
  },
  models: {
    state: () => ipcRenderer.invoke(IPC.modelsState),
    download: (id) => ipcRenderer.send(IPC.modelsDownload, id),
    cancel: (id) => ipcRenderer.send(IPC.modelsCancel, id),
    remove: (dir) => ipcRenderer.invoke(IPC.modelsRemove, dir),
    onEvent: (cb) => subscribe<[Parameters<typeof cb>[0]]>(IPC.modelsEvt, cb)
  },
  images: {
    add: (bytes) => ipcRenderer.invoke(IPC.imagesAdd, bytes),
    get: (id) => ipcRenderer.invoke(IPC.imagesGet, id)
  },
  agents: {
    watch: (list) => ipcRenderer.send(IPC.agentsWatch, list),
    onStatus: (cb) => subscribe<[string, AgentStatus]>(IPC.agentsStatusEvt, cb)
  },
  limits: {
    read: () => ipcRenderer.invoke(IPC.limitsRead),
    signInClaude: () => ipcRenderer.invoke(IPC.limitsSignInClaude)
  },
  clipboard: {
    write: (text) => ipcRenderer.send(IPC.clipboardWrite, text)
  },
  app: {
    setHotkey: (accelerator) => ipcRenderer.invoke(IPC.appSetHotkey, accelerator),
    onHotkey: (cb) => subscribe<[]>(IPC.appHotkeyEvt, cb),
    minimize: () => ipcRenderer.send(IPC.winMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.winToggleMax),
    close: () => ipcRenderer.send(IPC.winClose),
    onMaximizedChange: (cb) => subscribe<[boolean]>(IPC.winMaxEvt, cb)
  }
}

contextBridge.exposeInMainWorld('api', api)

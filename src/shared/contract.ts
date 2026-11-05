// Shared contract between main, preload and renderer.
// Owned by the architect. Do not change shapes without updating both sides.

export type TicketStatus = 'todo' | 'doing' | 'done'

export interface SendRecord {
  targetId: string
  targetName: string
  at: number // epoch ms
  verified: boolean // true = paste confirmed by UI Automation or by the user
  submitted: boolean // Enter was pressed after paste
  windowTitle?: string // window the ticket landed in, when dragged out of STUB
}

export interface Project {
  id: string
  name: string
}

export interface TicketImage {
  id: string // full picture lives in the database
  thumb: string // small JPEG as a data: URL
  width: number
  height: number
}

export interface Ticket {
  id: string // crypto.randomUUID()
  projectId: string
  key: string // human key, e.g. "T-014" (sequential, from AppData.seq)
  title: string
  body: string
  status: TicketStatus
  order: number // sort order inside its lane (ascending)
  source: 'voice' | 'manual'
  createdAt: number
  updatedAt: number
  sentTo: SendRecord[]
  images?: TicketImage[]
}

export interface HarnessTarget {
  id: string
  name: string // "Claude Code"
  glyph: string // 2-3 letters shown in the socket when the target has no brand logo, e.g. "CC"
  processNames: string[] // Windows process names without .exe, case-insensitive, e.g. ["claude"]
  titleIncludes?: string // optional case-insensitive substring of the window title
  submit: boolean // press Enter after a verified paste
  builtin: boolean
}

export interface LimitWindow {
  kind: 'five_hour' | 'weekly'
  usedPercent: number // 0-100
  resetsAt: number | null // epoch ms
}

export interface HarnessLimits {
  status: 'ok' | 'signin' | 'error' | 'none' // signin: needs STUB's own login; none: this harness is not available here
  windows: LimitWindow[]
  note?: string
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error'
  current: string // running version
  version?: string // the new one
  percent?: number
  message?: string
}

export interface ModelJob {
  phase: 'download' | 'unpack'
  received: number
  total: number
}

export interface ModelItem {
  id: string
  name: string
  langs: string[]
  note: string
  bytes: number
  version: string // newest known
  installed: { dir: string; version: string } | null
  updateAvailable: boolean
  job: ModelJob | null
}

export interface ModelsState {
  items: ModelItem[]
  external: { dir: string; name: string }[] // found in other apps, never changed by STUB
  online: boolean // false: GitHub could not be asked, so versions are the built-in ones
}

export interface ModelEvent {
  id: string
  job: ModelJob | null // null: finished, one way or another
  doneDir?: string
  replacesDir?: string | null
  error?: string
}

export interface DeletedTicket {
  ticket: Ticket
  deletedAt: number // epoch ms
}

export interface AppSettings {
  theme: 'paper' | 'carbon' // light / dark
  uiLanguage: 'ru' | 'en'
  hotkey: string // GLOBAL dictation hotkey (works from any app), Electron accelerator, default "Control+Alt+T"
  voiceKey: string // IN-APP dictation shortcut (only while STUB is focused), accelerator format, default "Control+N"
  micDeviceId: string // '' = system default
  language: string // 'auto' | 'ru' | 'en' ... passed to the ASR stream
  modelDir: string // '' = auto-detect from Beautiful Voice
  returnFocus: boolean // bring STUB back to front after sending to a harness
  targets: HarnessTarget[]
}

export interface AppData {
  version: 1
  seq: number // last used ticket number
  tickets: Ticket[]
  projects: Project[] // never empty
  activeProjectId: string
  settings: AppSettings
}

export type AsrState = 'loading' | 'ready' | 'listening' | 'finishing' | 'no-model' | 'error'

export interface AsrStatus {
  state: AsrState
  modelName: string // e.g. "nemotron-3.5-asr-streaming"
  modelDir: string
  message?: string
}

export type SendOutcome =
  | 'verified' // text was found in the focused control after paste
  | 'unverified' // pasted, but the focused control could not be read — ask the user
  | 'not-found' // no running window for this target (text left in clipboard)
  | 'focus-failed' // window exists but could not be brought to front (text left in clipboard)
  | 'error'

export interface SendResult {
  outcome: SendOutcome
  submitted: boolean
  windowTitle?: string
  message?: string
}

export interface SendRequest {
  ticketId: string
  target: HarnessTarget
  text: string
  images: string[] // pasted before the text, in order
  returnFocus: boolean
}

/** Paste into whatever window is under the cursor (a ticket dragged out of STUB). */
export interface DropRequest {
  targets: HarnessTarget[] // used to recognise the window; its process may match none of them
  text: string
  images: string[] // pasted before the text, in order
  returnFocus: boolean
}

export interface DropResult {
  outcome: SendOutcome | 'no-window' // no-window: released over STUB itself or the desktop; clipboard untouched
  submitted: boolean
  targetId?: string // matched harness target
  appName?: string // process name of the window, e.g. "claude"
  windowTitle?: string
  message?: string
}

/** The text pasted into a harness for a ticket. */
export function buildPrompt(t: Pick<Ticket, 'title' | 'body'>): string {
  const title = t.title.trim()
  const body = t.body.trim()
  if (!body) return title
  if (!title || body.toLowerCase().startsWith(title.toLowerCase().replace(/[.…]+$/, ''))) return body
  return `${title}\n\n${body}`
}

export const DEFAULT_TARGETS: HarnessTarget[] = [
  { id: 'claude', name: 'Claude Code', glyph: 'CC', processNames: ['claude'], submit: false, builtin: true },
  { id: 'opencode', name: 'OpenCode', glyph: 'OC', processNames: ['OpenCode'], submit: false, builtin: true },
  // The Codex desktop app's window belongs to ChatGPT.exe; codex.exe is its windowless engine.
  { id: 'codex', name: 'Codex', glyph: 'CX', processNames: ['ChatGPT', 'Codex'], submit: false, builtin: true }
]

export const DEFAULT_PROJECT: Project = { id: 'default', name: 'Общий' }

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'paper',
  uiLanguage: 'ru',
  hotkey: 'Control+Alt+T',
  voiceKey: 'Control+N',
  micDeviceId: '',
  language: 'auto',
  modelDir: '',
  returnFocus: false,
  targets: DEFAULT_TARGETS
}

/**
 * window.api — exposed by preload via contextBridge.
 * Renderer owns ticket state and persists it through store.save (debounced on the renderer side).
 */
export interface StubApi {
  store: {
    load(): Promise<AppData>
    save(data: AppData): Promise<void>
    /** Blocks until written; for the moment the window closes. Resolves to false if the write failed. */
    saveNow(data: AppData): boolean
    deleted(): Promise<DeletedTicket[]>
  }
  asr: {
    status(): Promise<AsrStatus>
    /** Open a fresh recognition stream. Rejects if the model is not ready. */
    start(language: string): Promise<void>
    /** 16 kHz mono float32 PCM, roughly 100 ms per call. Fire-and-forget. */
    push(samples: Float32Array): void
    /** Flush, finish the stream and resolve with the final text. */
    stop(): Promise<string>
    cancel(): void
    onPartial(cb: (text: string) => void): () => void
    onStatus(cb: (s: AsrStatus) => void): () => void
    /** Reload the recognizer (e.g. after settings.modelDir changed). */
    reload(modelDir: string): Promise<AsrStatus>
  }
  harness: {
    send(req: SendRequest): Promise<SendResult>
    sendToCursor(req: DropRequest): Promise<DropResult>
    /** Which targets currently have a window. Keyed by target id. */
    detect(targets: HarnessTarget[]): Promise<Record<string, boolean>>
  }
  updates: {
    state(): Promise<UpdateState>
    check(): void
    /** Restarts into the downloaded version. */
    install(): void
    onChange(cb: (s: UpdateState) => void): () => void
  }
  models: {
    state(): Promise<ModelsState>
    /** Runs in the background; follow it with onEvent. */
    download(id: string): void
    cancel(id: string): void
    remove(dir: string): Promise<void>
    onEvent(cb: (e: ModelEvent) => void): () => void
  }
  images: {
    /** Stores a picture; rejects with a readable message if it cannot be used. */
    add(bytes: Uint8Array): Promise<TicketImage>
    /** The full picture as a data: URL. */
    get(id: string): Promise<string | null>
  }
  limits: {
    /** Current plan limits, keyed by harness target id. */
    read(): Promise<Record<string, HarnessLimits>>
    /** Opens the Claude sign-in window; resolves when it closes. */
    signInClaude(): Promise<void>
  }
  clipboard: {
    write(text: string): void
  }
  app: {
    /** Re-register the global dictation hotkey. Resolves false if registration failed. */
    setHotkey(accelerator: string): Promise<boolean>
    /** Fired when the global hotkey is pressed (window is already shown and focused). */
    onHotkey(cb: () => void): () => void
    minimize(): void
    toggleMaximize(): void
    close(): void
    onMaximizedChange(cb: (maximized: boolean) => void): () => void
  }
}

// IPC channel names
export const IPC = {
  storeLoad: 'store:load',
  storeSave: 'store:save',
  storeSaveNow: 'store:save-now', // ipcRenderer.sendSync
  storeDeleted: 'store:deleted',
  asrStatus: 'asr:status',
  asrStart: 'asr:start',
  asrPush: 'asr:push', // ipcRenderer.send
  asrStop: 'asr:stop',
  asrCancel: 'asr:cancel', // ipcRenderer.send
  asrReload: 'asr:reload',
  asrPartialEvt: 'asr:partial', // main -> renderer
  asrStatusEvt: 'asr:status-evt', // main -> renderer
  harnessSend: 'harness:send',
  harnessDrop: 'harness:drop',
  harnessDetect: 'harness:detect',
  updatesState: 'updates:state',
  updatesCheck: 'updates:check', // ipcRenderer.send
  updatesInstall: 'updates:install', // ipcRenderer.send
  updatesEvt: 'updates:evt', // main -> renderer
  modelsState: 'models:state',
  modelsDownload: 'models:download', // ipcRenderer.send
  modelsCancel: 'models:cancel', // ipcRenderer.send
  modelsRemove: 'models:remove',
  modelsEvt: 'models:evt', // main -> renderer
  imagesAdd: 'images:add',
  imagesGet: 'images:get',
  limitsRead: 'limits:read',
  limitsSignInClaude: 'limits:signin-claude',
  clipboardWrite: 'clipboard:write', // ipcRenderer.send
  appSetHotkey: 'app:set-hotkey',
  appHotkeyEvt: 'app:hotkey', // main -> renderer
  winMinimize: 'win:minimize',
  winToggleMax: 'win:toggle-max',
  winClose: 'win:close',
  winMaxEvt: 'win:max-evt' // main -> renderer
} as const

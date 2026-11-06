// Follows the session logs of Claude Code, Codex and OpenCode to learn how a sent ticket is going.
// A ticket finds its session by its own text: the first prompt with that text after it was sent.
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import zlib from 'node:zlib'
import type { AgentStatus, AgentWatch } from '@shared/contract'

const POLL_MS = 3000
const SEARCH_SOON_MS = 5000 // how often a ticket that was just sent looks for its session
const SEARCH_LATER_MS = 60000 // a ticket pasted but not submitted yet
const SEARCH_FAST_FOR_MS = 10 * 60000
const SEARCH_FOR_MS = 3 * 86400000
const MATCH_SLACK_MS = 60000 // the send is recorded after the paste, so the prompt can be slightly older
const SETTLE_MS = 10000 // a turn can continue right after it seems to end
const QUICK_TOOL_MS = 30000 // a file edit taking this long is waiting for permission
const SLOW_TOOL_MS = 120000 // commands can really run this long
const SILENT_TEXT_MS = 120000 // for logs that do not record why a message stopped
const QUEUE_FORGET_MS = 60000 // a queued prompt starts as soon as a turn ends
const BACKGROUND_FORGET_MS = 30 * 60000
const CHUNK = 1 << 20
const PROMPT_KEEP = 4000

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'request_user_input', 'question'])
const NEVER_LATE_TOOLS = new Set(['Agent', 'Task', 'spawn_agent', 'wait', 'task']) // their subagents do the waiting
const SLOW_TOOLS = /bash|shell|exec|powershell|command|mcp__|web|fetch|search/i
const ASKS = /[?？]|(?<!\p{L})(скажи|подтверди|выбери|ответь|уточни|вопрос(?!ов нет)|let me know|please confirm|which (one|option)|should i|do you want)/iu

const promptKey = (text: string): string => text.replace(/\s+/g, '')

export interface Tail {
  prompts: { at: number; text: string }[]
  lastAt: number
  ended: boolean
  textOnly: boolean // the newest entry is plain text from the model
  lastText: string
  asked: boolean // the model filled in a question for the user
  error: boolean
  stopped: boolean
  blocked: boolean // the log says it is waiting for an approval
  queued: number
  background: number
  pending: Map<string, { name: string; at: number }>
  ignored: boolean
}

export function newTail(): Tail {
  return { prompts: [], lastAt: 0, ended: false, textOnly: false, lastText: '', asked: false, error: false, stopped: false, blocked: false, queued: 0, background: 0, pending: new Map(), ignored: false }
}

function begin(t: Tail, at: number): void {
  t.lastAt = Math.max(t.lastAt, at)
  t.ended = false
  t.textOnly = false
  t.lastText = ''
  t.asked = false
  t.error = false
  t.stopped = false
  t.blocked = false
  t.pending.clear()
}

function addPrompt(t: Tail, at: number, text: string, keepSince: number): void {
  if (at >= keepSince) t.prompts.push({ at, text: promptKey(text).slice(0, PROMPT_KEEP) })
  begin(t, at)
}

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n')
}

export function feedClaude(t: Tail, e: any, keepSince: number): void {
  const at = Date.parse(e.timestamp) || 0
  if (e.type === 'queue-operation') {
    if (e.operation === 'enqueue') t.queued++
    else t.queued = Math.max(0, t.queued - 1)
    return
  }
  if (e.type === 'attachment') {
    if (e.attachment?.type === 'queued_command' && typeof e.attachment.prompt === 'string' && e.attachment.origin?.kind !== 'task-notification') addPrompt(t, at, e.attachment.prompt, keepSince)
    return
  }
  if (e.isSidechain || e.isMeta) return
  if (e.type === 'user') {
    const content = e.message?.content
    const results = Array.isArray(content) ? content.filter((p) => p?.type === 'tool_result') : []
    if (results.length > 0) {
      for (const r of results) t.pending.delete(r.tool_use_id)
      const use = e.toolUseResult
      if (use && (use.backgroundTaskId || use.status === 'async_launched')) t.background++
      t.lastAt = Math.max(t.lastAt, at)
      t.ended = false
      t.textOnly = false
      t.blocked = false
      return
    }
    if (e.isCompactSummary || e.isVisibleInTranscriptOnly) return
    if (e.origin?.kind === 'task-notification') {
      t.background = Math.max(0, t.background - 1)
      t.lastAt = Math.max(t.lastAt, at)
      t.ended = false
      return
    }
    const text = textOf(content)
    if (text.startsWith('[Request interrupted')) {
      t.lastAt = Math.max(t.lastAt, at)
      t.pending.clear()
      t.stopped = true
      t.ended = true
      return
    }
    if (e.promptSource === 'system') return
    addPrompt(t, at, text, keepSince)
    return
  }
  if (e.type !== 'assistant') return
  t.lastAt = Math.max(t.lastAt, at)
  const parts = Array.isArray(e.message?.content) ? e.message.content : []
  let usesTool = false
  let text = ''
  for (const p of parts) {
    if (p?.type === 'text' && p.text) text = p.text
    if (p?.type === 'tool_use') {
      usesTool = true
      t.pending.set(p.id, { name: String(p.name), at })
      if (/wrap_up$/.test(String(p.name)) && p.input?.ask) t.asked = true
    }
  }
  if (text) t.lastText = text
  t.textOnly = !usesTool && text !== ''
  const stop = e.message?.stop_reason
  t.ended = !usesTool && (stop === 'end_turn' || stop === 'stop_sequence')
  if (e.isApiErrorMessage) {
    t.error = true
    t.ended = true
  } else if (t.ended) t.error = false
}

export function feedCodex(t: Tail, e: any, keepSince: number): void {
  const at = Date.parse(e.timestamp) || 0
  const p = e.payload ?? {}
  if (e.type === 'session_meta') {
    if (p.source && typeof p.source === 'object' && p.source.subagent) t.ignored = true
    return
  }
  if (e.type === 'response_item') {
    if (p.type === 'message' && p.role === 'user') {
      const text = textOf(p.content)
      if (text.startsWith('<environment_context>')) return
      addPrompt(t, at, text, keepSince)
    } else if (p.type === 'message' && p.role === 'assistant') {
      const text = textOf(p.content)
      if (text) t.lastText = text
      t.lastAt = Math.max(t.lastAt, at)
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      t.pending.set(p.call_id, { name: String(p.name), at })
      t.lastAt = Math.max(t.lastAt, at)
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      t.pending.delete(p.call_id)
      t.blocked = false
      t.lastAt = Math.max(t.lastAt, at)
    }
    return
  }
  if (e.type !== 'event_msg') return
  const kind = String(p.type)
  if (kind === 'task_started') {
    t.ended = false
    t.stopped = false
    t.error = false
    t.lastAt = Math.max(t.lastAt, at)
  } else if (kind === 'task_complete') {
    t.lastAt = Math.max(t.lastAt, at)
    t.pending.clear()
    t.blocked = false
    t.ended = true
    t.error = Boolean(p.error)
    if (typeof p.last_agent_message === 'string' && p.last_agent_message) t.lastText = p.last_agent_message
  } else if (kind === 'turn_aborted') {
    t.lastAt = Math.max(t.lastAt, at)
    t.pending.clear()
    t.blocked = false
    t.stopped = true
    t.ended = true
  } else if (/approval_request|elicitation_request/.test(kind)) {
    t.lastAt = Math.max(t.lastAt, at)
    t.blocked = true
  }
}

/** One message row of OpenCode's session_message table. */
export function feedOpenCode(t: Tail, type: string, data: any, updatedAt: number, keepSince: number): void {
  if (type === 'user') {
    addPrompt(t, Number(data.time?.created) || updatedAt, String(data.text ?? data.metadata?.displayText ?? ''), keepSince)
  } else if (type === 'assistant') {
    t.lastAt = Math.max(t.lastAt, updatedAt)
    t.ended = false
    let text = ''
    for (const c of Array.isArray(data.content) ? data.content : []) {
      if (c?.type === 'text' && c.text) text = c.text
      if (c?.type !== 'tool') continue
      const status = typeof c.state === 'string' ? c.state : c.state?.status
      if (status === 'completed' || status === 'error') t.pending.delete(c.id)
      else t.pending.set(c.id, { name: String(c.name), at: updatedAt })
    }
    if (text) t.lastText = text
  } else if (type === 'idle') {
    t.lastAt = Math.max(t.lastAt, updatedAt)
    t.pending.clear()
    t.ended = true
    t.error = data.outcome === 'failed'
    t.stopped = data.outcome !== 'failed' && data.outcome !== 'succeeded'
  }
}

/** Whether a model's closing message waits for the user. */
export function asksUser(text: string): boolean {
  const plain = text.replace(/```[\s\S]*?```/g, ' ')
  const paragraphs = plain.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
  return ASKS.test(paragraphs.slice(-1)[0]?.slice(-500) ?? '')
}

export function statusOf(t: Tail, now: number): AgentStatus {
  if (t.stopped) return { state: 'waiting', reason: 'stopped' }
  if (t.error && t.ended) return { state: 'waiting', reason: 'error' }
  if (t.blocked) return { state: 'waiting', reason: 'permission' }
  for (const { name, at } of t.pending.values()) {
    if (QUESTION_TOOLS.has(name)) return { state: 'waiting', reason: 'question' }
    if (NEVER_LATE_TOOLS.has(name)) continue
    if (now - at > (SLOW_TOOLS.test(name) ? SLOW_TOOL_MS : QUICK_TOOL_MS)) return { state: 'waiting', reason: 'permission' }
  }
  if (t.pending.size > 0) return { state: 'working' }
  const idle = now - t.lastAt
  if (!t.ended && !(t.textOnly && idle > SILENT_TEXT_MS)) return { state: 'working' }
  if (idle < SETTLE_MS) return { state: 'working' }
  if (t.queued > 0 && idle < QUEUE_FORGET_MS) return { state: 'working' }
  if (t.background > 0 && idle < BACKGROUND_FORGET_MS) return { state: 'working' }
  return t.asked || asksUser(t.lastText) ? { state: 'waiting', reason: 'question' } : { state: 'finished' }
}

const WORKING: AgentStatus = { state: 'working' }

type Feed = (t: Tail, e: any, keepSince: number) => void

/** Reads a growing .jsonl file a piece at a time, so a long first read never stalls the app. */
class LogFile {
  tail = newTail()
  path: string
  feed: Feed
  private offset = 0
  private carry: Buffer = Buffer.alloc(0)
  private packedAt = 0
  private filter: RegExp

  constructor(path: string, feed: Feed, filter: RegExp) {
    this.path = path
    this.feed = feed
    this.filter = filter
  }

  async pump(keepSince: number): Promise<void> {
    if (this.path.endsWith('.zst')) return this.pumpPacked(keepSince)
    const file = await fs.open(this.path, 'r').catch(() => null)
    if (!file) return
    try {
      const { size } = await file.stat()
      while (this.offset < size) {
        const piece = Buffer.alloc(Math.min(CHUNK, size - this.offset))
        const { bytesRead } = await file.read(piece, 0, piece.length, this.offset)
        if (bytesRead === 0) break
        this.offset += bytesRead
        const data = this.carry.length > 0 ? Buffer.concat([this.carry, piece.subarray(0, bytesRead)]) : piece.subarray(0, bytesRead)
        const end = data.lastIndexOf(10)
        if (end === -1) {
          this.carry = data
          continue
        }
        this.lines(data.toString('utf8', 0, end), keepSince)
        this.carry = data.subarray(end + 1)
      }
    } finally {
      await file.close().catch(() => undefined)
    }
  }

  private async pumpPacked(keepSince: number): Promise<void> {
    const decompress = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync
    if (!decompress) return
    const stat = await fs.stat(this.path).catch(() => null)
    if (!stat || stat.mtimeMs === this.packedAt) return
    try {
      const text = decompress(await fs.readFile(this.path)).toString('utf8')
      this.tail = newTail()
      this.lines(text, keepSince)
      this.packedAt = stat.mtimeMs
    } catch {
      // Still being written; the next round tries again.
    }
  }

  private lines(text: string, keepSince: number): void {
    for (const line of text.split('\n')) {
      if (!line || !this.filter.test(line)) continue
      try {
        this.feed(this.tail, JSON.parse(line), keepSince)
      } catch {
        // A line that is not JSON says nothing about the session.
      }
    }
  }
}

const CLAUDE_LINES = /"type":"(user|assistant|queue-operation)"|"queued_command"/
const CODEX_LINES = /"type":"(session_meta|response_item|event_msg)"/

const claudeRoot = (): string => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
const codexRoot = (): string => join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
const openCodeDb = (): string => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'opencode.db')

async function listDir(dir: string): Promise<{ name: string; isDir: boolean }[]> {
  const list = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return list.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
}

async function claudeFiles(): Promise<string[]> {
  const out: string[] = []
  for (const dir of await listDir(claudeRoot())) {
    if (!dir.isDir) continue
    const path = join(claudeRoot(), dir.name)
    // Subagents keep their logs one level deeper, so they are never picked up here.
    for (const f of await listDir(path)) if (!f.isDir && f.name.endsWith('.jsonl')) out.push(join(path, f.name))
  }
  return out
}

async function codexFiles(since: number): Promise<string[]> {
  const out: string[] = []
  const days = Math.min(30, Math.ceil((Date.now() - since) / 86400000) + 1)
  for (let i = 0; i <= days; i++) {
    const d = new Date(Date.now() - i * 86400000)
    const dir = join(codexRoot(), String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    for (const f of await listDir(dir)) if (/^rollout-.*\.jsonl(\.zst)?$/.test(f.name)) out.push(join(dir, f.name))
  }
  return out
}

/** OpenCode keeps its sessions in a database. Rebuilt per session, since a row changes while it streams. */
class OpenCodeLogs {
  tails = new Map<string, Tail>()
  private stamp = -1
  private seen = 0

  async read(keepSince: number): Promise<void> {
    const path = openCodeDb()
    const stats = await Promise.all([fs.stat(path).catch(() => null), fs.stat(`${path}-wal`).catch(() => null)])
    if (!stats[0]) return
    const stamp = (stats[0]?.mtimeMs ?? 0) + (stats[1]?.mtimeMs ?? 0) + (stats[1]?.size ?? 0)
    if (stamp === this.stamp) return
    this.stamp = stamp
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(path, { readOnly: true })
      const changed = db.prepare('SELECT DISTINCT session_id AS id FROM session_message WHERE time_updated >= ?').all(Math.max(this.seen, keepSince)) as { id: string }[]
      const rows = db.prepare('SELECT type, data, time_updated AS at FROM session_message WHERE session_id = ? AND time_created >= ? ORDER BY seq')
      for (const { id } of changed) {
        const tail = newTail()
        for (const r of rows.all(id, keepSince) as { type: string; data: string; at: number }[]) {
          feedOpenCode(tail, r.type, JSON.parse(r.data), Number(r.at), keepSince)
          this.seen = Math.max(this.seen, Number(r.at))
        }
        this.tails.set(id, tail)
      }
    } catch {
      // Older OpenCode, a database being rebuilt, or a busy file: nothing to learn this round.
    } finally {
      db?.close()
    }
  }
}

export class AgentWatcher {
  private watches: AgentWatch[] = []
  private bound = new Map<string, () => Tail>() // by watch id
  private told = new Map<string, string>()
  private files = new Map<string, LogFile>() // by session id, which a file keeps when it is packed later
  private openCode = new OpenCodeLogs()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private lastSearch = 0
  private keepSince = 0
  private emit: (ticketId: string, status: AgentStatus) => void

  constructor(emit: (ticketId: string, status: AgentStatus) => void) {
    this.emit = emit
  }

  setWatches(list: AgentWatch[]): void {
    this.watches = list
    const ids = new Set(list.map(watchId))
    for (const id of [...this.bound.keys()]) if (!ids.has(id)) this.bound.delete(id)
    for (const id of [...this.told.keys()]) if (!ids.has(id)) this.told.delete(id)
    // A ticket sent again starts clean, whatever its previous session ended with.
    for (const w of list) {
      if (this.told.has(watchId(w))) continue
      this.told.set(watchId(w), JSON.stringify(WORKING))
      this.emit(w.ticketId, WORKING)
    }
    if (list.length === 0) {
      this.stop()
      this.files.clear()
      this.openCode = new OpenCodeLogs()
      return
    }
    const oldest = Math.min(...list.map((w) => w.sentAt)) - MATCH_SLACK_MS
    if (this.files.size === 0) this.keepSince = oldest
    this.lastSearch = 0
    if (!this.timer) this.timer = setInterval(() => void this.tick(), POLL_MS)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.search()
      await this.readBound()
      const now = Date.now()
      for (const w of this.watches) {
        const tail = this.bound.get(watchId(w))?.()
        if (!tail) continue
        const status = statusOf(tail, now)
        const json = JSON.stringify(status)
        if (this.told.get(watchId(w)) === json) continue
        this.told.set(watchId(w), json)
        this.emit(w.ticketId, status)
      }
    } catch (e) {
      console.error('agent watch', e)
    } finally {
      this.running = false
    }
  }

  private async readBound(): Promise<void> {
    await Promise.all([...this.files.values()].filter((f) => f.tail.prompts.length > 0).map((f) => f.pump(this.keepSince)))
    if (this.watches.length > 0) await this.openCode.read(this.keepSince)
  }

  /** Looks for the sessions of tickets that have none yet. */
  private async search(): Promise<void> {
    const now = Date.now()
    const open = this.watches.filter((w) => !this.bound.has(watchId(w)) && now - w.sentAt < SEARCH_FOR_MS)
    if (open.length === 0) return
    const fast = open.some((w) => now - w.sentAt < SEARCH_FAST_FOR_MS)
    if (now - this.lastSearch < (fast ? SEARCH_SOON_MS : SEARCH_LATER_MS)) return
    this.lastSearch = now
    const since = Math.min(...open.map((w) => w.sentAt)) - MATCH_SLACK_MS
    await this.collect(await claudeFiles(), feedClaude, CLAUDE_LINES, since)
    await this.collect(await codexFiles(since), feedCodex, CODEX_LINES, since)
    for (const f of this.files.values()) await f.pump(this.keepSince)
    await this.openCode.read(this.keepSince)
    for (const w of open) {
      let best: { at: number; get: () => Tail } | null = null
      const consider = (tail: Tail, get: () => Tail): void => {
        if (tail.ignored) return
        const hit = tail.prompts.find((p) => p.at >= w.sentAt - MATCH_SLACK_MS && p.text.includes(w.key))
        if (hit && (!best || hit.at < best.at)) best = { at: hit.at, get }
      }
      for (const f of this.files.values()) consider(f.tail, () => f.tail)
      const logs = this.openCode
      for (const [id, tail] of logs.tails) consider(tail, () => logs.tails.get(id) ?? tail)
      if (best) this.bound.set(watchId(w), (best as { get: () => Tail }).get)
    }
  }

  private async collect(paths: string[], feed: Feed, filter: RegExp, since: number): Promise<void> {
    for (const path of paths) {
      const id = basename(path).replace(/\.jsonl(\.zst)?$/, '')
      if (this.files.has(id)) continue
      const stat = await fs.stat(path).catch(() => null)
      if (stat && stat.mtimeMs >= since) this.files.set(id, new LogFile(path, feed, filter))
    }
  }
}

const watchId = (w: AgentWatch): string => `${w.ticketId}:${w.sentAt}`

import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_PROJECT, DEFAULT_SETTINGS, DEFAULT_TARGETS, type AppData, type AppSettings, type DeletedTicket, type HarnessTarget, type Project, type Ticket } from '@shared/contract'

// Local SQLite database: <userData>/stub.db. Tickets are never hard-deleted and every change is kept in ticket_history.
const LEGACY_FILE = 'stub-data.json' // imported once into an empty database, then left untouched
const BACKUPS_KEPT = 14
const SCHEMA_VERSION = 1

const userData = (): string => app.getPath('userData')
export const dbPath = (): string => join(userData(), 'stub.db')

let db: DatabaseSync | null = null
let lastBackupDay = ''

function open(): DatabaseSync {
  if (db) return db
  mkdirSync(userData(), { recursive: true })
  const d = new DatabaseSync(dbPath())
  try {
    d.exec('PRAGMA busy_timeout = 2000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    const check = d.prepare('PRAGMA quick_check').get() as { quick_check: string }
    if (check.quick_check !== 'ok') throw new Error(`база повреждена: ${check.quick_check}`)
    d.exec(`
      CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, data TEXT NOT NULL, deleted_at INTEGER);
      CREATE TABLE IF NOT EXISTS ticket_history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        action TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ticket_history_ticket ON ticket_history (ticket_id, seq);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, png BLOB NOT NULL, created_at INTEGER NOT NULL);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
  } catch (e) {
    d.close()
    throw e
  }
  db = d
  return d
}

function transaction<T>(d: DatabaseSync, fn: () => T): T {
  d.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    d.exec('COMMIT')
    return r
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
}

function seedTickets(): Ticket[] {
  const now = Date.now()
  const mk = (n: number, status: Ticket['status'], order: number, title: string, body: string, source: Ticket['source']): Ticket => ({
    id: crypto.randomUUID(),
    projectId: DEFAULT_PROJECT.id,
    key: `T-${String(n).padStart(3, '0')}`,
    title,
    body,
    status,
    order,
    source,
    createdAt: now - (4 - n) * 3600_000,
    updatedAt: now - (4 - n) * 3600_000,
    sentTo: []
  })
  return [
    mk(1, 'todo', 0, 'Попробовать голосовой ввод', 'Нажми Ctrl+Alt+T или кнопку микрофона, надиктуй задачу и создай тикет.', 'manual'),
    mk(2, 'doing', 0, 'Перетащить карточку в Claude Code', 'Перетащи тикет на сокет справа — текст вставится в окно агента.', 'manual'),
    mk(3, 'done', 0, 'Установить STUB', 'Приложение запущено, модель распознавания загружена.', 'manual')
  ]
}

/** The built-in ChatGPT socket was the Codex app's real window under another name: it folds into the Codex socket. */
function mergeChatgptIntoCodex(targets: HarnessTarget[]): HarnessTarget[] {
  const old = targets.find((t) => t.id === 'chatgpt' && t.builtin)
  if (!old) return targets
  return targets
    .filter((t) => t !== old)
    .map((t) => (t.id === 'codex' ? { ...t, processNames: ['ChatGPT', ...t.processNames.filter((n) => n.toLowerCase() !== 'chatgpt')], submit: t.submit || old.submit } : t))
}

function normalizeSettings(raw: Partial<AppSettings> | undefined): AppSettings {
  const s: AppSettings = { ...DEFAULT_SETTINGS, ...(raw ?? {}) }
  const targets = mergeChatgptIntoCodex(Array.isArray(raw?.targets) ? [...raw.targets] : [])
  for (const d of DEFAULT_TARGETS) {
    if (!targets.some((t) => t.id === d.id)) targets.push({ ...d, processNames: [...d.processNames] })
  }
  s.targets = targets
  return s
}

/** What the first start of this version puts into an empty database. A legacy file that cannot be read is an error, not an empty board. */
function initialData(): AppData {
  const file = join(userData(), LEGACY_FILE)
  if (!existsSync(file)) {
    return { version: 1, seq: 3, tickets: seedTickets(), projects: [DEFAULT_PROJECT], activeProjectId: DEFAULT_PROJECT.id, settings: normalizeSettings(undefined) }
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) as Partial<AppData>
  // Files saved before projects existed: everything lands in the first project.
  const projects: Project[] = Array.isArray(parsed.projects) && parsed.projects.length > 0 ? parsed.projects : [DEFAULT_PROJECT]
  const known = (id: unknown): boolean => projects.some((p) => p.id === id)
  const tickets = Array.isArray(parsed.tickets) ? parsed.tickets : []
  return {
    version: 1,
    seq: typeof parsed.seq === 'number' ? parsed.seq : tickets.length,
    tickets: tickets.map((t) => (known(t.projectId) ? t : { ...t, projectId: projects[0].id })),
    projects,
    activeProjectId: known(parsed.activeProjectId) ? (parsed.activeProjectId as string) : projects[0].id,
    settings: normalizeSettings(parsed.settings)
  }
}

function getMeta(d: DatabaseSync, key: string): string | undefined {
  return (d.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

/** Same ticket apart from its position in a lane? Dragging reorders neighbours; that is not worth a history row. */
function onlyOrderChanged(before: string, after: string): boolean {
  const { order: _a, ...x } = JSON.parse(before) as Ticket
  const { order: _b, ...y } = JSON.parse(after) as Ticket
  return JSON.stringify(x) === JSON.stringify(y)
}

function write(d: DatabaseSync, data: AppData, createAction: string): void {
  const now = Date.now()
  const rows = d.prepare('SELECT id, data, deleted_at FROM tickets').all() as { id: string; data: string; deleted_at: number | null }[]
  const existing = new Map(rows.map((r) => [r.id, r]))
  const upsert = d.prepare('INSERT INTO tickets (id, data, deleted_at) VALUES (?, ?, NULL) ON CONFLICT (id) DO UPDATE SET data = excluded.data, deleted_at = NULL')
  const log = d.prepare('INSERT INTO ticket_history (ticket_id, at, action, data) VALUES (?, ?, ?, ?)')
  const seen = new Set<string>()
  for (const t of data.tickets) {
    seen.add(t.id)
    const json = JSON.stringify(t)
    const old = existing.get(t.id)
    if (old && old.deleted_at === null && old.data === json) continue
    upsert.run(t.id, json)
    if (!old) log.run(t.id, now, createAction, json)
    else if (old.deleted_at !== null) log.run(t.id, now, 'restore', json)
    else if (!onlyOrderChanged(old.data, json)) log.run(t.id, now, 'update', json)
  }
  const remove = d.prepare('UPDATE tickets SET deleted_at = ? WHERE id = ?')
  for (const r of rows) {
    if (seen.has(r.id) || r.deleted_at !== null) continue
    remove.run(now, r.id)
    log.run(r.id, now, 'delete', r.data)
  }
  d.exec('DELETE FROM projects')
  const project = d.prepare('INSERT INTO projects (id, name, position) VALUES (?, ?, ?)')
  data.projects.forEach((p, i) => project.run(p.id, p.name, i))
  const meta = d.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
  meta.run('seq', String(data.seq))
  meta.run('activeProjectId', data.activeProjectId)
  meta.run('settings', JSON.stringify(data.settings))
}

/** One consistent copy per day in <userData>/backups; a failed backup must not get in the way of saving. */
function backupOncePerDay(d: DatabaseSync): void {
  const day = new Date().toLocaleDateString('sv') // YYYY-MM-DD, local time
  if (day === lastBackupDay) return
  try {
    const dir = join(userData(), 'backups')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `stub-${day}.db`)
    if (!existsSync(file)) d.prepare('VACUUM INTO ?').run(file)
    lastBackupDay = day
    const old = readdirSync(dir).filter((n) => /^stub-\d{4}-\d{2}-\d{2}\.db$/.test(n)).sort().slice(0, -BACKUPS_KEPT)
    for (const n of old) rmSync(join(dir, n), { force: true })
  } catch (e) {
    console.warn('[stub] backup failed', e)
  }
}

/** Lanes used to run newest first. Once only, so manual reordering made afterwards is kept. */
function sortLanesOldestFirstOnce(d: DatabaseSync): void {
  if (getMeta(d, 'lanesOldestFirst')) return
  transaction(d, () => {
    const rows = d.prepare('SELECT id, data FROM tickets').all() as { id: string; data: string }[]
    const tickets = rows.map((r) => JSON.parse(r.data) as Ticket).sort((a, b) => a.createdAt - b.createdAt)
    const next: Record<string, number> = {}
    const update = d.prepare('UPDATE tickets SET data = ? WHERE id = ?')
    for (const t of tickets) {
      const order = next[t.status] ?? 0
      next[t.status] = order + 1
      update.run(JSON.stringify({ ...t, order }), t.id)
    }
    d.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('lanesOldestFirst', '1')
  })
}

export function putImage(id: string, png: Buffer): void {
  open().prepare('INSERT INTO images (id, png, created_at) VALUES (?, ?, ?)').run(id, png, Date.now())
}

export function getImage(id: string): Buffer | null {
  const row = open().prepare('SELECT png FROM images WHERE id = ?').get(id) as { png: Uint8Array } | undefined
  return row ? Buffer.from(row.png) : null
}

/** Pictures from drafts that were never saved. Anything a ticket or its history mentions stays. */
function dropOrphanImages(d: DatabaseSync): void {
  d.prepare(`
    DELETE FROM images WHERE created_at < ?
      AND NOT EXISTS (SELECT 1 FROM tickets WHERE instr(tickets.data, images.id) > 0)
      AND NOT EXISTS (SELECT 1 FROM ticket_history WHERE instr(ticket_history.data, images.id) > 0)
  `).run(Date.now() - 86_400_000)
}

export async function loadData(): Promise<AppData> {
  const d = open()
  if (getMeta(d, 'seq') === undefined) {
    const first = initialData()
    transaction(d, () => write(d, first, 'import'))
  }
  backupOncePerDay(d) // before the reorder below, so the day's copy is the board as it was
  sortLanesOldestFirstOnce(d)
  dropOrphanImages(d)
  const rows = d.prepare('SELECT data FROM tickets WHERE deleted_at IS NULL').all() as { data: string }[]
  const projects = d.prepare('SELECT id, name FROM projects ORDER BY position').all() as unknown as Project[]
  return {
    version: 1,
    seq: Number(getMeta(d, 'seq')),
    tickets: rows.map((r) => JSON.parse(r.data) as Ticket),
    projects,
    activeProjectId: getMeta(d, 'activeProjectId') as string,
    settings: normalizeSettings(JSON.parse(getMeta(d, 'settings') as string) as Partial<AppSettings>)
  }
}

export function saveData(data: AppData): void {
  const d = open()
  transaction(d, () => write(d, data, 'create'))
  backupOncePerDay(d)
}

export function deletedTickets(): DeletedTicket[] {
  const rows = open().prepare('SELECT data, deleted_at FROM tickets WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200').all() as { data: string; deleted_at: number }[]
  return rows.map((r) => ({ ticket: JSON.parse(r.data) as Ticket, deletedAt: r.deleted_at }))
}

export function closeStore(): void {
  try {
    db?.close()
  } catch (e) {
    console.warn('[stub] closing the database failed', e)
  }
  db = null
}

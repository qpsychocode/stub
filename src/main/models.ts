// Speech model catalog: download, update and removal. Models live in <userData>/models/<id>-<version>.
import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { app, net } from 'electron'
import type { ModelEvent, ModelItem, ModelJob, ModelsState } from '@shared/contract'
import { inspectModelDir, listExternalModels } from './model.ts'

const RELEASE_API = 'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/tags/asr-models'
const DOWNLOAD_BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'
const CHECK_EVERY_MS = 3_600_000
const MANIFEST = '.stub-model.json'
const REMOVE_MARK = '.stub-remove'

interface CatalogEntry {
  id: string
  name: string
  langs: string
  note: string
  /** Asset name before the date; the release may hold newer dates, which is what an update is. */
  prefix: string
  /** Known good version, used when GitHub cannot be asked. */
  version: string
  bytes: number
}

const MB = 1024 * 1024
const CATALOG: CatalogEntry[] = [
  { id: 'nemotron-35-160', name: 'Nemotron 3.5 · 160 мс', langs: 'ru en', note: 'быстрый отклик', prefix: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-160ms-int8-', version: '2026-06-11', bytes: 453 * MB },
  { id: 'nemotron-35-560', name: 'Nemotron 3.5 · 560 мс', langs: 'ru en', note: 'точнее, но с задержкой', prefix: 'sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-', version: '2026-06-11', bytes: 453 * MB },
  { id: 'zipformer-multi', name: 'Zipformer, 8 языков', langs: 'ru en zh ja ar id th vi', note: 'для смеси языков', prefix: 'sherpa-onnx-streaming-zipformer-ar_en_id_ja_ru_th_vi_zh-', version: '2025-02-10', bytes: 247 * MB },
  { id: 'vosk-ru', name: 'Vosk small', langs: 'ru', note: 'только русский', prefix: 'sherpa-onnx-streaming-zipformer-small-ru-vosk-', version: '2025-08-16', bytes: 85 * MB },
  { id: 'vosk-ru-int8', name: 'Vosk small int8', langs: 'ru', note: 'только русский, самая лёгкая', prefix: 'sherpa-onnx-streaming-zipformer-small-ru-vosk-int8-', version: '2025-08-16', bytes: 23 * MB },
  { id: 'kroko-en', name: 'Kroko', langs: 'en', note: 'только английский', prefix: 'sherpa-onnx-streaming-zipformer-en-kroko-', version: '2025-08-06', bytes: 55 * MB }
]

const root = (): string => join(app.getPath('userData'), 'models')
const assetName = (e: CatalogEntry, version: string): string => `${e.prefix}${version}.tar.bz2`

interface Latest {
  version: string
  bytes: number
}
let latest: Record<string, Latest> = {}
let checkedAt = 0
let online = false

async function refreshLatest(): Promise<void> {
  if (Date.now() - checkedAt < CHECK_EVERY_MS) return
  checkedAt = Date.now()
  try {
    const r = await net.fetch(RELEASE_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'STUB' } })
    if (!r.ok) throw new Error(String(r.status))
    const assets = ((await r.json()) as { assets: { name: string; size: number }[] }).assets
    const next: Record<string, Latest> = {}
    for (const e of CATALOG) {
      for (const a of assets) {
        // The date must follow the prefix directly: "...-vosk-" must not catch "...-vosk-int8-".
        const m = a.name.startsWith(e.prefix) ? /^(\d{4}-\d{2}-\d{2})\.tar\.bz2$/.exec(a.name.slice(e.prefix.length)) : null
        if (m && (!next[e.id] || m[1] > next[e.id].version)) next[e.id] = { version: m[1], bytes: a.size }
      }
    }
    latest = next
    online = true
  } catch {
    online = false
    checkedAt = Date.now() - CHECK_EVERY_MS + 300_000 // try again in 5 minutes
  }
}

interface Installed {
  dir: string
  version: string
}

function installedModels(): Map<string, Installed> {
  const out = new Map<string, Installed>()
  if (!existsSync(root())) return out
  for (const n of readdirSync(root())) {
    const dir = join(root(), n)
    if (existsSync(join(dir, REMOVE_MARK))) {
      // Its files were still held open when it was removed.
      rmSync(dir, { recursive: true, force: true, maxRetries: 1 })
      continue
    }
    if (n.startsWith('.tmp-')) {
      if (!jobs.has(n.slice(5))) rmSync(dir, { recursive: true, force: true })
      continue
    }
    try {
      const m = JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8')) as { id: string; version: string }
      const cur = out.get(m.id)
      if (inspectModelDir(dir) && (!cur || m.version > cur.version)) out.set(m.id, { dir, version: m.version })
    } catch {
      /* not one of ours */
    }
  }
  return out
}

interface Running {
  job: ModelJob
  abort: AbortController
}
const jobs = new Map<string, Running>()

export async function modelsState(): Promise<ModelsState> {
  await refreshLatest()
  const installed = installedModels()
  const items: ModelItem[] = CATALOG.map((e) => {
    const l = latest[e.id]
    const inst = installed.get(e.id)
    return {
      id: e.id,
      name: e.name,
      langs: e.langs.split(' '),
      note: e.note,
      bytes: l?.bytes ?? e.bytes,
      version: l?.version ?? e.version,
      installed: inst ?? null,
      updateAvailable: Boolean(inst && l && l.version > inst.version),
      job: jobs.get(e.id)?.job ?? null
    }
  })
  return { items, external: listExternalModels(), online }
}

function unpack(archive: string, into: string): Promise<void> {
  // bsdtar ships with Windows and refuses paths that climb out of the target folder.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return new Promise((res, rej) => execFile(tar, ['-xjf', archive, '-C', into], { windowsHide: true, maxBuffer: 1 << 24 }, (e) => (e ? rej(e) : res())))
}

/** Runs in the background; progress and the outcome arrive as events. */
export function startDownload(id: string, emit: (e: ModelEvent) => void): void {
  const e = CATALOG.find((x) => x.id === id)
  if (!e || jobs.has(id)) return
  const version = latest[id]?.version ?? e.version
  const running: Running = { job: { phase: 'download', received: 0, total: latest[id]?.bytes ?? e.bytes }, abort: new AbortController() }
  jobs.set(id, running)
  const replaces = installedModels().get(id)?.dir ?? null
  const tmp = join(root(), `.tmp-${id}`)
  const run = async (): Promise<string> => {
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const archive = join(tmp, 'model.tar.bz2')
    const r = await net.fetch(`${DOWNLOAD_BASE}${assetName(e, version)}`, { signal: running.abort.signal, headers: { 'user-agent': 'STUB' } })
    if (!r.ok || !r.body) throw new Error(`GitHub ответил ${r.status}`)
    const total = Number(r.headers.get('content-length')) || running.job.total
    running.job = { phase: 'download', received: 0, total }
    let last = 0
    const source = Readable.fromWeb(r.body as WebReadableStream<Uint8Array>)
    source.on('data', (chunk: Buffer) => {
      running.job.received += chunk.length
      const now = Date.now()
      if (now - last > 200) {
        last = now
        emit({ id, job: running.job })
      }
    })
    await pipeline(source, createWriteStream(archive), { signal: running.abort.signal })
    // No published checksum to compare with, so the size is what proves the file arrived whole.
    if (statSync(archive).size !== total) throw new Error('Файл скачался не полностью')
    running.job = { phase: 'unpack', received: total, total }
    emit({ id, job: running.job })
    await unpack(archive, tmp)
    if (running.abort.signal.aborted) throw new DOMException('aborted', 'AbortError')
    const folder = readdirSync(tmp).map((n) => join(tmp, n)).find((p) => inspectModelDir(p))
    if (!folder) throw new Error('В архиве нет подходящих файлов модели')
    const dest = join(root(), `${id}-${version}`)
    rmSync(dest, { recursive: true, force: true })
    renameSync(folder, dest)
    writeFileSync(join(dest, MANIFEST), JSON.stringify({ id, version }))
    return dest
  }
  run()
    .then((dir) => {
      jobs.delete(id)
      rmSync(tmp, { recursive: true, force: true })
      emit({ id, job: null, doneDir: dir, replacesDir: replaces && replaces !== dir ? replaces : null })
    })
    .catch((err: Error) => {
      const cancelled = running.abort.signal.aborted
      jobs.delete(id)
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
      emit({ id, job: null, error: cancelled ? undefined : err.message })
    })
}

export function cancelDownload(id: string): void {
  jobs.get(id)?.abort.abort()
}

/** Only ever touches folders inside STUB's own models directory. */
export function removeModel(dir: string): void {
  const target = resolve(dir)
  if (!target.startsWith(resolve(root()) + sep)) throw new Error('Эта модель не принадлежит STUB')
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    writeFileSync(join(target, REMOVE_MARK), '') // still loaded: gone on the next look
  }
}

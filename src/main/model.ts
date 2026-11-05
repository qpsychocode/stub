// Model discovery (pure fs, no electron). Imported by the ASR worker and by tests,
// so keep relative imports with explicit extensions and no path aliases.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

export interface ModelFiles {
  dir: string
  name: string
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

export interface DiscoverResult {
  model?: ModelFiles
  message?: string
}

const NO_MODEL_MSG = 'Модель не найдена. Скачай её в настройках.'

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function pick(files: string[], prefix: string): string | undefined {
  const c = files.filter((f) => f.toLowerCase().startsWith(prefix) && f.toLowerCase().endsWith('.onnx'))
  return c.find((f) => f.toLowerCase().includes('int8')) ?? c[0]
}

/** Returns the model files if `dir` contains a complete transducer model. */
export function inspectModelDir(dir: string): ModelFiles | undefined {
  if (!dir || !isDir(dir)) return undefined
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return undefined
  }
  const encoder = pick(files, 'encoder')
  const decoder = pick(files, 'decoder')
  const joiner = pick(files, 'joiner')
  const tokens = files.find((f) => f.toLowerCase() === 'tokens.txt')
  if (!encoder || !decoder || !joiner || !tokens) return undefined
  return {
    dir,
    name: basename(dir),
    encoder: join(dir, encoder),
    decoder: join(dir, decoder),
    joiner: join(dir, joiner),
    tokens: join(dir, tokens)
  }
}

/** Models another app keeps on this machine: usable, never changed. */
export function listExternalModels(): { dir: string; name: string }[] {
  const local = process.env.LOCALAPPDATA
  if (!local) return []
  const modelsRoot = join(local, 'BeautifulVoice', 'models')
  if (!isDir(modelsRoot)) return []
  return readdirSync(modelsRoot).flatMap((d) => {
    const m = inspectModelDir(join(modelsRoot, d))
    return m ? [{ dir: m.dir, name: m.name }] : []
  })
}

export function discoverModel(settingsModelDir: string): DiscoverResult {
  const custom = (settingsModelDir ?? '').trim()
  if (custom) {
    const m = inspectModelDir(custom)
    if (m) return { model: m }
    return { message: `В папке «${custom}» нет файлов модели (encoder/decoder/joiner .onnx и tokens.txt).` }
  }

  const appData = process.env.APPDATA
  const local = process.env.LOCALAPPDATA
  if (!local) return { message: NO_MODEL_MSG }
  const modelsRoot = join(local, 'BeautifulVoice', 'models')

  // 1. Beautiful Voice active model
  if (appData) {
    try {
      const raw = readFileSync(join(appData, 'BeautifulVoice', 'settings.json'), 'utf8').replace(/^﻿/, '')
      const active = (JSON.parse(raw) as { active_model?: string }).active_model
      if (active) {
        const m = inspectModelDir(join(modelsRoot, active))
        if (m) return { model: m }
      }
    } catch {
      /* fall through to scan */
    }
  }

  // 2. Scan, preferring nemotron
  if (!isDir(modelsRoot)) return { message: NO_MODEL_MSG }
  const found: ModelFiles[] = []
  for (const d of readdirSync(modelsRoot)) {
    const m = inspectModelDir(join(modelsRoot, d))
    if (m) found.push(m)
  }
  if (found.length === 0) return { message: NO_MODEL_MSG }
  found.sort((a, b) => Number(/nemotron/i.test(b.name)) - Number(/nemotron/i.test(a.name)))
  return { model: found[0] }
}

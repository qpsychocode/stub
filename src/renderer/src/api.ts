import {
  DEFAULT_PROJECT,
  DEFAULT_SETTINGS,
  type AppData,
  type AsrStatus,
  type DropResult,
  type HarnessTarget,
  type SendRequest,
  type SendResult,
  type StubApi,
  type Ticket
} from '@shared/contract'

/** In-memory stand-in used when the renderer runs in a plain browser (no preload). */
function createMockApi(): StubApi {
  const now = Date.now()
  const mk = (n: number, status: Ticket['status'], title: string, body: string, ageMin: number, voice: boolean): Ticket => ({
    id: `mock-${n}`,
    projectId: n === 8 ? 'mock-site' : DEFAULT_PROJECT.id,
    key: `T-${String(n).padStart(3, '0')}`,
    title,
    body,
    status,
    order: n,
    source: voice ? 'voice' : 'manual',
    createdAt: now - ageMin * 60000,
    updatedAt: now - ageMin * 60000,
    sentTo:
      status === 'todo'
        ? []
        : [{ targetId: 'claude', targetName: 'Claude Code', at: now - ageMin * 30000, verified: true, submitted: status === 'done' }]
  })
  let data: AppData = {
    version: 1,
    seq: 8,
    projects: [DEFAULT_PROJECT, { id: 'mock-site', name: 'Сайт' }],
    activeProjectId: DEFAULT_PROJECT.id,
    settings: { ...DEFAULT_SETTINGS },
    tickets: [
      mk(1, 'todo', 'Добавить копирование промпта на карточку', 'Добавить копирование промпта на карточку тикета и показать тост об успехе. Проверить, что текст попадает в буфер целиком.', 5, true),
      mk(2, 'todo', 'Пересобрать сетку фонового паттерна', 'Точки должны быть тоньше, а зерно почти незаметным.', 42, false),
      mk(3, 'todo', 'Проверить горячую клавишу после сна системы', '', 190, true),
      mk(4, 'doing', 'Разобрать падение рабочего процесса распознавания при перезагрузке модели', 'Воспроизводится при смене каталога модели в настройках. Нужно проверить автоперезапуск и корректный статус в плашке.', 12, true),
      mk(5, 'doing', 'Отполировать анимацию дропа в гнездо', '', 90, false),
      mk(6, 'done', 'Верстка титульной панели', 'Кнопки окна, плашка модели, переключатель темы.', 1500, false),
      mk(7, 'done', 'Подключить шрифты офлайн', 'Unbounded, Onest, JetBrains Mono — с кириллическими подмножествами.', 3000, true),
      mk(8, 'done', 'Атомарная запись хранилища', '', 8000, false)
    ]
  }
  let asr: AsrStatus = { state: 'ready', modelName: 'nemotron-3.5-asr-streaming', modelDir: 'C:\\Users\\demo\\AppData\\Local\\BeautifulVoice\\models\\nemotron' }
  const statusCbs = new Set<(s: AsrStatus) => void>()
  const partialCbs = new Set<(t: string) => void>()
  const hotkeyCbs = new Set<() => void>()
  const setAsr = (s: AsrStatus): void => {
    asr = s
    statusCbs.forEach((cb) => cb(s))
  }
  const phrase = 'Добавить на карточку кнопку копирования промпта и проверить, что вставка работает в окне Claude Code. Потом обновить документацию.'.split(' ')
  let timer: number | undefined
  let words = 0

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.code === 'KeyT') hotkeyCbs.forEach((cb) => cb())
  })

  return {
    store: {
      load: async () => data,
      save: async (d) => {
        data = d
      },
      saveNow: (d) => {
        data = d
        return true
      },
      deleted: async () => []
    },
    asr: {
      status: async () => asr,
      start: async () => {
        words = 0
        setAsr({ ...asr, state: 'listening' })
        timer = window.setInterval(() => {
          words = Math.min(phrase.length, words + 1)
          const t = phrase.slice(0, words).join(' ')
          partialCbs.forEach((cb) => cb(t))
        }, 420)
      },
      push: () => undefined,
      stop: async () => {
        window.clearInterval(timer)
        setAsr({ ...asr, state: 'ready' })
        return phrase.slice(0, Math.max(words, 4)).join(' ')
      },
      cancel: () => {
        window.clearInterval(timer)
        setAsr({ ...asr, state: 'ready' })
      },
      onPartial: (cb) => {
        partialCbs.add(cb)
        return () => partialCbs.delete(cb)
      },
      onStatus: (cb) => {
        statusCbs.add(cb)
        return () => statusCbs.delete(cb)
      },
      reload: async () => asr
    },
    harness: {
      send: async (req: SendRequest): Promise<SendResult> => {
        await new Promise((r) => setTimeout(r, 1100))
        if (req.target.id === 'codex') return { outcome: 'unverified', submitted: false, windowTitle: 'Codex — рабочая область' }
        return { outcome: 'verified', submitted: req.target.submit, windowTitle: 'claude' }
      },
      sendToCursor: async (): Promise<DropResult> => {
        await new Promise((r) => setTimeout(r, 600))
        return { outcome: 'verified', submitted: false, targetId: 'claude', appName: 'claude', windowTitle: 'Claude' }
      },
      detect: async (targets: HarnessTarget[]) => Object.fromEntries(targets.map((t, i) => [t.id, i % 2 === 0]))
    },
    updates: {
      state: async () => ({ status: 'none', current: 'dev' }),
      check: () => undefined,
      install: () => undefined,
      onChange: () => () => undefined
    },
    models: {
      state: async () => ({ items: [], external: [], online: false }),
      download: () => undefined,
      cancel: () => undefined,
      remove: async () => undefined,
      onEvent: () => () => undefined
    },
    images: {
      add: async () => ({ id: crypto.randomUUID(), thumb: '', width: 1, height: 1 }),
      get: async () => null
    },
    limits: {
      read: async () => ({
        claude: { status: 'ok', windows: [{ kind: 'five_hour', usedPercent: 65, resetsAt: Date.now() + 5160000 }, { kind: 'weekly', usedPercent: 51, resetsAt: Date.now() + 86400000 }] },
        codex: { status: 'ok', windows: [{ kind: 'five_hour', usedPercent: 100, resetsAt: Date.now() + 3600000 }, { kind: 'weekly', usedPercent: 32, resetsAt: Date.now() + 86400000 }] }
      }),
      signInClaude: async () => undefined
    },
    clipboard: { write: (t) => void navigator.clipboard?.writeText(t).catch(() => undefined) },
    app: {
      setHotkey: async () => true,
      onHotkey: (cb) => {
        hotkeyCbs.add(cb)
        return () => hotkeyCbs.delete(cb)
      },
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined,
      onMaximizedChange: () => () => undefined
    }
  }
}

const w = window as unknown as { api?: StubApi }

export const hasNativeApi = Boolean(w.api)
export const api: StubApi = w.api ?? createMockApi()

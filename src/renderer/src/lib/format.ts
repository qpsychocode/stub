import { getLanguage, tr } from './i18n'

/** forms = [1 тикет, 2 тикета, 5 тикетов], already translated; English only uses the first and the last. */
export function plural(n: number, forms: [string, string, string]): string {
  if (getLanguage() === 'en') return n === 1 ? forms[0] : forms[2]
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return forms[2]
  if (b > 1 && b < 5) return forms[1]
  if (b === 1) return forms[0]
  return forms[2]
}

export function pluralN(n: number, forms: [string, string, string]): string {
  return `${n} ${plural(n, forms)}`
}

const MONTHS = {
  ru: ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
}
const month = (d: Date): string => MONTHS[getLanguage()][d.getMonth()]

const pad = (n: number): string => String(n).padStart(2, '0')

export function clock(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function dateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getDate()} ${month(d)}, ${clock(ts)}`
}

/** Short relative time: "сейчас", "5 мин", "3 ч", "2 дн", "12 окт". */
export function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return tr('сейчас')
  const m = Math.round(s / 60)
  if (m < 60) return tr('{0} мин', Math.max(1, m))
  const h = Math.round(m / 60)
  if (h < 24) return tr('{0} ч', h)
  const d = Math.round(h / 24)
  if (d < 7) return tr('{0} дн', d)
  const dt = new Date(ts)
  return `${dt.getDate()} ${month(dt)}`
}

export function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`
}

/** First sentence of a dictated text, cut on a word boundary with "…" when too long. */
export function deriveTitle(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const m = flat.match(/^(.+?[.!?…])(\s|$)/)
  let s = (m ? m[1] : flat).replace(/\.+$/, '').trim()
  if (s.length > max) {
    let cut = s.slice(0, max)
    const sp = cut.lastIndexOf(' ')
    if (sp > max * 0.5) cut = cut.slice(0, sp)
    s = cut.replace(/[\s,;:\-–—]+$/, '') + '…'
  }
  return s
}

/** Body text without the leading title (it is already shown as the title). */
export function previewOf(title: string, body: string): string {
  let b = body.trim()
  const t = title.trim().replace(/[.…]+$/, '')
  if (t && b.toLowerCase().startsWith(t.toLowerCase())) {
    b = b.slice(t.length).replace(/^[\s.…,:;!?-]+/, '')
  }
  return b
}

export function modelLabel(name: string): string {
  const s = name
    .split(/[-_ ]/)
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
    .toUpperCase()
  return s || 'ASR'
}

export function keycaps(accelerator: string): string[] {
  const map: Record<string, string> = {
    Control: 'Ctrl',
    CommandOrControl: 'Ctrl',
    CmdOrCtrl: 'Ctrl',
    Super: 'Win',
    Meta: 'Win',
    Return: 'Enter'
  }
  return accelerator
    .split('+')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => map[k] ?? k)
}

const CODE_NAMES: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Space: 'Space',
  Enter: 'Return',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

/** True if the keydown event matches the accelerator (by physical key code + exact modifiers). */
export function matchesAccelerator(e: KeyboardEvent, accelerator: string): boolean {
  const acc = acceleratorFromEvent(e)
  if (!acc) return false
  const norm = (a: string): string => {
    const parts = a.split('+').map((p) => (p === 'CommandOrControl' || p === 'CmdOrCtrl' ? 'Control' : p === 'Meta' ? 'Super' : p))
    return [...parts].sort().join('+')
  }
  return norm(acc) === norm(accelerator)
}

/** Build an Electron accelerator from a keydown event, or null if it is not a valid combo yet. */
export function acceleratorFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  let key: string | null = null
  const code = e.code
  const letter = /^Key([A-Z])$/.exec(code)
  const digit = /^Digit(\d)$/.exec(code)
  if (letter) key = letter[1]
  else if (digit) key = digit[1]
  else if (/^F\d{1,2}$/.test(code)) key = code
  else if (code in CODE_NAMES) key = CODE_NAMES[code]
  if (!key) return null
  const isF = /^F\d{1,2}$/.test(key)
  if (mods.length === 0 && !isF) return null
  return [...mods, key].join('+')
}

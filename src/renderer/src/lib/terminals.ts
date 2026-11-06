// Terminal tabs and their xterm instances. Lives outside React: a terminal must survive the remount a language switch causes.
import { useSyncExternalStore } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalKind } from '@shared/contract'
import { api } from '../api'

export interface TerminalTab {
  id: string
  kind: TerminalKind
  projectId: string
  exited: boolean
}

interface Instance {
  term: Terminal
  fit: FitAddon
  host: HTMLDivElement
  opened: boolean
}

const instances = new Map<string, Instance>()
const activeByProject = new Map<string, string>()
let tabs: TerminalTab[] = []
let version = 0
const listeners = new Set<() => void>()

function changed(): void {
  version++
  listeners.forEach((l) => l())
}

export function useTerminals(): { tabs: TerminalTab[]; activeOf: (projectId: string) => string | undefined } {
  useSyncExternalStore((l) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }, () => version)
  return { tabs, activeOf: (p) => activeByProject.get(p) }
}

/** Whether the program in this terminal has asked for pasted text to arrive as one block. */
export const takesBlocks = (id: string): boolean => instances.get(id)?.term.modes.bracketedPasteMode ?? false

export const activeTerminal = (projectId: string): TerminalTab | undefined => tabs.find((t) => t.id === activeByProject.get(projectId) && !t.exited)

function themeFromPage(): Record<string, string> {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string): string => css.getPropertyValue(n).trim()
  return { background: v('--surface'), foreground: v('--ink'), cursor: v('--accent'), cursorAccent: v('--surface'), selectionBackground: v('--accent-soft') }
}

export function applyTerminalTheme(): void {
  for (const i of instances.values()) i.term.options.theme = themeFromPage()
}

let wired = false
function wire(): void {
  if (wired) return
  wired = true
  api.terminals.onData((id, data) => instances.get(id)?.term.write(data))
  api.terminals.onExit((id) => {
    tabs = tabs.map((t) => (t.id === id ? { ...t, exited: true } : t))
    changed()
  })
}

export async function openTerminal(kind: TerminalKind, projectId: string, cwd: string): Promise<void> {
  wire()
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', Consolas, monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    theme: themeFromPage()
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const host = document.createElement('div')
  host.className = 'term-host'
  const id = await api.terminals.create(kind, cwd, 100, 30)
  term.onData((d) => api.terminals.write(id, d))
  term.onResize(({ cols, rows }) => api.terminals.resize(id, cols, rows))
  // Copy when something is selected, and paste; everything else goes to the program. On a Mac these are Cmd, and Ctrl+C stays an interrupt.
  const mac = navigator.platform.startsWith('Mac')
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !(mac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return true
    if (e.code === 'KeyC' && (mac || term.hasSelection())) {
      api.clipboard.write(term.getSelection())
      term.clearSelection()
      return false
    }
    if (e.code === 'KeyV') {
      e.preventDefault()
      void navigator.clipboard.readText().then((t) => t && term.paste(t))
      return false
    }
    return true
  })
  instances.set(id, { term, fit, host, opened: false })
  tabs = [...tabs, { id, kind, projectId, exited: false }]
  activeByProject.set(projectId, id)
  changed()
}

export function selectTerminal(projectId: string, id: string): void {
  activeByProject.set(projectId, id)
  changed()
}

export function closeTerminal(id: string): void {
  const tab = tabs.find((t) => t.id === id)
  if (tab && !tab.exited) api.terminals.kill(id)
  instances.get(id)?.term.dispose()
  instances.get(id)?.host.remove()
  instances.delete(id)
  tabs = tabs.filter((t) => t.id !== id)
  if (tab && activeByProject.get(tab.projectId) === id) {
    const next = tabs.filter((t) => t.projectId === tab.projectId).at(-1)
    if (next) activeByProject.set(tab.projectId, next.id)
    else activeByProject.delete(tab.projectId)
  }
  changed()
}

/** Puts the terminal into `container`, reusing its element if it was already opened. */
export function attachTerminal(id: string, container: HTMLElement): void {
  const i = instances.get(id)
  if (!i) return
  container.replaceChildren(i.host) // only one terminal shows at a time; the others stay alive, detached
  if (!i.opened) {
    i.term.open(i.host)
    i.opened = true
  }
  fitTerminal(id)
  i.term.focus()
}

export function fitTerminal(id: string): void {
  const i = instances.get(id)
  if (i?.opened && i.host.clientWidth > 0) i.fit.fit()
}

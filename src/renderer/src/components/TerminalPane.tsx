import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { FolderOpen, Plus, SquareTerminal, X } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { AppSettings, Project, TerminalKind } from '@shared/contract'
import { api } from '../api'
import { tr } from '../lib/i18n'
import { applyTerminalTheme, attachTerminal, closeTerminal, fitTerminal, openTerminal, selectTerminal, useTerminals } from '../lib/terminals'
import { HarnessLogo, hasLogo } from './HarnessLogo'
import { useToast } from './Toasts'

const KINDS: { kind: TerminalKind; label: string }[] = [
  { kind: 'claude', label: 'Claude' },
  { kind: 'codex', label: 'Codex' },
  { kind: 'opencode', label: 'OpenCode' },
  { kind: 'shell', label: 'Терминал' }
]
const labelOf = (k: TerminalKind): string => tr(KINDS.find((x) => x.kind === k)?.label ?? k)
const MIN_W = 320
const WIDTH_KEY = 'stub-terminal-width'

function savedWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return n >= MIN_W ? n : 560
  } catch {
    return 560
  }
}

function KindIcon({ kind }: { kind: TerminalKind }): JSX.Element {
  return hasLogo(kind) ? <HarnessLogo targetId={kind} glyph="" /> : <SquareTerminal size={14} strokeWidth={1.75} />
}

interface Props {
  open: boolean
  project: Project
  theme: AppSettings['theme']
  dragging: boolean
  onFolder: (projectId: string, folder: string) => void
}

export function TerminalPane({ open, project, theme, dragging, onFolder }: Props): JSX.Element | null {
  const { tabs, activeOf } = useTerminals()
  const toast = useToast()
  const [width, setWidth] = useState(savedWidth)
  const [available, setAvailable] = useState<Record<TerminalKind, boolean> | null>(null)
  const [repo, setRepo] = useState('')
  const [cloning, setCloning] = useState(false)
  const stage = useRef<HTMLDivElement>(null)

  const mine = tabs.filter((t) => t.projectId === project.id)
  const activeId = activeOf(project.id)
  const active = mine.find((t) => t.id === activeId)
  const { setNodeRef, isOver } = useDroppable({ id: 'terminal:active', disabled: !open || !active || active.exited })

  useEffect(() => {
    if (open) void api.terminals.available().then(setAvailable)
  }, [open])

  useEffect(() => applyTerminalTheme(), [theme])

  // The voice capsule stays over the board, not over the terminal.
  useEffect(() => {
    document.documentElement.style.setProperty('--term-w', open ? `${width}px` : '0px')
    return () => document.documentElement.style.setProperty('--term-w', '0px')
  }, [open, width])

  useLayoutEffect(() => {
    if (!open || !stage.current) return
    if (activeId) attachTerminal(activeId, stage.current)
    else stage.current.replaceChildren() // this project has no terminal; don't show another project's
  }, [open, activeId])

  useEffect(() => {
    if (!stage.current) return
    const ro = new ResizeObserver(() => activeId && fitTerminal(activeId))
    ro.observe(stage.current)
    return () => ro.disconnect()
  }, [activeId, open])

  if (!open) return null

  const start = async (kind: TerminalKind): Promise<void> => {
    try {
      let folder = project.folder
      if (!folder) {
        folder = (await api.terminals.pickFolder()) ?? undefined
        if (!folder) return
        onFolder(project.id, folder)
      }
      await openTerminal(kind, project.id, folder)
    } catch (e) {
      toast({ kind: 'err', label: tr('ТЕРМИНАЛ'), text: (e as Error).message })
    }
  }

  const clone = async (): Promise<void> => {
    if (!repo.trim()) return
    const parent = await api.terminals.pickFolder()
    if (!parent) return
    setCloning(true)
    try {
      const dest = await api.terminals.clone(repo, parent)
      onFolder(project.id, dest)
      setRepo('')
      toast({ kind: 'ok', label: 'GITHUB', text: tr('Склонировано: {0}', dest) })
    } catch (e) {
      toast({ kind: 'err', label: 'GITHUB', text: (e as Error).message })
    }
    setCloning(false)
  }

  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (ev: PointerEvent): void => {
      const max = Math.max(MIN_W, window.innerWidth - 480)
      setWidth(Math.max(MIN_W, Math.min(max, startW + startX - ev.clientX)))
    }
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        const max = Math.max(MIN_W, window.innerWidth - 480)
        localStorage.setItem(WIDTH_KEY, String(Math.max(MIN_W, Math.min(max, startW + startX - ev.clientX))))
      } catch {
        /* the width just won't be remembered */
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const launchers = KINDS.map(({ kind, label }) => {
    const ok = available?.[kind] ?? false
    return (
      <button key={kind} type="button" className="term-launch" disabled={!ok} title={ok ? tr('Открыть в папке проекта') : tr('{0} не установлен', tr(label))} onClick={() => void start(kind)}>
        <KindIcon kind={kind} />
        <span>{tr(label)}</span>
      </button>
    )
  })

  return (
    <section className="terminal-pane" style={{ width }} aria-label={tr('Терминалы')}>
      <div className="term-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" />
      <header className="term-folder">
        <span className="term-path" title={project.folder}>
          {project.folder ?? tr('Папка проекта не выбрана')}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label={tr('Выбрать папку проекта')}
          title={tr('Выбрать папку проекта')}
          onClick={() => void api.terminals.pickFolder().then((f) => f && onFolder(project.id, f))}
        >
          <FolderOpen size={14} strokeWidth={1.75} />
        </button>
      </header>

      {mine.length > 0 && (
        <div className="term-tabs" role="tablist">
          {mine.map((t) => (
            <div key={t.id} className="term-tab" data-active={t.id === activeId} data-exited={t.exited}>
              <button type="button" role="tab" aria-selected={t.id === activeId} className="term-tab-open" onClick={() => selectTerminal(project.id, t.id)}>
                <KindIcon kind={t.kind} />
                <span>{labelOf(t.kind)}</span>
              </button>
              <button type="button" className="term-tab-close" aria-label={tr('Закрыть терминал')} onClick={() => closeTerminal(t.id)}>
                <X size={11} strokeWidth={2} />
              </button>
            </div>
          ))}
          <div className="term-add">
            <Plus size={13} strokeWidth={1.75} aria-hidden="true" />
            <div className="term-add-menu">{launchers}</div>
          </div>
        </div>
      )}

      <div className="term-stage" ref={setNodeRef} data-over={isOver}>
        <div className="term-mount" ref={stage} />
        {mine.length === 0 && (
          <div className="term-empty">
            <p className="term-empty-title">{tr('Открыть терминал в этом проекте')}</p>
            <div className="term-launchers">{launchers}</div>
            {!project.folder && (
              <form
                className="term-clone"
                onSubmit={(e) => {
                  e.preventDefault()
                  void clone()
                }}
              >
                <input className="input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={tr('или ссылка на GitHub: склонирую')} spellCheck={false} aria-label={tr('Ссылка на репозиторий')} />
                <button type="submit" className="btn is-ghost" disabled={cloning || !repo.trim()}>
                  {cloning ? tr('Клонирую…') : tr('Клонировать')}
                </button>
              </form>
            )}
          </div>
        )}
        {active?.exited && <div className="term-note">{tr('Процесс завершился')}</div>}
        {dragging && active && !active.exited && <div className="term-drop">{tr('Отпусти: вставлю в {0}', labelOf(active.kind))}</div>}
      </div>
    </section>
  )
}

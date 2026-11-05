import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { buildPrompt, DEFAULT_SETTINGS, type AppSettings, type DropResult, type HarnessLimits, type UpdateState, type AsrState, type AsrStatus, type HarnessTarget, type SendResult } from '@shared/contract'
import { api } from './api'
import { setLanguage, tr } from './lib/i18n'
import { useBoard } from './store/useBoard'
import { useDictation, type Draft } from './store/useDictation'
import { useNow } from './lib/useNow'
import { matchesAccelerator } from './lib/format'
import { Titlebar } from './components/Titlebar'
import { Workspace } from './components/Workspace'
import { HarnessRail, type PendingConfirm } from './components/HarnessRail'
import { ProjectTabs } from './components/ProjectTabs'
import { VoiceCapsule } from './components/VoiceCapsule'
import { TicketSheet } from './components/TicketSheet'
import { SettingsPopover } from './components/SettingsPopover'
import { Popover } from './components/Popover'
import { useToast } from './components/Toasts'

const INITIAL_ASR: AsrStatus = { state: 'loading', modelName: '', modelDir: '' }

export function App(): JSX.Element {
  const { state, dispatch, canUndo, undoLabel, undo: undoBoard, saveError } = useBoard()
  const { settings, tickets, projects, activeProjectId, ready } = state
  setLanguage(settings.uiLanguage ?? 'ru')
  const toast = useToast()
  const now = useNow(30000)

  const stateRef = useRef(state)
  stateRef.current = state

  // A file dropped outside a drop zone must not make the window navigate to it.
  useEffect(() => {
    const block = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  // ---- theme
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // ---- ASR status
  const [asr, setAsr] = useState<AsrStatus>(INITIAL_ASR)
  useEffect(() => {
    let alive = true
    void api.asr.status().then((s) => alive && setAsr(s))
    const off = api.asr.onStatus(setAsr)
    return () => {
      alive = false
      off()
    }
  }, [])

  // ---- harness detection (every 4 s)
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const targetsKey = useMemo(() => JSON.stringify(settings.targets.map((t) => [t.id, t.processNames, t.titleIncludes])), [settings.targets])
  useEffect(() => {
    if (!ready) return
    let alive = true
    const tick = (): void => {
      void api.harness
        .detect(stateRef.current.settings.targets)
        .then((r) => alive && setRunning(r))
        .catch(() => undefined)
    }
    tick()
    const id = window.setInterval(tick, 4000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [ready, targetsKey])

  // ---- STUB's own updates
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle', current: '' })
  useEffect(() => {
    void api.updates.state().then(setUpdate)
    return api.updates.onChange(setUpdate)
  }, [])

  // ---- speech model downloads: they outlive the settings panel, so the outcome is handled here
  const asrRef = useRef(asr)
  asrRef.current = asr
  useEffect(
    () =>
      api.models.onEvent((e) => {
        if (e.job !== null) return
        if (e.error) toast({ kind: 'err', label: tr('МОДЕЛЬ'), text: tr('Не удалось скачать модель: {0}', e.error) })
        if (!e.doneDir) return
        const old = e.replacesDir
        const current = asrRef.current
        // Take it into use if there was no working model, or if it is a newer version of the one in use.
        const wasActive = Boolean(old && current.modelDir === old)
        const use = wasActive || current.state !== 'ready'
        const after = (): void => {
          if (old) void api.models.remove(old)
        }
        if (use) {
          dispatch({ type: 'settings', patch: { modelDir: e.doneDir } })
          void api.asr.reload(e.doneDir).then((s) => {
            setAsr(s)
            after()
          })
        } else after()
        toast({ kind: 'ok', label: tr('МОДЕЛЬ'), text: tr('Модель скачана: {0}', e.id) })
      }),
    [dispatch, toast]
  )

  // ---- plan limits (every 3 min); a failed read keeps the last good numbers
  const [limits, setLimits] = useState<Record<string, HarnessLimits>>({})
  const refreshLimits = useCallback(() => {
    void api.limits
      .read()
      .then((next) =>
        setLimits((prev) => {
          const merged = { ...next }
          for (const id of Object.keys(next)) if (next[id].status === 'error' && prev[id]?.status === 'ok') merged[id] = prev[id]
          return merged
        })
      )
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!ready) return
    refreshLimits()
    const id = window.setInterval(refreshLimits, 180000)
    return () => window.clearInterval(id)
  }, [ready, refreshLimits])

  // ---- settings
  const patchSettings = useCallback((patch: Partial<AppSettings>) => dispatch({ type: 'settings', patch }), [dispatch])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsBtn = useRef<HTMLButtonElement>(null)

  // ---- tickets
  const [freshId, setFreshId] = useState<string | null>(null)
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  draggingRef.current = dragging

  const createTicket = useCallback(
    (d: Draft) => {
      const id = crypto.randomUUID()
      dispatch({ type: 'create', ticket: { id, title: d.title, body: d.body, status: d.status, source: d.source, images: d.images } })
      setFreshId(id)
      window.setTimeout(() => setFreshId((cur) => (cur === id ? null : cur)), 1200)
    },
    [dispatch]
  )

  const dict = useDictation({ settings, asr, onCreate: createTicket, toast })
  const dictRef = useRef(dict)
  dictRef.current = dict

  const displayState: AsrState = dict.phase === 'recording' ? 'listening' : dict.phase === 'finishing' ? 'finishing' : asr.state

  useEffect(() => api.app.onHotkey(() => dictRef.current.toggle()), [])

  const undo = useCallback(() => {
    const top = stateRef.current.past[stateRef.current.past.length - 1]
    if (!top) return
    undoBoard()
    setSheetId((cur) => (cur && top.tickets.some((t) => t.id === cur) ? cur : null))
    const sent = top.label.startsWith(tr('отправка'))
    toast({ kind: 'info', label: tr('ОТМЕНЕНО'), text: sent ? tr('{0} — текст в харнессе остался, удали его там вручную', top.label) : top.label })
  }, [undoBoard, toast])
  const undoRef = useRef(undo)
  undoRef.current = undo

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const d = dictRef.current
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.code === 'KeyZ' || e.key.toLowerCase() === 'z')) {
        const el = e.target as HTMLElement | null
        const editable = !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
        if (editable || draggingRef.current || d.phase === 'recording' || d.phase === 'finishing') return
        e.preventDefault()
        undoRef.current()
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyN') {
        e.preventDefault()
        d.openManual()
      } else if (matchesAccelerator(e, stateRef.current.settings.voiceKey ?? DEFAULT_SETTINGS.voiceKey)) {
        const el = e.target as HTMLElement | null
        const editable = !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))
        // While recording, the focused transcript field must not swallow the stop shortcut.
        if ((editable && d.phase !== 'recording') || draggingRef.current || (d.phase !== 'idle' && d.phase !== 'recording')) return
        e.preventDefault()
        d.toggle()
      } else if (e.key === 'Enter' && !e.shiftKey && d.phase === 'recording' && !e.isComposing) {
        e.preventDefault()
        void d.stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const copyPrompt = useCallback(
    (id: string) => {
      const t = stateRef.current.tickets.find((x) => x.id === id)
      if (!t) return
      api.clipboard.write(buildPrompt(t))
      toast({ kind: 'ok', label: tr('СКОПИРОВАНО'), text: tr('{0} — промпт в буфере', t.key) })
    },
    [toast]
  )

  const deleteTicket = useCallback(
    (id: string) => {
      const t = stateRef.current.tickets.find((x) => x.id === id)
      dispatch({ type: 'delete', id })
      setSheetId((cur) => (cur === id ? null : cur))
      if (t) toast({ kind: 'info', label: tr('УДАЛЕНО'), text: t.key })
    },
    [dispatch, toast]
  )

  const markDone = useCallback((id: string) => dispatch({ type: 'update', id, patch: { status: 'done' } }), [dispatch])

  // ---- send flow
  const [sending, setSending] = useState<{ ticketId: string; targetId: string } | null>(null)
  const [pending, setPending] = useState<(PendingConfirm & { ticketId: string; submitted: boolean }) | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const markSent = useCallback(
    (ticketId: string, target: HarnessTarget, submitted: boolean) => {
      if (!stateRef.current.tickets.some((t) => t.id === ticketId)) return
      dispatch({ type: 'sent', id: ticketId, record: { targetId: target.id, targetName: target.name, at: Date.now(), verified: true, submitted } })
      setFlash(target.id)
      window.setTimeout(() => setFlash((cur) => (cur === target.id ? null : cur)), 1500)
      toast({ kind: 'ok', label: tr('ОТПРАВЛЕНО'), text: tr('Отправлено в {0}{1}', target.name, submitted ? tr(' и запущено') : '') })
    },
    [dispatch, toast]
  )

  const sendTicket = useCallback(
    async (ticketId: string, targetId: string) => {
      const s = stateRef.current
      const ticket = s.tickets.find((t) => t.id === ticketId)
      const target = s.settings.targets.find((t) => t.id === targetId)
      if (!ticket || !target) return
      setPending(null)
      setSending({ ticketId, targetId })
      let res: SendResult
      try {
        res = await api.harness.send({ ticketId, target, text: buildPrompt(ticket), images: (ticket.images ?? []).map((i) => i.id), returnFocus: s.settings.returnFocus })
      } catch (e) {
        res = { outcome: 'error', submitted: false, message: (e as Error).message }
      }
      setSending(null)
      if (!stateRef.current.tickets.some((t) => t.id === ticketId)) return
      const manual = tr('Текст в буфере — вставь вручную (Ctrl+V)')
      switch (res.outcome) {
        case 'verified':
          markSent(ticketId, target, res.submitted)
          break
        case 'unverified':
          setPending({ ticketId, targetId, windowTitle: res.windowTitle, submitted: res.submitted })
          break
        case 'not-found':
          toast({ kind: 'warn', label: target.name.toUpperCase(), text: tr('Окно не найдено. {0}', manual) })
          break
        case 'focus-failed':
          toast({ kind: 'warn', label: target.name.toUpperCase(), text: tr('Не удалось вывести окно вперёд. {0}', manual) })
          break
        default:
          toast({ kind: 'err', label: tr('ОШИБКА ОТПРАВКИ'), text: res.message ? `${res.message}. ${manual}` : manual })
      }
    },
    [markSent, toast]
  )

  const sendToCursor = useCallback(
    async (ticketId: string) => {
      const s = stateRef.current
      const ticket = s.tickets.find((t) => t.id === ticketId)
      if (!ticket) return
      setPending(null)
      setSending({ ticketId, targetId: '' })
      let res: DropResult
      try {
        res = await api.harness.sendToCursor({ targets: s.settings.targets, text: buildPrompt(ticket), images: (ticket.images ?? []).map((i) => i.id), returnFocus: s.settings.returnFocus })
      } catch (e) {
        res = { outcome: 'error', submitted: false, message: (e as Error).message }
      }
      setSending(null)
      if (!stateRef.current.tickets.some((t) => t.id === ticketId)) return
      const manual = tr('Текст в буфере — вставь вручную (Ctrl+V)')
      if (res.outcome === 'no-window') {
        toast({ kind: 'info', label: tr('НЕ ОТПРАВЛЕНО'), text: tr('Отпусти тикет над окном нейронки') })
      } else if (res.outcome === 'verified' || res.outcome === 'unverified') {
        const target = s.settings.targets.find((t) => t.id === res.targetId)
        const name = target?.name ?? res.appName ?? tr('окно')
        const project = s.projects.find((p) => p.id === ticket.projectId)?.name
        dispatch({
          type: 'sent',
          id: ticketId,
          record: { targetId: target?.id ?? `app:${res.appName ?? ''}`, targetName: name, at: Date.now(), verified: res.outcome === 'verified', submitted: res.submitted, windowTitle: res.windowTitle }
        })
        if (target) {
          setFlash(target.id)
          window.setTimeout(() => setFlash((cur) => (cur === target.id ? null : cur)), 1500)
        }
        if (res.outcome === 'verified') toast({ kind: 'ok', label: tr('ОТПРАВЛЕНО'), text: `${ticket.key} · ${project} → ${name}` })
        else toast({ kind: 'warn', label: tr('ПРОВЕРЬ ВСТАВКУ'), text: tr('Не смог проверить вставку в {0}. Если текста нет: {1}', name, manual) })
      } else {
        toast({ kind: res.outcome === 'error' ? 'err' : 'warn', label: tr('НЕ ОТПРАВЛЕНО'), text: res.message ? `${res.message}. ${manual}` : manual })
      }
    },
    [dispatch, toast]
  )

  const moveToProject = useCallback(
    (ticketId: string, projectId: string) => {
      const s = stateRef.current
      const ticket = s.tickets.find((t) => t.id === ticketId)
      const project = s.projects.find((p) => p.id === projectId)
      if (!ticket || !project) return
      dispatch({ type: 'update', id: ticketId, patch: { projectId } })
      toast({ kind: 'ok', label: tr('ПЕРЕНЕСЕНО'), text: `${ticket.key} → ${project.name}` })
    },
    [dispatch, toast]
  )

  const boardTickets = useMemo(() => tickets.filter((t) => t.projectId === activeProjectId), [tickets, activeProjectId])
  const projectCounts = useMemo(() => {
    const counts: Record<string, { open: number; total: number }> = {}
    for (const t of tickets) {
      const c = (counts[t.projectId] ??= { open: 0, total: 0 })
      c.total++
      if (t.status !== 'done') c.open++
    }
    return counts
  }, [tickets])

  const answerPending = useCallback(
    (yes: boolean) => {
      const p = pending
      setPending(null)
      if (!p) return
      const target = stateRef.current.settings.targets.find((t) => t.id === p.targetId)
      if (yes && target) markSent(p.ticketId, target, p.submitted)
      else toast({ kind: 'info', label: tr('БУФЕР'), text: tr('Текст в буфере — вставь вручную (Ctrl+V)') })
    },
    [pending, markSent, toast]
  )

  const sheetTicket = sheetId ? tickets.find((t) => t.id === sheetId) : undefined

  if (!ready) {
    return (
      <div className="splash">
        <div className="splash-mark">STUB</div>
        <div className="splash-sub">{tr('загружаю доску…')}</div>
      </div>
    )
  }

  return (
    <div className="app" key={settings.uiLanguage ?? 'ru'}>
      <Titlebar
        asr={asr}
        displayState={displayState}
        saveError={saveError}
        update={update}
        theme={settings.theme}
        settingsOpen={settingsOpen}
        settingsRef={settingsBtn}
        canUndo={canUndo}
        undoLabel={undoLabel}
        onUndo={undo}
        onToggleTheme={() => patchSettings({ theme: settings.theme === 'paper' ? 'carbon' : 'paper' })}
        onToggleSettings={() => setSettingsOpen((o) => !o)}
      />
      <main className="stage">
        <Workspace
          tickets={boardTickets}
          now={now}
          freshId={freshId}
          sendingId={sending?.ticketId ?? null}
          onLayout={(layout, movedId) => dispatch({ type: 'layout', layout, movedId })}
          onSend={(ticketId, targetId) => void sendTicket(ticketId, targetId)}
          onSendOutside={(ticketId) => void sendToCursor(ticketId)}
          onMoveToProject={moveToProject}
          onEdit={setSheetId}
          onCopy={copyPrompt}
          onDelete={deleteTicket}
          onDone={markDone}
          onDraggingChange={setDragging}
          tabs={
            <ProjectTabs
              projects={projects}
              activeId={activeProjectId}
              counts={projectCounts}
              onActivate={(id) => dispatch({ type: 'project-activate', id })}
              onAdd={(name) => dispatch({ type: 'project-add', project: { id: crypto.randomUUID(), name } })}
              onRename={(id, name) => dispatch({ type: 'project-rename', id, name })}
              onDelete={(id) => dispatch({ type: 'project-delete', id })}
            />
          }
          rail={
            <HarnessRail
              targets={settings.targets}
              running={running}
              limits={limits}
              onSignInClaude={() => void api.limits.signInClaude().then(refreshLimits)}
              dragging={dragging}
              sendingTargetId={sending?.targetId ?? null}
              flashTargetId={flash}
              pending={pending}
              onConfirm={answerPending}
              onChangeTargets={(targets) => patchSettings({ targets })}
            />
          }
        />
        <VoiceCapsule d={dict} asr={asr} hotkey={settings.hotkey} voiceKey={settings.voiceKey ?? DEFAULT_SETTINGS.voiceKey} />
      </main>

      <AnimatePresence>
        {sheetTicket && (
          <TicketSheet
            key={sheetTicket.id}
            ticket={sheetTicket}
            onSave={(id, patch) => dispatch({ type: 'update', id, patch })}
            onDelete={deleteTicket}
            onCopy={copyPrompt}
            onClose={() => setSheetId(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {settingsOpen && (
          <Popover anchor={settingsBtn.current} placement="bottom-end" width={344} onClose={() => setSettingsOpen(false)}>
            <SettingsPopover settings={settings} asr={asr} onChange={patchSettings} onAsr={setAsr} update={update} onRestoreTicket={(ticket) => dispatch({ type: 'restore', ticket })} />
          </Popover>
        )}
      </AnimatePresence>
    </div>
  )
}

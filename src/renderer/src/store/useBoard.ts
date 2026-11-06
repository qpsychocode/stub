import { useCallback, useEffect, useReducer, useRef, useState, type Dispatch } from 'react'
import { DEFAULT_PROJECT, DEFAULT_SETTINGS, type AppData, type AppSettings, type ChatBinding, type Project, type SendRecord, type Ticket, type TicketImage, type TicketStatus } from '@shared/contract'
import { api } from '../api'
import { tr } from '../lib/i18n'

export const STATUSES: TicketStatus[] = ['todo', 'doing', 'done']
export type Layout = Record<TicketStatus, string[]>

export interface BoardState {
  ready: boolean
  seq: number
  tickets: Ticket[]
  projects: Project[]
  activeProjectId: string
  settings: AppSettings
  past: Snapshot[]
}

export interface Snapshot {
  tickets: Ticket[]
  label: string
}

const MAX_HISTORY = 50

export interface NewTicket {
  id: string
  title: string
  body: string
  status: TicketStatus
  source: 'voice' | 'manual'
  images: TicketImage[]
}

export type BoardAction =
  | { type: 'loaded'; data: AppData }
  | { type: 'create'; ticket: NewTicket }
  | { type: 'update'; id: string; patch: Partial<Pick<Ticket, 'title' | 'body' | 'status' | 'projectId' | 'images'>> }
  | { type: 'project-add'; project: Project }
  | { type: 'project-rename'; id: string; name: string }
  | { type: 'project-delete'; id: string }
  | { type: 'project-activate'; id: string }
  | { type: 'project-chat'; id: string; targetId: string; chat: ChatBinding | null }
  | { type: 'delete'; id: string }
  | { type: 'restore'; ticket: Ticket }
  | { type: 'layout'; layout: Layout; movedId?: string }
  | { type: 'sent'; id: string; record: SendRecord }
  | { type: 'settings'; patch: Partial<AppSettings> }
  | { type: 'undo' }

const initial: BoardState = { ready: false, seq: 0, tickets: [], projects: [DEFAULT_PROJECT], activeProjectId: DEFAULT_PROJECT.id, settings: DEFAULT_SETTINGS, past: [] }

function withHistory(state: BoardState, label: string, tickets: Ticket[], seq: number = state.seq): BoardState {
  const past = [...state.past, { tickets: state.tickets, label }].slice(-MAX_HISTORY)
  return { ...state, seq, tickets, past }
}

/** Where a ticket entering a lane belongs: lanes run oldest to newest, so it goes before the first ticket younger than it. */
function orderByAge(tickets: Ticket[], status: TicketStatus, createdAt: number, exceptId?: string): number {
  const lane = tickets.filter((t) => t.status === status && t.id !== exceptId).sort((a, b) => a.order - b.order)
  if (lane.length === 0) return 0
  const i = lane.findIndex((t) => t.createdAt > createdAt)
  if (i === -1) return lane[lane.length - 1].order + 1
  return i === 0 ? lane[0].order - 1 : (lane[i - 1].order + lane[i].order) / 2
}

export function groupTickets(tickets: Ticket[]): Layout {
  const out: Layout = { todo: [], doing: [], done: [] }
  const sorted = [...tickets].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
  for (const t of sorted) (out[t.status] ?? out.todo).push(t.id)
  return out
}

function reducer(state: BoardState, action: BoardAction): BoardState {
  switch (action.type) {
    case 'loaded': {
      const d = action.data
      return { ready: true, seq: d.seq, tickets: d.tickets, projects: d.projects, activeProjectId: d.activeProjectId, settings: { ...DEFAULT_SETTINGS, ...d.settings }, past: state.past }
    }
    case 'project-add':
      return { ...state, projects: [...state.projects, action.project], activeProjectId: action.project.id }
    case 'project-rename':
      return { ...state, projects: state.projects.map((p) => (p.id === action.id ? { ...p, name: action.name } : p)) }
    case 'project-delete': {
      // Only an empty project can go, and never the last one.
      if (state.projects.length < 2 || state.tickets.some((t) => t.projectId === action.id)) return state
      const projects = state.projects.filter((p) => p.id !== action.id)
      return { ...state, projects, activeProjectId: state.activeProjectId === action.id ? projects[0].id : state.activeProjectId }
    }
    case 'project-chat':
      return {
        ...state,
        projects: state.projects.map((p) => {
          if (p.id !== action.id) return p
          const chats = { ...p.chats }
          if (action.chat) chats[action.targetId] = action.chat
          else delete chats[action.targetId]
          return { ...p, chats }
        })
      }
    case 'project-activate':
      return { ...state, activeProjectId: action.id }
    case 'create': {
      const n = action.ticket
      const seq = state.seq + 1
      const now = Date.now()
      const t: Ticket = {
        id: n.id,
        projectId: state.activeProjectId,
        key: `T-${String(seq).padStart(3, '0')}`,
        title: n.title,
        body: n.body,
        status: n.status,
        order: orderByAge(state.tickets, n.status, now),
        source: n.source,
        createdAt: now,
        updatedAt: now,
        sentTo: [],
        ...(n.images.length > 0 ? { images: n.images } : {})
      }
      return withHistory(state, tr('создание {0}', t.key), [...state.tickets, t], seq)
    }
    case 'update': {
      const cur = state.tickets.find((t) => t.id === action.id)
      if (!cur) return state
      const p = action.patch
      const statusChanged = p.status !== undefined && p.status !== cur.status
      const textChanged = (p.title !== undefined && p.title !== cur.title) || (p.body !== undefined && p.body !== cur.body)
      const projectChanged = p.projectId !== undefined && p.projectId !== cur.projectId
      const imagesChanged = p.images !== undefined && p.images.map((i) => i.id).join() !== (cur.images ?? []).map((i) => i.id).join()
      if (!statusChanged && !textChanged && !projectChanged && !imagesChanged) return state
      const tickets = state.tickets.map((t) =>
        t.id !== action.id
          ? t
          : {
              ...t,
              ...p,
              order: statusChanged ? orderByAge(state.tickets, p.status as TicketStatus, t.createdAt, t.id) : t.order,
              updatedAt: Date.now()
            }
      )
      return withHistory(state, `${!textChanged && !imagesChanged ? tr('перемещение') : tr('изменение')} ${cur.key}`, tickets)
    }
    case 'delete': {
      const cur = state.tickets.find((t) => t.id === action.id)
      if (!cur) return state
      return withHistory(
        state,
        tr('удаление {0}', cur.key),
        state.tickets.filter((t) => t.id !== action.id)
      )
    }
    case 'restore': {
      if (state.tickets.some((t) => t.id === action.ticket.id)) return state
      const t = action.ticket
      const projectId = state.projects.some((p) => p.id === t.projectId) ? t.projectId : state.activeProjectId
      return withHistory(state, tr('восстановление {0}', t.key), [...state.tickets, { ...t, projectId, order: orderByAge(state.tickets, t.status, t.createdAt), updatedAt: Date.now() }])
    }
    case 'layout': {
      const byId = new Map(state.tickets.map((t) => [t.id, t]))
      const seen = new Set<string>()
      const next: Ticket[] = []
      for (const status of STATUSES) {
        action.layout[status].forEach((id, i) => {
          const t = byId.get(id)
          if (!t || seen.has(id)) return
          seen.add(id)
          next.push({ ...t, status, order: i, updatedAt: t.status !== status ? Date.now() : t.updatedAt })
        })
      }
      for (const t of state.tickets) if (!seen.has(t.id)) next.push(t)
      const changed = next.filter((t) => {
        const o = byId.get(t.id)
        return !o || o.status !== t.status || o.order !== t.order
      })
      if (changed.length === 0) return state
      const statusMoved = changed.filter((t) => byId.get(t.id)?.status !== t.status)
      const moved = (action.movedId ? byId.get(action.movedId) : undefined) ?? (statusMoved.length === 1 ? statusMoved[0] : undefined)
      return withHistory(state, moved ? tr('перемещение {0}', moved.key) : tr('перемещение'), next)
    }
    case 'sent': {
      const cur = state.tickets.find((t) => t.id === action.id)
      if (!cur) return state
      const tickets = state.tickets.map((t) =>
        t.id === action.id
          ? {
              ...t,
              status: 'doing' as const,
              order: orderByAge(state.tickets, 'doing', t.createdAt, t.id),
              sentTo: [...t.sentTo, action.record],
              updatedAt: Date.now()
            }
          : t
      )
      return withHistory(state, tr('отправка {0} в {1}', cur.key, action.record.targetName), tickets)
    }
    case 'undo': {
      const last = state.past[state.past.length - 1]
      if (!last) return state
      // Its project may have been deleted since this snapshot; a ticket must never end up on no board.
      const tickets = last.tickets.map((t) => (state.projects.some((p) => p.id === t.projectId) ? t : { ...t, projectId: state.activeProjectId }))
      return { ...state, tickets, past: state.past.slice(0, -1) }
    }
    case 'settings':
      return { ...state, settings: { ...state.settings, ...action.patch } }
  }
}

export function useBoard(): {
  state: BoardState
  dispatch: Dispatch<BoardAction>
  canUndo: boolean
  undoLabel: string | null
  undo: () => void
  /** Why the last save failed; null while everything is on disk. */
  saveError: string | null
} {
  const [state, dispatch] = useReducer(reducer, initial)
  const latest = useRef(state)
  latest.current = state
  const skipFirst = useRef(true)
  const [saveError, setSaveError] = useState<string | null>(null)
  const retry = useRef<number | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void api.store.load().then((data) => {
      if (alive) dispatch({ type: 'loaded', data })
    })
    return () => {
      alive = false
    }
  }, [])

  const toData = (s: BoardState): AppData => ({ version: 1, seq: s.seq, tickets: s.tickets, projects: s.projects, activeProjectId: s.activeProjectId, settings: s.settings })

  // Keeps retrying the newest state until a write succeeds.
  const persist = useCallback((): void => {
    window.clearTimeout(retry.current)
    api.store
      .save(toData(latest.current))
      .then(() => setSaveError(null))
      .catch((e: Error) => {
        setSaveError(e.message)
        retry.current = window.setTimeout(persist, 5000)
      })
  }, [])

  useEffect(() => {
    if (!state.ready) return
    if (skipFirst.current) {
      skipFirst.current = false
      return
    }
    const id = window.setTimeout(persist, 300)
    return () => window.clearTimeout(id)
  }, [state.ready, state.tickets, state.seq, state.settings, state.projects, state.activeProjectId])

  useEffect(() => {
    const flush = (): void => {
      if (latest.current.ready && !skipFirst.current) api.store.saveNow(toData(latest.current))
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const canUndo = state.past.length > 0
  const undoLabel = canUndo ? state.past[state.past.length - 1].label : null

  return { state, dispatch, canUndo, undoLabel, undo, saveError }
}

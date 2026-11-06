import { useMemo, useRef, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  closestCorners,
  defaultDropAnimationSideEffects,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
  type Modifier
} from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { CSS, getEventCoordinates } from '@dnd-kit/utilities'
import { useReducedMotion } from 'motion/react'
import type { Ticket, TicketStatus } from '@shared/contract'
import { groupTickets, STATUSES, type Layout } from '../store/useBoard'
import { RAIL_WIDE_W } from './HarnessRail'
import { LANES, Lane } from './Lane'
import { DragTag } from './TicketCard'

interface Props {
  tickets: Ticket[]
  now: number
  freshId: string | null
  sendingId: string | null
  onLayout: (layout: Layout, movedId: string) => void
  onSend: (ticketId: string, targetId: string) => void
  /** Released outside the STUB window: goes to whatever window is under the cursor. */
  onSendOutside: (ticketId: string) => void
  onMoveToProject: (ticketId: string, projectId: string) => void
  onSendToTerminal: (ticketId: string) => void
  onEdit: (id: string) => void
  onCopy: (id: string) => void
  onDelete: (id: string) => void
  onDone: (id: string) => void
  onDraggingChange: (dragging: boolean) => void
  /** Rendered inside the DndContext (the harness rail). */
  rail: ReactNode
  /** Rendered inside the DndContext above the board (the project tabs). */
  tabs: ReactNode
  /** Rendered beside the board, inside the DndContext, so tickets can be dropped on it. */
  terminals: ReactNode
}

const EASE = 'cubic-bezier(.2,.8,.2,1)'
// Drag tag size (see .drag-tag), its gap from the cursor and from the window/rail edges.
const TAG_W = 184
const TAG_H = 34
const TAG_GAP = 14
const TAG_MARGIN = 8
const FLY_SCALE = 0.3
const isLane = (id: unknown): boolean => String(id).startsWith('lane:')
const isSocket = (id: unknown): boolean => String(id).startsWith('socket:')
const isProject = (id: unknown): boolean => String(id).startsWith('project:')
const isTerminal = (id: unknown): boolean => String(id).startsWith('terminal:')
const isOutside = (x: number, y: number): boolean => x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight

function findContainer(id: unknown, layout: Layout): TicketStatus | null {
  if (isLane(id)) return String(id).slice(5) as TicketStatus
  for (const s of STATUSES) if (layout[s].includes(String(id))) return s
  return null
}

function sameLayout(a: Layout, b: Layout): boolean {
  return STATUSES.every((s) => a[s].length === b[s].length && a[s].every((id, i) => id === b[s][i]))
}

export function Workspace({ tickets, now, freshId, sendingId, onLayout, onSend, onSendOutside, onMoveToProject, onSendToTerminal, onEdit, onCopy, onDelete, onDone, onDraggingChange, rail, tabs, terminals }: Props): JSX.Element {
  const reduced = useReducedMotion()
  const base = useMemo(() => groupTickets(tickets), [tickets])
  const byId = useMemo(() => new Map(tickets.map((t) => [t.id, t])), [tickets])
  const [layout, setLayout] = useState<Layout | null>(null)
  const current = layout ?? base
  const layoutRef = useRef<Layout>(current)
  layoutRef.current = current
  const [activeId, setActiveId] = useState<string | null>(null)
  const [overStatus, setOverStatus] = useState<TicketStatus | null>(null)
  const fly = useRef<{ dx: number; dy: number } | null>(null)
  const tagRef = useRef<HTMLDivElement>(null)
  const tagOrigin = useRef<{ left: number; top: number } | null>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const [outside, setOutside] = useState(false)

  // Keeps the tag left of the cursor and docked outside the expanded rail, so sockets stay visible.
  const tagBesideCursor: Modifier = ({ activatorEvent, activeNodeRect, transform }) => {
    if (!activeNodeRect) return transform
    // The overlay stays anchored where the drag began, even after the card moves to another lane.
    tagOrigin.current ??= activeNodeRect
    const start = activatorEvent && getEventCoordinates(activatorEvent)
    if (!start) return transform
    const maxLeft = window.innerWidth - RAIL_WIDE_W - TAG_MARGIN - TAG_W
    const maxTop = window.innerHeight - TAG_MARGIN - TAG_H
    const left = Math.max(TAG_MARGIN, Math.min(start.x + transform.x - TAG_GAP - TAG_W, maxLeft))
    const top = Math.max(TAG_MARGIN, Math.min(start.y + transform.y - TAG_H / 2, maxTop))
    return { ...transform, x: left - tagOrigin.current.left, y: top - tagOrigin.current.top }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  // Sockets win when hovered; otherwise resolve the lane under the pointer and the nearest card inside it.
  // Distances are measured from the pointer: the tag sits beside it, so its rect says nothing about the target.
  const collision: CollisionDetection = (args) => {
    const p = args.pointerCoordinates
    pointer.current = p
    if (p && isOutside(p.x, p.y)) return []
    const probe = p ? { ...args, collisionRect: { top: p.y, bottom: p.y, left: p.x, right: p.x, width: 0, height: 0 } } : args
    const within = pointerWithin(args)
    const socket = within.find((c) => isSocket(c.id))
    if (socket) return [socket]
    const project = within.find((c) => isProject(c.id))
    if (project) return [project]
    const terminal = within.find((c) => isTerminal(c.id))
    if (terminal) return [terminal]
    const lane = within.find((c) => isLane(c.id))
    if (lane) {
      const ids = new Set(layoutRef.current[String(lane.id).slice(5) as TicketStatus])
      const cands = args.droppableContainers.filter((c) => ids.has(String(c.id)))
      if (cands.length > 0) {
        const hit = closestCenter({ ...probe, droppableContainers: cands })
        if (hit.length > 0) return [hit[0]]
      }
      return [lane]
    }
    return closestCorners({ ...probe, droppableContainers: args.droppableContainers.filter((c) => !isSocket(c.id) && !isProject(c.id) && !isTerminal(c.id)) })
  }

  const onDragStart = (e: DragStartEvent): void => {
    fly.current = null
    tagOrigin.current = null // reset here, not on finish: the modifier still runs once after a drag ends
    setActiveId(String(e.active.id))
    setLayout(base)
    setOverStatus(findContainer(e.active.id, base))
    onDraggingChange(true)
  }

  const onDragOver = ({ active, over }: DragOverEvent): void => {
    if (!over) return
    if (isSocket(over.id) || isProject(over.id) || isTerminal(over.id)) {
      setOverStatus(null)
      return
    }
    const overC = findContainer(over.id, layoutRef.current)
    if (!overC) return
    setOverStatus(overC)
    setLayout((prev) => {
      const l = prev ?? base
      const activeC = findContainer(active.id, l)
      if (!activeC || activeC === overC) return prev
      const aid = String(active.id)
      const overItems = l[overC]
      let idx: number
      if (isLane(over.id)) idx = overItems.length
      else {
        const oi = overItems.indexOf(String(over.id))
        const y = pointer.current?.y ?? active.rect.current.translated?.top
        const below = y !== undefined && y > over.rect.top + over.rect.height / 2
        idx = oi + (below ? 1 : 0)
      }
      return {
        ...l,
        [activeC]: l[activeC].filter((i) => i !== aid),
        [overC]: [...overItems.slice(0, idx), aid, ...overItems.slice(idx)]
      }
    })
  }

  const finish = (): void => {
    setActiveId(null)
    setOverStatus(null)
    setLayout(null)
    setOutside(false)
    onDraggingChange(false)
  }

  // The pointer itself, not the drag delta: that one also counts scrolled lanes.
  const onDragMove = (): void => {
    const p = pointer.current
    if (p) setOutside(isOutside(p.x, p.y))
  }

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    const l = layoutRef.current
    const p = pointer.current
    if (p && isOutside(p.x, p.y)) {
      finish()
      onSendOutside(String(active.id))
      return
    }
    if (over && isTerminal(over.id)) {
      finish()
      onSendToTerminal(String(active.id))
      return
    }
    if (over && isProject(over.id)) {
      finish()
      onMoveToProject(String(active.id), String(over.id).slice(8))
      return
    }
    if (over && isSocket(over.id)) {
      const tag = tagRef.current?.getBoundingClientRect()
      if (tag) {
        // The overlay scales from its top-left corner; land the shrunken tag on the socket's centre.
        fly.current = {
          dx: over.rect.left + over.rect.width / 2 - tag.left - (tag.width * FLY_SCALE) / 2,
          dy: over.rect.top + over.rect.height / 2 - tag.top - (tag.height * FLY_SCALE) / 2
        }
      }
      const targetId = String(over.id).slice(7)
      finish()
      onSend(String(active.id), targetId)
      return
    }
    let next = l
    if (over) {
      const a = findContainer(active.id, l)
      const o = findContainer(over.id, l)
      if (a && o && a === o) {
        const from = l[a].indexOf(String(active.id))
        const to = isLane(over.id) ? l[o].length - 1 : l[o].indexOf(String(over.id))
        if (from >= 0 && to >= 0 && from !== to) next = { ...l, [a]: arrayMove(l[a], from, to) }
      }
    }
    finish()
    if (!sameLayout(next, base)) onLayout(next, String(active.id))
  }

  const sideEffects = defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } })
  const f = fly.current
  const dropAnimation: DropAnimation | null = reduced
    ? null
    : f
      ? {
          duration: 300,
          easing: EASE,
          sideEffects,
          keyframes: ({ transform }) => [
            { transform: CSS.Transform.toString(transform.initial), opacity: 1 },
            {
              transform: CSS.Transform.toString({ ...transform.initial, x: transform.initial.x + f.dx, y: transform.initial.y + f.dy, scaleX: FLY_SCALE, scaleY: FLY_SCALE }),
              opacity: 0
            }
          ]
        }
      : {
          // The real card is already in its lane; the tag just fades where it was dropped.
          duration: 120,
          easing: EASE,
          keyframes: ({ transform }) => [
            { transform: CSS.Transform.toString(transform.initial), opacity: 1 },
            { transform: CSS.Transform.toString(transform.initial), opacity: 0 }
          ]
        }

  const activeTicket = activeId ? byId.get(activeId) : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={finish}
    >
      <div className="workspace">
        <div className="board-col">
          {tabs}
          <div className="board-row">
            <div className="board">
              {LANES.map((l) => (
                <Lane
                  key={l.status}
                  {...l}
                  ids={current[l.status]}
                  byId={byId}
                  hot={overStatus === l.status}
                  dragging={activeId !== null}
                  now={now}
                  freshId={freshId}
                  sendingId={sendingId}
                  onEdit={onEdit}
                  onCopy={onCopy}
                  onDelete={onDelete}
                  onDone={onDone}
                />
              ))}
            </div>
            {terminals}
          </div>
        </div>
        {rail}
      </div>
      <DragOverlay dropAnimation={dropAnimation} zIndex={90} modifiers={[tagBesideCursor]}>
        {activeTicket ? <DragTag ref={tagRef} ticket={activeTicket} outside={outside} /> : null}
      </DragOverlay>
    </DndContext>
  )
}

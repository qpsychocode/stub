import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { Ticket, TicketStatus } from '@shared/contract'
import { pluralN } from '../lib/format'
import { TicketCard } from './TicketCard'
import { tr } from '../lib/i18n'

export const LANES: { status: TicketStatus; num: string; label: string }[] = [
  { status: 'todo', num: '01', label: 'Не начато' },
  { status: 'doing', num: '02', label: 'В процессе' },
  { status: 'done', num: '03', label: 'Готово' }
]

interface Props {
  status: TicketStatus
  num: string
  label: string
  ids: string[]
  byId: Map<string, Ticket>
  hot: boolean
  dragging: boolean
  now: number
  freshId: string | null
  sendingId: string | null
  onEdit: (id: string) => void
  onCopy: (id: string) => void
  onDelete: (id: string) => void
  onDone: (id: string) => void
}

export function Lane({ status, num, label, ids, byId, hot, dragging, now, freshId, sendingId, onEdit, onCopy, onDelete, onDone }: Props): JSX.Element {
  const { setNodeRef } = useDroppable({ id: `lane:${status}`, data: { type: 'lane', status } })
  return (
    <section className="lane" data-status={status} data-hot={hot} aria-label={`${tr(label)}: ${pluralN(ids.length, [tr('тикет'), tr('тикета'), tr('тикетов')])}`}>
      <div className="lane-hatch" />
      <header className="lane-head">
        <div className="lane-num" aria-hidden="true">
          {num}
        </div>
        <div className="lane-label">
          <span>{tr(label)}</span>
          <span className="lane-dot">·</span>
          <span className="lane-count">{ids.length}</span>
        </div>
      </header>
      <div className="lane-body" ref={setNodeRef}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="lane-list">
            {ids.map((id) => {
              const t = byId.get(id)
              if (!t) return null
              return <TicketCard key={id} ticket={t} now={now} fresh={freshId === id} sending={sendingId === id} onEdit={onEdit} onCopy={onCopy} onDelete={onDelete} onDone={onDone} />
            })}
            {ids.length === 0 && (
              <div className="lane-empty" data-hot={hot && dragging}>
                <span>{tr('Пусто.')}</span>
                <span>{tr('Перетащи сюда')}</span>
              </div>
            )}
          </div>
        </SortableContext>
      </div>
    </section>
  )
}

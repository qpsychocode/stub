import { forwardRef, memo, useState, type KeyboardEvent } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { motion } from 'motion/react'
import { ArrowRight, Check, Copy, Image as ImageIcon, Loader2, Mic, Pencil, Trash2 } from 'lucide-react'
import type { Ticket } from '@shared/contract'
import { clock, previewOf, relTime } from '../lib/format'
import { HarnessLogo, hasLogo } from './HarnessLogo'
import { tr } from '../lib/i18n'

interface BodyProps {
  ticket: Ticket
  now: number
  ghost?: boolean
  sending?: boolean
  confirming?: boolean
  onEdit?: () => void
  onCopy?: () => void
  onAskDelete?: () => void
  onDelete?: () => void
  onCancelDelete?: () => void
  onDone?: () => void
}

/** Small tag that follows the cursor during a drag, so it never hides the drop target. */
export const DragTag = forwardRef<HTMLDivElement, { ticket: Ticket; outside: boolean }>(function DragTag({ ticket: t, outside }, ref) {
  return (
    <div ref={ref} className="drag-tag">
      <div className="drag-tag-in" data-outside={outside}>
        <span className="drag-tag-key">{t.key}</span>
        <span className="drag-tag-title">{outside ? tr('Отпусти в нужном окне') : t.title}</span>
      </div>
    </div>
  )
})

/** Presentational ticket stub. */
function CardBody({ ticket: t, now, ghost, sending, confirming, onEdit, onCopy, onAskDelete, onDelete, onCancelDelete, onDone }: BodyProps): JSX.Element {
  const preview = previewOf(t.title, t.body)
  const sent = t.sentTo.slice(-2)
  const extra = t.sentTo.length - sent.length
  return (
    <div className="stub-wrap">
      <div className="stub" data-status={t.status} data-ghost={ghost ? 'true' : undefined} data-sending={sending ? 'true' : undefined}>
        {t.status === 'doing' && <span className="stub-bar" />}
        <div className="stub-main">
          <div className="stub-meta">
            <span className="stub-key">{t.key}</span>
            <span className="stub-sep" />
            <span className="stub-time">{relTime(t.createdAt, now)}</span>
            {t.source === 'voice' && <Mic size={11} strokeWidth={1.75} className="stub-mic" aria-label={tr('Голосовой тикет')} />}
            {(t.images?.length ?? 0) > 0 && (
              <span className="stub-images" aria-label={tr('Картинок: {0}', t.images?.length)}>
                <ImageIcon size={11} strokeWidth={1.75} />
                {t.images?.length}
              </span>
            )}
          </div>
          <h3 className="stub-title">{t.title}</h3>
          {preview && <p className="stub-text">{preview}</p>}
        </div>
        {t.status === 'done' && <span className="stamp">{tr('ГОТОВО')}</span>}
        {t.status === 'doing' && !sending && !confirming && (
          <button
            type="button"
            className="stub-done"
            aria-label={tr('Перенести в «Готово»')}
            title={tr('В «Готово»')}
            onClick={(e) => {
              e.stopPropagation()
              onDone?.()
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Check size={14} strokeWidth={2.5} />
          </button>
        )}

        <div className="stub-foot">
          {confirming ? (
            <div className="confirm-row">
              <span className="confirm-q">{tr('Удалить?')}</span>
              <button type="button" className="mini-btn is-danger" onClick={onDelete}>
                {tr('Да')}
              </button>
              <button type="button" className="mini-btn" onClick={onCancelDelete}>
                {tr('Нет')}
              </button>
            </div>
          ) : (
            <>
              <div className="chips">
                {extra > 0 && <span className="chip is-more">+{extra}</span>}
                {sent.map((r, i) => (
                  <span key={i} className="chip" data-ok={r.verified} title={r.windowTitle}>
                    {hasLogo(r.targetId) ? <HarnessLogo targetId={r.targetId} glyph="" /> : <ArrowRight size={9} strokeWidth={2} />}
                    <span className="chip-name">{r.targetName}</span>
                    {r.verified && <Check size={10} strokeWidth={2.5} className="chip-check" />}
                    <span className="chip-time">{clock(r.at)}</span>
                  </span>
                ))}
              </div>
              <div className="stub-actions">
                <button type="button" className="icon-btn" onClick={onCopy} aria-label={tr('Копировать промпт')}>
                  <Copy size={13} strokeWidth={1.75} />
                </button>
                <button type="button" className="icon-btn" onClick={onEdit} aria-label={tr('Редактировать')}>
                  <Pencil size={13} strokeWidth={1.75} />
                </button>
                <button type="button" className="icon-btn is-danger" onClick={onAskDelete} aria-label={tr('Удалить')}>
                  <Trash2 size={13} strokeWidth={1.75} />
                </button>
              </div>
            </>
          )}
        </div>

        {sending && (
          <div className="stub-sending">
            <Loader2 size={14} strokeWidth={2} className="spin" />
            <span>{tr('вставляю…')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

interface CardProps {
  ticket: Ticket
  now: number
  fresh: boolean
  sending: boolean
  onEdit: (id: string) => void
  onCopy: (id: string) => void
  onDelete: (id: string) => void
  onDone: (id: string) => void
}

export const TicketCard = memo(function TicketCard({ ticket, now, fresh, sending, onEdit, onCopy, onDelete, onDone }: CardProps): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    data: { type: 'card' },
    disabled: sending || confirming
  })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    ;(listeners?.onKeyDown as ((ev: KeyboardEvent<HTMLDivElement>) => void) | undefined)?.(e)
    if (e.key === 'Delete' && e.target === e.currentTarget) {
      e.preventDefault()
      setConfirming(true)
    }
  }

  return (
    <div
      ref={setNodeRef}
      className="card-slot"
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-dragging={isDragging}
      {...attributes}
      {...listeners}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onEdit(ticket.id)}
      aria-label={`${ticket.key} ${ticket.title}`}
    >
      <motion.div
        initial={fresh ? { opacity: 0, scale: 0.88, y: -18 } : false}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 380, damping: 24 }}
      >
        <CardBody
          ticket={ticket}
          now={now}
          ghost={isDragging}
          sending={sending}
          confirming={confirming}
          onEdit={() => onEdit(ticket.id)}
          onCopy={() => onCopy(ticket.id)}
          onAskDelete={() => setConfirming(true)}
          onDelete={() => onDelete(ticket.id)}
          onCancelDelete={() => setConfirming(false)}
          onDone={() => onDone(ticket.id)}
        />
      </motion.div>
    </div>
  )
})

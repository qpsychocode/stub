import { useRef, useState, type KeyboardEvent } from 'react'
import { motion } from 'motion/react'
import { Check, Copy, Trash2, X } from 'lucide-react'
import type { Ticket, TicketImage, TicketStatus } from '@shared/contract'
import { dateTime, pluralN } from '../lib/format'
import { useEscLayer } from '../lib/layers'
import { ImageStrip, imageFiles, uploadImages, useImagePaste } from './ImageStrip'
import { useToast } from './Toasts'
import { Keycaps, Segmented } from './ui'
import { tr } from '../lib/i18n'

interface Props {
  ticket: Ticket
  onSave: (id: string, patch: { title: string; body: string; status: TicketStatus; images: TicketImage[] }) => void
  onDelete: (id: string) => void
  onCopy: (id: string) => void
  onClose: () => void
}

const STATUS_OPTIONS: { value: TicketStatus; label: string }[] = [
  { value: 'todo', label: 'Не начато' },
  { value: 'doing', label: 'В процессе' },
  { value: 'done', label: 'Готово' }
]

export function TicketSheet({ ticket, onSave, onDelete, onCopy, onClose }: Props): JSX.Element {
  const [title, setTitle] = useState(ticket.title)
  const [body, setBody] = useState(ticket.body)
  const [status, setStatus] = useState<TicketStatus>(ticket.status)
  const [images, setImages] = useState<TicketImage[]>(ticket.images ?? [])
  const [confirm, setConfirm] = useState(false)
  const toast = useToast()
  const closing = useRef(false)

  const addFiles = (files: File[]): void => {
    uploadImages(files)
      .then((added) => setImages((cur) => [...cur, ...added]))
      .catch((e: Error) => toast({ kind: 'err', label: tr('КАРТИНКА'), text: e.message }))
  }
  useImagePaste(true, addFiles)

  const imagesDirty = images.map((i) => i.id).join() !== (ticket.images ?? []).map((i) => i.id).join()
  const dirty = title !== ticket.title || body !== ticket.body || status !== ticket.status || imagesDirty

  const commit = (): void => {
    if (closing.current) return
    closing.current = true
    if (dirty && title.trim()) onSave(ticket.id, { title: title.trim(), body: body.trim(), status, images })
    onClose()
  }

  useEscLayer(true, commit)

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      commit()
    }
  }

  return (
    <>
      <motion.div className="scrim is-sheet" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={commit} />
      <motion.aside
        className="sheet"
        initial={{ x: 440 }}
        animate={{ x: 0 }}
        exit={{ x: 440, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }}
        transition={{ type: 'spring', stiffness: 380, damping: 40 }}
        onKeyDown={onKey}
        onDrop={(e) => {
          const files = imageFiles(e.dataTransfer)
          if (files.length > 0) addFiles(files)
        }}
        aria-label={tr('Тикет {0}', ticket.key)}
      >
        <header className="sheet-head">
          <span className="stub-key is-big">{ticket.key}</span>
          <span className="mono-label">{ticket.source === 'voice' ? tr('ГОЛОС') : tr('ВРУЧНУЮ')} · {dateTime(ticket.createdAt)}</span>
          <span className="pop-spacer" />
          <button type="button" className="icon-btn" onClick={commit} aria-label={tr('Закрыть')}>
            <X size={16} strokeWidth={1.5} />
          </button>
        </header>

        <div className="sheet-body">
          <label className="field">
            <span className="field-label">{tr('Заголовок')}</span>
            <input className="input is-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} spellCheck={false} />
          </label>
          <label className="field">
            <span className="field-label">{tr('Описание')}</span>
            <textarea className="input is-body is-tall" value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <div className="field">
            <span className="field-label">{tr('Картинки')}</span>
            <ImageStrip images={images} onFiles={addFiles} onRemove={(id) => setImages((cur) => cur.filter((i) => i.id !== id))} />
          </div>
          <div className="field">
            <span className="field-label">{tr('Колонка')}</span>
            <Segmented label={tr('Колонка')} value={status} options={STATUS_OPTIONS.map((o) => ({ ...o, label: tr(o.label) }))} onChange={setStatus} />
          </div>

          <div className="field">
            <span className="field-label">{tr('История отправок')} · {pluralN(ticket.sentTo.length, [tr('запись'), tr('записи'), tr('записей')])}</span>
            {ticket.sentTo.length === 0 ? (
              <div className="history-empty">{tr('Ещё не отправлялся. Перетащи карточку на гнездо справа.')}</div>
            ) : (
              <ul className="history">
                {[...ticket.sentTo].reverse().map((r, i) => (
                  <li key={i} className="history-row">
                    <span className="history-name">{r.targetName}</span>
                    <span className="history-meta">
                      {r.verified && <Check size={11} strokeWidth={2.5} className="chip-check" />}
                      {r.submitted ? tr('запущено · ') : ''}
                      {dateTime(r.at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <footer className="sheet-foot">
          {confirm ? (
            <div className="confirm-row is-wide">
              <span className="confirm-q">{tr('Удалить тикет насовсем?')}</span>
              <span className="pop-spacer" />
              <button type="button" className="btn is-ghost" onClick={() => setConfirm(false)}>
                {tr('Отмена')}
              </button>
              <button type="button" className="btn is-danger" onClick={() => onDelete(ticket.id)}>
                {tr('Удалить')}
              </button>
            </div>
          ) : (
            <>
              <button type="button" className="btn is-ghost" onClick={() => setConfirm(true)}>
                <Trash2 size={14} strokeWidth={1.75} />
                {tr('Удалить')}
              </button>
              <button type="button" className="btn is-ghost" onClick={() => onCopy(ticket.id)}>
                <Copy size={14} strokeWidth={1.75} />
                {tr('Промпт')}
              </button>
              <span className="pop-spacer" />
              <button type="button" className="btn is-primary" onClick={commit}>
                {tr('Сохранить')}
                <Keycaps combo="Control+Return" small />
              </button>
            </>
          )}
        </footer>
      </motion.aside>
    </>
  )
}

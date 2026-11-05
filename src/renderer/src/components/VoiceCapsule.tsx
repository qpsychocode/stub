import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CornerDownLeft, Loader2, Mic, Plus, Square, X } from 'lucide-react'
import type { AsrStatus } from '@shared/contract'
import type { Dictation } from '../store/useDictation'
import { ImageStrip, imageFiles, useImagePaste } from './ImageStrip'
import { formatTimer, keycaps } from '../lib/format'
import { Keycaps, Segmented } from './ui'
import { Waveform } from './Waveform'
import { tr } from '../lib/i18n'

interface Props {
  d: Dictation
  asr: AsrStatus
  hotkey: string
  voiceKey: string
}

const SPRING = { type: 'spring', stiffness: 380, damping: 34, mass: 0.9 } as const

function Timer({ startedAt }: { startedAt: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(id)
  }, [])
  return <span className="rec-timer">{formatTimer(startedAt ? now - startedAt : 0)}</span>
}

/** The live transcript as an ordinary text field: new speech lands at the end and the caret stays where the user put it. */
function TranscriptEditor({ value, placeholder, readOnly, onChange }: { value: string; placeholder: string; readOnly: boolean; onChange: (text: string) => void }): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null)
  const el = ref.current
  // Read during render: committing the new value is what would move the caret.
  const before = el ? { start: el.selectionStart, end: el.selectionEnd, atEnd: el.selectionEnd === el.value.length } : null

  useLayoutEffect(() => {
    const t = ref.current
    if (!t || !before) return
    if (before.atEnd) {
      t.setSelectionRange(value.length, value.length)
      t.scrollTop = t.scrollHeight
    } else {
      t.setSelectionRange(before.start, before.end)
    }
  }, [value])

  return (
    <textarea
      ref={ref}
      className="rec-edit"
      value={value}
      placeholder={placeholder}
      readOnly={readOnly}
      autoFocus
      spellCheck={false}
      aria-label={tr('Текст диктовки')}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

function asrHint(asr: AsrStatus): string | undefined {
  if (asr.state === 'ready') return undefined
  if (asr.message) return tr(asr.message)
  if (asr.state === 'loading') return tr('Модель загружается…')
  if (asr.state === 'no-model') return tr('Скачай модель в настройках')
  if (asr.state === 'error') return tr('Ошибка распознавания')
  return undefined
}

export function VoiceCapsule({ d, asr, hotkey, voiceKey }: Props): JSX.Element {
  const { phase } = d
  const mode = phase === 'idle' ? 'idle' : phase === 'review' ? 'review' : 'rec'
  const canRecord = asr.state === 'ready'
  const hint = asrHint(asr)
  useImagePaste(mode !== 'idle', d.addImages)

  const onFormKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    const inBody = (e.target as HTMLElement).tagName === 'TEXTAREA'
    if (inBody && e.shiftKey && !e.ctrlKey) return
    e.preventDefault()
    d.create()
  }

  return (
    <>
      <AnimatePresence>
        {mode !== 'idle' && <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />}
      </AnimatePresence>
      <div className="dock">
        <motion.div
          layout
          className="capsule"
          data-mode={mode}
          style={{ borderRadius: mode === 'idle' ? 999 : 24 }}
          transition={SPRING}
          onDrop={(e) => {
            const files = imageFiles(e.dataTransfer)
            if (mode !== 'idle' && files.length > 0) d.addImages(files)
          }}
        >
          <AnimatePresence mode="wait" initial={false}>
            {mode === 'idle' && (
              <motion.div key="idle" className="cap-idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={{ duration: 0.18, delay: 0.05 }}>
                <button
                  type="button"
                  className="mic-btn"
                  data-disabled={!canRecord}
                  data-tip={hint ?? tr('Голосом · {0} · из любой программы {1}', keycaps(voiceKey).join('+'), keycaps(hotkey).join('+'))}
                  onClick={() => void d.start()}
                  aria-label={tr('Начать диктовку')}
                >
                  <Mic size={20} strokeWidth={1.75} />
                </button>
                <div className="cap-copy">
                  <span className="cap-title">{tr('Надиктуй задачу')}</span>
                  <span className="cap-sub">
                    {canRecord ? (
                      <>
                        <span>{tr('нажми или')}</span>
                        <Keycaps combo={voiceKey} small />
                      </>
                    ) : (
                      <span>{hint ?? tr('нет модели')}</span>
                    )}
                  </span>
                </div>
                <span className="cap-spacer" />
                <button type="button" className="ghost-btn" onClick={d.openManual}>
                  <Plus size={14} strokeWidth={1.75} />
                  <span>{tr('вручную')}</span>
                  <Keycaps combo="Control+Shift+N" small />
                </button>
              </motion.div>
            )}

            {mode === 'rec' && (
              <motion.div key="rec" className="cap-rec" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={{ duration: 0.2, delay: 0.08 }}>
                <div className="rec-top">
                  <span className="rec-badge" data-busy={phase !== 'recording'}>
                    <span className="rec-dot" />
                    {phase === 'starting' ? tr('ЗАПУСК') : phase === 'finishing' ? tr('ДОПИСЫВАЮ') : tr('ЗАПИСЬ')}
                  </span>
                  <Waveform levelRef={d.levelRef} active={phase === 'recording'} />
                  <Timer startedAt={phase === 'recording' || phase === 'finishing' ? d.startedAt : 0} />
                </div>
                <TranscriptEditor
                  value={d.transcript}
                  placeholder={phase === 'starting' ? tr('Включаю микрофон…') : tr('Говори — текст появится здесь. Его можно править прямо на ходу')}
                  readOnly={phase === 'starting'}
                  onChange={d.editTranscript}
                />
                <ImageStrip images={d.draft.images} onFiles={d.addImages} onRemove={d.removeImage} />
                <div className="rec-actions">
                  <button type="button" className="btn is-primary" onClick={() => void d.stop()} disabled={phase !== 'recording'}>
                    {phase === 'finishing' ? <Loader2 size={14} strokeWidth={2} className="spin" /> : <Square size={12} strokeWidth={0} fill="currentColor" />}
                    {tr('Готово')}
                    <Keycaps combo="Return" small />
                  </button>
                  <button type="button" className="btn is-ghost" onClick={d.cancel} disabled={phase === 'finishing'}>
                    <X size={14} strokeWidth={1.75} />
                    <Keycaps combo="Esc" small />
                  </button>
                  <span className="pop-spacer" />
                  <Keycaps combo={voiceKey} small />
                </div>
              </motion.div>
            )}

            {mode === 'review' && (
              <motion.div key="review" className="cap-review" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={{ duration: 0.2, delay: 0.08 }} onKeyDown={onFormKey}>
                <div className="review-head">
                  <span className="mono-label">{d.draft.source === 'voice' ? tr('ПРОВЕРЬ ТЕКСТ') : tr('НОВЫЙ ТИКЕТ')}</span>
                  <Segmented
                    label={tr('Колонка')}
                    value={d.draft.status}
                    options={[
                      { value: 'todo', label: tr('Не начато') },
                      { value: 'doing', label: tr('В процессе') }
                    ]}
                    onChange={(status) => d.setDraft({ ...d.draft, status })}
                  />
                </div>
                <input
                  className="input is-title"
                  value={d.draft.title}
                  onChange={(e) => d.setDraft({ ...d.draft, title: e.target.value })}
                  placeholder={tr('Заголовок')}
                  maxLength={140}
                  autoFocus
                  spellCheck={false}
                />
                <textarea
                  className="input is-body"
                  value={d.draft.body}
                  onChange={(e) => d.setDraft({ ...d.draft, body: e.target.value })}
                  placeholder={tr('Подробности (необязательно)')}
                  rows={5}
                />
                <ImageStrip images={d.draft.images} onFiles={d.addImages} onRemove={d.removeImage} />
                <div className="rec-actions">
                  <button type="button" className="btn is-primary" onClick={d.create}>
                    {tr('Создать тикет')}
                    <CornerDownLeft size={13} strokeWidth={2} />
                  </button>
                  <button type="button" className="btn is-ghost" onClick={d.cancel}>
                    {tr('Отмена')}
                    <Keycaps combo="Esc" small />
                  </button>
                  <span className="pop-spacer" />
                  <span className="hint-mono">{tr('Shift+Enter — новая строка')}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </>
  )
}

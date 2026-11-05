import { useState } from 'react'
import type { HarnessTarget } from '@shared/contract'
import { hasLogo } from './HarnessLogo'
import { Switch } from './ui'
import { tr } from '../lib/i18n'

interface Props {
  initial: HarnessTarget
  isNew: boolean
  onSave: (t: HarnessTarget) => void
  onDelete: () => void
  onClose: () => void
}

/** Content of the socket edit popover (name, glyph, process names, title filter, submit). */
export function TargetEditor({ initial, isNew, onSave, onDelete, onClose }: Props): JSX.Element {
  const [name, setName] = useState(initial.name)
  const [glyph, setGlyph] = useState(initial.glyph)
  const [procs, setProcs] = useState(initial.processNames.join(', '))
  const [title, setTitle] = useState(initial.titleIncludes ?? '')
  const [submit, setSubmit] = useState(initial.submit)

  const processNames = procs
    .split(/[,;]+/)
    .map((s) => s.trim().replace(/\.exe$/i, ''))
    .filter(Boolean)
  const valid = name.trim().length > 0 && processNames.length > 0

  const save = (): void => {
    if (!valid) return
    onSave({
      ...initial,
      name: name.trim(),
      glyph: (glyph.trim() || name.trim().slice(0, 2)).toUpperCase().slice(0, 3),
      processNames,
      titleIncludes: title.trim() || undefined,
      submit
    })
  }

  return (
    <form
      className="pop-form"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <div className="pop-title">{isNew ? tr('Новое гнездо') : tr('Гнездо')}</div>
      <div className="field-row">
        <label className="field" style={{ flex: 1 }}>
          <span className="field-label">{tr('Название')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} autoFocus placeholder={tr('Мой агент')} spellCheck={false} />
        </label>
        {!hasLogo(initial.id) && (
          <label className="field" style={{ width: 72 }}>
            <span className="field-label">{tr('Знак')}</span>
            <input className="input is-mono" value={glyph} onChange={(e) => setGlyph(e.target.value)} maxLength={3} placeholder="AG" spellCheck={false} />
          </label>
        )}
      </div>
      <label className="field">
        <span className="field-label">{tr('Процессы (без .exe, через запятую)')}</span>
        <input className="input is-mono" value={procs} onChange={(e) => setProcs(e.target.value)} placeholder="claude, node" spellCheck={false} />
      </label>
      <label className="field">
        <span className="field-label">{tr('Фильтр по заголовку окна')}</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tr('необязательно')} spellCheck={false} />
      </label>
      <div className="field-inline">
        <span>{tr('Нажимать Enter после вставки')}</span>
        <Switch checked={submit} onChange={setSubmit} label={tr('Enter после вставки')} />
      </div>
      <div className="pop-actions">
        {!initial.builtin && !isNew && (
          <button type="button" className="btn is-ghost is-danger" onClick={onDelete}>
            {tr('Удалить')}
          </button>
        )}
        <span className="pop-spacer" />
        <button type="button" className="btn is-ghost" onClick={onClose}>
          {tr('Отмена')}
        </button>
        <button type="submit" className="btn is-primary" disabled={!valid}>
          {isNew ? tr('Добавить') : tr('Сохранить')}
        </button>
      </div>
    </form>
  )
}

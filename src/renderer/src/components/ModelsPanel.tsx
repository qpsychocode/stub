import { useEffect, useState } from 'react'
import { Check, Download, RefreshCw, Trash2, X } from 'lucide-react'
import type { AsrStatus, ModelItem, ModelsState } from '@shared/contract'
import { api } from '../api'
import { getLanguage, tr } from '../lib/i18n'

interface Props {
  asr: AsrStatus
  onSelect: (dir: string) => void
}

const size = (bytes: number): string => (bytes >= 1024 ** 3 ? tr('{0} ГБ', (bytes / 1024 ** 3).toFixed(1)) : tr('{0} МБ', Math.round(bytes / 1024 ** 2)))

/** Speech models: what is installed, what can be downloaded, what has a newer version. Downloads go on with the panel closed. */
export function ModelsPanel({ asr, onSelect }: Props): JSX.Element {
  const [state, setState] = useState<ModelsState | null>(null)
  const refresh = (): void => void api.models.state().then(setState).catch(() => undefined)

  useEffect(() => {
    refresh()
    return api.models.onEvent((e) => {
      if (e.job === null) refresh()
      else setState((s) => s && { ...s, items: s.items.map((i) => (i.id === e.id ? { ...i, job: e.job } : i)) })
    })
  }, [])

  const busy = asr.state === 'listening' || asr.state === 'finishing'
  // The interface language's own models first.
  const lang = getLanguage()
  const items = [...(state?.items ?? [])].sort((a, b) => Number(b.langs.includes(lang)) - Number(a.langs.includes(lang)))

  const row = (key: string, name: string, meta: string, dir: string | null, actions: JSX.Element | null, item?: ModelItem): JSX.Element => {
    const active = dir !== null && dir === asr.modelDir
    return (
      <li key={key} className="model-row" data-active={active}>
        <button type="button" className="model-pick" disabled={dir === null || active || busy} onClick={() => dir && onSelect(dir)} title={dir && !active ? tr('Выбрать эту модель') : undefined}>
          <span className="model-mark">{active && <Check size={12} strokeWidth={3} />}</span>
          <span className="model-text">
            <span className="model-title">{name}</span>
            <span className="model-meta">{meta}</span>
          </span>
        </button>
        {actions}
        {item?.job && (
          <span className="model-progress" role="progressbar" aria-valuenow={Math.round((item.job.received / item.job.total) * 100)}>
            <span style={{ width: `${(item.job.received / item.job.total) * 100}%` }} />
          </span>
        )}
      </li>
    )
  }

  return (
    <div className="field">
      <span className="field-label">{tr('Модель распознавания')}</span>
      {!state && <div className="path-line">{tr('Загружаю список…')}</div>}
      <ul className="model-list">
        {state?.external.map((m) => row(m.dir, m.name, 'Beautiful Voice', m.dir, null))}
        {items.map((m) => {
          const langs = m.langs.join(' · ')
          const meta = m.job
            ? m.job.phase === 'unpack'
              ? tr('распаковываю…')
              : `${size(m.job.received)} / ${size(m.job.total)}`
            : m.installed
              ? m.updateAvailable
                ? tr('{0} · есть версия {1}', langs, m.version)
                : tr('{0} · версия {1}', langs, m.installed.version)
              : `${langs} · ${size(m.bytes)} · ${tr(m.note)}`
          const actions = m.job ? (
            <button type="button" className="icon-btn" onClick={() => api.models.cancel(m.id)} aria-label={tr('Отменить скачивание')} title={tr('Отменить скачивание')}>
              <X size={14} strokeWidth={1.75} />
            </button>
          ) : (
            <>
              {(!m.installed || m.updateAvailable) && (
                <button type="button" className="icon-btn" onClick={() => api.models.download(m.id)} aria-label={m.installed ? tr('Обновить') : tr('Скачать')} title={m.installed ? tr('Обновить') : tr('Скачать')}>
                  {m.installed ? <RefreshCw size={14} strokeWidth={1.75} /> : <Download size={14} strokeWidth={1.75} />}
                </button>
              )}
              {m.installed && m.installed.dir !== asr.modelDir && (
                <button
                  type="button"
                  className="icon-btn is-danger"
                  aria-label={tr('Удалить модель')}
                  title={tr('Удалить модель')}
                  onClick={() => {
                    if (m.installed) void api.models.remove(m.installed.dir).then(refresh)
                  }}
                >
                  <Trash2 size={14} strokeWidth={1.75} />
                </button>
              )}
            </>
          )
          return row(m.id, tr(m.name), meta, m.installed?.dir ?? null, actions, m)
        })}
      </ul>
      {state && !state.online && <div className="path-line">{tr('Нет связи с GitHub: новые версии не проверены')}</div>}
    </div>
  )
}

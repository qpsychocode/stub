import { useEffect, useState, type RefObject } from 'react'
import { Contrast, Copy, Minus, Settings, Square, Undo2, X } from 'lucide-react'
import type { AppSettings, AsrState, AsrStatus, UpdateState } from '@shared/contract'
import { api } from '../api'
import { modelLabel } from '../lib/format'
import { tr } from '../lib/i18n'

interface Props {
  asr: AsrStatus
  displayState: AsrState
  saveError: string | null
  update: UpdateState
  theme: AppSettings['theme']
  settingsOpen: boolean
  settingsRef: RefObject<HTMLButtonElement>
  canUndo: boolean
  undoLabel: string | null
  onUndo: () => void
  onToggleTheme: () => void
  onToggleSettings: () => void
}

const STATE_LABEL: Record<AsrState, string> = {
  loading: 'ЗАГРУЗКА',
  ready: 'ГОТОВ',
  listening: 'СЛУШАЮ',
  finishing: 'ДОПИСЫВАЮ',
  'no-model': 'НЕТ МОДЕЛИ',
  error: 'ОШИБКА'
}

export function Titlebar({ asr, displayState, saveError, update, theme, settingsOpen, settingsRef, canUndo, undoLabel, onUndo, onToggleTheme, onToggleSettings }: Props): JSX.Element {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => api.app.onMaximizedChange(setMaximized), [])

  const bad = displayState === 'no-model' || displayState === 'error'
  const tip = bad ? (asr.message && tr(asr.message)) || (displayState === 'no-model' ? tr('Скачай модель в настройках') : tr('Ошибка распознавания')) : undefined

  return (
    <header className="titlebar">
      <div className="tb-brand">
        <svg className="tb-logo" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path
            d="M2 1h14a1 1 0 0 1 1 1v4.2a2.8 2.8 0 0 0 0 5.6V16a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-4.2a2.8 2.8 0 0 0 0-5.6V2a1 1 0 0 1 1-1Z"
            fill="currentColor"
          />
          <path d="M6.5 3v12" stroke="var(--bg)" strokeWidth="1.2" strokeDasharray="1.4 1.8" />
        </svg>
        <span className="tb-word">STUB</span>
        <span className="tb-sub">{tr('голосовой тикет-борд')}</span>
      </div>

      <div className="tb-right">
        {(update.status === 'ready' || update.status === 'manual') && (
          <button type="button" className="update-btn" onClick={() => api.updates.install()} title={update.status === 'ready' ? tr('STUB перезапустится, доска сохранится') : tr('Новая версия на сайте')}>
            {update.status === 'ready' ? tr('Обновить до {0}', update.version) : tr('Скачать {0}', update.version)}
          </button>
        )}
        {saveError && (
          <div className="save-error" role="alert" data-tip={tr('Изменения пока только в памяти, повторяю запись. {0}', saveError)} data-tip-pos="bottom">
            {tr('НЕ СОХРАНЕНО')}
          </div>
        )}
        <div className="model-pill" data-state={displayState} data-bad={bad} data-tip={tip} data-tip-pos="bottom">
          <span className="model-dot" />
          <span className="model-name">{modelLabel(asr.modelName)}</span>
          <span className="model-sep">·</span>
          <span className="model-state">{tr(STATE_LABEL[displayState])}</span>
        </div>

        <button
          type="button"
          className="tb-btn"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label={tr('Отменить')}
          data-tip={canUndo ? tr('Отменить «{0}» · Ctrl+Z', undoLabel) : tr('Нечего отменять')}
          data-tip-pos="bottom"
        >
          <Undo2 size={16} strokeWidth={1.5} />
        </button>
        <button type="button" className="tb-btn" onClick={onToggleTheme} aria-label={tr('Сменить тему')} data-tip={theme === 'paper' ? tr('Тема: бумага') : tr('Тема: карбон')} data-tip-pos="bottom">
          <Contrast size={16} strokeWidth={1.5} style={{ transform: theme === 'carbon' ? 'rotate(180deg)' : undefined }} />
        </button>
        <button type="button" ref={settingsRef} className="tb-btn" data-active={settingsOpen} onClick={onToggleSettings} aria-label={tr('Настройки')} aria-expanded={settingsOpen}>
          <Settings size={16} strokeWidth={1.5} />
        </button>
        {update.current && <span className="tb-version">v{update.current}</span>}

        <span className="tb-gap" />

        <button type="button" className="win-btn" onClick={() => api.app.minimize()} aria-label={tr('Свернуть')}>
          <Minus size={14} strokeWidth={1.5} />
        </button>
        <button type="button" className="win-btn" onClick={() => api.app.toggleMaximize()} aria-label={maximized ? tr('Восстановить') : tr('Развернуть')}>
          {maximized ? <Copy size={12} strokeWidth={1.5} /> : <Square size={11} strokeWidth={1.5} />}
        </button>
        <button type="button" className="win-btn is-close" onClick={() => api.app.close()} aria-label={tr('Закрыть')}>
          <X size={15} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  )
}

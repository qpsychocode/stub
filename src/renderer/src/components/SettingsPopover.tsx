import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { playDoneSound } from '../lib/sound'
import { DEFAULT_SETTINGS, type AppSettings, type AsrStatus, type DeletedTicket, type Ticket, type UpdateState } from '@shared/contract'
import { api } from '../api'
import { acceleratorFromEvent, relTime } from '../lib/format'
import { ModelsPanel } from './ModelsPanel'
import { useToast } from './Toasts'
import { Keycaps, Segmented, Select, Switch } from './ui'
import { tr } from '../lib/i18n'

interface Props {
  settings: AppSettings
  asr: AsrStatus
  onChange: (patch: Partial<AppSettings>) => void
  onAsr: (s: AsrStatus) => void
  onRestoreTicket: (ticket: Ticket) => void
  update: UpdateState
}

function matchesCombo(a: string, b: string): boolean {
  const norm = (x: string): string =>
    x
      .split('+')
      .map((p) => (p === 'CommandOrControl' || p === 'CmdOrCtrl' ? 'Control' : p === 'Meta' ? 'Super' : p.length === 1 ? p.toUpperCase() : p))
      .sort()
      .join('+')
  return norm(a) === norm(b)
}

const LANGS = [
  { value: 'auto', label: 'Авто' },
  { value: 'ru', label: 'Русский' },
  { value: 'en', label: 'English' }
]

export function SettingsPopover({ settings, asr, onChange, onAsr, onRestoreTicket, update }: Props): JSX.Element {
  const toast = useToast()
  const [mics, setMics] = useState<{ value: string; label: string }[]>([{ value: '', label: tr('По умолчанию') }])
  const [capturing, setCapturing] = useState(false)
  const [modelDir, setModelDir] = useState(settings.modelDir)
  useEffect(() => setModelDir(settings.modelDir), [settings.modelDir])
  const [reloading, setReloading] = useState(false)
  const [deleted, setDeleted] = useState<DeletedTicket[]>([])

  useEffect(() => {
    let alive = true
    api.store
      .deleted()
      .then((list) => alive && setDeleted(list))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    navigator.mediaDevices
      ?.enumerateDevices()
      .then((list) => {
        if (!alive) return
        const inputs = list.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
        setMics([{ value: '', label: tr('По умолчанию') }, ...inputs.map((d, i) => ({ value: d.deviceId, label: d.label || tr('Микрофон {0}', i + 1) }))])
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const voiceKey = settings.voiceKey ?? DEFAULT_SETTINGS.voiceKey
  const [voiceCapturing, setVoiceCapturing] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)

  useEffect(() => {
    if (!voiceCapturing) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setVoiceCapturing(false)
        return
      }
      const acc = acceleratorFromEvent(e)
      if (!acc) return
      setVoiceCapturing(false)
      const parts = acc.split('+')
      if (!parts.some((p) => p === 'Control' || p === 'Alt' || p === 'Super')) {
        setVoiceError(tr('Нужен модификатор: Ctrl, Alt или Win'))
      } else if (matchesCombo(acc, 'Control+Shift+N')) {
        setVoiceError(tr('Занято: Ctrl+Shift+N — ручное создание'))
      } else if (matchesCombo(acc, 'Control+Z')) {
        setVoiceError(tr('Занято: Ctrl+Z — отмена'))
      } else if (matchesCombo(acc, settings.hotkey)) {
        setVoiceError(tr('Совпадает с глобальной клавишей диктовки'))
      } else {
        setVoiceError(null)
        onChange({ voiceKey: acc })
        toast({ kind: 'ok', label: tr('ГОРЯЧАЯ КЛАВИША'), text: tr('Сочетание обновлено') })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [voiceCapturing, onChange, settings.hotkey, toast])

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(false)
        return
      }
      const acc = acceleratorFromEvent(e)
      if (!acc) return
      setCapturing(false)
      if (matchesCombo(acc, voiceKey)) {
        toast({ kind: 'err', label: tr('ГОРЯЧАЯ КЛАВИША'), text: tr('Совпадает с клавишей диктовки в окне') })
        return
      }
      void api.app.setHotkey(acc).then((ok) => {
        if (ok) {
          onChange({ hotkey: acc })
          toast({ kind: 'ok', label: tr('ГОРЯЧАЯ КЛАВИША'), text: tr('Сочетание обновлено') })
        } else {
          void api.app.setHotkey(settings.hotkey)
          toast({ kind: 'err', label: tr('ГОРЯЧАЯ КЛАВИША'), text: tr('Не удалось занять это сочетание — оно уже используется') })
        }
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, onChange, settings.hotkey, voiceKey, toast])

  const reload = async (): Promise<void> => {
    setReloading(true)
    onChange({ modelDir: modelDir.trim() })
    try {
      onAsr(await api.asr.reload(modelDir.trim()))
    } catch (e) {
      toast({ kind: 'err', label: tr('МОДЕЛЬ'), text: (e as Error).message || tr('Не удалось перезагрузить модель') })
    }
    setReloading(false)
  }

  return (
    <div className="pop-form settings">
      <div className="pop-title">{tr('Настройки')}</div>

      <div className="field">
        <span className="field-label">{tr('Тема')}</span>
        <Segmented
          label={tr('Тема')}
          value={settings.theme}
          options={[
            { value: 'paper', label: tr('Бумага') },
            { value: 'carbon', label: tr('Карбон') }
          ]}
          onChange={(theme) => onChange({ theme })}
        />
      </div>

      <div className="field">
        <span className="field-label">{tr('Язык интерфейса')}</span>
        <Segmented
          label={tr('Язык интерфейса')}
          value={settings.uiLanguage ?? 'ru'}
          options={[
            { value: 'ru', label: 'Русский' },
            { value: 'en', label: 'English' }
          ]}
          onChange={(uiLanguage) => onChange({ uiLanguage })}
        />
      </div>

      <div className="field">
        <span className="field-label">{tr('Звук готового тикета')}</span>
        <Segmented
          label={tr('Звук готового тикета')}
          value={settings.doneSound === false ? 'off' : 'on'}
          options={[
            { value: 'on', label: tr('Вкл') },
            { value: 'off', label: tr('Выкл') }
          ]}
          onChange={(v) => {
            onChange({ doneSound: v === 'on' })
            if (v === 'on') playDoneSound()
          }}
        />
      </div>

      <div className="field">
        <span className="field-label">{tr('Микрофон')}</span>
        <Select label={tr('Микрофон')} value={settings.micDeviceId} options={mics} onChange={(micDeviceId) => onChange({ micDeviceId })} />
      </div>

      <div className="field">
        <span className="field-label">{tr('Язык распознавания')}</span>
        <Segmented label={tr('Язык')} value={LANGS.some((l) => l.value === settings.language) ? settings.language : 'auto'} options={LANGS.map((l) => ({ ...l, label: tr(l.label) }))} onChange={(language) => onChange({ language })} />
      </div>

      <div className="field">
        <span className="field-label">{tr('Голосом (в окне)')}</span>
        <button
          type="button"
          className="hotkey-field"
          data-capturing={voiceCapturing}
          onClick={() => {
            setVoiceError(null)
            setVoiceCapturing((c) => !c)
          }}
        >
          {voiceCapturing ? <span className="hotkey-hint">{tr('Нажми сочетание…')}</span> : <Keycaps combo={voiceKey} />}
          <span className="hotkey-act">{voiceCapturing ? 'Esc' : tr('изменить')}</span>
        </button>
        {voiceError && (
          <div className="path-line" role="alert" style={{ color: 'var(--accent)' }}>
            <span className="path-text">{voiceError}</span>
          </div>
        )}
      </div>

      <div className="field">
        <span className="field-label">{tr('Голосом (из любой программы)')}</span>
        <button type="button" className="hotkey-field" data-capturing={capturing} onClick={() => setCapturing((c) => !c)}>
          {capturing ? <span className="hotkey-hint">{tr('Нажми сочетание…')}</span> : <Keycaps combo={settings.hotkey} />}
          <span className="hotkey-act">{capturing ? 'Esc' : tr('изменить')}</span>
        </button>
      </div>

      <ModelsPanel
        asr={asr}
        onSelect={(dir) => {
          onChange({ modelDir: dir })
          void api.asr.reload(dir).then(onAsr)
        }}
      />

      <div className="field">
        <span className="field-label">{tr('Папка модели')}</span>
        <div className="field-row">
          <input
            className="input is-mono"
            style={{ flex: 1, minWidth: 0 }}
            value={modelDir}
            onChange={(e) => setModelDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void reload()
            }}
            placeholder={tr('авто (Beautiful Voice)')}
            spellCheck={false}
          />
          <button type="button" className="icon-btn is-boxed" onClick={() => void reload()} aria-label={tr('Перезагрузить модель')} data-tip={tr('Перезагрузить модель')} data-tip-pos="left" disabled={reloading}>
            <RefreshCw size={14} strokeWidth={1.75} className={reloading ? 'spin' : undefined} />
          </button>
        </div>
        <div className="path-line" data-tip={asr.modelDir || undefined}>
          <span className="path-text">{asr.modelDir ? tr('найдена: {0}', asr.modelDir) : tr('модель не найдена')}</span>
        </div>
      </div>

      <div className="field-inline">
        <span>{tr('Возвращать фокус в STUB после отправки')}</span>
        <Switch checked={settings.returnFocus} onChange={(returnFocus) => onChange({ returnFocus })} label={tr('Возвращать фокус')} />
      </div>

      <div className="field">
        <span className="field-label">{tr('Версия STUB')}</span>
        <div className="field-row update-row">
          <span className="path-text" title={update.message}>
            {update.current}
            {update.status === 'checking' && ` · ${tr('проверяю…')}`}
            {update.status === 'none' && ` · ${tr('последняя')}`}
            {update.status === 'downloading' && ` · ${tr('скачиваю {0} · {1}%', update.version, update.percent ?? 0)}`}
            {update.status === 'ready' && ` · ${tr('готова {0}', update.version)}`}
            {update.status === 'error' && ` · ${tr('не удалось проверить')}`}
          </span>
          <span className="pop-spacer" />
          {update.status === 'ready' ? (
            <button type="button" className="btn is-primary" onClick={() => api.updates.install()}>
              {tr('Перезапустить')}
            </button>
          ) : (
            <button type="button" className="btn is-ghost" disabled={update.status === 'checking' || update.status === 'downloading'} onClick={() => api.updates.check()}>
              {tr('Проверить')}
            </button>
          )}
        </div>
      </div>

      {deleted.length > 0 && (
        <div className="field">
          <span className="field-label">{tr('Удалённые тикеты')}</span>
          <ul className="trash-list">
            {deleted.map(({ ticket, deletedAt }) => (
              <li key={ticket.id} className="trash-item">
                <span className="trash-key">{ticket.key}</span>
                <span className="trash-title" title={ticket.title}>
                  {ticket.title}
                </span>
                <span className="trash-time">{relTime(deletedAt, Date.now())}</span>
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => {
                    onRestoreTicket(ticket)
                    setDeleted((list) => list.filter((d) => d.ticket.id !== ticket.id))
                  }}
                >
                  {tr('Вернуть')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

import { useDroppable } from '@dnd-kit/core'
import { motion } from 'motion/react'
import { Check, CornerDownLeft, Loader2 } from 'lucide-react'
import type { HarnessLimits, HarnessTarget } from '@shared/contract'
import { HarnessLogo } from './HarnessLogo'
import { LimitBars } from './LimitBars'
import { tr } from '../lib/i18n'

interface Props {
  target: HarnessTarget
  running: boolean
  limits?: HarnessLimits
  onSignIn: () => void
  wide: boolean
  state: 'idle' | 'sending' | 'ok'
  disabled: boolean
  elRef: (el: HTMLElement | null) => void
  onToggleSubmit: () => void
  onEdit: () => void
}

/** A droppable harness socket: logo, name, running dot, Enter-after-paste toggle. */
export function Socket({ target, running, limits, onSignIn, wide, state, disabled, elRef, onToggleSubmit, onEdit }: Props): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: `socket:${target.id}`, data: { type: 'socket' }, disabled })
  return (
    <div
      ref={(el) => {
        setNodeRef(el)
        elRef(el)
      }}
      className="socket"
      data-over={isOver}
      data-wide={wide}
      data-state={state}
      data-running={running}
      onContextMenu={(e) => {
        e.preventDefault()
        onEdit()
      }}
      onDoubleClick={onEdit}
      aria-label={`${target.name}${running ? tr(', окно запущено') : tr(', окно не найдено')}`}
    >
      <button
        type="button"
        className="socket-submit"
        aria-pressed={target.submit}
        aria-label={tr('Нажимать Enter после вставки')}
        data-tip={target.submit ? tr('Enter после вставки: вкл') : tr('Enter после вставки: выкл')}
        onClick={(e) => {
          e.stopPropagation()
          onToggleSubmit()
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <CornerDownLeft size={11} strokeWidth={2} />
      </button>
      <span className="socket-dot" data-on={running} aria-hidden="true" />
      <motion.span layout="position" className="socket-glyph">
        <HarnessLogo targetId={target.id} glyph={target.glyph} />
      </motion.span>
      <motion.span layout="position" className="socket-text">
        <span className="socket-name">{target.name}</span>
        <span className="socket-hint">{state === 'sending' ? tr('вставляю…') : tr('отпусти — отправлю')}</span>
        {limits && <LimitBars limits={limits} onSignIn={onSignIn} />}
      </motion.span>
      <span className="socket-status" aria-hidden="true">
        {state === 'sending' && (
          <>
            <Loader2 size={18} strokeWidth={2} className="spin" />
            <span className="socket-status-text">{tr('вставляю…')}</span>
          </>
        )}
        {state === 'ok' && <Check size={26} strokeWidth={2.5} />}
      </span>
    </div>
  )
}

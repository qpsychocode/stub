import { useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Plus } from 'lucide-react'
import type { HarnessLimits, HarnessTarget } from '@shared/contract'
import { Popover } from './Popover'
import { Socket } from './Socket'
import { TargetEditor } from './TargetEditor'
import { tr } from '../lib/i18n'

export interface PendingConfirm {
  targetId: string
  windowTitle?: string
}

interface Props {
  targets: HarnessTarget[]
  running: Record<string, boolean>
  limits: Record<string, HarnessLimits>
  onSignInClaude: () => void
  dragging: boolean
  sendingTargetId: string | null
  flashTargetId: string | null
  pending: PendingConfirm | null
  onConfirm: (yes: boolean) => void
  onChangeTargets: (targets: HarnessTarget[]) => void
}

type Editing = { mode: 'edit'; id: string } | { mode: 'new' } | null

/** Rail width while a ticket is being dragged. */
export const RAIL_WIDE_W = 240
const RAIL_W = 132

const BLANK: HarnessTarget ={ id: '', name: '', glyph: '', processNames: [], submit: false, builtin: false }

export function HarnessRail({ targets, running, limits, onSignInClaude, dragging, sendingTargetId, flashTargetId, pending, onConfirm, onChangeTargets }: Props): JSX.Element {
  const els = useRef<Record<string, HTMLElement | null>>({})
  const addRef = useRef<HTMLButtonElement>(null)
  const [editing, setEditing] = useState<Editing>(null)

  const editTarget = editing?.mode === 'edit' ? targets.find((t) => t.id === editing.id) : undefined
  const pendingTarget = pending ? targets.find((t) => t.id === pending.targetId) : undefined

  return (
    <div className="rail-slot">
      <motion.aside className="rail" data-wide={dragging} animate={{ width: dragging ? RAIL_WIDE_W : RAIL_W }} transition={{ duration: 0.26, ease: [0.2, 0.8, 0.2, 1] }}>
        <div className="rail-head">
          <span>{tr('ОТПРАВИТЬ')}</span>
        </div>
        <div className="rail-list">
          {targets.map((t) => (
            <Socket
              key={t.id}
              target={t}
              running={Boolean(running[t.id])}
              limits={limits[t.id]}
              onSignIn={onSignInClaude}
              wide={dragging}
              state={sendingTargetId === t.id ? 'sending' : flashTargetId === t.id ? 'ok' : 'idle'}
              disabled={sendingTargetId !== null}
              elRef={(el) => {
                els.current[t.id] = el
              }}
              onToggleSubmit={() => onChangeTargets(targets.map((x) => (x.id === t.id ? { ...x, submit: !x.submit } : x)))}
              onEdit={() => setEditing({ mode: 'edit', id: t.id })}
            />
          ))}
        </div>
        <button
          type="button"
          ref={addRef}
          className="rail-add"
          data-wide={dragging}
          onClick={() => setEditing({ mode: 'new' })}
          aria-label={tr('Добавить гнездо')}
          data-tip={tr('Своё гнездо')}
          data-tip-pos="left"
        >
          <Plus size={18} strokeWidth={1.5} />
        </button>
      </motion.aside>

      <AnimatePresence>
        {editing && (editTarget || editing.mode === 'new') && (
          <Popover
            key={editing.mode === 'edit' ? editing.id : 'new'}
            anchor={editing.mode === 'edit' ? els.current[editing.id] ?? null : addRef.current}
            placement="left"
            width={320}
            onClose={() => setEditing(null)}
          >
            <TargetEditor
              initial={editTarget ?? BLANK}
              isNew={editing.mode === 'new'}
              onClose={() => setEditing(null)}
              onSave={(t) => {
                if (editing.mode === 'new') onChangeTargets([...targets, { ...t, id: `custom-${Date.now().toString(36)}` }])
                else onChangeTargets(targets.map((x) => (x.id === t.id ? t : x)))
                setEditing(null)
              }}
              onDelete={() => {
                if (editTarget) onChangeTargets(targets.filter((x) => x.id !== editTarget.id))
                setEditing(null)
              }}
            />
          </Popover>
        )}
        {pending && pendingTarget && (
          <Popover key="confirm" anchor={els.current[pending.targetId] ?? null} placement="left" width={300} dismissOnOutside={false} onClose={() => onConfirm(false)}>
            <div className="pop-form">
              <div className="pop-title">{tr('Проверь вставку')}</div>
              <p className="pop-text">
                {tr('Не смог проверить вставку в «{0}». Вставилось?', pending.windowTitle || pendingTarget.name)}
              </p>
              <div className="pop-actions">
                <button type="button" className="btn is-ghost" onClick={() => onConfirm(false)}>
                  {tr('Нет')}
                </button>
                <span className="pop-spacer" />
                <button type="button" className="btn is-primary" onClick={() => onConfirm(true)} autoFocus>
                  {tr('Да, в работу')}
                </button>
              </div>
            </div>
          </Popover>
        )}
      </AnimatePresence>
    </div>
  )
}

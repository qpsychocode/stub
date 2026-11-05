import { useRef, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { AnimatePresence } from 'motion/react'
import { Plus } from 'lucide-react'
import type { Project } from '@shared/contract'
import { Popover } from './Popover'
import { tr } from '../lib/i18n'

interface Props {
  projects: Project[]
  activeId: string
  /** Tickets per project: open ones are shown on the tab, any at all block deleting it. */
  counts: Record<string, { open: number; total: number }>
  onActivate: (id: string) => void
  onAdd: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}

type Editing = { mode: 'edit'; id: string } | { mode: 'new' } | null

interface TabProps {
  project: Project
  active: boolean
  open: number
  elRef: (el: HTMLElement | null) => void
  onActivate: () => void
  onEdit: () => void
}

/** A project tab; also a drop target that moves a ticket into that project. */
function Tab({ project, active, open, elRef, onActivate, onEdit }: TabProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: `project:${project.id}`, data: { type: 'project' }, disabled: active })
  return (
    <button
      type="button"
      ref={(el) => {
        setNodeRef(el)
        elRef(el)
      }}
      className="project-tab"
      data-active={active}
      data-over={isOver}
      aria-pressed={active}
      onClick={onActivate}
      onDoubleClick={onEdit}
      onContextMenu={(e) => {
        e.preventDefault()
        onEdit()
      }}
    >
      <span className="project-tab-name">{project.name}</span>
      {open > 0 && <span className="project-tab-count">{open}</span>}
    </button>
  )
}

function ProjectEditor({ initial, isNew, deleteBlock, onSave, onDelete, onClose }: {
  initial: string
  isNew: boolean
  deleteBlock: string | null
  onSave: (name: string) => void
  onDelete: () => void
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState(initial)
  const valid = name.trim().length > 0
  return (
    <form
      className="pop-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onSave(name.trim())
      }}
    >
      <div className="pop-title">{isNew ? tr('Новый проект') : tr('Проект')}</div>
      <label className="field">
        <span className="field-label">{tr('Название')}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} autoFocus spellCheck={false} />
      </label>
      {!isNew && deleteBlock && <p className="pop-text">{deleteBlock}</p>}
      <div className="pop-actions">
        {!isNew && (
          <button type="button" className="btn is-ghost is-danger" onClick={onDelete} disabled={deleteBlock !== null}>
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

export function ProjectTabs({ projects, activeId, counts, onActivate, onAdd, onRename, onDelete }: Props): JSX.Element {
  const els = useRef<Record<string, HTMLElement | null>>({})
  const addRef = useRef<HTMLButtonElement>(null)
  const [editing, setEditing] = useState<Editing>(null)

  const edited = editing?.mode === 'edit' ? projects.find((p) => p.id === editing.id) : undefined
  const editedTotal = edited ? counts[edited.id]?.total ?? 0 : 0
  const deleteBlock = projects.length < 2 ? tr('Это единственный проект, его нельзя удалить.') : editedTotal > 0 ? tr('Чтобы удалить проект, сначала перенеси или удали его тикеты.') : null

  return (
    <nav className="project-tabs" aria-label={tr('Проекты')}>
      {projects.map((p) => (
        <Tab
          key={p.id}
          project={p}
          active={p.id === activeId}
          open={counts[p.id]?.open ?? 0}
          elRef={(el) => {
            els.current[p.id] = el
          }}
          onActivate={() => onActivate(p.id)}
          onEdit={() => setEditing({ mode: 'edit', id: p.id })}
        />
      ))}
      <button type="button" ref={addRef} className="project-add" onClick={() => setEditing({ mode: 'new' })} aria-label={tr('Новый проект')} data-tip={tr('Новый проект')} data-tip-pos="bottom">
        <Plus size={14} strokeWidth={1.75} />
      </button>

      <AnimatePresence>
        {editing && (edited || editing.mode === 'new') && (
          <Popover key={editing.mode === 'edit' ? editing.id : 'new'} anchor={edited ? els.current[edited.id] ?? null : addRef.current} placement="bottom-end" width={300} onClose={() => setEditing(null)}>
            <ProjectEditor
              initial={edited?.name ?? ''}
              isNew={editing.mode === 'new'}
              deleteBlock={deleteBlock}
              onClose={() => setEditing(null)}
              onSave={(name) => {
                if (edited) onRename(edited.id, name)
                else onAdd(name)
                setEditing(null)
              }}
              onDelete={() => {
                if (edited) onDelete(edited.id)
                setEditing(null)
              }}
            />
          </Popover>
        )}
      </AnimatePresence>
    </nav>
  )
}

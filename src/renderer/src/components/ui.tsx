import { useEffect, useId, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { ChevronDown } from 'lucide-react'
import { keycaps } from '../lib/format'
import { useEscLayer } from '../lib/layers'

export function Keycaps({ combo, small }: { combo: string; small?: boolean }): JSX.Element {
  return (
    <span className={`keycaps ${small ? 'is-small' : ''}`}>
      {keycaps(combo).map((k, i) => (
        <kbd key={i} className="keycap">
          {k}
        </kbd>
      ))}
    </span>
  )
}

interface SegProps<T extends string> {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label?: string
}

/** Segmented control with a sliding highlight. */
export function Segmented<T extends string>({ value, options, onChange, label }: SegProps<T>): JSX.Element {
  const id = useId()
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="seg-item"
          data-active={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }): JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" data-on={checked} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  )
}

interface SelectProps {
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  label: string
}

/** Custom dropdown (no native select UI). */
export function Select({ value, options, onChange, label }: SelectProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEscLayer(open, () => setOpen(false))
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])
  const current = options.find((o) => o.value === value) ?? options[0]
  return (
    <div className="select" ref={ref}>
      <button type="button" className="select-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        <span className="select-value">{current?.label ?? '—'}</span>
        <ChevronDown size={14} strokeWidth={1.75} className="select-chev" data-open={open} />
      </button>
      {open && (
        <motion.div className="select-list" role="listbox" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.14 }}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className="select-opt"
              data-active={o.value === value}
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
            >
              {o.label}
            </button>
          ))}
        </motion.div>
      )}
    </div>
  )
}

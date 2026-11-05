import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { useEscLayer } from '../lib/layers'

export type Placement = 'bottom-end' | 'left'

interface Props {
  anchor: HTMLElement | null
  placement: Placement
  width: number
  onClose: () => void
  /** When false, clicking outside does not close (used for confirmations). */
  dismissOnOutside?: boolean
  className?: string
  children: ReactNode
}

const GAP = 12
const MARGIN = 12

/** Portal popover pinned to an anchor element, clamped into the viewport. */
export function Popover({ anchor, placement, width, onClose, dismissOnOutside = true, className, children }: Props): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useEscLayer(true, onClose)

  useLayoutEffect(() => {
    const place = (): void => {
      const el = ref.current
      if (!anchor || !el) return
      const r = anchor.getBoundingClientRect()
      const h = el.offsetHeight
      let left: number
      let top: number
      if (placement === 'left') {
        left = r.left - GAP - width
        top = r.top + r.height / 2 - h / 2
      } else {
        left = r.right - width
        top = r.bottom + GAP
      }
      left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN))
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN))
      setPos({ left, top })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, placement, width])

  useEffect(() => {
    if (!dismissOnOutside) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor?.contains(t)) return
      onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [anchor, dismissOnOutside, onClose])

  if (!anchor) return null

  return createPortal(
    <motion.div
      ref={ref}
      className={`popover ${className ?? ''}`}
      style={{ width, left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      initial={{ opacity: 0, y: placement === 'left' ? 0 : -6, x: placement === 'left' ? 10 : 0, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, x: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 520, damping: 34 }}
      role="dialog"
    >
      {children}
    </motion.div>,
    document.body
  )
}

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'

export type ToastKind = 'ok' | 'warn' | 'err' | 'info'

export interface ToastInput {
  kind?: ToastKind
  label: string
  text: string
}

interface ToastItem extends ToastInput {
  id: number
}

const ToastCtx = createContext<(t: ToastInput) => void>(() => undefined)

export const useToast = (): ((t: ToastInput) => void) => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([])
  const seq = useRef(0)

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), [])

  const push = useCallback(
    (t: ToastInput) => {
      const id = ++seq.current
      setItems((l) => [...l.slice(-3), { ...t, id }])
      window.setTimeout(() => dismiss(id), 3500)
    },
    [dismiss]
  )

  const value = useMemo(() => push, [push])

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.button
              key={t.id}
              type="button"
              layout
              className="toast"
              data-kind={t.kind ?? 'info'}
              initial={{ opacity: 0, x: -24, scale: 0.96 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -16, transition: { duration: 0.16 } }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              onClick={() => dismiss(t.id)}
            >
              <span className="toast-bar" />
              <span className="toast-label">{t.label}</span>
              <span className="toast-text">{t.text}</span>
            </motion.button>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  )
}

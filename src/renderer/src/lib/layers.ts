import { useEffect, useRef } from 'react'

/** A tiny global stack: Escape always closes the topmost registered layer. */
interface Layer {
  fn: () => void
}
const stack: Layer[] = []

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stack.length > 0) {
      e.preventDefault()
      stack[stack.length - 1].fn()
    }
  })
}

export function useEscLayer(active: boolean, onEsc: () => void): void {
  const ref = useRef(onEsc)
  ref.current = onEsc
  useEffect(() => {
    if (!active) return
    const layer: Layer = { fn: () => ref.current() }
    stack.push(layer)
    return () => {
      const i = stack.indexOf(layer)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [active])
}

export function hasOpenLayer(): boolean {
  return stack.length > 0
}

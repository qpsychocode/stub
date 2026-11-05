import { useEffect, useRef } from 'react'

const BARS = 56

interface Props {
  levelRef: React.MutableRefObject<number>
  active: boolean
}

/** Mirrored bar waveform: a scrolling history of RMS levels with smooth decay. */
export function Waveform({ levelRef, active }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.scale(dpr, dpr)

    const bars = new Array<number>(BARS).fill(0)
    let smooth = 0
    let acc = 0
    let last = performance.now()
    let frame = 0
    let raf = 0
    let color = '#FF4F1F'
    let muted = 'rgba(127,127,127,.3)'

    const draw = (t: number): void => {
      const dt = Math.min(64, t - last)
      last = t
      const raw = active ? levelRef.current : 0
      // perceptual boost: speech RMS sits around 0.01-0.2
      const target = Math.min(1, Math.pow(raw * 5.5, 0.7))
      smooth += (target - smooth) * (target > smooth ? 0.55 : 0.12)
      acc += dt
      while (acc >= 46) {
        acc -= 46
        bars.shift()
        bars.push(smooth)
      }
      if (frame++ % 30 === 0) {
        const cs = getComputedStyle(canvas)
        color = cs.getPropertyValue('--accent').trim() || color
        muted = cs.getPropertyValue('--line-strong').trim() || muted
      }
      ctx.clearRect(0, 0, w, h)
      const gap = 3
      const bw = Math.max(2, (w - gap * (BARS - 1)) / BARS)
      const mid = h / 2
      for (let i = 0; i < BARS; i++) {
        const v = bars[i]
        const bh = Math.max(3, v * (h - 4))
        const x = i * (bw + gap)
        ctx.fillStyle = v > 0.04 ? color : muted
        ctx.globalAlpha = v > 0.04 ? 0.35 + 0.65 * (i / BARS) : 1
        const r = Math.min(bw / 2, 2)
        ctx.beginPath()
        ctx.roundRect(x, mid - bh / 2, bw, bh, r)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [levelRef, active])

  return <canvas ref={canvasRef} className="waveform" aria-hidden="true" />
}

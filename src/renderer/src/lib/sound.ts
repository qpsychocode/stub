/** A short rising chime for a finished ticket, made on the spot so the app carries no sound files. */
export function playDoneSound(): void {
  const Ctx = window.AudioContext
  if (!Ctx) return
  const audio = new Ctx()
  const start = audio.currentTime + 0.01
  const notes = [659.25, 987.77] // E5, B5
  notes.forEach((freq, i) => {
    const at = start + i * 0.11
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.16, at + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0008, at + 0.42)
    osc.connect(gain).connect(audio.destination)
    osc.start(at)
    osc.stop(at + 0.45)
  })
  window.setTimeout(() => void audio.close(), 900)
}

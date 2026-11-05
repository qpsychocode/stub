// Headless check (no window): fork out/main/asr-worker.js via utilityProcess and stream a WAV through it.
// Usage: npx electron scripts/test-worker-electron.cjs <file.wav>
const { app, utilityProcess } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// sherpa's readWave() is avoided on purpose: Electron's V8 forbids external buffers in the main process.
function readWav(p) {
  const b = fs.readFileSync(p)
  let off = 12
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4)
    const len = b.readUInt32LE(off + 4)
    if (id === 'data') {
      const n = Math.floor(len / 2)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768
      return { samples: out }
    }
    off += 8 + len
  }
  throw new Error('no data chunk')
}

app.whenReady().then(() => {
  const wav = readWav(process.argv[2])
  const child = utilityProcess.fork(path.join(__dirname, '..', 'out', 'main', 'asr-worker.js'))
  const t0 = Date.now()
  let req = 1
  child.on('message', (m) => {
    if (m.type === 'status') console.log(`[status +${Date.now() - t0}ms]`, m.status.state, m.status.modelName, m.status.message ?? '')
    if (m.type === 'partial') console.log('[partial]', m.text)
    if (m.type === 'status' && m.status.state === 'ready' && req === 1) {
      req = 2
      child.postMessage({ type: 'start', language: 'auto', reqId: 1 })
    }
    if (m.type === 'reply' && m.reqId === 1) {
      ;(async () => {
        for (let i = 0; i < wav.samples.length; i += 1600) {
          child.postMessage({ type: 'push', samples: wav.samples.slice(i, i + 1600) })
          await new Promise((r) => setTimeout(r, 20))
        }
        child.postMessage({ type: 'stop', reqId: 2 })
      })()
    }
    if (m.type === 'reply' && m.reqId === 2) {
      console.log('FINAL:', JSON.stringify(m.text))
      child.kill()
      setTimeout(() => app.quit(), 200)
    }
    if (m.type === 'status' && (m.status.state === 'error' || m.status.state === 'no-model')) {
      child.kill(); app.quit()
    }
  })
  child.postMessage({ type: 'load', modelDir: '' })
})

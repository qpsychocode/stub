import { createRequire } from 'node:module'
import { AsrEngine } from '../src/main/asr-core.ts'
import { discoverModel } from '../src/main/model.ts'
const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')
const d = discoverModel('')
console.log('model:', d.model?.name, d.model?.encoder, d.message ?? '')
const t0 = Date.now()
const eng = new AsrEngine(sherpa, (t: string) => console.log(`[partial +${Date.now() - t0}ms]`, t))
eng.load(d.model!)
console.log('load ms', Date.now() - t0)
const wav = sherpa.readWave(process.argv[2])
console.log('wav', wav.sampleRate, wav.samples.length / wav.sampleRate, 's')
eng.start('auto')
const chunk = 1600
for (let i = 0; i < wav.samples.length; i += chunk) {
  eng.push(wav.samples.slice(i, i + chunk))
  await new Promise((r) => setTimeout(r, 20))
}
const t1 = Date.now()
const text = await eng.stop()
console.log('stop ms', Date.now() - t1)
console.log('FINAL:', JSON.stringify(text))

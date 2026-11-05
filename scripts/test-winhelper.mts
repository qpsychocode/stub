// End-to-end test of winhelper.ps1 against a Notepad launched by this script ONLY.
import { spawn, execFileSync } from 'node:child_process'
import { WinHelper } from '../src/main/winhelper.ts'

const ps = (cmd: string): string => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim()
const pids = (): number[] => ps("(Get-Process -Name Notepad -ErrorAction SilentlyContinue).Id -join ','").split(',').filter(Boolean).map(Number)

const before = new Set(pids())
if (before.size) {
  console.log('Notepad already running (pids ' + [...before] + '), refusing to test')
  process.exit(2)
}
const prevClip = ps('Get-Clipboard -Raw')
spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref()
await new Promise((r) => setTimeout(r, 3000))
const mine = pids().filter((p) => !before.has(p))
console.log('notepad pids started by test:', mine)

const h = new WinHelper(new URL('../resources/winhelper.ps1', import.meta.url).pathname.replace(/^\//, ''))
try {
  let t = Date.now()
  const target = { id: 'np', processNames: ['Notepad'] }
  console.log('detect:', JSON.stringify(await h.detect([target, { id: 'none', processNames: ['definitely-not-running'] }])), `(${Date.now() - t}ms incl. helper startup)`)

  const text = 'STUB test ticket: проверка вставки текста в блокнот'
  ps(`Set-Clipboard -Value '${text}'`)
  t = Date.now()
  const r = await h.paste({ processNames: ['Notepad'], submit: false, needle: text.slice(0, 40) })
  console.log('paste:', JSON.stringify(r), `(${Date.now() - t}ms)`)

  // second paste, same needle already present: must still verify through length growth
  const r2 = await h.paste({ processNames: ['Notepad'], submit: false, needle: text.slice(0, 40) })
  console.log('paste again:', JSON.stringify(r2))

  const nf = await h.paste({ processNames: ['definitely-not-running'], submit: false, needle: 'x' })
  console.log('not-found:', JSON.stringify(nf))
} finally {
  h.dispose()
  for (const p of mine) {
    try { process.kill(p) } catch (e) { console.log('kill', p, String(e)) }
  }
  await new Promise((r) => setTimeout(r, 1000))
  console.log('notepad left:', pids().filter((p) => !before.has(p)))
  ps(`Set-Clipboard -Value @'\n${prevClip}\n'@`)
}

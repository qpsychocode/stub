// Starts the packaged macOS app on a CI machine and checks what no compiler can: that the native parts really run.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arch = process.argv[2]
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`)
  if (!ok) failures.push(name)
}

const appDir = readdirSync('dist').map((d) => join('dist', d, 'STUB.app')).find((p) => existsSync(p))
if (!appDir) throw new Error('STUB.app not found in dist')
console.log('app', appDir, 'arch', arch)
const unpacked = join(appDir, 'Contents/Resources/app.asar.unpacked/node_modules')
check('sherpa library unpacked', existsSync(join(unpacked, `sherpa-onnx-darwin-${arch}`)))
check('node-pty prebuild unpacked', existsSync(join(unpacked, `node-pty/prebuilds/darwin-${arch}/pty.node`)))

// The helper script runs by itself; these commands need no permissions.
const script = join(appDir, 'Contents/Resources/machelper.js')
const helper = (req) => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', script, JSON.stringify(req)], { encoding: 'utf8', timeout: 20000 }))
const tryHelper = (name, req, judge) => {
  try {
    const out = helper(req)
    check(name, out.ok === true && judge(out), out)
    return out
  } catch (e) {
    check(name, false, String(e.stderr || e.message).slice(0, 300))
    return null
  }
}
console.log('Finder running:', execFileSync('sh', ['-c', 'pgrep -x Finder || echo no'], { encoding: 'utf8' }).trim())
tryHelper('helper sees regular apps', { cmd: 'ping' }, (o) => o.regular.some((a) => a.startsWith('Finder#')))

const profile = mkdtempSync(join(tmpdir(), 'stub-smoke-'))
const folder = mkdtempSync(join(tmpdir(), 'stub-project-'))
const port = 9222
const app = spawn(join(appDir, 'Contents/MacOS/STUB'), [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { stdio: 'inherit' })
let page
for (let i = 0; i < 100 && !page; i++) {
  await wait(500)
  try {
    page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.url.includes('index.html'))
  } catch {
    /* not up yet */
  }
}
if (!page) {
  app.kill()
  throw new Error('the window never appeared')
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => {
  ws.onopen = r
})
let id = 0
const js = (expression) =>
  new Promise((res) => {
    const me = ++id
    const on = (m) => {
      const d = JSON.parse(m.data)
      if (d.id === me) {
        ws.removeEventListener('message', on)
        res(d.result?.exceptionDetails ? { error: d.result.exceptionDetails.exception?.description?.slice(0, 300) } : d.result?.result?.value)
      }
    }
    ws.addEventListener('message', on)
    ws.send(JSON.stringify({ id: me, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
try {
  await wait(4000)
  // With STUB's own window up, the helper has something real to find. This is what sockets rely on.
  const found = tryHelper('helper finds a running app', { cmd: 'find', processNames: ['STUB'] }, (o) => o.hwnd === app.pid)
  console.log('helper found', found?.hwnd, 'app pid', app.pid)
  tryHelper('helper detect', { cmd: 'detect', targets: [{ id: 'me', processNames: ['stub'] }, { id: 'none', processNames: ['NoSuchApp'] }] }, (o) => o.found.me === true && o.found.none === false)
  const seen = tryHelper('helper sees STUB\'s window', { cmd: 'ping' }, (o) => o.windows.some((w) => w.pid === app.pid))
  const mine = seen?.windows.find((w) => w.pid === app.pid)
  tryHelper('helper atCursor answers', { cmd: 'atCursor' }, () => true)
  // The window lookup itself, at a known spot: a mouse over STUB's window must resolve to STUB.
  if (mine) {
    const m = seen.mouse
    const over = m.x >= mine.b.X && m.x < mine.b.X + mine.b.Width && m.y >= mine.b.Y && m.y < mine.b.Y + mine.b.Height
    console.log('mouse', m, 'window', mine.b, 'over it:', over)
    if (over) tryHelper('helper atCursor resolves the window', { cmd: 'atCursor' }, (o) => o.hwnd === app.pid)
  }
  check('board shows', (await js(`document.querySelectorAll('.lane').length`)) === 3)
  check('platform class', (await js(`document.documentElement.dataset.platform`)) === 'mac')
  check('no window buttons of ours', (await js(`getComputedStyle(document.querySelector('.win-btn')).display`)) === 'none')
  check('three sockets', (await js(`document.querySelectorAll('.socket').length`)) === 3)
  check('chats reported unsupported', (await js(`window.api.harness.listChats({ id: 'x', name: 'x', processNames: ['Finder'], glyph: '', submit: false, builtin: false }).then(l => l.supported)`)) === false)

  const term = await js(`(async () => {
    const id = await window.api.terminals.create('shell', ${JSON.stringify(folder)}, 100, 30);
    let out = ''; const off = window.api.terminals.onData((i, d) => { if (i === id) out += d });
    await new Promise(r => setTimeout(r, 2500));
    window.api.terminals.write(id, 'echo STUB-$((40+2)); pwd\\n');
    await new Promise(r => setTimeout(r, 2500));
    off(); window.api.terminals.kill(id);
    return out;
  })()`)
  check('terminal runs a command', typeof term === 'string' && term.includes('STUB-42'), typeof term === 'string' ? term.slice(-200) : term)
  check('terminal opens in the folder', typeof term === 'string' && term.includes(folder.split('/').pop()))

  // A real download and load is the only proof the speech library's own files are found.
  const model = await js(`new Promise((res) => {
    const off = window.api.models.onEvent((e) => { if (e.job === null) { off(); res(e) } });
    window.api.models.state().then(() => window.api.models.download('vosk-ru-int8'));
    setTimeout(() => res({ error: 'timeout' }), 240000);
  })`)
  check('model downloads and unpacks', Boolean(model?.doneDir), model)
  if (model?.doneDir) {
    const status = await js(`window.api.asr.reload(${JSON.stringify(model.doneDir)})`)
    check('speech recognition loads', status?.state === 'ready', status)
  }
  const limits = await js(`window.api.limits.read().then(l => Object.keys(l))`)
  check('limits read does not crash', Array.isArray(limits), limits)
  check('update check is manual', (await js(`window.api.updates.state().then(s => s.status !== 'error')`)) === true, await js(`window.api.updates.state()`))
  check('database written', existsSync(join(profile, 'stub.db')))
} finally {
  ws.close()
  app.kill()
}
await wait(1000)
if (failures.length) {
  console.error('failed:', failures.join(', '))
  process.exit(1)
}
console.log('all good')
process.exit(0)

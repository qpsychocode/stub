// STUB's macOS helper, run as: osascript -l JavaScript machelper.js '<json>'
// The Windows counterpart is winhelper.ps1. On macOS an app's id is its process id.
ObjC.import('AppKit')
ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['unsigned int', 'unsigned int']])

const NS_ACTIVATE_ALL_WINDOWS = 1
const NS_ACTIVATE_IGNORING_OTHERS = 2
const CG_ON_SCREEN_ONLY = 1
const CG_EXCLUDE_DESKTOP = 16
const KEY_RETURN = 36

// The bridge hands numbers over as wrapped values that only look like numbers: "0" !== 0.
const num = (v) => Number(ObjC.unwrap(v))
const text = (ns) => {
  const s = ObjC.unwrap(ns)
  return typeof s === 'string' ? s : ''
}

/** Regular apps, the ones with a Dock icon. Needs no permission. */
function apps() {
  const list = $.NSWorkspace.sharedWorkspace.runningApplications
  const out = []
  const count = num(list.count)
  for (let i = 0; i < count; i++) {
    const a = list.objectAtIndex(i)
    if (num(a.activationPolicy) !== 0) continue
    const url = a.executableURL
    out.push({ pid: num(a.processIdentifier), name: text(a.localizedName), exe: url.isNil() ? '' : text(url.lastPathComponent) })
  }
  return out
}

function findApp(names) {
  const wanted = (names || []).map((n) => String(n).trim().replace(/\.(exe|app)$/i, '').toLowerCase()).filter(Boolean)
  return apps().find((a) => wanted.includes(a.name.toLowerCase()) || wanted.includes(a.exe.toLowerCase())) || null
}

const frontmostPid = () => num($.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier)
const systemEvents = () => Application('System Events')

function focus(pid) {
  const a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid)
  if (a.isNil()) return false
  a.activateWithOptions(NS_ACTIVATE_ALL_WINDOWS | NS_ACTIVATE_IGNORING_OTHERS)
  for (let i = 0; i < 20; i++) {
    if (frontmostPid() === pid) return true
    delay(0.05)
  }
  systemEvents().processes.whose({ unixId: pid })[0].frontmost = true
  for (let i = 0; i < 20; i++) {
    if (frontmostPid() === pid) return true
    delay(0.05)
  }
  return false
}

/** The text of the focused control, or null when the app does not expose it. */
function focusedValue(pid) {
  try {
    const proc = systemEvents().processes.whose({ unixId: pid })[0]
    const el = proc.attributes.byName('AXFocusedUIElement').value()
    const v = el.value()
    return typeof v === 'string' ? v : null
  } catch (e) {
    return null
  }
}

const squeeze = (s) => s.replace(/\s+/g, ' ').trim()

function pasteInto(pid, windowTitle, req) {
  if (!focus(pid)) return { ok: true, outcome: 'focus-failed', submitted: false, windowTitle }
  delay(0.25)
  systemEvents().keystroke('v', { using: 'command down' })
  let verified = false
  let readable = false
  const needle = squeeze(String(req.needle || ''))
  for (let i = 0; i < 8 && !verified; i++) {
    delay(0.2)
    const v = focusedValue(pid)
    if (v !== null) {
      readable = true
      verified = needle.length > 0 && squeeze(v).includes(needle)
    }
  }
  let submitted = false
  if (verified && req.submit) {
    systemEvents().keyCode(KEY_RETURN)
    submitted = true
  }
  return { ok: true, outcome: verified ? 'verified' : 'unverified', submitted, windowTitle, readable }
}

function onScreenWindows() {
  return ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(CG_ON_SCREEN_ONLY | CG_EXCLUDE_DESKTOP, 0)) || []
}

/** Mouse position with the origin at the top left, the way window bounds are measured. */
function mousePoint() {
  const mouse = $.NSEvent.mouseLocation
  return { x: num(mouse.x), y: num($.NSScreen.screens.objectAtIndex(0).frame.size.height) - num(mouse.y) }
}

/** The frontmost normal window under the mouse. Its title needs Screen Recording, so it may be empty. */
function atCursor() {
  const { x, y } = mousePoint()
  for (const w of onScreenWindows()) {
    const b = w.kCGWindowBounds
    if (Number(w.kCGWindowLayer) !== 0 || !b) continue
    if (x >= Number(b.X) && x < Number(b.X) + Number(b.Width) && y >= Number(b.Y) && y < Number(b.Y) + Number(b.Height)) {
      return { ok: true, hwnd: Number(w.kCGWindowOwnerPID), proc: w.kCGWindowOwnerName || '', title: w.kCGWindowName || '' }
    }
  }
  return { ok: true }
}

const commands = {
  detect(req) {
    const found = {}
    for (const t of req.targets || []) found[t.id] = findApp(t.processNames) !== null
    return { ok: true, found }
  },
  find(req) {
    const a = findApp(req.processNames)
    return a ? { ok: true, hwnd: a.pid } : { ok: true }
  },
  focus(req) {
    return { ok: true, focused: focus(Number(req.hwnd)) }
  },
  paste(req) {
    const a = findApp(req.processNames)
    if (!a) return { ok: true, outcome: 'not-found', submitted: false }
    return pasteInto(a.pid, a.name, req)
  },
  pasteInto(req) {
    return pasteInto(Number(req.hwnd), req.title, req)
  },
  pasteImage(req) {
    if (!focus(Number(req.hwnd))) return { ok: true, pasted: false }
    delay(0.25)
    systemEvents().keystroke('v', { using: 'command down' })
    return { ok: true, pasted: true }
  },
  atCursor,
  ping() {
    const windows = onScreenWindows().filter((w) => Number(w.kCGWindowLayer) === 0)
    return {
      ok: true,
      regular: apps().map((a) => `${a.name}#${a.pid}`),
      mouse: mousePoint(),
      windows: windows.map((w) => ({ pid: Number(w.kCGWindowOwnerPID), owner: w.kCGWindowOwnerName, b: w.kCGWindowBounds }))
    }
  }
}

function run(argv) {
  const req = JSON.parse(argv[0])
  const cmd = commands[req.cmd]
  return JSON.stringify(cmd ? cmd(req) : { ok: false, error: 'unknown cmd' })
}

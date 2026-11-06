# STUB — голосовой тикет-борд (desktop)

Windows desktop app (Electron). You dictate a task → local Nemotron ASR (the model
installed by the user's own app *Beautiful Voice*) transcribes it → it becomes a
ticket card on a 3-lane kanban → you drag the card onto a harness socket
(Claude Code / OpenCode / Codex / ChatGPT) → the app focuses that app's window,
pastes the ticket text, verifies the paste, and moves the card to "В процессе".
Cards can be dragged freely between all three lanes.

UI language: Russian. Code comments: English.

## Stack

- electron-vite (Vite for main / preload / renderer), TypeScript everywhere.
- Electron (latest stable you can install), electron-builder → NSIS installer + `win-unpacked`.
- Renderer: React 18, `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`,
  `motion` (framer-motion successor, import from `motion/react`), `lucide-react`,
  fonts bundled offline: `@fontsource/unbounded`, `@fontsource/onest`, `@fontsource/jetbrains-mono`
  (they include cyrillic subsets — required).
- ASR: `sherpa-onnx-node@2.0.1` (N-API, verified working on this machine with the model).
- No Python, no network at runtime.

The IPC contract is `src/shared/contract.ts` — the single source of truth. Both sides import it.

## File ownership

- Backend agent: `package.json`, `electron.vite.config.ts`, `tsconfig*.json`,
  `electron-builder.yml`, `src/main/**`, `src/preload/**`, `resources/**`, `scripts/**`.
- Frontend agent: `src/renderer/**` only.
- Architect: `src/shared/contract.ts`, `SPEC.md`.

## Backend

### Window
- Frameless (`frame: false`), `backgroundColor` matching theme (#E9E6DF), 1360×860, min 1040×680,
  `show: false` until `ready-to-show`. `titleBarStyle: 'hidden'` is NOT used; renderer draws its own titlebar
  with `-webkit-app-region: drag`.
- Single instance lock; second instance focuses the existing window.
- Permission handler: allow `media` (microphone) for the app's own origin.
- Global hotkey (settings.hotkey, default `Control+Alt+T`): show + restore + focus the window, then send `app:hotkey`.
- App icon: generate a simple 256px PNG/ICO in `resources/` (a ticket-stub glyph, vermilion #FF4F1F on #151412).

### Store
- `userData/stub-data.json`. `store:load` returns AppData (merge with DEFAULT_SETTINGS; ensure every
  DEFAULT_TARGET id exists in settings.targets, keep user edits). First run: seed 3 example tickets
  (one per lane) so the board isn't empty. `store:save` writes atomically (tmp + rename), serialised (queue).

### ASR (utilityProcess)
- `src/main/asr-worker.ts` is a separate entry run with `utilityProcess.fork`. It owns `sherpa-onnx-node`.
- Model discovery (in this order): settings.modelDir if non-empty → Beautiful Voice active model:
  read `%APPDATA%\BeautifulVoice\settings.json` → `active_model` → `%LOCALAPPDATA%\BeautifulVoice\models\<active_model>`
  → otherwise scan `%LOCALAPPDATA%\BeautifulVoice\models\*` for a dir containing
  `encoder*.onnx`, `decoder*.onnx`, `joiner*.onnx`, `tokens.txt` (prefer names containing `nemotron`).
  Pick int8 files when present. If nothing → status `no-model` with a helpful message
  ("Установите модель в Beautiful Voice").
- Recognizer config (proven on this machine — encoder is 650 MB, load ≈ 3 s, RTF ≈ 0.17):
  ```js
  new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: { transducer: { encoder, decoder, joiner }, tokens,
                   numThreads: Math.min(8, os.cpus().length), provider: 'cpu', debug: 0 },
    decodingMethod: 'greedy_search',
  })
  ```
- Load the model eagerly at app start (status `loading` → `ready`).
- start(language): `stream = rec.createStream()`; if language && language !== 'auto' → `stream.setOption('language', language)`.
- push: `stream.acceptWaveform({ samples, sampleRate: 16000 })`; `while (rec.isReady(stream)) rec.decode(stream)`;
  if `rec.getResult(stream).text` changed → emit partial. Decoding must not block audio intake: queue pushes,
  process in a loop.
- stop: accept 1.2 s of zeros (needed for the last chunk), `inputFinished()`, drain decode, resolve final text (trimmed).
- cancel: drop the stream.
- Main relays status/partials to the renderer (`asr:status-evt`, `asr:partial`). Worker crash → status `error`, auto-restart once.
- electron-builder: `asarUnpack: ["**/node_modules/sherpa-onnx-*/**"]`. Verify the packaged app loads the addon.

### Harness send (Windows automation)
- A persistent helper: `resources/winhelper.ps1`, spawned once with
  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <path>` (in packaged builds the script is
  in `process.resourcesPath`; use `extraResources`). JSON-lines protocol over stdin/stdout, `{id, cmd, ...}` →
  `{id, ok, ...}`. Compile C# once via `Add-Type` (user32 P/Invoke + `UIAutomationClient`/`UIAutomationTypes`).
  Restart the helper if it dies. Use `[Console]::InputEncoding/OutputEncoding = UTF8`.
- `detect {targets}`: for each target, true if any process with one of `processNames` has a visible top-level
  window with a non-empty title (matching `titleIncludes` if set).
- `paste {processNames, titleIncludes, submit, needle}` — main has already put the text on the clipboard
  (`clipboard.writeText`, after saving the previous clipboard text):
  1. Find the best window: EnumWindows (z-order, topmost first), visible, non-tool, titled, owned by a matching PID.
  2. Focus: if `IsIconic` → `ShowWindow(SW_RESTORE)`; ALT keybd_event trick + `AttachThreadInput` +
     `SetForegroundWindow` + `BringWindowToTop`; poll `GetForegroundWindow()` up to 1 s → else `focus-failed`.
  3. Sleep 250 ms. Read focused element text (`AutomationElement.FocusedElement`; ValuePattern.Value, else
     TextPattern.DocumentRange.GetText(-1); wrap in try/catch) → `before` (may be null).
  4. SendInput Ctrl+V. Sleep 450 ms. Read again → `after`.
  5. verified = after != null && normalized(after) contains normalized(needle) && (before == null || !normalized(before).contains(normalized(needle)) || after.Length > before.Length).
     Normalization: collapse whitespace, lower-case. `needle` = first 40 chars of the text.
  6. If verified && submit → SendInput Enter → submitted = true. Never press Enter when not verified.
  7. Reply `{outcome: verified|unverified, submitted, windowTitle}`.
- Main `harness:send`: save clipboard → write text → helper.paste → if verified, restore the previous clipboard
  after 1.5 s; otherwise leave the ticket text on the clipboard (so the user can paste manually).
  If `returnFocus` → focus the STUB window again after 600 ms.

### Preload
- `contextBridge.exposeInMainWorld('api', api)` implementing `StubApi`. `asr.push` uses `ipcRenderer.send`
  with the Float32Array (structured clone). Event subscriptions return an unsubscribe fn.
- Also export a `src/renderer/src/env.d.ts`? NO — the frontend agent declares `window.api: StubApi` itself.

## Frontend — design direction: "Ticket stub / transit-editorial"

Not a Trello clone. The metaphor is the paper ticket stub: perforations, punched notches, rubber stamps,
monospace serials, big outlined lane numerals. Calm, warm, tactile, confident; one hot signal colour.

### Tokens (CSS custom properties on `:root[data-theme=paper]` / `[data-theme=carbon]`)
| token | paper (light) | carbon (dark) |
|---|---|---|
| --bg | #E9E6DF | #121211 |
| --surface | #F7F5F0 | #1C1B19 |
| --surface-2 | #EFECE5 | #242320 |
| --ink | #151412 | #EEEBE4 |
| --muted | #6E6A62 | #8F8A80 |
| --line | rgba(21,20,18,.12) | rgba(238,235,228,.10) |
| --accent (vermilion, "в процессе", primary actions, recording) | #FF4F1F | #FF5A2A |
| --done (acid lime, "готово" stamps) | #9CC93A | #B8E04F |
| --shadow-card | 0 1px 0 rgba(21,20,18,.06), 0 8px 24px -12px rgba(21,20,18,.25) | 0 1px 0 rgba(0,0,0,.4), 0 10px 28px -12px rgba(0,0,0,.7) |

- Fonts: Unbounded 700/800 (wordmark, lane numerals, harness glyphs), Onest 400/500/600 (UI & card text),
  JetBrains Mono 400/500 (ticket keys, timestamps, labels — uppercase, letter-spacing .08em, 10–11px).
- Background: `--bg` + dot grid (radial-gradient 1px dots every 22px, ink at 7%) + very faint SVG noise overlay (3%).
- Radii: cards 14px, pills 999px, sockets 18px. Motion: 180–260 ms, `cubic-bezier(.2,.8,.2,1)`; springs for drops.

### Layout (frameless window)
```
┌ titlebar 44px: STUB wordmark · "голосовой тикет-борд" (mono) ···· [● NEMOTRON 3.5 · ГОТОВ] [◐] [⚙] [–][□][×] ┐
│                                                                                              │ rail │
│  01 (outlined, 72px)        02                         03                                     │ ┌──┐ │
│  НЕ НАЧАТО · 4             В ПРОЦЕССЕ · 2              ГОТОВО · 7                              │ │CC│ │
│  ┌ card ┐                  ┌ card ┐                    ┌ card ┐                               │ └──┘ │
│  │      │                  │      │                    │STAMP │                               │ ┌──┐ │
│  ◖- - - ◗ (notches+perf)   ...                                                               │ │OC│ │
│  └──────┘                                                                                    │  ... │
│                       ╭──────── voice capsule (floating, bottom center) ────────╮             │ [+]  │
│                       │  (●mic)  Надиктуй задачу   [Ctrl][Alt][T]   [+ вручную] │             │      │
│                       ╰──────────────────────────────────────────────────────────╯             │      │
└──────────────────────────────────────────────────────────────────────────────────────────────┴──────┘
```
- Titlebar: drag region; buttons are `no-drag`. Window buttons are minimal square glyphs; close turns vermilion on hover.
  Model pill: dot colour by AsrState (loading = pulsing muted, ready = done-lime, listening = accent, no-model/error = accent outline + tooltip message).
- Lanes: three equal columns separated by 1px vertical `--line` rules, no boxed backgrounds. Header: giant
  numeral "01/02/03" in Unbounded 800 ~72px, `-webkit-text-stroke: 1.5px var(--ink)`, transparent fill; under it
  a mono uppercase label + count. Lane 02 numeral stroke uses --accent, lane 03 uses --done.
  While a card is dragged over a lane: lane gets diagonal hatching (`repeating-linear-gradient(135deg, …)` in accent at ~6%)
  and its numeral fills solid. Lanes scroll vertically independently (thin custom scrollbar); bottom padding so the capsule never covers the last card.
- Card = ticket stub (`surface`, radius 14, shadow-card). Two semicircle notches (r=9px) punched out of the left and
  right edges at the perforation line (CSS `mask` with two radial-gradients), plus a dashed perforation line between
  them. Above perforation: row [mono key `T-014` · relative time "5 мин" · mic icon if source=voice], title (Onest 600,
  15px, 2 lines clamp), body preview (13px, muted, 3 lines clamp). Below perforation (footer): send chips
  `→ CLAUDE CODE ✓ 14:02` (mono 10px; ✓ only when verified) and, on hover, icon actions (copy, edit, delete).
  - doing: a 3px accent bar on the left edge inside the card.
  - done: a rotated (-9°) rubber stamp "ГОТОВО" (double border, --done colour, mono 11px, slight opacity 0.85,
    slightly uneven via a mask noise) at the top-right; title colour muted.
- Drag & drop (dnd-kit): PointerSensor with `activationConstraint: { distance: 5 }`, KeyboardSensor; sortable inside
  lanes and across lanes (multiple-containers pattern), reorder updates `order`. DragOverlay: card lifted, rotate 2.5°,
  scale 1.03, bigger shadow; the original slot shows a dashed outline placeholder of the same height. Collision:
  `closestCorners` for lanes plus harness sockets as droppables (`pointerWithin` first so sockets win when hovered).
- Harness rail (right, 104px wide, full height under titlebar, `--surface-2`, left border line): vertical list of sockets
  (80×80, radius 18): glyph (Unbounded 700, 18px), name under it (mono 9px uppercase), a small status dot (lime = window
  running, muted = not running; poll `harness.detect` every 4 s). A tiny "↵" toggle on each socket = `submit` (Enter after paste).
  Right-click a socket → small popover to edit name/glyph/process names/title filter/submit, delete (custom only).
  "+" socket at the bottom adds a custom target.
  While ANY card is being dragged: the rail widens to 240px (animated), sockets become wide rows with the name in full and
  "отпусти — отправлю" hint, gently pulsing border. Hovered socket: inverted (ink bg, surface text) with accent ring.
- Drop on a socket:
  1. The card animates "into" the socket (shrink + fade toward it), socket shows a spinner state "вставляю…".
  2. Call `harness.send({ ticketId, target, text: buildPrompt(ticket), returnFocus: settings.returnFocus })`.
  3. verified → append SendRecord(verified true), status → 'doing' (top of lane 02), socket flashes lime ✓, toast
     "Отправлено в Claude Code" (+ "и запущено" if submitted).
  4. unverified → popover anchored to the socket: "Не смог проверить вставку в «<windowTitle>». Вставилось?"
     [Да, в работу] → record verified true + doing; [Нет] → keep in place, toast "Текст в буфере — вставь вручную (Ctrl+V)".
  5. not-found / focus-failed / error → card returns to its place, toast with the reason; text is on the clipboard.
- Voice capsule (bottom center, floating, 560px, radius 999, `backdrop-filter: blur(16px)`, surface at 85% opacity,
  shadow). Idle: round 44px accent mic button, "Надиктуй задачу", keycaps for the hotkey (mono keycap style),
  a ghost button "+ вручную" (Ctrl+N).
  Recording: capsule morphs (motion layout) into a 680px rounded sheet (radius 24): live waveform (canvas, ~56 mirrored
  bars from RMS levels, accent colour, smooth decay), mono timer `00:07`, streaming transcript (Onest 20px, caret blinking at the
  end; partials replace the text), buttons [■ Готово (Enter)] [✕ Esc]. Global hotkey again also stops.
  Review: after stop → the final text in an editable form: Title input (auto = first sentence, max ~70 chars, cut on a word
  boundary with "…" when longer), Body textarea (the full transcript), lane segmented control (Не начато / В процессе),
  [Создать тикет ⏎] [Отмена]. Enter creates (Shift+Enter newline in body), Esc cancels. The new card springs into its lane top.
  If ASR is not ready: mic button disabled-looking with tooltip from status.message; manual creation still works.
- Audio capture: `getUserMedia({ audio: { deviceId, channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } })`,
  `new AudioContext({ sampleRate: 16000 })`, AudioWorklet loaded from a Blob URL (CSP in index.html must allow
  `worker-src blob:` / `script-src 'self' blob:`); worklet posts Float32 frames; batch to ~1600 samples (100 ms) → `api.asr.push`.
  Compute RMS per batch for the waveform. Max recording 10 min. Stop all tracks on finish.
- Ticket sheet: double-click a card (or Edit) → right-side sheet (420px, slides in) to edit title/body, change status,
  see send history, copy prompt, delete (with inline confirm). Ctrl+Enter saves, Esc closes.
- Settings popover (⚙ in titlebar): theme (paper/carbon), microphone select (`enumerateDevices`), language
  (auto/ru/en), hotkey field (validate via `app.setHotkey`), model dir (text + current detected path from `asr.status`,
  button "перезагрузить модель"), returnFocus toggle.
- Toasts: bottom-left stack, mono label + text, auto-dismiss 3.5 s.
- Keyboard: Ctrl+N new manual ticket, global hotkey dictation, Esc closes topmost layer, Delete on a focused card asks to delete.
- Empty lane: dashed ticket-shaped outline with "Пусто. Перетащи сюда".
- Persist: debounce 300 ms → `api.store.save(data)`, and synchronously when the window closes. New ticket key: `T-${String(seq+1).padStart(3,'0')}`.
  Storage is SQLite (`<userData>/stub.db`, Electron's built-in `node:sqlite`): tickets are only soft-deleted (restorable from Settings), every
  change except reordering goes to `ticket_history`, and one copy per day stays in `backups/` (14 kept). `stub-data.json` is imported once into
  an empty database and then left untouched. A failed write shows НЕ СОХРАНЕНО in the titlebar and retries every 5 s. A database or legacy file
  that cannot be read shows an error and quits; it is never replaced with an empty board.
- Respect `prefers-reduced-motion` (disable rotations/springs).
- Terminals: a panel right of the board, per project, opening in the project's folder (chosen locally or cloned from a link). Buttons start Claude,
  Codex, OpenCode (from PATH, or the copy their desktop app keeps) or a plain PowerShell, through node-pty. A ticket dropped on the panel goes into the
  active terminal without running: as one bracketed paste where the program supports it, otherwise as a single line; pictures become files whose paths join the text. Terminals last as long as the app runs.
- Project chats: a project can name a chat per app (right-click its tab). Sending to that socket first opens the chat by pressing its button in the app's
  sidebar through UI Automation (`Get-ChatUi` in winhelper.ps1, which reads how the buttons relate rather than their wording) and confirms it from the
  window header. If that fails nothing is pasted and the text stays on the clipboard. Bindings go by section and title, so renaming a chat breaks one.
  Dragging a ticket out of STUB still goes to the window it is dropped on.
- Self-update: electron-updater against the public `qpsychocode/stub-releases` GitHub releases (installers only, no source). Checks at start and every
  6 hours, downloads in the background, then offers a restart button in the titlebar; otherwise it installs on a normal quit.
  Publish with `npm run release`: bumps the version, builds and uploads. Not code-signed; integrity comes from the sha512 in `latest.yml`.
- Speech models: Settings lists sherpa-onnx streaming transducers (`src/main/models.ts`). Download with progress and cancel, unpack with Windows' `tar.exe`,
  keep in `<userData>/models/<id>-<version>`. An update is a newer date in the asset name on the `asr-models` GitHub release (checked at most hourly).
  Models found in Beautiful Voice can be selected but are never changed. A finished update replaces the model in use and removes the old folder.
- Interface language: Russian or English (`settings.uiLanguage`, `src/renderer/src/lib/i18n.ts`). Russian text is the key of `tr()`; a missing English
  string falls back to Russian. Errors raised in the main process are mostly left in Russian.
- Pictures: paste (Ctrl+V), drop a file or use the button while recording, in review and in the ticket sheet. Stored as PNG in the `images` table
  (longest side 2400 px), with a small thumbnail in the ticket. Sending pastes each picture into the window through the clipboard, waits for
  the app to take it, then pastes the text. A pasted picture cannot be verified, only the text can.
- Lanes run oldest to newest, top to bottom. A new ticket goes to the bottom; a ticket moved by sending or by a status change goes to its place
  by creation time; a ticket dragged into a position stays there.
- The transcript is an editable field while recording. After an edit, the text belongs to the user and further speech is appended at the end;
  the caret stays where it is. Enter finishes, Shift+Enter adds a line, Esc cancels.
- Plan limits on sockets, refreshed every 3 min: 5-hour and weekly bars, green = remaining, grey = used, percent beside each. Codex comes from
  the installed CLI (`codex app-server`, `account/rateLimits/read`, its own login). Claude comes from claude.ai's usage data through STUB's own sign-in
  window (partition `persist:claude-usage`); that endpoint is not a public API, so an unexpected answer shows "нет данных", never a guess.
  OpenCode's free models expose no such limits, so that socket shows no bars.
- There is no built-in ChatGPT socket: the Codex desktop app's window is `ChatGPT.exe`, so the Codex socket looks for both process names.
- Projects: tabs above the board, one board per project (`Ticket.projectId`, `AppData.projects`, `AppData.activeProjectId`). New tickets
  go to the active tab; drop a ticket on another tab to move it. Right-click or double-click a tab to rename or delete it; only an empty
  project can be deleted, never the last one. Data saved before projects existed loads into the first project.
- Drag out: releasing a ticket outside the STUB window pastes it into the top-level window under the cursor (`harness.sendToCursor`).
  The window's process is matched against the harness targets, and the result is stored in `SendRecord`: that is how STUB knows who took
  the ticket. The project comes from the ticket, not the window: Claude Desktop has one window titled "Claude" for all its sessions.
  Releasing over STUB itself, the desktop, the taskbar or File Explorer sends nothing. Not possible while STUB is maximized on the only monitor.

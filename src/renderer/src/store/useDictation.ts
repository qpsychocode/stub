import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, AsrStatus, TicketImage, TicketStatus } from '@shared/contract'
import { api } from '../api'
import { startRecorder, type Recorder } from '../audio/recorder'
import { uploadImages } from '../components/ImageStrip'
import { deriveTitle } from '../lib/format'
import { useEscLayer } from '../lib/layers'
import type { ToastInput } from '../components/Toasts'
import { tr } from '../lib/i18n'

export type Phase = 'idle' | 'starting' | 'recording' | 'finishing' | 'review'

export interface Draft {
  title: string
  body: string
  status: Extract<TicketStatus, 'todo' | 'doing'>
  source: 'voice' | 'manual'
  images: TicketImage[]
}

interface Options {
  settings: AppSettings
  asr: AsrStatus
  onCreate: (d: Draft) => void
  toast: (t: ToastInput) => void
}

export interface Dictation {
  phase: Phase
  transcript: string
  /** The user changed the text while recording; further speech is appended after it. */
  editTranscript: (text: string) => void
  startedAt: number
  levelRef: React.MutableRefObject<number>
  draft: Draft
  setDraft: (d: Draft) => void
  addImages: (files: File[]) => void
  removeImage: (id: string) => void
  start: () => Promise<void>
  stop: () => Promise<void>
  cancel: () => void
  toggle: () => void
  openManual: () => void
  create: () => void
}

const EMPTY: Draft = { title: '', body: '', status: 'todo', source: 'manual', images: [] }

const TYPING_PAUSE_MS = 1200

/** The user's text, plus whatever the recognizer has produced since their last edit. */
function mergeSpeech(edited: string | null, absorbed: number, raw: string): string {
  if (edited === null) return raw
  const tail = raw.slice(absorbed)
  if (!tail.trim()) return edited
  if (!edited) return tail.trimStart()
  // No space at the seam means the recognizer is still finishing the word it was on, so it joins up.
  return /\s$/.test(edited) ? edited + tail.trimStart() : edited + tail
}

function describe(e: unknown): string {
  const name = (e as { name?: string } | null)?.name
  if (name === 'NotAllowedError') return tr('Нет доступа к микрофону')
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return tr('Микрофон не найден — проверь выбор в настройках')
  const m = (e as { message?: string } | null)?.message
  return m ? m : tr('Не удалось начать запись')
}

export function useDictation(opts: Options): Dictation {
  const [phase, setPhaseState] = useState<Phase>('idle')
  const phaseRef = useRef<Phase>('idle')
  const [transcript, setTranscript] = useState('')
  const transcriptRef = useRef('')
  const rawRef = useRef('') // recognizer's own text; it resends all of it with every update
  const editedRef = useRef<string | null>(null) // text as of the user's last edit
  const absorbedRef = useRef(0) // how much of rawRef that edit already covers
  const shownRef = useRef(0) // how much of rawRef is on screen
  const lastEditRef = useRef(0)
  const speechTimer = useRef<number | undefined>(undefined)
  const [startedAt, setStartedAt] = useState(0)
  const [draft, setDraftState] = useState<Draft>(EMPTY)
  const draftRef = useRef<Draft>(EMPTY)
  const setDraft = useCallback((d: Draft) => {
    draftRef.current = d
    setDraftState(d)
  }, [])
  const addImages = useCallback((files: File[]) => {
    uploadImages(files)
      .then((added) => setDraft({ ...draftRef.current, images: [...draftRef.current.images, ...added] }))
      .catch((e: Error) => optsRef.current.toast({ kind: 'err', label: tr('КАРТИНКА'), text: e.message }))
  }, [])
  const removeImage = useCallback((id: string) => {
    setDraft({ ...draftRef.current, images: draftRef.current.images.filter((i) => i.id !== id) })
  }, [])
  const levelRef = useRef(0)
  const recRef = useRef<Recorder | null>(null)
  const abortRef = useRef(false)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p
    setPhaseState(p)
  }, [])

  const showSpeech = useCallback((): void => {
    shownRef.current = rawRef.current.length
    const merged = mergeSpeech(editedRef.current, absorbedRef.current, rawRef.current)
    transcriptRef.current = merged
    setTranscript(merged)
  }, [])

  useEffect(
    () =>
      api.asr.onPartial((text) => {
        if (phaseRef.current === 'recording' || phaseRef.current === 'finishing') {
          rawRef.current = text.trimStart()
          // Speech landing between keystrokes would splice into the word being typed: hold it until the typing pauses.
          const typing = Date.now() - lastEditRef.current
          window.clearTimeout(speechTimer.current)
          if (typing < TYPING_PAUSE_MS) speechTimer.current = window.setTimeout(showSpeech, TYPING_PAUSE_MS - typing)
          else showSpeech()
        }
      }),
    []
  )

  const editTranscript = useCallback((text: string) => {
    editedRef.current = text
    absorbedRef.current = shownRef.current // speech held back while typing is not part of this edit
    lastEditRef.current = Date.now()
    transcriptRef.current = text
    setTranscript(text)
  }, [])

  const stop = useCallback(async () => {
    if (phaseRef.current !== 'recording') return
    setPhase('finishing')
    try {
      await recRef.current?.stop()
    } catch {
      /* ignore */
    }
    recRef.current = null
    window.clearTimeout(speechTimer.current)
    let final = ''
    try {
      final = (await api.asr.stop()).trim()
    } catch (e) {
      optsRef.current.toast({ kind: 'err', label: tr('РАСПОЗНАВАНИЕ'), text: describe(e) })
    }
    const text = (final ? mergeSpeech(editedRef.current, absorbedRef.current, final) : transcriptRef.current).trim()
    const images = draftRef.current.images
    if (!text && images.length === 0) {
      optsRef.current.toast({ kind: 'warn', label: tr('ТИШИНА'), text: tr('Ничего не расслышал — попробуй ещё раз') })
      setPhase('idle')
      return
    }
    setDraft({ title: deriveTitle(text), body: text, status: 'todo', source: 'voice', images })
    setPhase('review')
  }, [setPhase])

  const start = useCallback(async () => {
    if (phaseRef.current !== 'idle') return
    const { asr, settings, toast } = optsRef.current
    if (asr.state !== 'ready') {
      const msg =
        (asr.message && tr(asr.message)) ??
        (asr.state === 'loading' ? tr('Модель ещё загружается…') : asr.state === 'no-model' ? tr('Скачай модель в настройках') : tr('Распознавание сейчас недоступно'))
      toast({ kind: 'warn', label: tr('МИКРОФОН'), text: msg })
      return
    }
    abortRef.current = false
    transcriptRef.current = ''
    rawRef.current = ''
    editedRef.current = null
    absorbedRef.current = 0
    shownRef.current = 0
    lastEditRef.current = 0
    window.clearTimeout(speechTimer.current)
    setDraft({ ...EMPTY })
    setTranscript('')
    levelRef.current = 0
    setPhase('starting')
    try {
      await api.asr.start(settings.language)
      const rec = await startRecorder({
        deviceId: settings.micDeviceId,
        onBatch: (s) => api.asr.push(s),
        onLevel: (v) => {
          levelRef.current = v
        },
        onLimit: () => void stop()
      })
      if (abortRef.current) {
        await rec.stop()
        api.asr.cancel()
        setPhase('idle')
        return
      }
      recRef.current = rec
      setStartedAt(Date.now())
      setPhase('recording')
    } catch (e) {
      api.asr.cancel()
      toast({ kind: 'err', label: tr('МИКРОФОН'), text: describe(e) })
      setPhase('idle')
    }
  }, [setPhase, stop, setDraft])

  const cancel = useCallback(() => {
    switch (phaseRef.current) {
      case 'starting':
        abortRef.current = true
        break
      case 'recording':
        void recRef.current?.stop()
        recRef.current = null
        api.asr.cancel()
        setPhase('idle')
        break
      case 'review':
        setPhase('idle')
        break
      default:
        break
    }
  }, [setPhase])

  const toggle = useCallback(() => {
    if (phaseRef.current === 'idle') void start()
    else if (phaseRef.current === 'recording') void stop()
  }, [start, stop])

  const openManual = useCallback(() => {
    if (phaseRef.current !== 'idle') return
    setDraft({ ...EMPTY })
    setPhase('review')
  }, [setPhase])

  const create = useCallback(() => {
    if (phaseRef.current !== 'review') return
    const d = draftRef.current
    const title = d.title.trim() || deriveTitle(d.body) || (d.images.length > 0 ? tr('Картинка') : '')
    if (!title) {
      optsRef.current.toast({ kind: 'warn', label: tr('ПУСТО'), text: tr('Нужен хотя бы заголовок') })
      return
    }
    setPhase('idle')
    optsRef.current.onCreate({ ...d, title, body: d.body.trim() })
  }, [setPhase])

  useEscLayer(phase === 'starting' || phase === 'recording' || phase === 'review', cancel)

  return { phase, transcript, editTranscript, startedAt, levelRef, draft, setDraft, addImages, removeImage, start, stop, cancel, toggle, openManual, create }
}

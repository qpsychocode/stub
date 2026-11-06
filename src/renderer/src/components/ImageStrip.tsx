import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImagePlus, X } from 'lucide-react'
import type { TicketImage } from '@shared/contract'
import { api } from '../api'
import { useEscLayer } from '../lib/layers'
import { tr } from '../lib/i18n'

export const imageFiles = (dt: DataTransfer | null): File[] => [...(dt?.files ?? [])].filter((f) => f.type.startsWith('image/'))

/** Stores the files one by one, in order. Rejects with the first readable problem. */
export async function uploadImages(files: File[]): Promise<TicketImage[]> {
  const out: TicketImage[] = []
  for (const f of files) out.push(await api.images.add(new Uint8Array(await f.arrayBuffer())))
  return out
}

/** Ctrl+V of a picture anywhere in the window while `active`; text paste is left alone. */
export function useImagePaste(active: boolean, onFiles: (files: File[]) => void): void {
  const handler = useRef(onFiles)
  handler.current = onFiles
  useEffect(() => {
    if (!active) return
    const onPaste = (e: ClipboardEvent): void => {
      const files = imageFiles(e.clipboardData)
      if (files.length === 0) return
      e.preventDefault()
      handler.current(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [active])
}

function Viewer({ url, onClose }: { url: string; onClose: () => void }): JSX.Element {
  useEscLayer(true, onClose)
  return createPortal(
    <div className="image-viewer" onClick={onClose} role="dialog" aria-label={tr('Картинка')}>
      <img src={url} alt="" />
    </div>,
    document.body
  )
}

interface Props {
  images: TicketImage[]
  onFiles: (files: File[]) => void
  onRemove: (id: string) => void
  /** Only the thumbnails: for dictation, where a picture arrives by Ctrl+V and an empty row is just clutter. */
  thumbsOnly?: boolean
}

/** Thumbnails of a ticket's pictures with an add button. */
export function ImageStrip({ images, onFiles, onRemove, thumbsOnly }: Props): JSX.Element | null {
  const input = useRef<HTMLInputElement>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  if (thumbsOnly && images.length === 0) return null
  return (
    <div className="image-strip">
      {images.map((img) => (
        <div key={img.id} className="image-thumb">
          <button type="button" className="image-open" aria-label={tr('Открыть картинку')} onClick={() => void api.images.get(img.id).then(setViewing)}>
            <img src={img.thumb} alt="" />
          </button>
          <button type="button" className="image-remove" aria-label={tr('Убрать картинку')} onClick={() => onRemove(img.id)}>
            <X size={11} strokeWidth={2.5} />
          </button>
        </div>
      ))}
      {!thumbsOnly && (
        <>
          <button type="button" className="image-add" onClick={() => input.current?.click()} title={tr('Добавить картинку. Можно вставить через Ctrl+V или перетащить файл')}>
            <ImagePlus size={15} strokeWidth={1.75} />
          </button>
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              onFiles([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
        </>
      )}
      {viewing && <Viewer url={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

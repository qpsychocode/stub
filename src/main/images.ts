import { randomUUID } from 'node:crypto'
import { nativeImage } from 'electron'
import type { TicketImage } from '@shared/contract'
import { getImage, putImage } from './store'

const MAX_INPUT_BYTES = 30 * 1024 * 1024
const MAX_SIDE = 2400 // bigger pictures only make the target app's upload slower
const THUMB_HEIGHT = 120

/** Normalises a picture to PNG and stores it. Throws a readable message when it cannot be used. */
export function addImage(bytes: Uint8Array): TicketImage {
  if (bytes.byteLength > MAX_INPUT_BYTES) throw new Error('Картинка больше 30 МБ')
  let img = nativeImage.createFromBuffer(Buffer.from(bytes))
  if (img.isEmpty()) throw new Error('Этот формат не поддерживается, нужен PNG или JPEG')
  const size = img.getSize()
  const longest = Math.max(size.width, size.height)
  if (longest > MAX_SIDE) {
    const k = MAX_SIDE / longest
    img = img.resize({ width: Math.round(size.width * k), height: Math.round(size.height * k), quality: 'best' })
  }
  const id = randomUUID()
  putImage(id, img.toPNG())
  const thumb = img.resize({ height: THUMB_HEIGHT, quality: 'good' }).toJPEG(70)
  const { width, height } = img.getSize()
  return { id, thumb: `data:image/jpeg;base64,${thumb.toString('base64')}`, width, height }
}

export function imageDataUrl(id: string): string | null {
  const png = getImage(id)
  return png ? `data:image/png;base64,${png.toString('base64')}` : null
}

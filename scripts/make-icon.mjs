// Generates resources/icon.png (256x256) and resources/icon.ico (PNG-in-ICO) with no dependencies.
// Glyph: a ticket stub (vermilion #FF4F1F) on a dark rounded square (#151412).
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 256
const SS = 3 // supersampling per axis
const BG = [0x15, 0x14, 0x12]
const FG = [0xff, 0x4f, 0x1f]

const rrect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r)
  const cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1
}

// Returns [r,g,b,a] for a point in 0..256 space.
function shade(x, y) {
  if (!rrect(x, y, 0, 0, SIZE, SIZE, 56)) return [0, 0, 0, 0]
  // ticket body
  const tx0 = 34, tx1 = 222, ty0 = 70, ty1 = 186
  let onTicket = rrect(x, y, tx0, ty0, tx1, ty1, 16)
  const perfX = 164
  const notchR = 13
  if ((x - perfX) ** 2 + (y - ty0) ** 2 < notchR ** 2) onTicket = false
  if ((x - perfX) ** 2 + (y - ty1) ** 2 < notchR ** 2) onTicket = false
  if (!onTicket) return [...BG, 255]
  // dashed perforation
  if (Math.abs(x - perfX) < 2.5 && y > ty0 + notchR + 4 && y < ty1 - notchR - 4) {
    const k = Math.floor((y - ty0) / 10)
    if (k % 2 === 0) return [...BG, 255]
  }
  // "text" bars on the main part
  if (rrect(x, y, 58, 98, 140, 112, 7)) return [...BG, 255]
  if (rrect(x, y, 58, 126, 118, 138, 6)) return [...BG, 255]
  if (rrect(x, y, 58, 150, 100, 162, 6)) return [...BG, 255]
  // stub: a small punched circle
  if ((x - 193) ** 2 + (y - 128) ** 2 < 11 ** 2) return [...BG, 255]
  return [...FG, 255]
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let py = 0; py < SIZE; py++) {
  raw[py * (SIZE * 4 + 1)] = 0 // filter: none
  for (let px = 0; px < SIZE; px++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = shade(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)
        r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]
      }
    }
    const n = SS * SS
    const o = py * (SIZE * 4 + 1) + 1 + px * 4
    if (a > 0) {
      raw[o] = Math.round(r / a)
      raw[o + 1] = Math.round(g / a)
      raw[o + 2] = Math.round(b / a)
      raw[o + 3] = Math.round(a / n)
    }
  }
}

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

// ICO with one 256x256 PNG image (width/height byte 0 means 256).
const ico = Buffer.alloc(22)
ico.writeUInt16LE(0, 0)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(1, 4)
ico[6] = 0
ico[7] = 0
ico.writeUInt16LE(1, 10) // planes
ico.writeUInt16LE(32, 12) // bpp
ico.writeUInt32LE(png.length, 14)
ico.writeUInt32LE(22, 18)

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'icon.png'), png)
writeFileSync(join(out, 'icon.ico'), Buffer.concat([ico, png]))
console.log(`wrote ${join(out, 'icon.png')} (${png.length} bytes) and icon.ico`)

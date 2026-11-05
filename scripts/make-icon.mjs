// Generates build/icon.ico and build/icon.png (the app icon) with no dependencies.
// A rounded accent tile with a small agent network: one hub node linked to three agents.
// Run: node scripts/make-icon.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build')

const TOP = [124, 106, 255]
const BOTTOM = [74, 92, 235]
const SS = 4 // supersampling per axis

/** Coverage (0..1) of a shape given as a signed-distance function, sampled on a grid inside one pixel. */
function render(size) {
  const px = Buffer.alloc(size * size * 4)
  const s = size / 256
  // Geometry in a 256 design space.
  const hub = { x: 128, y: 138, r: 30 }
  const nodes = [
    { x: 128, y: 56, r: 19 },
    { x: 62, y: 190, r: 19 },
    { x: 194, y: 190, r: 19 }
  ]
  const segDist = (x, y, a, b) => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy))
  }
  const inTile = (x, y) => {
    const r = 56
    const cx = Math.min(Math.max(x, 8 + r), 248 - r)
    const cy = Math.min(Math.max(y, 8 + r), 248 - r)
    return Math.hypot(x - cx, y - cy) <= r
  }
  const inGlyph = (x, y) => {
    if (Math.hypot(x - hub.x, y - hub.y) <= hub.r) return true
    for (const n of nodes) {
      if (Math.hypot(x - n.x, y - n.y) <= n.r) return true
      if (segDist(x, y, hub, n) <= 6) return true
    }
    return false
  }
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let tile = 0
      let glyph = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (pxl + (sx + 0.5) / SS) / s
          const y = (py + (sy + 0.5) / SS) / s
          if (inTile(x, y)) {
            tile++
            if (inGlyph(x, y)) glyph++
          }
        }
      }
      const total = SS * SS
      const alpha = tile / total
      const t = py / size
      const base = TOP.map((c, i) => c + (BOTTOM[i] - c) * t)
      const g = tile ? glyph / tile : 0
      const o = (py * size + pxl) * 4
      for (let i = 0; i < 3; i++) px[o + i] = Math.round(base[i] * (1 - g) + 255 * g)
      px[o + 3] = Math.round(alpha * 255)
    }
  }
  return px
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
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
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(size) {
  const rgba = render(size)
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

function ico(sizes) {
  const images = sizes.map((n) => ({ n, data: png(n) }))
  const head = Buffer.alloc(6)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = 6 + images.length * 16
  const dir = images.map(({ n, data }) => {
    const e = Buffer.alloc(16)
    e[0] = n >= 256 ? 0 : n
    e[1] = n >= 256 ? 0 : n
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    return e
  })
  return Buffer.concat([head, ...dir, ...images.map((i) => i.data)])
}

mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'icon.png'), png(512))
writeFileSync(join(outDir, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]))
console.log('wrote build/icon.png and build/icon.ico')

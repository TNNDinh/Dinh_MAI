import { deflateSync, inflateSync } from 'node:zlib'

/**
 * Pixel-level image handling for the asset pipeline, with no native dependencies:
 * a PNG decoder/encoder and the operations the pipeline needs (resize, fit, trim, background removal).
 * JPEG/WebP and interlaced PNG are decoded by the host (Electron) instead; see `codec.ts`.
 */

export class PixelError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'unsupported' | 'too_large' | 'empty' | 'no_background'
  ) {
    super(message)
    this.name = 'PixelError'
  }
}

/** Straight (non-premultiplied) RGBA, 8 bits per channel, row-major. */
export interface Raster {
  width: number
  height: number
  data: Uint8Array
}

/** 8192 x 6144; larger images would need hundreds of MB of working memory. */
export const MAX_PIXELS = 50_331_648

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function isPng(buf: Uint8Array): boolean {
  if (buf.length < 8) return false
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIGNATURE[i]) return false
  return true
}

export function newRaster(width: number, height: number): Raster {
  assertDimensions(width, height)
  return { width, height, data: new Uint8Array(width * height * 4) }
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new PixelError(`Invalid image size ${width}x${height}.`, 'invalid')
  if (width * height > MAX_PIXELS) throw new PixelError(`The image is ${width}x${height}; the limit is ${MAX_PIXELS} pixels in total.`, 'too_large')
}

// ------------------------------------------------------------------ PNG decode

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

export function decodePng(buf: Uint8Array): Raster {
  if (!isPng(buf)) throw new PixelError('Not a PNG file.', 'invalid')
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 8
  let ihdr: { width: number; height: number; depth: number; colorType: number; interlace: number } | null = null
  let palette: Buffer | null = null
  let trns: Buffer | null = null
  const idat: Buffer[] = []
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos)
    const type = b.toString('latin1', pos + 4, pos + 8)
    const start = pos + 8
    if (start + len + 4 > b.length) throw new PixelError('The PNG file is truncated.', 'invalid')
    const body = b.subarray(start, start + len)
    if (type === 'IHDR') {
      if (len < 13) throw new PixelError('Broken PNG header.', 'invalid')
      ihdr = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] }
    } else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') trns = body
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos = start + len + 4
  }
  if (!ihdr) throw new PixelError('The PNG file has no header.', 'invalid')
  const { width, height, depth, colorType, interlace } = ihdr
  if (!(colorType in CHANNELS) || ![1, 2, 4, 8, 16].includes(depth)) throw new PixelError('Unsupported PNG format.', 'unsupported')
  if (interlace !== 0) throw new PixelError('Interlaced PNG files are not supported by the built-in decoder.', 'unsupported')
  assertDimensions(width, height)
  if (colorType === 3 && !palette) throw new PixelError('The PNG file has no palette.', 'invalid')
  if (idat.length === 0) throw new PixelError('The PNG file has no image data.', 'invalid')

  const channels = CHANNELS[colorType]
  const bitsPerPixel = channels * depth
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8)
  const bpp = Math.max(1, bitsPerPixel >> 3)
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (rowBytes + 1) * height + 16 })
  } catch {
    throw new PixelError('The PNG image data is corrupt.', 'invalid')
  }
  if (raw.length < (rowBytes + 1) * height) throw new PixelError('The PNG image data is incomplete.', 'invalid')

  // Undo the per-row filters in place.
  const pixels = Buffer.alloc(rowBytes * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]
    const src = y * (rowBytes + 1) + 1
    const dst = y * rowBytes
    const up = y > 0 ? dst - rowBytes : -1
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= bpp ? pixels[dst + x - bpp] : 0
      const above = up >= 0 ? pixels[up + x] : 0
      const upLeft = up >= 0 && x >= bpp ? pixels[up + x - bpp] : 0
      let v = raw[src + x]
      switch (filter) {
        case 0:
          break
        case 1:
          v += left
          break
        case 2:
          v += above
          break
        case 3:
          v += (left + above) >> 1
          break
        case 4: {
          const p = left + above - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - above)
          const pc = Math.abs(p - upLeft)
          v += pa <= pb && pa <= pc ? left : pb <= pc ? above : upLeft
          break
        }
        default:
          throw new PixelError('The PNG file uses an unknown filter.', 'invalid')
      }
      pixels[dst + x] = v & 0xff
    }
  }

  const out = new Uint8Array(width * height * 4)
  const maxVal = (1 << depth) - 1
  const sample = (row: number, index: number): number => {
    // `index` counts samples (not bytes) within the row.
    if (depth === 8) return pixels[row + index]
    if (depth === 16) return (pixels[row + index * 2] << 8) | pixels[row + index * 2 + 1]
    const bit = index * depth
    const byte = pixels[row + (bit >> 3)]
    return (byte >> (8 - depth - (bit & 7))) & maxVal
  }
  const to8 = (v: number): number => (depth === 8 ? v : depth === 16 ? v >> 8 : Math.round((v * 255) / maxVal))
  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? trns.readUInt16BE(0) : -1
  const trnsRgb = colorType === 2 && trns && trns.length >= 6 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : null
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      switch (colorType) {
        case 0: {
          const g = sample(row, x)
          out[o] = out[o + 1] = out[o + 2] = to8(g)
          out[o + 3] = g === trnsGray ? 0 : 255
          break
        }
        case 2: {
          const r = sample(row, x * 3)
          const g = sample(row, x * 3 + 1)
          const bl = sample(row, x * 3 + 2)
          out[o] = to8(r)
          out[o + 1] = to8(g)
          out[o + 2] = to8(bl)
          out[o + 3] = trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && bl === trnsRgb[2] ? 0 : 255
          break
        }
        case 3: {
          const i = sample(row, x)
          if (i * 3 + 2 >= palette!.length) throw new PixelError('The PNG file refers to a missing palette entry.', 'invalid')
          out[o] = palette![i * 3]
          out[o + 1] = palette![i * 3 + 1]
          out[o + 2] = palette![i * 3 + 2]
          out[o + 3] = trns && i < trns.length ? trns[i] : 255
          break
        }
        case 4: {
          out[o] = out[o + 1] = out[o + 2] = to8(sample(row, x * 2))
          out[o + 3] = to8(sample(row, x * 2 + 1))
          break
        }
        default: {
          out[o] = to8(sample(row, x * 4))
          out[o + 1] = to8(sample(row, x * 4 + 1))
          out[o + 2] = to8(sample(row, x * 4 + 2))
          out[o + 3] = to8(sample(row, x * 4 + 3))
        }
      }
    }
  }
  return { width, height, data: out }
}

// ------------------------------------------------------------------ PNG encode

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}

/** 8-bit RGBA PNG. Each row uses whichever of the five PNG filters gives the smallest sum of absolute values. */
export function encodePng(img: Raster): Buffer {
  const { width, height, data } = img
  assertDimensions(width, height)
  const rowBytes = width * 4
  const out = Buffer.alloc((rowBytes + 1) * height)
  const cand = Buffer.alloc(rowBytes)
  const best = Buffer.alloc(rowBytes)
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes
    const up = y > 0 ? row - rowBytes : -1
    let bestScore = Infinity
    let bestFilter = 0
    for (let f = 0; f < 5; f++) {
      let score = 0
      for (let x = 0; x < rowBytes; x++) {
        const cur = data[row + x]
        const left = x >= 4 ? data[row + x - 4] : 0
        const above = up >= 0 ? data[up + x] : 0
        const upLeft = up >= 0 && x >= 4 ? data[up + x - 4] : 0
        let pred = 0
        if (f === 1) pred = left
        else if (f === 2) pred = above
        else if (f === 3) pred = (left + above) >> 1
        else if (f === 4) {
          const p = left + above - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - above)
          const pc = Math.abs(p - upLeft)
          pred = pa <= pb && pa <= pc ? left : pb <= pc ? above : upLeft
        }
        const v = (cur - pred) & 0xff
        cand[x] = v
        score += v < 128 ? v : 256 - v
      }
      if (score < bestScore) {
        bestScore = score
        bestFilter = f
        cand.copy(best)
      }
    }
    out[y * (rowBytes + 1)] = bestFilter
    best.copy(out, y * (rowBytes + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(out, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

// ------------------------------------------------------------------ operations

export function hasTransparency(img: Raster): boolean {
  const d = img.data
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true
  return false
}

export type ResizeFilter = 'smooth' | 'nearest'

/** Resamples one axis. Shrinking averages the covered pixels (area filter), enlarging interpolates linearly; colour is premultiplied by alpha. */
function resampleAxis(src: Float32Array, srcW: number, srcH: number, dstLen: number, horizontal: boolean): Float32Array {
  const srcLen = horizontal ? srcW : srcH
  const outW = horizontal ? dstLen : srcW
  const outH = horizontal ? srcH : dstLen
  const out = new Float32Array(outW * outH * 4)
  const scale = srcLen / dstLen
  for (let d = 0; d < dstLen; d++) {
    // Contributions of source positions to destination index d.
    const taps: Array<[number, number]> = []
    if (scale > 1) {
      const a = d * scale
      const b = (d + 1) * scale
      for (let s = Math.floor(a); s < Math.min(srcLen, Math.ceil(b)); s++) taps.push([s, Math.min(b, s + 1) - Math.max(a, s)])
    } else {
      const c = (d + 0.5) * scale - 0.5
      const s0 = Math.floor(c)
      const t = c - s0
      taps.push([Math.max(0, Math.min(srcLen - 1, s0)), 1 - t])
      taps.push([Math.max(0, Math.min(srcLen - 1, s0 + 1)), t])
    }
    let total = 0
    for (const [, w] of taps) total += w
    const other = horizontal ? srcH : srcW
    for (let o = 0; o < other; o++) {
      let r = 0
      let g = 0
      let bl = 0
      let a = 0
      for (const [s, w] of taps) {
        const i = ((horizontal ? o * srcW + s : s * srcW + o) * 4) | 0
        r += src[i] * w
        g += src[i + 1] * w
        bl += src[i + 2] * w
        a += src[i + 3] * w
      }
      const j = (horizontal ? o * outW + d : d * outW + o) * 4
      out[j] = r / total
      out[j + 1] = g / total
      out[j + 2] = bl / total
      out[j + 3] = a / total
    }
  }
  return out
}

export function resizeRaster(src: Raster, width: number, height: number, filter: ResizeFilter = 'smooth'): Raster {
  assertDimensions(width, height)
  if (width === src.width && height === src.height) return { width, height, data: src.data.slice() }
  const out = newRaster(width, height)
  if (filter === 'nearest') {
    for (let y = 0; y < height; y++) {
      const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) * src.height) / height))
      for (let x = 0; x < width; x++) {
        const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) * src.width) / width))
        const s = (sy * src.width + sx) * 4
        const o = (y * width + x) * 4
        out.data[o] = src.data[s]
        out.data[o + 1] = src.data[s + 1]
        out.data[o + 2] = src.data[s + 2]
        out.data[o + 3] = src.data[s + 3]
      }
    }
    return out
  }
  // Premultiply, resample both axes, un-premultiply.
  const pm = new Float32Array(src.width * src.height * 4)
  for (let i = 0; i < src.data.length; i += 4) {
    const a = src.data[i + 3] / 255
    pm[i] = src.data[i] * a
    pm[i + 1] = src.data[i + 1] * a
    pm[i + 2] = src.data[i + 2] * a
    pm[i + 3] = src.data[i + 3]
  }
  const h = resampleAxis(pm, src.width, src.height, width, true)
  const v = resampleAxis(h, width, src.height, height, false)
  for (let i = 0; i < out.data.length; i += 4) {
    const a = v[i + 3]
    if (a <= 0.5) {
      out.data[i] = out.data[i + 1] = out.data[i + 2] = out.data[i + 3] = 0
      continue
    }
    const k = 255 / a
    out.data[i] = Math.max(0, Math.min(255, Math.round(v[i] * k)))
    out.data[i + 1] = Math.max(0, Math.min(255, Math.round(v[i + 1] * k)))
    out.data[i + 2] = Math.max(0, Math.min(255, Math.round(v[i + 2] * k)))
    out.data[i + 3] = Math.max(0, Math.min(255, Math.round(a)))
  }
  return out
}

export function cropRaster(src: Raster, x: number, y: number, width: number, height: number): Raster {
  if (x < 0 || y < 0 || width < 1 || height < 1 || x + width > src.width || y + height > src.height) throw new PixelError('The crop area is outside the image.', 'invalid')
  const out = newRaster(width, height)
  for (let row = 0; row < height; row++) {
    const s = ((y + row) * src.width + x) * 4
    out.data.set(src.data.subarray(s, s + width * 4), row * width * 4)
  }
  return out
}

export type FitMode = 'contain' | 'cover' | 'stretch'

/** Produces exactly width x height. `contain` keeps the whole picture and pads with transparency; `cover` fills and crops the overflow. */
export function fitRaster(src: Raster, width: number, height: number, fit: FitMode = 'contain', filter: ResizeFilter = 'smooth'): Raster {
  assertDimensions(width, height)
  if (fit === 'stretch') return resizeRaster(src, width, height, filter)
  const ratio = fit === 'contain' ? Math.min(width / src.width, height / src.height) : Math.max(width / src.width, height / src.height)
  const w = Math.max(1, Math.round(src.width * ratio))
  const h = Math.max(1, Math.round(src.height * ratio))
  const scaled = resizeRaster(src, w, h, filter)
  const out = newRaster(width, height)
  if (fit === 'cover') {
    return cropRaster(scaled, Math.max(0, Math.floor((w - width) / 2)), Math.max(0, Math.floor((h - height) / 2)), width, height)
  }
  const ox = Math.floor((width - w) / 2)
  const oy = Math.floor((height - h) / 2)
  for (let y = 0; y < h; y++) out.data.set(scaled.data.subarray(y * w * 4, (y + 1) * w * 4), ((y + oy) * width + ox) * 4)
  return out
}

export interface TrimResult {
  raster: Raster
  box: { x: number; y: number; width: number; height: number }
}

/** Crops away fully (or almost) transparent borders. */
export function trimRaster(src: Raster, opts: { alphaThreshold?: number; padding?: number } = {}): TrimResult {
  const threshold = opts.alphaThreshold ?? 8
  const padding = Math.max(0, opts.padding ?? 0)
  let minX = src.width
  let minY = src.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (src.data[(y * src.width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) throw new PixelError('The image is fully transparent, so there is nothing to trim to.', 'empty')
  const x0 = Math.max(0, minX - padding)
  const y0 = Math.max(0, minY - padding)
  const x1 = Math.min(src.width - 1, maxX + padding)
  const y1 = Math.min(src.height - 1, maxY + padding)
  const box = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
  return { raster: cropRaster(src, box.x, box.y, box.width, box.height), box }
}

export interface BackgroundRemoval {
  raster: Raster
  background: [number, number, number]
  removedPixels: number
}

/**
 * Makes a flat background transparent. The background colour is read from the four corners (they must agree), then every pixel
 * connected to the border with a similar colour becomes transparent, with a soft edge so the outline is not jagged. This works for solid
 * backgrounds only; photographs, gradients and busy backgrounds are refused rather than guessed.
 */
export function removeBackground(src: Raster, opts: { tolerance?: number } = {}): BackgroundRemoval {
  const tol = Math.max(0, Math.min(120, opts.tolerance ?? 24))
  const { width: w, height: h, data } = src
  const px = (x: number, y: number): [number, number, number, number] => {
    const i = (y * w + x) * 4
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)]
  if (corners.some((c) => c[3] < 250)) throw new PixelError('The image already has a transparent border.', 'no_background')
  const dist = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
  const bg: [number, number, number] = [0, 1, 2].map((k) => {
    const v = corners.map((c) => c[k]).sort((a, b) => a - b)
    return Math.round((v[1] + v[2]) / 2)
  }) as [number, number, number]
  if (corners.some((c) => dist(c, bg) > Math.max(tol, 12) * 1.5)) throw new PixelError('The corners of the image are different colours, so there is no single flat background to remove.', 'no_background')

  const out = new Uint8Array(data)
  const removed = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (x: number, y: number): void => {
    const idx = y * w + x
    if (removed[idx]) return
    if (dist(px(x, y), bg) > tol) return
    removed[idx] = 1
    stack.push(idx)
  }
  for (let x = 0; x < w; x++) {
    push(x, 0)
    push(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    push(0, y)
    push(w - 1, y)
  }
  while (stack.length) {
    const idx = stack.pop()!
    const x = idx % w
    const y = (idx - x) / w
    if (x > 0) push(x - 1, y)
    if (x < w - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < h - 1) push(x, y + 1)
  }
  let count = 0
  for (let i = 0; i < removed.length; i++) {
    if (removed[i]) {
      out[i * 4 + 3] = 0
      count++
    }
  }
  if (count === 0) throw new PixelError('No pixels matched the background colour.', 'no_background')
  if (count === w * h) throw new PixelError('The whole image matches the background colour.', 'no_background')

  // Soften the rim: kept pixels touching the removed area that are still close to the background colour become partly transparent.
  const soft = tol * 3
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (removed[idx]) continue
      const touches = (x > 0 && removed[idx - 1]) || (x < w - 1 && removed[idx + 1]) || (y > 0 && removed[idx - w]) || (y < h - 1 && removed[idx + w])
      if (!touches) continue
      const d = dist(px(x, y), bg)
      if (d >= soft) continue
      const alpha = Math.max(0, Math.min(1, (d - tol) / (soft - tol)))
      const o = idx * 4
      out[o + 3] = Math.round(255 * alpha)
      if (alpha > 0.05) {
        for (let k = 0; k < 3; k++) out[o + k] = Math.max(0, Math.min(255, Math.round(bg[k] + (data[o + k] - bg[k]) / alpha)))
      }
    }
  }
  return { raster: { width: w, height: h, data: out }, background: bg, removedPixels: count }
}

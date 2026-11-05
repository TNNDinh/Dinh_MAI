import { PixelError, decodePng, isPng, type Raster } from './pixels'

/**
 * Reading images in any format the app might meet. PNG is decoded by the built-in decoder (pixels.ts). JPEG, WebP,
 * GIF and interlaced PNG need a real codec, which only the host has (Electron's image decoder); the host registers
 * it with `setForeignDecoder`. Without one (unit tests), those formats are reported as unsupported rather than guessed at.
 */
export type ForeignDecoder = (data: Buffer) => Raster | null

let foreign: ForeignDecoder | null = null

export function setForeignDecoder(fn: ForeignDecoder | null): void {
  foreign = fn
}

export function decodeImage(data: Buffer): Raster {
  if (isPng(data)) {
    try {
      return decodePng(data)
    } catch (e) {
      // Interlaced PNGs and unusual layouts go to the host decoder; real corruption does not.
      if (!(e instanceof PixelError) || e.code !== 'unsupported' || !foreign) throw e
    }
  }
  if (!foreign) throw new PixelError('This image format can only be read inside the running app; the built-in decoder handles PNG.', 'unsupported')
  const r = foreign(data)
  if (!r) throw new PixelError('The image could not be decoded.', 'invalid')
  return r
}

/**
 * Converts the host's 4-byte-per-pixel BGRA bitmap to straight RGBA. Hosts hand out premultiplied alpha, so colours are
 * divided by alpha again (otherwise soft edges come out too dark).
 */
export function bgraToRaster(bgra: Uint8Array, width: number, height: number, premultiplied = true): Raster {
  if (bgra.length < width * height * 4) throw new PixelError('The decoded bitmap is smaller than its size says.', 'invalid')
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    const a = bgra[i + 3]
    let r = bgra[i + 2]
    let g = bgra[i + 1]
    let b = bgra[i]
    if (premultiplied && a > 0 && a < 255) {
      const k = 255 / a
      r = Math.min(255, Math.round(r * k))
      g = Math.min(255, Math.round(g * k))
      b = Math.min(255, Math.round(b * k))
    }
    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = a
  }
  return { width, height, data }
}

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif'

export function imageFormat(buf: Uint8Array): ImageFormat | null {
  if (isPng(buf)) return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif'
  return null
}

export const FORMAT_EXT: Record<ImageFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' }
export const FORMAT_MIME: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/** Width and height read from the file header, without decoding any pixels. Null when the header is unreadable. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  const fmt = imageFormat(buf)
  try {
    if (fmt === 'png') return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null
    if (fmt === 'gif') return buf.length >= 10 ? { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) } : null
    if (fmt === 'jpeg') {
      let pos = 2
      while (pos + 9 < buf.length) {
        if (buf[pos] !== 0xff) {
          pos++
          continue
        }
        const marker = buf[pos + 1]
        if (marker === 0xff) {
          pos++
          continue
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          pos += 2
          continue
        }
        const len = buf.readUInt16BE(pos + 2)
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: buf.readUInt16BE(pos + 7), height: buf.readUInt16BE(pos + 5) }
        }
        pos += 2 + len
      }
      return null
    }
    if (fmt === 'webp' && buf.length >= 30) {
      const kind = buf.toString('latin1', 12, 16)
      if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
      if (kind === 'VP8L') {
        const bits = buf.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
  } catch {
    /* fall through */
  }
  return null
}

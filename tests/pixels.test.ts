import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PixelError, cropRaster, decodePng, encodePng, fitRaster, hasTransparency, isPng, newRaster, removeBackground, resizeRaster, trimRaster, type Raster } from '../src/main/assets/pixels'

function solid(w: number, h: number, rgba: [number, number, number, number]): Raster {
  const r = newRaster(w, h)
  for (let i = 0; i < r.data.length; i += 4) r.data.set(rgba, i)
  return r
}
function setPx(r: Raster, x: number, y: number, rgba: [number, number, number, number]): void {
  r.data.set(rgba, (y * r.width + x) * 4)
}
function getPx(r: Raster, x: number, y: number): number[] {
  const i = (y * r.width + x) * 4
  return Array.from(r.data.subarray(i, i + 4))
}
function rect(r: Raster, x0: number, y0: number, w: number, h: number, c: [number, number, number, number]): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(r, x, y, c)
}

/** Builds a PNG by hand (unfiltered rows) so the decoder is checked against something other than our own encoder. */
function handPng(width: number, height: number, depth: number, colorType: number, rows: number[][], extra: Array<[string, Buffer]> = [], interlace = 0): Buffer {
  const crc = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const byte of buf) {
      c ^= byte
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const out = Buffer.alloc(12 + body.length)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'latin1')
    body.copy(out, 8)
    out.writeUInt32BE(crc(out.subarray(4, 8 + body.length)), 8 + body.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = depth
  ihdr[9] = colorType
  ihdr[12] = interlace
  const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra.map(([t, b]) => chunk(t, b)),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

describe('PNG codec', () => {
  it('round-trips RGBA exactly, including semi-transparent pixels', () => {
    const img = newRaster(7, 5)
    for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) setPx(img, x, y, [x * 30, y * 50, (x * y) % 256, (x * 40 + y * 7) % 256])
    const png = encodePng(img)
    expect(isPng(png)).toBe(true)
    const back = decodePng(png)
    expect(back.width).toBe(7)
    expect(back.height).toBe(5)
    expect(Buffer.from(back.data).equals(Buffer.from(img.data))).toBe(true)
  })

  it('round-trips a larger noisy image (exercises every row filter)', () => {
    const img = newRaster(64, 48)
    let seed = 12345
    for (let i = 0; i < img.data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      img.data[i] = i % 4 === 3 ? 255 : (seed >> 8) & 0xff
    }
    expect(Buffer.from(decodePng(encodePng(img)).data).equals(Buffer.from(img.data))).toBe(true)
  })

  it('decodes 8-bit RGB', () => {
    const r = decodePng(handPng(2, 1, 8, 2, [[255, 0, 0, 0, 0, 255]]))
    expect(Array.from(r.data)).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  })

  it('decodes grey+alpha and plain grey', () => {
    expect(Array.from(decodePng(handPng(1, 1, 8, 4, [[100, 50]])).data)).toEqual([100, 100, 100, 50])
    expect(Array.from(decodePng(handPng(2, 1, 8, 0, [[10, 200]])).data)).toEqual([10, 10, 10, 255, 200, 200, 200, 255])
  })

  it('decodes a palette image with transparency', () => {
    const plte = Buffer.from([255, 0, 0, 0, 255, 0])
    const trns = Buffer.from([128])
    const r = decodePng(handPng(2, 1, 8, 3, [[0, 1]], [['PLTE', plte], ['tRNS', trns]]))
    expect(Array.from(r.data)).toEqual([255, 0, 0, 128, 0, 255, 0, 255])
  })

  it('decodes 1-bit grey and 16-bit RGBA', () => {
    // 8 pixels in one byte: 10101010 -> white,black,...
    const bits = decodePng(handPng(8, 1, 1, 0, [[0b10101010]]))
    expect(bits.data[0]).toBe(255)
    expect(bits.data[4]).toBe(0)
    const deep = decodePng(handPng(1, 1, 16, 6, [[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xff, 0xff]]))
    expect(Array.from(deep.data)).toEqual([0x12, 0x56, 0x9a, 255])
  })

  it('applies the Sub/Up/Average/Paeth filters when decoding', () => {
    // Build with our encoder (which picks filters per row) on a gradient and check the round trip.
    const img = newRaster(16, 16)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) setPx(img, x, y, [x * 16, y * 16, (x + y) * 8, 255])
    expect(Buffer.from(decodePng(encodePng(img)).data).equals(Buffer.from(img.data))).toBe(true)
  })

  it('rejects non-PNG, interlaced, truncated and corrupt input with clear errors', () => {
    expect(() => decodePng(Buffer.from('GIF89a....'))).toThrow(/Not a PNG/)
    expect(() => decodePng(handPng(1, 1, 8, 6, [[0, 0, 0, 0]], [], 1))).toThrow(/Interlaced/)
    const good = encodePng(solid(4, 4, [1, 2, 3, 255]))
    expect(() => decodePng(good.subarray(0, 40))).toThrow(PixelError)
    const bad = Buffer.from(good)
    bad[bad.length - 30] ^= 0xff
    // Either the data is rejected or the result differs; it must never crash with a raw zlib error.
    try {
      decodePng(bad)
    } catch (e) {
      expect(e).toBeInstanceOf(PixelError)
    }
  })

  it('refuses absurd dimensions before allocating', () => {
    expect(() => newRaster(100_000, 100_000)).toThrow(/limit/)
  })
})

describe('resize', () => {
  it('keeps a flat colour flat in both directions', () => {
    const img = solid(10, 10, [10, 200, 30, 255])
    for (const [w, h] of [[5, 5], [20, 20], [3, 17]] as const) {
      const out = resizeRaster(img, w, h)
      expect(out.width).toBe(w)
      expect(out.height).toBe(h)
      for (let i = 0; i < out.data.length; i += 4) expect(Array.from(out.data.subarray(i, i + 4))).toEqual([10, 200, 30, 255])
    }
  })

  it('averages when shrinking', () => {
    const img = newRaster(2, 1)
    setPx(img, 0, 0, [0, 0, 0, 255])
    setPx(img, 1, 0, [200, 100, 50, 255])
    expect(getPx(resizeRaster(img, 1, 1), 0, 0)).toEqual([100, 50, 25, 255])
  })

  it('does not bleed the colour of transparent pixels into the edge', () => {
    // Opaque red on the left, fully transparent (but green) on the right. The blend must stay red.
    const img = newRaster(2, 1)
    setPx(img, 0, 0, [255, 0, 0, 255])
    setPx(img, 1, 0, [0, 255, 0, 0])
    const out = resizeRaster(img, 1, 1)
    expect(out.data[0]).toBe(255)
    expect(out.data[1]).toBe(0)
    expect(out.data[3]).toBeGreaterThan(100)
    expect(out.data[3]).toBeLessThan(160)
  })

  it('nearest-neighbour keeps hard pixels when enlarging', () => {
    const img = newRaster(2, 1)
    setPx(img, 0, 0, [255, 0, 0, 255])
    setPx(img, 1, 0, [0, 0, 255, 255])
    const out = resizeRaster(img, 4, 2, 'nearest')
    expect(getPx(out, 0, 0)).toEqual([255, 0, 0, 255])
    expect(getPx(out, 1, 1)).toEqual([255, 0, 0, 255])
    expect(getPx(out, 2, 0)).toEqual([0, 0, 255, 255])
    expect(getPx(out, 3, 1)).toEqual([0, 0, 255, 255])
  })

  it('returns a copy, not the same buffer, when the size is unchanged', () => {
    const img = solid(3, 3, [1, 2, 3, 4])
    const out = resizeRaster(img, 3, 3)
    expect(out.data).not.toBe(img.data)
    out.data[0] = 99
    expect(img.data[0]).toBe(1)
  })
})

describe('fit', () => {
  it('contain pads with transparency and centres the picture', () => {
    const out = fitRaster(solid(4, 2, [255, 0, 0, 255]), 8, 8, 'contain')
    expect(out.width).toBe(8)
    expect(out.height).toBe(8)
    expect(getPx(out, 4, 4)[3]).toBe(255)
    expect(getPx(out, 4, 0)[3]).toBe(0)
    expect(getPx(out, 4, 7)[3]).toBe(0)
  })

  it('cover fills the whole area', () => {
    const out = fitRaster(solid(4, 2, [0, 255, 0, 255]), 6, 6, 'cover')
    expect(out.width).toBe(6)
    expect(hasTransparency(out)).toBe(false)
  })

  it('stretch ignores the aspect ratio', () => {
    const out = fitRaster(solid(4, 2, [0, 0, 255, 255]), 3, 9, 'stretch')
    expect([out.width, out.height]).toEqual([3, 9])
  })
})

describe('crop and trim', () => {
  it('crops an exact area and rejects one outside the image', () => {
    const img = newRaster(4, 4)
    setPx(img, 2, 1, [9, 9, 9, 255])
    const c = cropRaster(img, 2, 1, 2, 2)
    expect(getPx(c, 0, 0)).toEqual([9, 9, 9, 255])
    expect(() => cropRaster(img, 3, 3, 3, 3)).toThrow(/outside/)
  })

  it('trims transparent borders and reports the box', () => {
    const img = newRaster(10, 10)
    rect(img, 3, 2, 4, 5, [255, 255, 255, 255])
    const t = trimRaster(img)
    expect(t.box).toEqual({ x: 3, y: 2, width: 4, height: 5 })
    expect(t.raster.width).toBe(4)
    expect(t.raster.height).toBe(5)
  })

  it('supports padding, clamped to the image', () => {
    const img = newRaster(10, 10)
    rect(img, 1, 1, 2, 2, [1, 1, 1, 255])
    const t = trimRaster(img, { padding: 3 })
    expect(t.box).toEqual({ x: 0, y: 0, width: 6, height: 6 })
  })

  it('refuses to trim a fully transparent image', () => {
    expect(() => trimRaster(newRaster(4, 4))).toThrow(/fully transparent/)
  })
})

describe('background removal', () => {
  const white: [number, number, number, number] = [250, 250, 250, 255]

  it('removes a flat background connected to the border and keeps the subject', () => {
    const img = solid(20, 20, white)
    rect(img, 6, 6, 8, 8, [200, 30, 30, 255])
    const r = removeBackground(img)
    expect(r.background).toEqual([250, 250, 250])
    expect(getPx(r.raster, 0, 0)[3]).toBe(0)
    expect(getPx(r.raster, 19, 19)[3]).toBe(0)
    expect(getPx(r.raster, 10, 10)).toEqual([200, 30, 30, 255])
    expect(r.removedPixels).toBe(400 - 64)
  })

  it('keeps background-coloured pixels that are enclosed by the subject', () => {
    const img = solid(20, 20, white)
    rect(img, 4, 4, 12, 12, [20, 20, 200, 255])
    rect(img, 9, 9, 2, 2, white) // a hole inside the subject
    const r = removeBackground(img)
    expect(getPx(r.raster, 9, 9)[3]).toBe(255)
    expect(getPx(r.raster, 1, 1)[3]).toBe(0)
  })

  it('tolerates slight noise in the background', () => {
    const img = solid(16, 16, white)
    setPx(img, 3, 3, [245, 248, 252, 255])
    rect(img, 6, 6, 4, 4, [0, 0, 0, 255])
    const r = removeBackground(img)
    expect(getPx(r.raster, 3, 3)[3]).toBe(0)
  })

  it('refuses images whose corners disagree (not a flat background)', () => {
    const img = solid(10, 10, white)
    setPx(img, 0, 0, [0, 0, 0, 255])
    setPx(img, 9, 9, [0, 0, 0, 255])
    expect(() => removeBackground(img)).toThrow(/different colours/)
  })

  it('refuses images that already have a transparent border and ones that are one colour', () => {
    expect(() => removeBackground(newRaster(6, 6))).toThrow(/already has a transparent/)
    expect(() => removeBackground(solid(6, 6, white))).toThrow(/whole image/)
  })

  it('softens the rim for pixels between subject and background', () => {
    const img = solid(20, 20, white)
    rect(img, 6, 6, 8, 8, [0, 0, 0, 255])
    // An anti-aliased ring pixel that is close to, but not within tolerance of, the background colour.
    setPx(img, 5, 10, [200, 200, 200, 255])
    const r = removeBackground(img, { tolerance: 24 })
    const a = getPx(r.raster, 5, 10)[3]
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(255)
  })
})

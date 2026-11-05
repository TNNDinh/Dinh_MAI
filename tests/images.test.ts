import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createImageProvider } from '../src/main/providers'
import { aspectRatioFor, nearestSize, openaiImageFamily, sniffMime } from '../src/main/providers/images'
import { ProviderError } from '../src/main/providers/http'
import { encodePng, newRaster } from '../src/main/assets/pixels'
import { MockServer, json } from './helpers/mock-server'

const server = new MockServer()
beforeAll(() => server.start())
afterAll(() => server.stop())
beforeEach(() => server.reset())

// Real PNG bytes, built by our own encoder, so the provider's MIME sniffing runs on actual image data.
const png = (r = 10, g = 20, b = 30): Buffer => {
  const img = newRaster(2, 2)
  for (let i = 0; i < img.data.length; i += 4) img.data.set([r, g, b, 255], i)
  return encodePng(img)
}
const b64 = (buf: Buffer): string => buf.toString('base64')

const openai = (over: Record<string, unknown> = {}) => createImageProvider({ id: 'c1', kind: 'openai', baseUrl: server.url, apiKey: 'sk-test', maxRetries: 0, ...over })
const gemini = () => createImageProvider({ id: 'g1', kind: 'gemini', baseUrl: server.url, apiKey: 'g-test', maxRetries: 0 })

describe('helpers', () => {
  it('sniffs the real image type from bytes', () => {
    expect(sniffMime(png())).toBe('image/png')
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))).toBe('image/jpeg')
    expect(sniffMime(Buffer.from('<html>'))).toBe('application/octet-stream')
  })

  it('classifies OpenAI image models', () => {
    expect(openaiImageFamily('gpt-image-1')).toBe('gpt-image')
    expect(openaiImageFamily('dall-e-3')).toBe('dall-e-3')
    expect(openaiImageFamily('dall-e-2')).toBe('dall-e-2')
    expect(openaiImageFamily('my-local-sd')).toBe('generic')
  })

  it('picks the nearest allowed size by aspect ratio', () => {
    const sizes = ['1024x1024', '1536x1024', '1024x1536']
    expect(nearestSize('512x512', sizes)).toBe('1024x1024')
    expect(nearestSize('1920x1080', sizes)).toBe('1536x1024')
    expect(nearestSize('600x1000', sizes)).toBe('1024x1536')
    expect(nearestSize(undefined, sizes)).toBe('1024x1024')
  })

  it('maps sizes to the aspect ratios Gemini accepts', () => {
    expect(aspectRatioFor('1024x1024')).toBe('1:1')
    expect(aspectRatioFor('1920x1080')).toBe('16:9')
    expect(aspectRatioFor('768x1024')).toBe('3:4')
    expect(aspectRatioFor('nonsense')).toBeUndefined()
  })
})

describe('createImageProvider', () => {
  it('refuses providers without an image API, with a clear message', () => {
    for (const kind of ['anthropic', 'openrouter', 'deepseek', 'groq', 'ollama'] as const) {
      expect(() => createImageProvider({ id: 'x', kind, baseUrl: 'http://x', apiKey: 'k' })).toThrow(/no image generation API/)
    }
  })

  it('requires an API key where the provider needs one', () => {
    expect(() => createImageProvider({ id: 'x', kind: 'openai', baseUrl: server.url })).toThrow(/requires an API key/)
  })
})

describe('OpenAI image provider', () => {
  it('gpt-image: asks for PNG, sends the key, and decodes base64', async () => {
    server.handler = (_r, res) => json(res, 200, { data: [{ b64_json: b64(png()) }] })
    const out = await openai().generate({ model: 'gpt-image-1', prompt: 'a red sword', size: '1920x1080', transparent: true })
    expect(out.images).toHaveLength(1)
    expect(out.images[0].mimeType).toBe('image/png')
    expect(Buffer.from(out.images[0].dataBase64, 'base64').equals(png())).toBe(true)
    const rec = server.requests[0]
    expect(rec.url).toBe('/images/generations')
    expect(rec.headers.authorization).toBe('Bearer sk-test')
    expect(rec.body).toMatchObject({ model: 'gpt-image-1', prompt: 'a red sword', n: 1, size: '1536x1024', output_format: 'png', background: 'transparent' })
    expect(rec.body.response_format).toBeUndefined()
  })

  it('dall-e-3: one image per request, so n=3 makes three calls, and asks for base64', async () => {
    server.handler = (_r, res, n) => json(res, 200, { data: [{ b64_json: b64(png(n, 0, 0)), revised_prompt: `v${n}` }] })
    const out = await openai().generate({ model: 'dall-e-3', prompt: 'x', count: 3, size: '1024x1792' })
    expect(server.requests).toHaveLength(3)
    expect(out.images.map((i) => i.revisedPrompt)).toEqual(['v1', 'v2', 'v3'])
    expect(server.requests[0].body).toMatchObject({ n: 1, size: '1024x1792', response_format: 'b64_json' })
    expect(server.requests[0].body.background).toBeUndefined()
  })

  it('dall-e-3 refuses edits instead of silently ignoring the reference image', async () => {
    await expect(openai().generate({ model: 'dall-e-3', prompt: 'x', referenceImage: { mimeType: 'image/png', dataBase64: b64(png()) } })).rejects.toMatchObject({ kind: 'unsupported' })
    expect(server.requests).toHaveLength(0)
  })

  it('uses multipart /images/edits when a reference image is given', async () => {
    server.handler = (_r, res) => json(res, 200, { data: [{ b64_json: b64(png()) }] })
    await openai().generate({ model: 'gpt-image-1', prompt: 'make it blue', referenceImage: { mimeType: 'image/png', dataBase64: b64(png()) } })
    const rec = server.requests[0]
    expect(rec.url).toBe('/images/edits')
    expect(String(rec.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/)
    expect(typeof rec.body).toBe('string')
    expect(rec.body).toContain('name="prompt"')
    expect(rec.body).toContain('make it blue')
    expect(rec.body).toContain('name="image"; filename="reference.png"')
  })

  it('downloads an image URL when the server returns one, without sending the API key to it', async () => {
    const img = png(1, 2, 3)
    server.handler = (r, res) => {
      if (r.url === '/images/generations') return json(res, 200, { data: [{ url: `${server.url}/files/a.png` }] })
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(img)
    }
    const out = await openai({ kind: 'custom' }).generate({ model: 'local-sd', prompt: 'x' })
    expect(Buffer.from(out.images[0].dataBase64, 'base64').equals(img)).toBe(true)
    const download = server.requests.find((r) => r.url === '/files/a.png')!
    expect(download.headers.authorization).toBeUndefined()
    // generic models: no response_format / output_format forced on unknown servers
    expect(server.requests[0].body.response_format).toBeUndefined()
    expect(server.requests[0].body.output_format).toBeUndefined()
  })

  it('rejects responses that are not images', async () => {
    server.handler = (_r, res) => json(res, 200, { data: [{ b64_json: Buffer.from('<html>nope</html>').toString('base64') }] })
    await expect(openai().generate({ model: 'gpt-image-1', prompt: 'x' })).rejects.toThrow(/not an image/)
  })

  it('rejects an empty data list and non-http URLs', async () => {
    server.handler = (_r, res) => json(res, 200, { data: [] })
    await expect(openai().generate({ model: 'gpt-image-1', prompt: 'x' })).rejects.toThrow(/no images/)
    server.handler = (_r, res) => json(res, 200, { data: [{ url: 'file:///etc/passwd' }] })
    await expect(openai().generate({ model: 'gpt-image-1', prompt: 'x' })).rejects.toThrow(/not http/)
  })

  it('surfaces API errors with their kind', async () => {
    server.handler = (_r, res) => json(res, 400, { error: { message: 'Your request was rejected by the safety system.' } })
    const err = await openai().generate({ model: 'gpt-image-1', prompt: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.kind).toBe('bad_request')
    expect(err.message).toMatch(/safety system/)
    server.handler = (_r, res) => json(res, 401, { error: { message: 'bad key' } })
    await expect(openai().generate({ model: 'gpt-image-1', prompt: 'x' })).rejects.toMatchObject({ kind: 'auth' })
  })

  it('validates the request before spending a call', async () => {
    await expect(openai().generate({ model: 'gpt-image-1', prompt: '   ' })).rejects.toThrow(/prompt is required/)
    await expect(openai().generate({ model: 'gpt-image-1', prompt: 'x', count: 99 })).rejects.toThrow(/between 1 and/)
    await expect(openai().generate({ model: '', prompt: 'x' })).rejects.toThrow(/Choose an image model/)
    expect(server.requests).toHaveLength(0)
  })

  it('stops when cancelled', async () => {
    const ctl = new AbortController()
    server.handler = async (_r, res) => {
      await new Promise((r) => setTimeout(r, 300))
      json(res, 200, { data: [{ b64_json: b64(png()) }] })
    }
    const p = openai().generate({ model: 'gpt-image-1', prompt: 'x', signal: ctl.signal })
    setTimeout(() => ctl.abort(), 30)
    await expect(p).rejects.toMatchObject({ kind: 'cancelled' })
  })
})

describe('Gemini image provider', () => {
  it('Imagen: calls :predict with sampleCount and aspect ratio', async () => {
    server.handler = (_r, res) => json(res, 200, { predictions: [{ bytesBase64Encoded: b64(png()), mimeType: 'image/png' }, { bytesBase64Encoded: b64(png(9, 9, 9)), mimeType: 'image/png' }] })
    const out = await gemini().generate({ model: 'imagen-4.0-generate-001', prompt: 'a castle', count: 2, size: '1920x1080' })
    expect(out.images).toHaveLength(2)
    const rec = server.requests[0]
    expect(rec.url).toBe('/models/imagen-4.0-generate-001:predict')
    expect(rec.headers['x-goog-api-key']).toBe('g-test')
    expect(rec.body).toEqual({ instances: [{ prompt: 'a castle' }], parameters: { sampleCount: 2, aspectRatio: '16:9' } })
  })

  it('Imagen: an empty prediction list is reported as filtered, not as success', async () => {
    server.handler = (_r, res) => json(res, 200, {})
    await expect(gemini().generate({ model: 'imagen-3.0-generate-002', prompt: 'x' })).rejects.toThrow(/filtered/)
  })

  it('Imagen: refuses reference images and more than 4 samples', async () => {
    await expect(gemini().generate({ model: 'imagen-4.0-generate-001', prompt: 'x', referenceImage: { mimeType: 'image/png', dataBase64: b64(png()) } })).rejects.toMatchObject({ kind: 'unsupported' })
    await expect(gemini().generate({ model: 'imagen-4.0-generate-001', prompt: 'x', count: 5 })).rejects.toThrow(/at most 4/)
    expect(server.requests).toHaveLength(0)
  })

  it('native Gemini image model: generateContent with IMAGE modality, one call per image', async () => {
    server.handler = (_r, res, n) => json(res, 200, { candidates: [{ content: { parts: [{ text: 'here you go' }, { inlineData: { mimeType: 'image/png', data: b64(png(n, 0, 0)) } }] }, finishReason: 'STOP' }] })
    const out = await gemini().generate({ model: 'gemini-2.5-flash-image', prompt: 'a tree', count: 2, size: '1024x1792' })
    expect(out.images).toHaveLength(2)
    expect(server.requests).toHaveLength(2)
    const rec = server.requests[0]
    expect(rec.url).toBe('/models/gemini-2.5-flash-image:generateContent')
    expect(rec.body.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '9:16' } })
    expect(rec.body.contents[0].parts).toEqual([{ text: 'a tree' }])
  })

  it('native Gemini: sends the reference image as inline data', async () => {
    server.handler = (_r, res) => json(res, 200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: b64(png()) } }] } }] })
    await gemini().generate({ model: 'gemini-2.5-flash-image', prompt: 'recolour', referenceImage: { mimeType: 'image/png', dataBase64: b64(png(5, 5, 5)) } })
    const parts = server.requests[0].body.contents[0].parts
    expect(parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: b64(png(5, 5, 5)) } })
    expect(server.requests[0].body.generationConfig.imageConfig).toBeUndefined()
  })

  it('native Gemini: explains a text-only answer and a blocked prompt', async () => {
    server.handler = (_r, res) => json(res, 200, { candidates: [{ content: { parts: [{ text: 'I cannot draw that.' }] }, finishReason: 'IMAGE_SAFETY' }] })
    await expect(gemini().generate({ model: 'gemini-2.5-flash-image', prompt: 'x' })).rejects.toThrow(/IMAGE_SAFETY.*I cannot draw that/)
    server.handler = (_r, res) => json(res, 200, { promptFeedback: { blockReason: 'SAFETY' } })
    await expect(gemini().generate({ model: 'gemini-2.5-flash-image', prompt: 'x' })).rejects.toThrow(/blocked by Gemini: SAFETY/)
  })
})

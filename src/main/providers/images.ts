import { fetchWithRetry, ProviderError, readBytes, readJson, type HttpInit } from './http'
import type { ConnectionConfig, GeneratedImage, ImageProvider, ImageRequest } from './types'

/**
 * Image generation adapters. Strictly separate from the chat adapters: a different endpoint, different
 * parameters, and results are binary files rather than text. Only providers whose image API is implemented
 * here are supported (see `supportsImages`); there is no fallback that fabricates pictures.
 */

/** Hard cap on one decoded image, whether it arrived as base64 or was downloaded. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
/** Most images one request may ask for. */
export const MAX_IMAGES_PER_REQUEST = 8

export function sniffMime(buf: Uint8Array): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif'
  return 'application/octet-stream'
}

export function parseSize(size: string | undefined): { width: number; height: number } | null {
  const m = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(size?.trim() ?? '')
  if (!m) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

/** The allowed size whose aspect ratio is closest to the requested one (ties go to the larger area). */
export function nearestSize(requested: string | undefined, allowed: string[]): string {
  const want = parseSize(requested)
  if (!want) return allowed[0]
  const ratio = want.width / want.height
  let best = allowed[0]
  let bestScore = Infinity
  for (const a of allowed) {
    const p = parseSize(a)
    if (!p) continue
    const score = Math.abs(Math.log(p.width / p.height / ratio)) + Math.abs(Math.log(p.width / want.width)) * 0.001
    if (score < bestScore) {
      bestScore = score
      best = a
    }
  }
  return best
}

export type OpenAIImageFamily = 'gpt-image' | 'dall-e-3' | 'dall-e-2' | 'generic'

export function openaiImageFamily(model: string): OpenAIImageFamily {
  const m = model.toLowerCase()
  if (/gpt-image|chatgpt-image/.test(m)) return 'gpt-image'
  if (/dall-e-3/.test(m)) return 'dall-e-3'
  if (/dall-e-2|^dall-e$/.test(m)) return 'dall-e-2'
  return 'generic'
}

const OPENAI_SIZES: Record<Exclude<OpenAIImageFamily, 'generic'>, string[]> = {
  'gpt-image': ['1024x1024', '1536x1024', '1024x1536'],
  'dall-e-3': ['1024x1024', '1792x1024', '1024x1792'],
  'dall-e-2': ['1024x1024', '512x512', '256x256']
}

/** Sizes a model accepts, or null when unknown (custom servers decide for themselves). */
export function allowedSizes(provider: 'openai' | 'gemini' | 'other', model: string): string[] | null {
  if (provider !== 'openai') return null
  const fam = openaiImageFamily(model)
  return fam === 'generic' ? null : OPENAI_SIZES[fam]
}

/** True when the model itself can produce a transparent background (gpt-image models); otherwise the app has to remove a flat background. */
export function nativeTransparency(providerKind: ConnectionConfig['kind'], model: string): boolean {
  return providerKind !== 'gemini' && openaiImageFamily(model) === 'gpt-image'
}

/** What an image model can do, so the UI and agents do not offer options that would only fail. */
export function imageCapabilities(providerKind: ConnectionConfig['kind'], model: string): { supportsEdit: boolean; sizes: string[] | null } {
  if (providerKind === 'gemini') return { supportsEdit: !isImagenModel(model), sizes: null }
  const fam = openaiImageFamily(model)
  return { supportsEdit: fam !== 'dall-e-3', sizes: fam === 'generic' ? null : OPENAI_SIZES[fam] }
}

function bytesFromBase64(b64: string, provider: ConnectionConfig['kind']): Buffer {
  const buf = Buffer.from(b64, 'base64')
  if (buf.length === 0) throw new ProviderError('The provider returned an empty image.', 'unknown', { provider })
  if (buf.length > MAX_IMAGE_BYTES) throw new ProviderError('The provider returned an image over the size limit.', 'bad_request', { provider })
  return buf
}

abstract class BaseImageProvider implements ImageProvider {
  abstract readonly kind: ConnectionConfig['kind']
  constructor(protected readonly config: ConnectionConfig) {}

  get connectionId(): string {
    return this.config.id
  }

  protected get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '')
  }

  protected abstract authHeaders(): Record<string, string>

  protected request(url: string, init: HttpInit): Promise<Response> {
    return fetchWithRetry(url, {
      // Image generation is slow; a failed attempt may still have been billed, so retry less eagerly than chat.
      timeoutMs: this.config.timeoutMs ?? 300_000,
      maxRetries: this.config.maxRetries ?? 1,
      fetchImpl: this.config.fetchImpl,
      provider: this.kind,
      ...init,
      headers: { ...this.config.headers, ...this.authHeaders(), ...init.headers }
    })
  }

  abstract generate(req: ImageRequest): Promise<{ images: GeneratedImage[]; latencyMs: number; costUsd?: number }>

  protected check(req: ImageRequest): number {
    if (!req.prompt.trim()) throw new ProviderError('An image prompt is required.', 'bad_request', { provider: this.kind })
    if (!req.model.trim()) throw new ProviderError('Choose an image model.', 'bad_request', { provider: this.kind })
    const n = Math.floor(req.count ?? 1)
    if (!(n >= 1 && n <= MAX_IMAGES_PER_REQUEST)) throw new ProviderError(`Ask for between 1 and ${MAX_IMAGES_PER_REQUEST} images.`, 'bad_request', { provider: this.kind })
    return n
  }
}

// ------------------------------------------------------------------ OpenAI and compatible servers

export class OpenAIImageProvider extends BaseImageProvider {
  readonly kind: ConnectionConfig['kind']

  constructor(config: ConnectionConfig, kind: ConnectionConfig['kind'] = 'openai') {
    super(config)
    this.kind = kind
  }

  protected authHeaders(): Record<string, string> {
    return this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}
  }

  async generate(req: ImageRequest): Promise<{ images: GeneratedImage[]; latencyMs: number }> {
    const n = this.check(req)
    const started = Date.now()
    const family = openaiImageFamily(req.model)
    const sizes = family === 'generic' ? null : OPENAI_SIZES[family]
    const size = req.size ? (sizes ? nearestSize(req.size, sizes) : req.size) : undefined

    if (req.referenceImage && family === 'dall-e-3') {
      throw new ProviderError('DALL·E 3 cannot edit or vary an existing image. Choose gpt-image-1 or dall-e-2 for that.', 'unsupported', { provider: this.kind })
    }
    // dall-e-3 returns one image per request.
    const perRequest = family === 'dall-e-3' ? 1 : n
    const calls = Math.ceil(n / perRequest)
    const images: GeneratedImage[] = []

    for (let call = 0; call < calls; call++) {
      const want = Math.min(perRequest, n - images.length)
      const res = req.referenceImage ? await this.edit(req, family, want, size) : await this.create(req, family, want, size)
      const json = await readJson(res, this.kind)
      const items: any[] = Array.isArray(json?.data) ? json.data : []
      if (items.length === 0) throw new ProviderError('The provider returned no images.', 'unknown', { provider: this.kind })
      for (const item of items) {
        let buf: Buffer
        if (typeof item?.b64_json === 'string' && item.b64_json) buf = bytesFromBase64(item.b64_json, this.kind)
        else if (typeof item?.url === 'string' && item.url) buf = await this.download(item.url, req.signal)
        else throw new ProviderError('The provider returned an image in a format this app does not understand.', 'unknown', { provider: this.kind })
        const mime = sniffMime(buf)
        if (!mime.startsWith('image/')) throw new ProviderError('The provider returned data that is not an image.', 'unknown', { provider: this.kind })
        images.push({ mimeType: mime, dataBase64: buf.toString('base64'), ...(typeof item.revised_prompt === 'string' ? { revisedPrompt: item.revised_prompt } : {}) })
      }
    }
    return { images: images.slice(0, n), latencyMs: Date.now() - started }
  }

  private create(req: ImageRequest, family: OpenAIImageFamily, n: number, size: string | undefined): Promise<Response> {
    const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, n }
    if (size) body.size = size
    if (family === 'gpt-image') {
      body.output_format = 'png'
      if (req.transparent) body.background = 'transparent'
    } else if (family === 'dall-e-3' || family === 'dall-e-2') {
      body.response_format = 'b64_json'
    }
    return this.request(`${this.baseUrl}/images/generations`, { method: 'POST', body, signal: req.signal })
  }

  private edit(req: ImageRequest, family: OpenAIImageFamily, n: number, size: string | undefined): Promise<Response> {
    const ref = req.referenceImage!
    const form = new FormData()
    form.append('model', req.model)
    form.append('prompt', req.prompt)
    form.append('n', String(n))
    if (size) form.append('size', size)
    if (family === 'gpt-image') {
      form.append('output_format', 'png')
      if (req.transparent) form.append('background', 'transparent')
    } else if (family === 'dall-e-2') {
      form.append('response_format', 'b64_json')
    }
    const bytes = Buffer.from(ref.dataBase64, 'base64')
    const ext = ref.mimeType === 'image/jpeg' ? 'jpg' : ref.mimeType === 'image/webp' ? 'webp' : 'png'
    form.append('image', new Blob([new Uint8Array(bytes)], { type: ref.mimeType }), `reference.${ext}`)
    return this.request(`${this.baseUrl}/images/edits`, { method: 'POST', body: form, signal: req.signal })
  }

  /** Some servers answer with a URL instead of data. No credentials are sent to it: it is not the API host. */
  private async download(url: string, signal?: AbortSignal): Promise<Buffer> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new ProviderError('The provider returned an invalid image URL.', 'unknown', { provider: this.kind })
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ProviderError('The provider returned an image URL that is not http(s).', 'unknown', { provider: this.kind })
    const res = await fetchWithRetry(parsed.toString(), { method: 'GET', timeoutMs: 120_000, maxRetries: 1, fetchImpl: this.config.fetchImpl, provider: this.kind, signal })
    return readBytes(res, MAX_IMAGE_BYTES, this.kind)
  }
}

// ------------------------------------------------------------------ Google Gemini / Imagen

export function isImagenModel(model: string): boolean {
  return /(^|\/)imagen/i.test(model)
}

const ASPECTS: Array<[string, number]> = [
  ['1:1', 1],
  ['3:4', 3 / 4],
  ['4:3', 4 / 3],
  ['9:16', 9 / 16],
  ['16:9', 16 / 9]
]

export function aspectRatioFor(size: string | undefined): string | undefined {
  const p = parseSize(size)
  if (!p) return undefined
  const r = p.width / p.height
  let best = ASPECTS[0]
  for (const a of ASPECTS) if (Math.abs(Math.log(a[1] / r)) < Math.abs(Math.log(best[1] / r))) best = a
  return best[0]
}

export class GeminiImageProvider extends BaseImageProvider {
  readonly kind = 'gemini' as const

  protected authHeaders(): Record<string, string> {
    return { 'x-goog-api-key': this.config.apiKey ?? '' }
  }

  async generate(req: ImageRequest): Promise<{ images: GeneratedImage[]; latencyMs: number }> {
    const n = this.check(req)
    const started = Date.now()
    const model = req.model.replace(/^models\//, '')
    const aspect = aspectRatioFor(req.size)
    const images = isImagenModel(model) ? await this.imagen(model, req, n, aspect) : await this.native(model, req, n, aspect)
    return { images, latencyMs: Date.now() - started }
  }

  private async imagen(model: string, req: ImageRequest, n: number, aspect: string | undefined): Promise<GeneratedImage[]> {
    if (req.referenceImage) throw new ProviderError('Imagen models cannot edit or vary an existing image. Choose a Gemini image model for that.', 'unsupported', { provider: 'gemini' })
    if (n > 4) throw new ProviderError('Imagen returns at most 4 images per request.', 'bad_request', { provider: 'gemini' })
    const body = { instances: [{ prompt: req.prompt }], parameters: { sampleCount: n, ...(aspect ? { aspectRatio: aspect } : {}) } }
    const res = await this.request(`${this.baseUrl}/models/${encodeURIComponent(model)}:predict`, { method: 'POST', body, signal: req.signal })
    const json = await readJson(res, 'gemini')
    const preds: any[] = Array.isArray(json?.predictions) ? json.predictions : []
    const images: GeneratedImage[] = []
    for (const p of preds) {
      if (typeof p?.bytesBase64Encoded !== 'string') continue
      const buf = bytesFromBase64(p.bytesBase64Encoded, 'gemini')
      images.push({ mimeType: typeof p.mimeType === 'string' && p.mimeType.startsWith('image/') ? p.mimeType : sniffMime(buf), dataBase64: buf.toString('base64') })
    }
    if (images.length === 0) {
      // Imagen answers 200 with an empty list when every candidate was filtered.
      throw new ProviderError('Imagen returned no images. The prompt may have been filtered by its safety policy.', 'bad_request', { provider: 'gemini' })
    }
    return images
  }

  private async native(model: string, req: ImageRequest, n: number, aspect: string | undefined): Promise<GeneratedImage[]> {
    const images: GeneratedImage[] = []
    for (let i = 0; i < n; i++) {
      const parts: unknown[] = [{ text: req.prompt }]
      if (req.referenceImage) parts.push({ inlineData: { mimeType: req.referenceImage.mimeType, data: req.referenceImage.dataBase64 } })
      const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] }
      if (aspect && aspect !== '1:1') generationConfig.imageConfig = { aspectRatio: aspect }
      const res = await this.request(`${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        body: { contents: [{ role: 'user', parts }], generationConfig },
        signal: req.signal
      })
      const json = await readJson(res, 'gemini')
      const blocked = json?.promptFeedback?.blockReason
      if (blocked) throw new ProviderError(`Prompt blocked by Gemini: ${blocked}`, 'bad_request', { provider: 'gemini' })
      const cand = json?.candidates?.[0]
      const outParts: any[] = cand?.content?.parts ?? []
      let got = false
      for (const part of outParts) {
        const inline = part?.inlineData ?? part?.inline_data
        const data = inline?.data
        if (typeof data !== 'string' || !data) continue
        const buf = bytesFromBase64(data, 'gemini')
        const mime = sniffMime(buf)
        images.push({ mimeType: mime.startsWith('image/') ? mime : String(inline.mimeType ?? inline.mime_type ?? 'image/png'), dataBase64: buf.toString('base64') })
        got = true
        break
      }
      if (!got) {
        const said = outParts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ').trim()
        const why = cand?.finishReason && cand.finishReason !== 'STOP' ? ` (${cand.finishReason})` : ''
        throw new ProviderError(`Gemini returned no image${why}${said ? `: ${said.slice(0, 300)}` : '.'}`, 'bad_request', { provider: 'gemini' })
      }
    }
    return images
  }
}

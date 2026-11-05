import type { ProviderKind } from './types'

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'bad_request'
  | 'not_found'
  | 'server'
  | 'cancelled'
  | 'unsupported'
  | 'unknown'

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind
  readonly status?: number
  readonly retryable: boolean
  readonly retryAfterMs?: number
  readonly provider?: ProviderKind

  constructor(
    message: string,
    kind: ProviderErrorKind,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number; provider?: ProviderKind } = {}
  ) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = opts.status
    this.retryable = opts.retryable ?? false
    this.retryAfterMs = opts.retryAfterMs
    this.provider = opts.provider
  }
}

export function classifyStatus(status: number): { kind: ProviderErrorKind; retryable: boolean } {
  if (status === 401 || status === 403) return { kind: 'auth', retryable: false }
  if (status === 404) return { kind: 'not_found', retryable: false }
  if (status === 408) return { kind: 'timeout', retryable: true }
  if (status === 429) return { kind: 'rate_limit', retryable: true }
  if (status >= 500) return { kind: 'server', retryable: true } // includes Anthropic 529 "overloaded"
  if (status >= 400) return { kind: 'bad_request', retryable: false }
  return { kind: 'unknown', retryable: false }
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - now)
  return undefined
}

/** Pull a human-readable message out of the many error body shapes providers use. */
export function extractErrorMessage(body: string): string {
  const trimmed = body.trim()
  if (!trimmed) return ''
  try {
    const json = JSON.parse(trimmed)
    const candidate =
      json?.error?.message ?? json?.error?.error?.message ?? json?.message ?? json?.error ?? json?.detail
    if (typeof candidate === 'string') return candidate.slice(0, 500)
    if (candidate) return JSON.stringify(candidate).slice(0, 500)
  } catch {
    /* not JSON */
  }
  return trimmed.slice(0, 500)
}

async function errorFromResponse(res: Response, provider?: ProviderKind): Promise<ProviderError> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    /* ignore */
  }
  const { kind, retryable } = classifyStatus(res.status)
  const detail = extractErrorMessage(body)
  return new ProviderError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, kind, {
    status: res.status,
    retryable,
    retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    provider
  })
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('Request cancelled', 'cancelled'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ProviderError('Request cancelled', 'cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface HttpInit {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Serialised as JSON, except FormData which is sent as multipart (the runtime sets the boundary header). */
  body?: unknown
  /** Time allowed to receive response headers (per attempt). */
  timeoutMs?: number
  maxRetries?: number
  retryBaseMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  provider?: ProviderKind
}

/**
 * fetch with per-attempt timeout, user cancellation, and exponential backoff
 * on retryable failures (429 / 5xx / network). Honours Retry-After.
 * Returns the first successful (2xx) Response; throws ProviderError otherwise.
 */
export async function fetchWithRetry(url: string, init: HttpInit = {}): Promise<Response> {
  const {
    method = 'GET',
    maxRetries = 3,
    timeoutMs = 120_000,
    retryBaseMs = 500,
    signal,
    fetchImpl = fetch,
    provider
  } = init

  const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new ProviderError('Request cancelled', 'cancelled', { provider })

    const ctl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctl.abort()
    }, timeoutMs)
    const onAbort = () => ctl.abort()
    signal?.addEventListener('abort', onAbort, { once: true })

    let err: ProviderError
    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          ...(init.body !== undefined && !isForm ? { 'content-type': 'application/json' } : {}),
          ...init.headers
        },
        body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
        signal: ctl.signal
      })
      clearTimeout(timer)
      // On success keep the abort listener: it lets the caller cancel the body stream.
      if (res.ok) return res
      err = await errorFromResponse(res, provider)
    } catch (e) {
      clearTimeout(timer)
      if (signal?.aborted) {
        signal.removeEventListener('abort', onAbort)
        throw new ProviderError('Request cancelled', 'cancelled', { provider })
      }
      err = timedOut
        ? new ProviderError(`No response within ${timeoutMs}ms`, 'timeout', { retryable: true, provider })
        : new ProviderError(`Network error: ${e instanceof Error ? e.message : String(e)}`, 'network', {
            retryable: true,
            provider
          })
    }
    signal?.removeEventListener('abort', onAbort)

    if (!err.retryable || attempt >= maxRetries) throw err
    const backoff = Math.min(retryBaseMs * 2 ** attempt, 30_000)
    await sleep(err.retryAfterMs ?? backoff + Math.random() * backoff * 0.25, signal)
  }
}

export function safeJson(text: string): any {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Parse a JSON response body; a non-JSON 2xx body is a provider protocol error, not a crash. */
export async function readJson(res: Response, provider?: ProviderKind): Promise<any> {
  const text = await res.text()
  const parsed = safeJson(text)
  if (parsed === undefined) {
    throw new ProviderError(`Provider returned a non-JSON response: ${text.slice(0, 200)}`, 'unknown', { provider })
  }
  return parsed
}

/** Reads a response body fully but refuses to buffer more than `maxBytes` (guards downloads of image URLs). */
export async function readBytes(res: Response, maxBytes: number, provider?: ProviderKind): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProviderError(`The download is ${Math.round(declared / 1024 / 1024)} MB, over the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`, 'bad_request', { provider })
  }
  if (!res.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined)
      throw new ProviderError(`The download is over the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`, 'bad_request', { provider })
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

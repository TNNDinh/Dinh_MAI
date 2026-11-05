import { ProviderError } from './http'
import type { ProviderKind } from './types'

export interface SseMessage {
  event?: string
  data: string
}

export interface SseOptions {
  /** Abort if no bytes arrive for this long. */
  idleTimeoutMs?: number
  signal?: AbortSignal
  provider?: ProviderKind
}

/** Parse one SSE block (text between blank lines). Returns undefined for comment-only blocks. */
export function parseSseBlock(block: string): SseMessage | undefined {
  let event: string | undefined
  const data: string[] = []
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue
    const idx = rawLine.indexOf(':')
    const field = idx === -1 ? rawLine : rawLine.slice(0, idx)
    let value = idx === -1 ? '' : rawLine.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (data.length === 0 && event === undefined) return undefined
  return { event, data: data.join('\n') }
}

/** Incrementally read Server-Sent Events from a fetch Response body. */
export async function* readSse(res: Response, opts: SseOptions = {}): AsyncGenerator<SseMessage, void, void> {
  const { idleTimeoutMs = 120_000, signal, provider } = opts
  if (!res.body) throw new ProviderError('Response has no body to stream', 'unknown', { provider })

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const readChunk = () =>
    new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reader.cancel().catch(() => undefined)
        reject(new ProviderError(`Stream stalled for ${idleTimeoutMs}ms`, 'timeout', { retryable: false, provider }))
      }, idleTimeoutMs)
      reader.read().then(
        (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        (e) => {
          clearTimeout(timer)
          if (signal?.aborted) reject(new ProviderError('Request cancelled', 'cancelled', { provider }))
          else reject(new ProviderError(`Stream error: ${e instanceof Error ? e.message : String(e)}`, 'network', { provider }))
        }
      )
    })

  try {
    for (;;) {
      if (signal?.aborted) throw new ProviderError('Request cancelled', 'cancelled', { provider })
      const { done, value } = await readChunk()
      if (value) buffer += decoder.decode(value, { stream: !done })
      if (done) buffer += decoder.decode()

      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        const msg = parseSseBlock(block)
        if (msg) yield msg
      }
      if (done) {
        const tail = parseSseBlock(buffer)
        if (tail) yield tail
        return
      }
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

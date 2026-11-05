import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RecordedRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: any
}

export type Handler = (req: RecordedRequest, res: ServerResponse, count: number) => void | Promise<void>

/** A real local HTTP server so adapters are exercised over actual sockets and chunked streams. */
export class MockServer {
  private server!: Server
  readonly requests: RecordedRequest[] = []
  handler: Handler = (_r, res) => {
    res.statusCode = 404
    res.end('{}')
  }
  url = ''

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: any = raw
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        /* keep raw */
      }
      const rec: RecordedRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }
      this.requests.push(rec)
      await this.handler(rec, res, this.requests.length)
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((r) => this.server.close(() => r()))
  }

  reset(): void {
    this.requests.length = 0
  }
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/**
 * Send SSE frames. Frames are deliberately split at awkward byte boundaries
 * (mid-line) to prove the parser reassembles them correctly.
 */
export async function sse(
  res: ServerResponse,
  frames: Array<{ event?: string; data: unknown }>,
  opts: { splitEvery?: number } = {}
): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const text = frames
    .map((f) => `${f.event ? `event: ${f.event}\n` : ''}data: ${typeof f.data === 'string' ? f.data : JSON.stringify(f.data)}\n\n`)
    .join('')
  const size = opts.splitEvery ?? 7
  for (let i = 0; i < text.length; i += size) {
    res.write(text.slice(i, i + size))
    await new Promise((r) => setTimeout(r, 1))
  }
  res.end()
}

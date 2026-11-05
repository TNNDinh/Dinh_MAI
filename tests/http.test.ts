import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ProviderError, classifyStatus, extractErrorMessage, fetchWithRetry, parseRetryAfter } from '../src/main/providers/http'
import { parseSseBlock, readSse } from '../src/main/providers/sse'
import { MockServer, json } from './helpers/mock-server'

const server = new MockServer()
beforeAll(() => server.start())
afterAll(() => server.stop())
beforeEach(() => server.reset())

describe('classifyStatus / helpers', () => {
  it('classifies statuses', () => {
    expect(classifyStatus(401)).toEqual({ kind: 'auth', retryable: false })
    expect(classifyStatus(429)).toEqual({ kind: 'rate_limit', retryable: true })
    expect(classifyStatus(529)).toEqual({ kind: 'server', retryable: true })
    expect(classifyStatus(400)).toEqual({ kind: 'bad_request', retryable: false })
  })
  it('parses Retry-After as seconds and as a date', () => {
    expect(parseRetryAfter('2')).toBe(2000)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000)
    expect(parseRetryAfter(null)).toBeUndefined()
  })
  it('extracts provider error messages', () => {
    expect(extractErrorMessage('{"error":{"message":"bad key"}}')).toBe('bad key')
    expect(extractErrorMessage('{"error":"nope"}')).toBe('nope')
    expect(extractErrorMessage('plain text')).toBe('plain text')
  })
})

describe('fetchWithRetry', () => {
  it('retries 503 with backoff and then succeeds', async () => {
    server.handler = (_r, res, n) => (n < 3 ? json(res, 503, { error: { message: 'busy' } }) : json(res, 200, { ok: true }))
    const res = await fetchWithRetry(`${server.url}/x`, { retryBaseMs: 1 })
    expect(await res.json()).toEqual({ ok: true })
    expect(server.requests).toHaveLength(3)
  })

  it('honours Retry-After on 429', async () => {
    server.handler = (_r, res, n) => (n === 1 ? json(res, 429, {}, { 'retry-after': '0' }) : json(res, 200, {}))
    await fetchWithRetry(`${server.url}/x`, { retryBaseMs: 10_000 })
    expect(server.requests).toHaveLength(2) // would time out if Retry-After were ignored
  })

  it('does not retry auth errors and surfaces the message', async () => {
    server.handler = (_r, res) => json(res, 401, { error: { message: 'invalid x-api-key' } })
    const err = await fetchWithRetry(`${server.url}/x`, { retryBaseMs: 1 }).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err.kind).toBe('auth')
    expect(err.message).toContain('invalid x-api-key')
    expect(server.requests).toHaveLength(1)
  })

  it('gives up after maxRetries', async () => {
    server.handler = (_r, res) => json(res, 500, {})
    const err = await fetchWithRetry(`${server.url}/x`, { retryBaseMs: 1, maxRetries: 2 }).catch((e) => e)
    expect(err.kind).toBe('server')
    expect(server.requests).toHaveLength(3)
  })

  it('times out when no headers arrive', async () => {
    server.handler = () => undefined // never responds
    const err = await fetchWithRetry(`${server.url}/x`, { timeoutMs: 50, maxRetries: 0 }).catch((e) => e)
    expect(err.kind).toBe('timeout')
  })

  it('reports network failures as retryable network errors', async () => {
    const err = await fetchWithRetry('http://127.0.0.1:1/x', { maxRetries: 0 }).catch((e) => e)
    expect(err.kind).toBe('network')
  })

  it('cancels immediately via AbortSignal', async () => {
    server.handler = () => undefined
    const ctl = new AbortController()
    const p = fetchWithRetry(`${server.url}/x`, { signal: ctl.signal, timeoutMs: 5000 }).catch((e) => e)
    setTimeout(() => ctl.abort(), 20)
    expect((await p).kind).toBe('cancelled')
  })
})

describe('SSE parsing', () => {
  it('parses event, multi-line data and comments', () => {
    expect(parseSseBlock('event: x\ndata: a\ndata: b')).toEqual({ event: 'x', data: 'a\nb' })
    expect(parseSseBlock(': keep-alive')).toBeUndefined()
    expect(parseSseBlock('data:no-space')).toEqual({ event: undefined, data: 'no-space' })
  })

  it('reassembles frames split across arbitrary chunk boundaries', async () => {
    server.handler = async (_r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const text = 'data: {"a":1}\n\n: ping\n\nevent: e\ndata: {"b":"é€"}\n\ndata: [DONE]\n\n'
      const buf = Buffer.from(text)
      for (let i = 0; i < buf.length; i += 3) {
        res.write(buf.subarray(i, i + 3)) // splits multi-byte UTF-8 characters too
        await new Promise((r) => setTimeout(r, 1))
      }
      res.end()
    }
    const res = await fetchWithRetry(`${server.url}/s`)
    const got: unknown[] = []
    for await (const m of readSse(res)) got.push(m)
    expect(got).toEqual([
      { event: undefined, data: '{"a":1}' },
      { event: 'e', data: '{"b":"é€"}' },
      { event: undefined, data: '[DONE]' }
    ])
  })

  it('fails with a timeout when the stream stalls', async () => {
    server.handler = (_r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: 1\n\n') // then silence
    }
    const res = await fetchWithRetry(`${server.url}/s`)
    const run = async () => {
      for await (const _ of readSse(res, { idleTimeoutMs: 60 })) void _
    }
    await expect(run()).rejects.toMatchObject({ kind: 'timeout' })
  })

  it('cancels mid-stream', async () => {
    server.handler = (_r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: 1\n\n')
    }
    const ctl = new AbortController()
    const res = await fetchWithRetry(`${server.url}/s`, { signal: ctl.signal })
    const run = async () => {
      for await (const _ of readSse(res, { signal: ctl.signal })) {
        void _
        ctl.abort()
      }
    }
    await expect(run()).rejects.toMatchObject({ kind: 'cancelled' })
  })
})

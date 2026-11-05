import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChatStreamEvent } from '../src/shared/ipc'
import { Database } from '../src/main/db/database'
import { createChatProvider } from '../src/main/providers/registry'
import { ChatService } from '../src/main/services/chat'
import { ConnectionService, redactSecret, validateBaseUrl } from '../src/main/services/connections'
import { EventService } from '../src/main/services/events'
import { MemorySecrets } from './helpers/memory-secrets'
import { MockServer, json, sse } from './helpers/mock-server'

const KEY = 'sk-test-key-0123456789'
const server = new MockServer()
beforeAll(() => server.start())
afterAll(() => server.stop())

let db: Database
let secrets: MemorySecrets
let events: EventService
let conns: ConnectionService
let chat: ChatService

beforeEach(() => {
  server.reset()
  db = new Database(':memory:')
  db.migrate()
  secrets = new MemorySecrets()
  events = new EventService(db)
  // No retries: failing-endpoint tests must not sit through backoff.
  conns = new ConnectionService(db, events, secrets, { providerFactory: (c) => createChatProvider({ ...c, maxRetries: 0 }) })
  chat = new ChatService(db, events, conns)
})

const addOpenAI = (extra: Partial<Parameters<ConnectionService['create']>[0]> = {}) =>
  conns.create({ kind: 'openai', name: 'Test OpenAI', baseUrl: `${server.url}/v1`, apiKey: KEY, ...extra })

describe('validateBaseUrl', () => {
  it('accepts https anywhere and http only for local/private hosts, trimming trailing slashes', () => {
    expect(validateBaseUrl(' https://api.example.com/v1/ ')).toBe('https://api.example.com/v1')
    for (const ok of ['http://localhost:11434/v1', 'http://127.0.0.1:1234', 'http://192.168.1.5:8000/v1', 'http://10.0.0.2', 'http://172.20.1.1', 'http://[::1]:8080']) {
      expect(() => validateBaseUrl(ok), ok).not.toThrow()
    }
  })

  it('rejects remote http, other schemes, embedded credentials and garbage', () => {
    expect(() => validateBaseUrl('http://api.example.com/v1')).toThrow(/https/)
    expect(() => validateBaseUrl('http://172.32.0.1')).toThrow(/https/) // just outside the private range
    expect(() => validateBaseUrl('ftp://example.com')).toThrow(/http/)
    expect(() => validateBaseUrl('https://user:pw@example.com')).toThrow(/credentials/)
    expect(() => validateBaseUrl('not a url')).toThrow(/valid URL/)
  })
})

describe('redactSecret', () => {
  it('scrubs the key and bearer tokens', () => {
    expect(redactSecret(`bad key ${KEY} rejected`, KEY)).toBe('bad key *** rejected')
    expect(redactSecret('Authorization: Bearer abcdefghijklmnop1234', undefined)).toBe('Authorization: Bearer ***')
    expect(redactSecret('plain', 'abc')).toBe('plain') // too short to be a real key: don't mangle text
  })
})

describe('ConnectionService CRUD', () => {
  it('stores the key encrypted-side only and never exposes it in the DTO or the database', async () => {
    const c = await addOpenAI()
    expect(c).toMatchObject({ kind: 'openai', name: 'Test OpenAI', hasKey: true, enabled: true, status: 'unknown', modelCount: 0 })
    expect(JSON.stringify(c)).not.toContain(KEY)
    expect(secrets.data.get(`conn:${c.id}`)).toBe(KEY)
    const raw = db.all(`SELECT * FROM provider_connections`)
    expect(JSON.stringify(raw)).not.toContain(KEY)
    expect(JSON.stringify(conns.list())).not.toContain(KEY)
  })

  it('validates input', async () => {
    await expect(conns.create({ kind: 'openai', name: 'x' })).rejects.toThrow(/API key/)
    await expect(conns.create({ kind: 'openai', name: '  ', apiKey: KEY })).rejects.toThrow(/name/)
    await expect(conns.create({ kind: 'custom', name: 'c' })).rejects.toThrow(/URL/) // custom has no default URL
    await expect(conns.create({ kind: 'openai', name: 'x', apiKey: KEY, baseUrl: 'http://evil.example.com' })).rejects.toThrow(/https/)
    await expect(conns.create({ kind: 'nope' as never, name: 'x' })).rejects.toThrow(/Unknown provider/)
    await expect(conns.create({ kind: 'openai', name: 'x', apiKey: 'line\nbreak' })).rejects.toThrow(/line breaks/)
    expect(conns.list()).toEqual([])
  })

  it('needs no key for Ollama and uses the catalog default URL', async () => {
    const c = await conns.create({ kind: 'ollama', name: 'Local' })
    expect(c.hasKey).toBe(false)
    expect(c.baseUrl).toBe('http://localhost:11434/v1')
  })

  it('rolls the row back if the key cannot be stored (e.g. DPAPI unavailable)', async () => {
    secrets.failNextSet = true
    await expect(addOpenAI()).rejects.toThrow(/plaintext/)
    expect(conns.list()).toEqual([])
  })

  it('updates name/url/enabled, replaces the key and resets status when credentials change', async () => {
    const c = await addOpenAI()
    db.run(`UPDATE provider_connections SET status='ok', last_error='old' WHERE id=?`, c.id)
    const renamed = await conns.update({ id: c.id, name: 'Renamed', enabled: false })
    expect(renamed).toMatchObject({ name: 'Renamed', enabled: false, status: 'ok' }) // cosmetic edits keep status

    const rekeyed = await conns.update({ id: c.id, apiKey: 'sk-new-key-9876543210' })
    expect(secrets.data.get(`conn:${c.id}`)).toBe('sk-new-key-9876543210')
    expect(rekeyed).toMatchObject({ status: 'unknown', lastError: null })

    await expect(conns.update({ id: c.id, baseUrl: 'http://remote.example.com' })).rejects.toThrow(/https/)
    await expect(conns.update({ id: c.id, clearKey: true })).rejects.toThrow(/requires an API key/)
    await expect(conns.update({ id: 'missing', name: 'x' })).rejects.toThrow(/not found/)
  })

  it('can add and clear an optional key on keyless providers', async () => {
    const c = await conns.create({ kind: 'custom', name: 'LAN', baseUrl: 'http://192.168.1.9:8000/v1' })
    expect((await conns.update({ id: c.id, apiKey: 'secret-lan-key' })).hasKey).toBe(true)
    expect((await conns.update({ id: c.id, clearKey: true })).hasKey).toBe(false)
    expect(secrets.has(`conn:${c.id}`)).toBe(false)
  })

  it('remove deletes the row, cached models, prices and the stored key but keeps usage history', async () => {
    const c = await addOpenAI()
    db.run(`INSERT INTO connection_models (connection_id, model, kind, fetched_at) VALUES (?, 'm', 'chat', 1)`, c.id)
    conns.setPricing({ connectionId: c.id, model: 'm', pricing: { inputPerMTok: 1, outputPerMTok: 2 } })
    db.run(`INSERT INTO llm_calls (id, connection_id, model, status, created_at) VALUES ('x', ?, 'm', 'ok', 1)`, c.id)
    conns.remove(c.id)
    expect(conns.list()).toEqual([])
    expect(secrets.has(`conn:${c.id}`)).toBe(false)
    expect(db.get(`SELECT COUNT(*) n FROM connection_models`)).toEqual({ n: 0 })
    expect(db.get(`SELECT COUNT(*) n FROM model_pricing`)).toEqual({ n: 0 })
    expect(chat.usageByModel()).toMatchObject([{ connectionId: null, connectionName: '(deleted connection)', model: 'm', calls: 1 }])
  })
})

describe('connection test', () => {
  it('records success with latency and sends the key', async () => {
    server.handler = (_r, res) => json(res, 200, { data: [{ id: 'a' }, { id: 'b' }] })
    const c = await addOpenAI()
    const r = await conns.test(c.id)
    expect(r.ok).toBe(true)
    expect(r.modelCount).toBe(2)
    expect(r.connection).toMatchObject({ status: 'ok', lastError: null })
    expect(r.connection.lastCheckedAt).toBeGreaterThan(0)
    expect(server.requests[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(events.recent({ limit: 1 })[0].type).toBe('connection.test_ok')
  })

  it('records failures and never leaks the key even when the server echoes it', async () => {
    server.handler = (_r, res) => json(res, 401, { error: { message: `Incorrect API key provided: ${KEY}` } })
    const c = await addOpenAI()
    const r = await conns.test(c.id)
    expect(r.ok).toBe(false)
    expect(r.errorKind).toBe('auth')
    expect(r.error).not.toContain(KEY)
    expect(r.connection.status).toBe('error')
    expect(r.connection.lastError).not.toContain(KEY)
    expect(JSON.stringify(events.recent())).not.toContain(KEY)
  })

  it('reports an unreachable host as an error instead of throwing', async () => {
    const c = await addOpenAI({ baseUrl: 'http://127.0.0.1:9/v1' }) // discard port: connection refused
    const r = await conns.test(c.id)
    expect(r.ok).toBe(false)
    expect(r.connection.status).toBe('error')
  })

  it('fails cleanly when the stored key cannot be decrypted', async () => {
    const c = await addOpenAI()
    secrets.data.delete(`conn:${c.id}`)
    const r = await conns.test(c.id)
    expect(r).toMatchObject({ ok: false, errorKind: 'auth' })
    expect(r.error).toMatch(/decrypt|Re-enter/)
  })
})

describe('model discovery and pricing', () => {
  const openrouter = () => conns.create({ kind: 'openrouter', name: 'OR', baseUrl: `${server.url}/api/v1`, apiKey: KEY })

  it('caches discovered models, kind and context window, and marks the connection ok', async () => {
    server.handler = (_r, res) => json(res, 200, { data: [{ id: 'gpt-x' }, { id: 'text-embedding-3-small' }, { id: 'dall-e-3' }] })
    const c = await addOpenAI()
    const models = await conns.discoverModels(c.id)
    expect(models.map((m) => [m.model, m.kind])).toEqual([
      ['gpt-x', 'chat'],
      ['text-embedding-3-small', 'embedding'],
      ['dall-e-3', 'image']
    ].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])))
    expect(conns.get(c.id)).toMatchObject({ status: 'ok', modelCount: 3 })
  })

  it('stores provider-published prices but never overwrites a price the user typed', async () => {
    server.handler = (_r, res) =>
      json(res, 200, {
        data: [
          { id: 'v/a', context_length: 8000, pricing: { prompt: '0.000003', completion: '0.000015' } },
          { id: 'v/b', pricing: { prompt: '0.000001', completion: '0.000002' } }
        ]
      })
    const c = await openrouter()
    let models = await conns.discoverModels(c.id)
    expect(models.find((m) => m.model === 'v/a')).toMatchObject({ contextWindow: 8000, pricing: { source: 'provider' } })
    expect(models.find((m) => m.model === 'v/a')!.pricing!.inputPerMTok).toBeCloseTo(3)

    conns.setPricing({ connectionId: c.id, model: 'v/a', pricing: { inputPerMTok: 9, outputPerMTok: 99 } })
    // Provider changes its price; user override must survive, the other provider-sourced row updates.
    server.handler = (_r, res) =>
      json(res, 200, {
        data: [
          { id: 'v/a', pricing: { prompt: '0.000005', completion: '0.000005' } },
          { id: 'v/b', pricing: { prompt: '0.000004', completion: '0.000008' } }
        ]
      })
    models = await conns.discoverModels(c.id)
    expect(models.find((m) => m.model === 'v/a')!.pricing).toEqual({ inputPerMTok: 9, outputPerMTok: 99, source: 'user' })
    expect(models.find((m) => m.model === 'v/b')!.pricing!.inputPerMTok).toBeCloseTo(4)
  })

  it('removes models the provider no longer lists', async () => {
    const c = await addOpenAI()
    server.handler = (_r, res) => json(res, 200, { data: [{ id: 'one' }, { id: 'two' }] })
    await conns.discoverModels(c.id)
    server.handler = (_r, res) => json(res, 200, { data: [{ id: 'two' }] })
    expect((await conns.discoverModels(c.id)).map((m) => m.model)).toEqual(['two'])
  })

  it('keeps the previous cache on failure, flags the connection and redacts the key', async () => {
    const c = await addOpenAI()
    server.handler = (_r, res) => json(res, 200, { data: [{ id: 'one' }] })
    await conns.discoverModels(c.id)
    server.handler = (_r, res) => json(res, 500, { error: { message: `boom ${KEY}` } })
    const err = await conns.discoverModels(c.id).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain(KEY)
    expect(conns.listModels(c.id)).toHaveLength(1)
    expect(conns.get(c.id)).toMatchObject({ status: 'error' })
  })

  it('validates and clears user pricing', async () => {
    const c = await addOpenAI()
    const set = (p: { inputPerMTok: number; outputPerMTok: number } | null, model = 'm') => conns.setPricing({ connectionId: c.id, model, pricing: p })
    set({ inputPerMTok: 2.5, outputPerMTok: 10 })
    expect(conns.pricingFor(c.id, 'm')).toEqual({ inputPerMTok: 2.5, outputPerMTok: 10 })
    set({ inputPerMTok: 0, outputPerMTok: 0 }) // free is a valid, explicit price
    expect(conns.pricingFor(c.id, 'm')).toEqual({ inputPerMTok: 0, outputPerMTok: 0 })
    for (const bad of [-1, NaN, Infinity, 1e9]) expect(() => set({ inputPerMTok: bad, outputPerMTok: 1 }), String(bad)).toThrow(/between 0/)
    expect(() => set({ inputPerMTok: 1, outputPerMTok: 1 }, ' ')).toThrow(/Model/)
    set(null)
    expect(conns.pricingFor(c.id, 'm')).toBeUndefined() // back to unknown, not zero
    expect(() => conns.setPricing({ connectionId: 'nope', model: 'm', pricing: null })).toThrow(/not found/)
  })

  it('treats local providers as free unless a price is set', async () => {
    const c = await conns.create({ kind: 'ollama', name: 'Local' })
    expect(conns.pricingFor(c.id, 'llama3')).toEqual({ inputPerMTok: 0, outputPerMTok: 0 })
  })
})

// ------------------------------------------------------------------ chat

function run(input: Parameters<ChatService['start']>[0]): Promise<{ id: string; events: ChatStreamEvent[] }> {
  return new Promise((resolve, reject) => {
    const got: ChatStreamEvent[] = []
    let id = ''
    id = chat.start(input, (e) => {
      got.push(e)
      if (e.type === 'done' || e.type === 'error' || e.type === 'cancelled') resolve({ id, events: got })
    })
    setTimeout(() => reject(new Error('chat timed out')), 8000)
  })
}

const reply = (res: Parameters<typeof sse>[0], text = 'Hi there', usage = { prompt_tokens: 1000, completion_tokens: 500 }) =>
  sse(res, [
    { data: { model: 'gpt-x', choices: [{ index: 0, delta: { content: text.slice(0, 3) } }] } },
    { data: { choices: [{ index: 0, delta: { content: text.slice(3) }, finish_reason: 'stop' }] } },
    { data: { choices: [], usage } },
    { data: '[DONE]' }
  ])

const user = (content: string) => [{ role: 'user' as const, content }]

describe('ChatService', () => {
  it('streams text, computes cost from the stored price and records the call', async () => {
    server.handler = (_r, res) => reply(res)
    const c = await addOpenAI()
    conns.setPricing({ connectionId: c.id, model: 'gpt-x', pricing: { inputPerMTok: 2, outputPerMTok: 10 } })

    const { id, events: got } = await run({ connectionId: c.id, model: 'gpt-x', system: 'Be brief', messages: user('hello') })
    expect(got.every((e) => e.requestId === id)).toBe(true)
    expect(got.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Hi there')
    const done = got[got.length - 1]
    expect(done).toMatchObject({ type: 'done', inputTokens: 1000, outputTokens: 500, stopReason: 'end' })
    expect((done as { costUsd: number }).costUsd).toBeCloseTo(0.007) // 1000*2/1M + 500*10/1M

    expect(server.requests[0].body.messages).toEqual([
      { role: 'system', content: 'Be brief' },
      { role: 'user', content: 'hello' }
    ])
    const row = db.get<Record<string, unknown>>(`SELECT * FROM llm_calls`)!
    expect(row).toMatchObject({ connection_id: c.id, model: 'gpt-x', status: 'ok', input_tokens: 1000, output_tokens: 500, error: null })
    expect(row.cost_usd as number).toBeCloseTo(0.007)
    expect(row.latency_ms as number).toBeGreaterThanOrEqual(0)
    expect(events.recent({ limit: 1 })[0].type).toBe('llm.call')
  })

  it('reports unknown cost as null (never a guessed number) and counts it as unpriced', async () => {
    server.handler = (_r, res) => reply(res)
    const c = await addOpenAI()
    const { events: got } = await run({ connectionId: c.id, model: 'gpt-x', messages: user('hi') })
    expect(got[got.length - 1]).toMatchObject({ type: 'done', costUsd: null })
    expect(chat.usageByModel()).toMatchObject([{ model: 'gpt-x', calls: 1, costUsd: 0, unpricedCalls: 1, failedCalls: 0, inputTokens: 1000 }])
  })

  it('prices local (Ollama) models at zero', async () => {
    server.handler = (_r, res) => reply(res)
    const c = await conns.create({ kind: 'ollama', name: 'Local', baseUrl: `${server.url}/v1` })
    const { events: got } = await run({ connectionId: c.id, model: 'llama3', messages: user('hi') })
    expect(got[got.length - 1]).toMatchObject({ type: 'done', costUsd: 0 })
  })

  it('surfaces provider errors with a kind, records the failure and redacts the key', async () => {
    server.handler = (_r, res) => json(res, 401, { error: { message: `Incorrect API key: ${KEY}` } })
    const c = await addOpenAI()
    const { events: got } = await run({ connectionId: c.id, model: 'gpt-x', messages: user('hi') })
    const err = got[got.length - 1] as Extract<ChatStreamEvent, { type: 'error' }>
    expect(err).toMatchObject({ type: 'error', kind: 'auth', retryable: false })
    expect(err.message).not.toContain(KEY)
    expect(db.get(`SELECT status, error, cost_usd FROM llm_calls`)).toMatchObject({ status: 'error', cost_usd: null })
    expect(JSON.stringify(db.all(`SELECT error FROM llm_calls`))).not.toContain(KEY)
    expect(JSON.stringify(events.recent())).not.toContain(KEY)
    expect(chat.usageByModel()[0]).toMatchObject({ calls: 1, failedCalls: 1, unpricedCalls: 0 })
  })

  it('cancels an in-flight stream, emits `cancelled` and records a cancelled call', async () => {
    let sawRequest!: () => void
    const requested = new Promise<void>((r) => (sawRequest = r))
    server.handler = (_r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' } }] })}\n\n`)
      sawRequest() // then never finishes
    }
    const c = await addOpenAI()
    const got: ChatStreamEvent[] = []
    const finished = new Promise<void>((resolve) => {
      const id = chat.start({ connectionId: c.id, model: 'gpt-x', messages: user('go') }, (e) => {
        got.push(e)
        if (e.type === 'cancelled') resolve()
      })
      void requested.then(() => setTimeout(() => chat.cancel(id), 30))
    })
    await finished
    expect(got.some((e) => e.type === 'text')).toBe(true)
    expect(db.get(`SELECT status FROM llm_calls`)).toEqual({ status: 'cancelled' })
    expect(chat.usageByModel()[0]).toMatchObject({ failedCalls: 1, unpricedCalls: 0 })
  })

  it('cancelAll aborts every running request', async () => {
    server.handler = (_r, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': keep-alive\n\n')
    }
    const c = await addOpenAI()
    const cancelled = [0, 1].map(
      () => new Promise<void>((resolve) => void chat.start({ connectionId: c.id, model: 'm', messages: user('x') }, (e) => e.type === 'cancelled' && resolve()))
    )
    await new Promise((r) => setTimeout(r, 100))
    chat.cancelAll()
    await Promise.all(cancelled)
  })

  it('rejects invalid requests synchronously, before any network call', async () => {
    const c = await addOpenAI()
    const start = (over: object) => () => chat.start({ connectionId: c.id, model: 'm', messages: user('x'), ...over } as never, () => undefined)
    expect(() => chat.start({ connectionId: 'nope', model: 'm', messages: user('x') }, () => undefined)).toThrow(/not found/)
    expect(start({ model: ' ' })).toThrow(/model/i)
    expect(start({ messages: [] })).toThrow(/message/i)
    expect(start({ messages: [{ role: 'assistant', content: 'x' }] })).toThrow(/last message/)
    expect(start({ messages: [{ role: 'system', content: 'x' }] })).toThrow(/Invalid message/)
    expect(start({ maxTokens: 0 })).toThrow(/Max tokens/)
    expect(start({ maxTokens: 1.5 })).toThrow(/Max tokens/)
    expect(start({ temperature: 3 })).toThrow(/Temperature/)
    await conns.update({ id: c.id, enabled: false })
    expect(start({})).toThrow(/disabled/)
    expect(server.requests).toHaveLength(0)
  })

  it('aggregates usage per model across calls', async () => {
    server.handler = (_r, res) => reply(res, 'ok!', { prompt_tokens: 100, completion_tokens: 50 })
    const c = await addOpenAI()
    conns.setPricing({ connectionId: c.id, model: 'gpt-x', pricing: { inputPerMTok: 10, outputPerMTok: 10 } })
    await run({ connectionId: c.id, model: 'gpt-x', messages: user('1') })
    await run({ connectionId: c.id, model: 'gpt-x', messages: user('2') })
    expect(chat.usageByModel()).toMatchObject([
      { connectionName: 'Test OpenAI', model: 'gpt-x', calls: 2, inputTokens: 200, outputTokens: 100, unpricedCalls: 0 }
    ])
    expect(chat.usageByModel()[0].costUsd).toBeCloseTo(0.003)
  })
})

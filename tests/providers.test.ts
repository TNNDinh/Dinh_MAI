import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createChatProvider } from '../src/main/providers'
import { sanitizeGeminiSchema, toGeminiContents } from '../src/main/providers/gemini'
import type { ChatMessage, ChatRequest, ToolDefinition } from '../src/main/providers/types'
import { MockServer, json, sse } from './helpers/mock-server'

const server = new MockServer()
beforeAll(() => server.start())
afterAll(() => server.stop())
beforeEach(() => server.reset())

const tool: ToolDefinition = {
  name: 'write_file',
  description: 'Write a file',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
    additionalProperties: false
  }
}

const roundTrip: ChatMessage[] = [
  { role: 'user', content: 'make a file' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'ok' },
      { type: 'tool_call', id: 'call_1', name: 'write_file', arguments: { path: 'a.txt', content: 'hi' }, meta: { thoughtSignature: 'SIG' } }
    ]
  },
  { role: 'user', content: [{ type: 'tool_result', toolCallId: 'call_1', content: 'written', isError: false }] }
]

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'test-model',
  system: 'You are a tester',
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 100,
  ...over
})

// ------------------------------------------------------------------ Anthropic
describe('AnthropicProvider', () => {
  const make = () =>
    createChatProvider({ id: 'c1', kind: 'anthropic', baseUrl: server.url, apiKey: 'sk-ant-test', maxRetries: 0 })

  it('streams text, assembles a tool call from partial JSON, and reports usage', async () => {
    server.handler = (_r, res) =>
      sse(res, [
        { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-x', usage: { input_tokens: 25, output_tokens: 1 } } } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
        { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {} } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.' } } },
        { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'txt","content":"hi"}' } } },
        { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
        { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } } },
        { event: 'message_stop', data: { type: 'message_stop' } }
      ])

    const deltas: string[] = []
    const out = await make().chat(req({ tools: [tool] }), (e) => e.type === 'text' && deltas.push(e.delta))

    expect(deltas.join('')).toBe('Hello')
    expect(out.text).toBe('Hello')
    expect(out.toolCalls).toEqual([{ id: 'toolu_1', name: 'write_file', arguments: { path: 'a.txt', content: 'hi' } }])
    expect(out.stopReason).toBe('tool_use')
    expect(out.usage).toMatchObject({ inputTokens: 25, outputTokens: 42 })
    expect(out.model).toBe('claude-x')

    const r = server.requests[0]
    expect(r.url).toBe('/v1/messages')
    expect(r.headers['x-api-key']).toBe('sk-ant-test')
    expect(r.headers['anthropic-version']).toBe('2023-06-01')
    expect(r.body).toMatchObject({ model: 'test-model', max_tokens: 100, system: 'You are a tester', stream: true })
    expect(r.body.tools[0]).toMatchObject({ name: 'write_file', input_schema: tool.parameters })
  })

  it('converts tool calls and results in history', async () => {
    server.handler = (_r, res) => sse(res, [{ event: 'message_stop', data: { type: 'message_stop' } }])
    await make().chat(req({ messages: roundTrip }))
    const msgs = server.requests[0].body.messages
    expect(msgs[1].content[1]).toEqual({ type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.txt', content: 'hi' } })
    expect(msgs[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1', content: 'written' })
  })

  it('maps a mid-stream overloaded error to a retryable server error', async () => {
    server.handler = (_r, res) => sse(res, [{ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }])
    await expect(make().chat(req())).rejects.toMatchObject({ kind: 'server', retryable: true })
  })

  it('lists models and tests the connection', async () => {
    server.handler = (_r, res) => json(res, 200, { data: [{ id: 'claude-a', display_name: 'Claude A' }] })
    const p = make()
    expect(await p.listModels()).toEqual([{ id: 'claude-a', displayName: 'Claude A', kind: 'chat' }])
    expect(await p.testConnection()).toMatchObject({ ok: true, modelCount: 1 })
  })

  it('reports an auth failure through testConnection', async () => {
    server.handler = (_r, res) => json(res, 401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } })
    const st = await make().testConnection()
    expect(st).toMatchObject({ ok: false, errorKind: 'auth' })
    expect(st.error).toContain('invalid x-api-key')
  })
})

// ------------------------------------------------------------------ OpenAI-compatible
describe('OpenAICompatibleProvider', () => {
  const make = (kind: 'openai' | 'groq' | 'custom' | 'ollama' | 'openrouter' | 'deepseek' = 'openai', extra = {}) =>
    createChatProvider({ id: 'c2', kind, baseUrl: `${server.url}/v1`, apiKey: kind === 'ollama' || kind === 'custom' ? undefined : 'sk-test', maxRetries: 0, ...extra })

  it('streams text, assembles interleaved tool-call deltas, and reads the usage chunk', async () => {
    server.handler = (_r, res) =>
      sse(res, [
        { data: { model: 'gpt-x', choices: [{ index: 0, delta: { role: 'assistant', content: 'He' } }] } },
        { data: { choices: [{ index: 0, delta: { content: 'llo' } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'write_file', arguments: '' } }] } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt",' } }] } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'write_file', arguments: '{"path":"b.txt","content":"2"}' } }] } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"1"}' } }] } }] } },
        { data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
        { data: { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } } },
        { data: '[DONE]' }
      ])

    const out = await make().chat(req({ tools: [tool] }))
    expect(out.text).toBe('Hello')
    expect(out.toolCalls.map((c) => [c.id, c.arguments])).toEqual([
      ['call_a', { path: 'a.txt', content: '1' }],
      ['call_b', { path: 'b.txt', content: '2' }]
    ])
    expect(out.stopReason).toBe('tool_use')
    expect(out.usage).toEqual({ inputTokens: 11, outputTokens: 7, cachedInputTokens: 4 })

    const r = server.requests[0]
    expect(r.url).toBe('/v1/chat/completions')
    expect(r.headers.authorization).toBe('Bearer sk-test')
    expect(r.body.stream_options).toEqual({ include_usage: true })
    expect(r.body.max_completion_tokens).toBe(100) // OpenAI proper
    expect(r.body.messages[0]).toEqual({ role: 'system', content: 'You are a tester' })
    expect(r.body.tools[0].function.name).toBe('write_file')
  })

  it('uses max_tokens (not max_completion_tokens) for non-OpenAI vendors and omits auth for Ollama', async () => {
    server.handler = (_r, res) => sse(res, [{ data: '[DONE]' }])
    await make('groq').chat(req())
    expect(server.requests[0].body.max_tokens).toBe(100)
    expect(server.requests[0].body.max_completion_tokens).toBeUndefined()

    server.reset()
    await make('ollama').chat(req())
    expect(server.requests[0].headers.authorization).toBeUndefined()
  })

  it('does not send stream_options to generic custom endpoints by default', async () => {
    server.handler = (_r, res) => sse(res, [{ data: '[DONE]' }])
    await make('custom').chat(req())
    expect(server.requests[0].body.stream_options).toBeUndefined()
    server.reset()
    await make('custom', { streamUsage: true }).chat(req())
    expect(server.requests[0].body.stream_options).toEqual({ include_usage: true })
  })

  it('converts tool history into assistant.tool_calls + role:tool messages', async () => {
    server.handler = (_r, res) => sse(res, [{ data: '[DONE]' }])
    await make().chat(req({ messages: roundTrip }))
    const msgs = server.requests[0].body.messages
    expect(msgs[2]).toEqual({
      role: 'assistant',
      content: 'ok',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}' } }]
    })
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'written' })
  })

  it('lists Ollama models via /api/tags', async () => {
    server.handler = (r, res) => (r.url === '/api/tags' ? json(res, 200, { models: [{ name: 'llama3:8b' }, { name: 'nomic-embed-text' }] }) : json(res, 404, {}))
    const models = await make('ollama').listModels()
    expect(models).toEqual([
      { id: 'llama3:8b', kind: 'chat' },
      { id: 'nomic-embed-text', kind: 'embedding' }
    ])
  })

  it('reads real per-token pricing published by OpenRouter', async () => {
    server.handler = (_r, res) =>
      json(res, 200, { data: [{ id: 'vendor/model', name: 'Model', context_length: 8000, pricing: { prompt: '0.000003', completion: '0.000015' } }] })
    const [m] = await make('openrouter').listModels()
    expect(m.contextWindow).toBe(8000)
    expect(m.pricing?.inputPerMTok).toBeCloseTo(3)
    expect(m.pricing?.outputPerMTok).toBeCloseTo(15)
  })

  it('surfaces rate limits as retryable errors', async () => {
    server.handler = (_r, res) => json(res, 429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '1' })
    const err = await make().chat(req()).catch((e) => e)
    expect(err).toMatchObject({ kind: 'rate_limit', retryable: true, retryAfterMs: 1000 })
  })

  it('classifies image models', async () => {
    server.handler = (_r, res) => json(res, 200, { data: [{ id: 'gpt-image-1' }, { id: 'text-embedding-3-small' }, { id: 'whisper-1' }, { id: 'gpt-4o' }] })
    const kinds = Object.fromEntries((await make().listModels()).map((m) => [m.id, m.kind]))
    expect(kinds).toEqual({ 'gpt-image-1': 'image', 'text-embedding-3-small': 'embedding', 'whisper-1': 'other', 'gpt-4o': 'chat' })
  })
})

// ------------------------------------------------------------------ Gemini
describe('GeminiProvider', () => {
  const make = () => createChatProvider({ id: 'c3', kind: 'gemini', baseUrl: `${server.url}/v1beta`, apiKey: 'g-key', maxRetries: 0 })

  it('streams text and function calls, keeps thought signatures, skips thought parts', async () => {
    server.handler = (_r, res) =>
      sse(res, [
        { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text: 'Hi ' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1 } } },
        { data: { candidates: [{ content: { role: 'model', parts: [{ text: 'there' }, { functionCall: { name: 'write_file', args: { path: 'a.txt', content: 'x' } }, thoughtSignature: 'SIG123' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 15, thoughtsTokenCount: 3 }, modelVersion: 'gemini-x' } }
      ])
    const out = await make().chat(req({ tools: [tool] }))
    expect(out.text).toBe('Hi there')
    expect(out.toolCalls).toHaveLength(1)
    expect(out.toolCalls[0]).toMatchObject({ name: 'write_file', arguments: { path: 'a.txt', content: 'x' }, meta: { thoughtSignature: 'SIG123' } })
    expect(out.stopReason).toBe('tool_use')
    expect(out.usage).toMatchObject({ inputTokens: 9, outputTokens: 18 })

    const r = server.requests[0]
    expect(r.url).toBe('/v1beta/models/test-model:streamGenerateContent?alt=sse')
    expect(r.headers['x-goog-api-key']).toBe('g-key')
    expect(r.body.systemInstruction).toEqual({ parts: [{ text: 'You are a tester' }] })
    expect(r.body.generationConfig).toEqual({ maxOutputTokens: 100 })
    expect(r.body.tools[0].functionDeclarations[0].parameters.additionalProperties).toBeUndefined()
  })

  it('round-trips tool history using function names and thought signatures', () => {
    const contents = toGeminiContents(roundTrip) as any[]
    expect(contents[1].role).toBe('model')
    expect(contents[1].parts[1]).toEqual({ functionCall: { name: 'write_file', args: { path: 'a.txt', content: 'hi' } }, thoughtSignature: 'SIG' })
    expect(contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { name: 'write_file', response: { result: 'written' } } }] })
  })

  it('strips unsupported schema keywords recursively', () => {
    expect(sanitizeGeminiSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'string', default: 'x' } } })).toEqual({
      type: 'object',
      properties: { a: { type: 'string' } }
    })
  })

  it('maps a blocked prompt to a bad_request error', async () => {
    server.handler = (_r, res) => sse(res, [{ data: { promptFeedback: { blockReason: 'SAFETY' } } }])
    await expect(make().chat(req())).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('lists models, normalising names and detecting Imagen', async () => {
    server.handler = (_r, res) =>
      json(res, 200, {
        models: [
          { name: 'models/gemini-chat', displayName: 'Chat', inputTokenLimit: 1000, supportedGenerationMethods: ['generateContent'] },
          { name: 'models/imagen-x', supportedGenerationMethods: ['predict'] },
          { name: 'models/embed-x', supportedGenerationMethods: ['embedContent'] }
        ]
      })
    const m = await make().listModels()
    expect(m.map((x) => [x.id, x.kind])).toEqual([['gemini-chat', 'chat'], ['imagen-x', 'image'], ['embed-x', 'embedding']])
  })
})

// ------------------------------------------------------------------ registry
describe('createChatProvider', () => {
  it('requires an API key for hosted providers but not for Ollama', () => {
    expect(() => createChatProvider({ id: 'x', kind: 'openai', baseUrl: '' })).toThrow(/API key/)
    expect(() => createChatProvider({ id: 'x', kind: 'ollama', baseUrl: '' })).not.toThrow()
  })
  it('requires a base URL for custom endpoints', () => {
    expect(() => createChatProvider({ id: 'x', kind: 'custom', baseUrl: '' })).toThrow(/base URL/)
  })
})

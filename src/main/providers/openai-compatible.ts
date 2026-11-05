import { BaseChatProvider, ResponseAccumulator, guessModelKind } from './base'
import { ProviderError, readJson, safeJson } from './http'
import { readSse } from './sse'
import type { ChatMessage, ChatRequest, ModelInfo, StopReason, StreamEvent, ToolCall } from './types'

export function toOpenAIMessages(system: string | undefined, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
      continue
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')
      const calls = m.content.filter((p) => p.type === 'tool_call') as Array<ToolCall & { type: 'tool_call' }>
      const msg: Record<string, unknown> = { role: 'assistant', content: text || null }
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) }
        }))
      }
      out.push(msg)
      continue
    }
    // user turn: tool results become dedicated `tool` messages, which must come first
    for (const p of m.content) {
      if (p.type === 'tool_result') out.push({ role: 'tool', tool_call_id: p.toolCallId, content: p.content })
    }
    const rest = m.content.filter((p) => p.type === 'text' || p.type === 'image')
    if (rest.length) {
      out.push({
        role: 'user',
        content: rest.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: `data:${(p as any).mimeType};base64,${(p as any).dataBase64}` } }
        )
      })
    }
  }
  return out
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
      return 'end'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return reason ? 'other' : 'end'
  }
}

/**
 * Covers OpenAI, OpenRouter, DeepSeek, Groq, Ollama (/v1) and any custom
 * OpenAI-compatible endpoint. Provider differences live in small quirk checks.
 */
export class OpenAICompatibleProvider extends BaseChatProvider {
  constructor(
    config: ConstructorParameters<typeof BaseChatProvider>[0],
    readonly kind: ConstructorParameters<typeof BaseChatProvider>[0]['kind']
  ) {
    super(config)
  }

  protected authHeaders(): Record<string, string> {
    return this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}
  }

  private get streamUsage(): boolean {
    return this.config.streamUsage ?? this.kind !== 'custom'
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true
    }
    if (this.streamUsage) body.stream_options = { include_usage: true }
    if (req.maxTokens !== undefined) {
      // OpenAI's newer models reject `max_tokens`; everything else still expects it.
      body[this.kind === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens
    }
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
    }

    const res = await this.request(`${this.baseUrl}/chat/completions`, { method: 'POST', body, signal: req.signal })
    const acc = new ResponseAccumulator(req.model)
    const pending = new Map<number, { id: string; name: string; args: string }>()

    for await (const msg of readSse(res, { signal: req.signal, provider: this.kind })) {
      if (msg.data === '[DONE]') break
      const chunk = safeJson(msg.data)
      if (!chunk) continue
      if (chunk.error) {
        throw new ProviderError(String(chunk.error.message ?? JSON.stringify(chunk.error)), 'server', {
          retryable: false,
          provider: this.kind
        })
      }
      if (chunk.model) acc.setModel(chunk.model)

      const usage = chunk.usage ?? chunk.x_groq?.usage
      if (usage) {
        acc.usage.inputTokens = usage.prompt_tokens ?? acc.usage.inputTokens
        acc.usage.outputTokens = usage.completion_tokens ?? acc.usage.outputTokens
        const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
        if (cached !== undefined) acc.usage.cachedInputTokens = cached
      }

      const choice = chunk.choices?.[0]
      if (!choice) continue
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string' && delta.content) {
        acc.text += delta.content
        yield { type: 'text', delta: delta.content }
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx: number = tc.index ?? 0
        const cur = pending.get(idx) ?? { id: '', name: '', args: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.args += tc.function.arguments
        pending.set(idx, cur)
      }
      if (choice.finish_reason) acc.stopReason = mapFinishReason(choice.finish_reason)
    }

    for (const [idx, tc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      const call: ToolCall = {
        id: tc.id || `call_${idx}_${Date.now().toString(36)}`,
        name: tc.name,
        arguments: (tc.args ? safeJson(tc.args) : {}) ?? {}
      }
      acc.toolCalls.push(call)
      yield { type: 'tool_call', call }
    }
    yield { type: 'done', response: acc.build() }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    if (this.kind === 'ollama') {
      // Ollama's native endpoint is richer than /v1/models and works without a key.
      const origin = this.baseUrl.replace(/\/v1$/, '')
      const res = await this.request(`${origin}/api/tags`, { signal })
      const json = await readJson(res, this.kind)
      return (json.models ?? []).map((m: any) => ({ id: m.name, kind: guessModelKind(m.name) }))
    }
    const res = await this.request(`${this.baseUrl}/models`, { signal })
    const json = await readJson(res, this.kind)
    return (json.data ?? []).map((m: any): ModelInfo => {
      const info: ModelInfo = {
        id: m.id,
        displayName: m.name,
        kind: guessModelKind(m.id),
        contextWindow: m.context_length
      }
      // OpenRouter publishes real per-token prices; surface them instead of guessing.
      const p = m.pricing
      if (p && p.prompt !== undefined && p.completion !== undefined) {
        const input = Number(p.prompt) * 1e6
        const output = Number(p.completion) * 1e6
        if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) {
          info.pricing = { inputPerMTok: input, outputPerMTok: output }
        }
      }
      return info
    })
  }
}

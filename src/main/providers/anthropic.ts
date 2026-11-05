import { BaseChatProvider, ResponseAccumulator } from './base'
import { ProviderError, readJson, safeJson } from './http'
import { readSse } from './sse'
import type { ChatMessage, ChatRequest, ModelInfo, StopReason, StreamEvent, ToolCall } from './types'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 8192

export function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content }
    const blocks: unknown[] = []
    // tool_result blocks must precede any other content in a user turn
    for (const p of m.content) {
      if (p.type === 'tool_result') {
        blocks.push({ type: 'tool_result', tool_use_id: p.toolCallId, content: p.content, is_error: p.isError ?? false })
      }
    }
    for (const p of m.content) {
      if (p.type === 'text') blocks.push({ type: 'text', text: p.text })
      else if (p.type === 'image')
        blocks.push({ type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.dataBase64 } })
      else if (p.type === 'tool_call') blocks.push({ type: 'tool_use', id: p.id, name: p.name, input: p.arguments })
    }
    return { role: m.role, content: blocks }
  })
}

function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    default:
      return 'other'
  }
}

export class AnthropicProvider extends BaseChatProvider {
  readonly kind = 'anthropic' as const

  protected authHeaders(): Record<string, string> {
    return { 'x-api-key': this.config.apiKey ?? '', 'anthropic-version': ANTHROPIC_VERSION }
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: toAnthropicMessages(req.messages),
      stream: true
    }
    if (req.system) body.system = req.system
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
    }

    const res = await this.request(`${this.baseUrl}/v1/messages`, { method: 'POST', body, signal: req.signal })
    const acc = new ResponseAccumulator(req.model)
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>()

    for await (const msg of readSse(res, { signal: req.signal, provider: this.kind })) {
      const ev = safeJson(msg.data)
      if (!ev) continue
      switch (ev.type) {
        case 'message_start': {
          const u = ev.message?.usage
          if (ev.message?.model) acc.setModel(ev.message.model)
          acc.usage.inputTokens = u?.input_tokens ?? 0
          acc.usage.cachedInputTokens = u?.cache_read_input_tokens
          acc.usage.outputTokens = u?.output_tokens ?? 0
          break
        }
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use') {
            toolBlocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, json: '' })
          }
          break
        case 'content_block_delta': {
          const d = ev.delta
          if (d?.type === 'text_delta' && d.text) {
            acc.text += d.text
            yield { type: 'text', delta: d.text }
          } else if (d?.type === 'input_json_delta') {
            const tb = toolBlocks.get(ev.index)
            if (tb) tb.json += d.partial_json ?? ''
          }
          break
        }
        case 'content_block_stop': {
          const tb = toolBlocks.get(ev.index)
          if (tb) {
            toolBlocks.delete(ev.index)
            const call: ToolCall = { id: tb.id, name: tb.name, arguments: (tb.json ? safeJson(tb.json) : {}) ?? {} }
            acc.toolCalls.push(call)
            yield { type: 'tool_call', call }
          }
          break
        }
        case 'message_delta':
          if (ev.delta?.stop_reason) acc.stopReason = mapStopReason(ev.delta.stop_reason)
          // output_tokens here is cumulative, so assign rather than add
          if (ev.usage?.output_tokens !== undefined) acc.usage.outputTokens = ev.usage.output_tokens
          break
        case 'error': {
          const type: string = ev.error?.type ?? 'unknown'
          const overloaded = type === 'overloaded_error' || type === 'api_error'
          throw new ProviderError(`${type}: ${ev.error?.message ?? 'stream error'}`, overloaded ? 'server' : 'bad_request', {
            retryable: overloaded,
            provider: this.kind
          })
        }
      }
    }
    yield { type: 'done', response: acc.build() }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.request(`${this.baseUrl}/v1/models?limit=1000`, { signal })
    const json = await readJson(res, this.kind)
    return (json.data ?? []).map((m: any) => ({ id: m.id, displayName: m.display_name, kind: 'chat' as const }))
  }
}

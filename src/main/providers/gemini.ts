import { BaseChatProvider, ResponseAccumulator, guessModelKind } from './base'
import { ProviderError, readJson, safeJson } from './http'
import { readSse } from './sse'
import type { ChatMessage, ChatRequest, ModelInfo, StopReason, StreamEvent, ToolCall } from './types'

/** Gemini accepts only an OpenAPI subset of JSON Schema. */
export function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema)
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'additionalProperties' || k === '$schema' || k === '$id' || k === 'default') continue
      out[k] = sanitizeGeminiSchema(v)
    }
    return out
  }
  return schema
}

export function toGeminiContents(messages: ChatMessage[]): unknown[] {
  // Gemini function responses are keyed by function *name*, not call id.
  const nameById = new Map<string, string>()
  for (const m of messages) {
    if (typeof m.content !== 'string') {
      for (const p of m.content) if (p.type === 'tool_call') nameById.set(p.id, p.name)
    }
  }

  return messages.map((m) => {
    const role = m.role === 'assistant' ? 'model' : 'user'
    if (typeof m.content === 'string') return { role, parts: [{ text: m.content }] }
    const parts: unknown[] = []
    for (const p of m.content) {
      if (p.type === 'text') parts.push({ text: p.text })
      else if (p.type === 'image') parts.push({ inlineData: { mimeType: p.mimeType, data: p.dataBase64 } })
      else if (p.type === 'tool_call') {
        const part: Record<string, unknown> = { functionCall: { name: p.name, args: p.arguments } }
        // Gemini 3 rejects follow-up turns that drop the thought signature.
        if (p.meta?.thoughtSignature) part.thoughtSignature = p.meta.thoughtSignature
        parts.push(part)
      } else if (p.type === 'tool_result') {
        parts.push({
          functionResponse: {
            name: nameById.get(p.toolCallId) ?? 'unknown_tool',
            response: p.isError ? { error: p.content } : { result: p.content }
          }
        })
      }
    }
    return { role, parts }
  })
}

function mapFinishReason(reason: string | undefined): StopReason {
  if (!reason || reason === 'STOP') return 'end'
  if (reason === 'MAX_TOKENS') return 'max_tokens'
  return 'other'
}

export class GeminiProvider extends BaseChatProvider {
  readonly kind = 'gemini' as const

  protected authHeaders(): Record<string, string> {
    return { 'x-goog-api-key': this.config.apiKey ?? '' }
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
    const model = req.model.replace(/^models\//, '')
    const body: Record<string, unknown> = { contents: toGeminiContents(req.messages) }
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] }
    const generationConfig: Record<string, unknown> = {}
    if (req.maxTokens !== undefined) generationConfig.maxOutputTokens = req.maxTokens
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: sanitizeGeminiSchema(t.parameters)
          }))
        }
      ]
    }

    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
    const res = await this.request(url, { method: 'POST', body, signal: req.signal })
    const acc = new ResponseAccumulator(req.model)
    let callCounter = 0

    for await (const msg of readSse(res, { signal: req.signal, provider: this.kind })) {
      const chunk = safeJson(msg.data)
      if (!chunk) continue
      if (chunk.error) {
        throw new ProviderError(String(chunk.error.message ?? 'Gemini stream error'), 'server', { provider: this.kind })
      }
      const blocked = chunk.promptFeedback?.blockReason
      if (blocked) throw new ProviderError(`Prompt blocked by Gemini: ${blocked}`, 'bad_request', { provider: this.kind })

      const u = chunk.usageMetadata
      if (u) {
        // cumulative on every chunk, so assign
        acc.usage.inputTokens = u.promptTokenCount ?? acc.usage.inputTokens
        acc.usage.outputTokens = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)
        if (u.cachedContentTokenCount !== undefined) acc.usage.cachedInputTokens = u.cachedContentTokenCount
      }
      if (chunk.modelVersion) acc.setModel(chunk.modelVersion)

      const cand = chunk.candidates?.[0]
      if (!cand) continue
      for (const part of cand.content?.parts ?? []) {
        if (part.thought) continue // reasoning summaries are not part of the answer
        if (typeof part.text === 'string' && part.text) {
          acc.text += part.text
          yield { type: 'text', delta: part.text }
        } else if (part.functionCall) {
          const call: ToolCall = {
            id: `gemini_call_${Date.now().toString(36)}_${callCounter++}`,
            name: part.functionCall.name,
            arguments: part.functionCall.args ?? {},
            ...(part.thoughtSignature ? { meta: { thoughtSignature: part.thoughtSignature } } : {})
          }
          acc.toolCalls.push(call)
          yield { type: 'tool_call', call }
        }
      }
      if (cand.finishReason) acc.stopReason = mapFinishReason(cand.finishReason)
    }
    yield { type: 'done', response: acc.build() }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await this.request(`${this.baseUrl}/models?pageSize=1000`, { signal })
    const json = await readJson(res, this.kind)
    return (json.models ?? []).map((m: any): ModelInfo => {
      const id = String(m.name).replace(/^models\//, '')
      const methods: string[] = m.supportedGenerationMethods ?? []
      let kind = guessModelKind(id)
      if (methods.includes('predict') && !methods.includes('generateContent')) kind = 'image' // Imagen
      else if (methods.includes('embedContent') && !methods.includes('generateContent')) kind = 'embedding'
      return { id, displayName: m.displayName, kind, contextWindow: m.inputTokenLimit }
    })
  }
}

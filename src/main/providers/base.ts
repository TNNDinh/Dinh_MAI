import { fetchWithRetry, type HttpInit } from './http'
import type {
  ChatProvider,
  ChatRequest,
  ChatResponse,
  ConnectionConfig,
  ConnectionStatus,
  ModelInfo,
  ModelKind,
  StopReason,
  StreamEvent,
  TokenUsage,
  ToolCall
} from './types'
import { ProviderError } from './http'

/** Collects streamed pieces into the final ChatResponse. */
export class ResponseAccumulator {
  text = ''
  toolCalls: ToolCall[] = []
  stopReason: StopReason = 'end'
  usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  private readonly started = Date.now()

  constructor(private model: string) {}

  setModel(model: string): void {
    this.model = model
  }

  build(): ChatResponse {
    // A response that contains tool calls is, by definition, a tool_use stop.
    const stopReason = this.toolCalls.length > 0 && this.stopReason === 'end' ? 'tool_use' : this.stopReason
    return {
      model: this.model,
      text: this.text,
      toolCalls: this.toolCalls,
      stopReason,
      usage: this.usage,
      latencyMs: Date.now() - this.started
    }
  }
}

export abstract class BaseChatProvider implements ChatProvider {
  abstract readonly kind: ConnectionConfig['kind']

  constructor(protected readonly config: ConnectionConfig) {}

  get connectionId(): string {
    return this.config.id
  }

  protected get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '')
  }

  abstract stream(req: ChatRequest): AsyncGenerator<StreamEvent, void, void>
  abstract listModels(signal?: AbortSignal): Promise<ModelInfo[]>

  /** Headers carrying authentication. Adapter-specific. */
  protected abstract authHeaders(): Record<string, string>

  protected request(url: string, init: HttpInit & { stream?: boolean } = {}): Promise<Response> {
    return fetchWithRetry(url, {
      timeoutMs: this.config.timeoutMs,
      maxRetries: this.config.maxRetries,
      fetchImpl: this.config.fetchImpl,
      provider: this.kind,
      ...init,
      headers: { ...this.config.headers, ...this.authHeaders(), ...init.headers }
    })
  }

  async chat(req: ChatRequest, onEvent?: (e: StreamEvent) => void): Promise<ChatResponse> {
    let final: ChatResponse | undefined
    for await (const ev of this.stream(req)) {
      onEvent?.(ev)
      if (ev.type === 'done') final = ev.response
    }
    if (!final) throw new ProviderError('Stream ended without a final response', 'unknown', { provider: this.kind })
    return final
  }

  async testConnection(signal?: AbortSignal): Promise<ConnectionStatus> {
    const started = Date.now()
    try {
      const models = await this.listModels(signal)
      return { ok: true, latencyMs: Date.now() - started, modelCount: models.length }
    } catch (e) {
      const pe = e instanceof ProviderError ? e : undefined
      return {
        ok: false,
        latencyMs: Date.now() - started,
        errorKind: pe?.kind ?? 'unknown',
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }
}

/** Best-effort classification from a model id; providers rarely say outright. */
export function guessModelKind(id: string): ModelKind {
  const s = id.toLowerCase()
  if (/embed/.test(s)) return 'embedding'
  if (/(^|[/-])(dall-e|gpt-image|imagen|sdxl|stable-diffusion|flux)/.test(s) || /-image(-|$)/.test(s)) return 'image'
  if (/(whisper|tts|moderation|transcribe|realtime|audio)/.test(s)) return 'other'
  return 'chat'
}

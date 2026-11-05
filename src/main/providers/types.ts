/**
 * Provider-neutral types. Every AI provider adapter translates to/from these,
 * so the orchestrator never has to know which vendor it is talking to.
 */

import type { ProviderKind } from '../../shared/ipc'

// Defined in shared/ so the renderer and main agree on one list.
export type { ProviderKind }

/** Wire protocol an adapter speaks. Several provider kinds share one protocol. */
export type ProviderProtocol = 'anthropic' | 'openai-compatible' | 'gemini'

export interface ConnectionConfig {
  /** Stable id of the connection row in the database. */
  id: string
  kind: ProviderKind
  baseUrl: string
  /** Resolved from the secret store at call time; never persisted in the DB. */
  apiKey?: string
  /** Extra static headers (e.g. OpenRouter attribution). Must not contain secrets. */
  headers?: Record<string, string>
  timeoutMs?: number
  maxRetries?: number
  /** Ask OpenAI-compatible servers for token usage in the stream (default depends on kind). */
  streamUsage?: boolean
  /** Injectable for tests. */
  fetchImpl?: typeof fetch
}

// ---------------------------------------------------------------- messages

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image'
  mimeType: string
  dataBase64: string
}

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  /** Opaque provider data that must be echoed back (e.g. Gemini thoughtSignature). */
  meta?: Record<string, unknown>
}

export interface ToolCallPart extends ToolCall {
  type: 'tool_call'
}

export interface ToolResultPart {
  type: 'tool_result'
  toolCallId: string
  content: string
  isError?: boolean
}

export type ContentPart = TextPart | ImagePart | ToolCallPart | ToolResultPart

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema object describing the arguments. */
  parameters: Record<string, unknown>
}

export interface ChatRequest {
  model: string
  system?: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

// ---------------------------------------------------------------- responses

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Tokens served from a prompt cache, when the provider reports it. */
  cachedInputTokens?: number
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'other'

export interface ChatResponse {
  model: string
  text: string
  toolCalls: ToolCall[]
  stopReason: StopReason
  usage: TokenUsage
  latencyMs: number
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; response: ChatResponse }

// ---------------------------------------------------------------- models / status

export type ModelKind = 'chat' | 'image' | 'embedding' | 'other'

export interface ModelPricing {
  /** USD per one million tokens. */
  inputPerMTok: number
  outputPerMTok: number
}

export interface ModelInfo {
  id: string
  displayName?: string
  kind: ModelKind
  contextWindow?: number
  /** Only set when the provider itself reports prices (e.g. OpenRouter). */
  pricing?: ModelPricing
}

export interface ConnectionStatus {
  ok: boolean
  latencyMs: number
  modelCount?: number
  errorKind?: string
  error?: string
}

// ---------------------------------------------------------------- provider interface

export interface ChatProvider {
  readonly kind: ProviderKind
  readonly connectionId: string
  /** Streams events; the final event is always `done` with the aggregated response. */
  stream(req: ChatRequest): AsyncGenerator<StreamEvent, void, void>
  /** Convenience: drains `stream` and returns the final response. */
  chat(req: ChatRequest, onEvent?: (e: StreamEvent) => void): Promise<ChatResponse>
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  testConnection(signal?: AbortSignal): Promise<ConnectionStatus>
}

// ---------------------------------------------------------------- image generation
// Interface only in Phase 1; implementations arrive in Phase 7 (kept strictly
// separate from text generation, per the product requirements).

export interface ImageRequest {
  model: string
  prompt: string
  count?: number
  /** e.g. "1024x1024" */
  size?: string
  transparent?: boolean
  /** Existing image to edit / vary. */
  referenceImage?: { mimeType: string; dataBase64: string }
  signal?: AbortSignal
}

export interface GeneratedImage {
  mimeType: string
  dataBase64: string
  revisedPrompt?: string
}

export interface ImageProvider {
  readonly kind: ProviderKind
  readonly connectionId: string
  generate(req: ImageRequest): Promise<{ images: GeneratedImage[]; latencyMs: number; costUsd?: number }>
}

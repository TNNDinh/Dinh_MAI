import type { ChatMessage, ChatResponse, ToolDefinition } from '../providers/types'

/** Who a model call is billed to. */
export interface CallContext {
  agentId: string
  projectId: string | null
  runId: string | null
  taskId: string | null
  label: string
}

export interface CompleteRequest {
  connectionId: string
  model: string
  system?: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  maxTokens?: number
  temperature?: number
  signal: AbortSignal
  ctx: CallContext
}

export interface CompleteResult {
  response: ChatResponse
  /** null = no price known for the model, so the cost of this call is unknown (not zero). */
  costUsd: number | null
}

/**
 * The only way the orchestrator reaches a model. `ChatService` implements it (real providers, real
 * accounting); tests substitute a scripted implementation to exercise scheduling deterministically.
 */
export interface LlmGateway {
  complete(req: CompleteRequest): Promise<CompleteResult>
}

/** The call was aborted by the user (STOP / run stop). */
export class CallCancelledError extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'CallCancelledError'
  }
}

/** A provider call failed. `message` has already had the API key redacted. */
export class CallFailedError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'CallFailedError'
  }
}

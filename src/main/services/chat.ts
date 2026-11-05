import { randomUUID } from 'node:crypto'
import type { AgentUsageRow, ChatStartInput, ChatStreamEvent, ModelUsageRow } from '../../shared/ipc'
import type { Database } from '../db/database'
import { ProviderError } from '../providers/http'
import { estimateCostUsd } from '../providers/usage'
import { CallCancelledError, CallFailedError, type CompleteRequest, type CompleteResult, type LlmGateway } from '../orchestrator/gateway'
import type { ConnectionService } from './connections'
import { redactSecret } from './connections'
import type { EventService } from './events'

export type ChatEmitter = (event: ChatStreamEvent) => void

/** Who a call is billed to: the Playground (nobody) or an agent (and through it, its project / run / task). */
interface Origin {
  agentId: string | null
  projectId: string | null
  runId?: string | null
  taskId?: string | null
  label: string
}

/**
 * Streams a completion from a connection and records every call (tokens, cost,
 * latency, outcome) in `llm_calls`. Used by the Playground now and by the
 * orchestrator's agents later: the same accounting path for every model call.
 */
export class ChatService implements LlmGateway {
  private readonly running = new Map<string, AbortController>()

  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly connections: ConnectionService
  ) {}

  /** Validates synchronously (so the UI gets an immediate error) then streams in the background. */
  start(input: ChatStartInput, emit: ChatEmitter): string {
    const conn = this.connections.get(String(input.connectionId))
    if (!conn) throw new Error('Connection not found.')
    if (!conn.enabled) throw new Error('This connection is disabled. Enable it first.')
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    if (!model) throw new Error('Choose a model.')
    if (!Array.isArray(input.messages) || input.messages.length === 0) throw new Error('Write a message first.')
    for (const m of input.messages) {
      if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') throw new Error('Invalid message.')
    }
    if (input.messages[input.messages.length - 1].role !== 'user') throw new Error('The last message must come from the user.')
    if (input.maxTokens !== undefined && (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 200_000)) {
      throw new Error('Max tokens must be a whole number between 1 and 200000.')
    }
    if (input.temperature !== undefined && (typeof input.temperature !== 'number' || input.temperature < 0 || input.temperature > 2)) {
      throw new Error('Temperature must be between 0 and 2.')
    }

    let origin: Origin = { agentId: null, projectId: null, label: 'Playground' }
    if (input.agentId !== undefined && input.agentId !== null) {
      const agent = this.db.get<{ id: string; name: string; project_id: string | null; enabled: number }>(
        `SELECT id, name, project_id, enabled FROM agents WHERE id = ?`,
        String(input.agentId)
      )
      if (!agent) throw new Error('Agent not found.')
      if (agent.enabled !== 1) throw new Error('This agent is disabled. Enable it first.')
      origin = { agentId: agent.id, projectId: agent.project_id, label: `Agent “${agent.name}”` }
    }

    const requestId = randomUUID()
    const controller = new AbortController()
    this.running.set(requestId, controller)
    void this.run(requestId, controller, conn.id, conn.name, { ...input, model }, origin, emit)
    return requestId
  }

  cancel(requestId: string): void {
    this.running.get(String(requestId))?.abort()
  }

  /** Aborts everything in flight (used by the emergency stop). */
  cancelAll(): void {
    for (const c of this.running.values()) c.abort()
  }

  private safeEmit(emit: ChatEmitter, event: ChatStreamEvent): void {
    try {
      emit(event)
    } catch {
      /* a closed window must not break the request */
    }
  }

  private async run(
    requestId: string,
    controller: AbortController,
    connectionId: string,
    connectionName: string,
    input: ChatStartInput,
    origin: Origin,
    emit: ChatEmitter
  ): Promise<void> {
    const started = Date.now()
    let secret: string | undefined
    try {
      const resolved = await this.connections.resolve(connectionId)
      secret = resolved.secret
      let final: Awaited<ReturnType<typeof resolved.provider.chat>> | undefined
      for await (const ev of resolved.provider.stream({
        model: input.model,
        system: input.system?.trim() || undefined,
        messages: input.messages,
        maxTokens: input.maxTokens,
        temperature: input.temperature,
        signal: controller.signal
      })) {
        if (ev.type === 'text') this.safeEmit(emit, { requestId, type: 'text', delta: ev.delta })
        else if (ev.type === 'done') final = ev.response
      }
      if (!final) throw new ProviderError('The provider ended the stream without a result.', 'unknown')

      const costUsd = estimateCostUsd(final.usage, this.connections.pricingFor(connectionId, input.model))
      const latencyMs = Date.now() - started
      this.record(origin, connectionId, input.model, final.usage.inputTokens, final.usage.outputTokens, costUsd, latencyMs, 'ok', null)
      this.events.record({
        projectId: origin.projectId,
        agentId: origin.agentId,
        type: 'llm.call',
        message: `${origin.label} · ${connectionName} · ${input.model} · ${final.usage.inputTokens}→${final.usage.outputTokens} tok · ${
          costUsd === null ? 'cost unknown' : `$${costUsd.toFixed(4)}`
        } · ${latencyMs} ms`
      })
      this.safeEmit(emit, {
        requestId,
        type: 'done',
        model: final.model || input.model,
        inputTokens: final.usage.inputTokens,
        outputTokens: final.usage.outputTokens,
        costUsd,
        latencyMs,
        stopReason: final.stopReason
      })
    } catch (e) {
      const latencyMs = Date.now() - started
      if (controller.signal.aborted) {
        // Tokens consumed before cancelling are unknown, so none are recorded.
        this.record(origin, connectionId, input.model, 0, 0, null, latencyMs, 'cancelled', null)
        this.events.record({ projectId: origin.projectId, agentId: origin.agentId, level: 'warn', type: 'llm.cancelled', message: `${origin.label} request to ${input.model} cancelled` })
        this.safeEmit(emit, { requestId, type: 'cancelled' })
      } else {
        const message = redactSecret(e instanceof Error ? e.message : String(e), secret)
        const kind = e instanceof ProviderError ? e.kind : 'unknown'
        this.record(origin, connectionId, input.model, 0, 0, null, latencyMs, 'error', message)
        this.events.record({ projectId: origin.projectId, agentId: origin.agentId, level: 'error', type: 'llm.error', message: `${connectionName} · ${input.model}: ${message}` })
        this.safeEmit(emit, { requestId, type: 'error', message, kind, retryable: e instanceof ProviderError ? e.retryable : false })
      }
    } finally {
      this.running.delete(requestId)
    }
  }

  /**
   * Non-streaming completion for the orchestrator (supports tool definitions). Goes through the same
   * accounting as the Playground: one `llm_calls` row per call (ok / error / cancelled), attributed to the
   * agent, run and task, plus an activity event.
   */
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const conn = this.connections.get(req.connectionId)
    if (!conn) throw new CallFailedError('The agent’s connection no longer exists.', 'config', false)
    if (!conn.enabled) throw new CallFailedError(`Connection “${conn.name}” is disabled.`, 'config', false)
    const origin: Origin = { agentId: req.ctx.agentId, projectId: req.ctx.projectId, runId: req.ctx.runId, taskId: req.ctx.taskId, label: req.ctx.label }
    const ev = { projectId: origin.projectId, runId: origin.runId ?? null, agentId: origin.agentId }
    const started = Date.now()
    let secret: string | undefined
    try {
      if (req.signal.aborted) throw new CallCancelledError()
      const resolved = await this.connections.resolve(conn.id)
      secret = resolved.secret
      const response = await resolved.provider.chat({
        model: req.model,
        system: req.system?.trim() || undefined,
        messages: req.messages,
        tools: req.tools && req.tools.length > 0 ? req.tools : undefined,
        maxTokens: req.maxTokens,
        temperature: req.temperature,
        signal: req.signal
      })
      const costUsd = estimateCostUsd(response.usage, this.connections.pricingFor(conn.id, req.model))
      const latencyMs = Date.now() - started
      this.record(origin, conn.id, req.model, response.usage.inputTokens, response.usage.outputTokens, costUsd, latencyMs, 'ok', null)
      this.events.record({
        ...ev,
        type: 'llm.call',
        message: `${origin.label} · ${conn.name} · ${req.model} · ${response.usage.inputTokens}→${response.usage.outputTokens} tok · ${
          costUsd === null ? 'cost unknown' : `$${costUsd.toFixed(4)}`
        } · ${latencyMs} ms`
      })
      return { response, costUsd }
    } catch (e) {
      const latencyMs = Date.now() - started
      if (req.signal.aborted || e instanceof CallCancelledError) {
        this.record(origin, conn.id, req.model, 0, 0, null, latencyMs, 'cancelled', null)
        this.events.record({ ...ev, level: 'warn', type: 'llm.cancelled', message: `${origin.label} request to ${req.model} cancelled` })
        throw new CallCancelledError()
      }
      const message = redactSecret(e instanceof Error ? e.message : String(e), secret)
      const kind = e instanceof ProviderError ? e.kind : 'unknown'
      this.record(origin, conn.id, req.model, 0, 0, null, latencyMs, 'error', message)
      this.events.record({ ...ev, level: 'error', type: 'llm.error', message: `${conn.name} · ${req.model}: ${message}` })
      throw new CallFailedError(message, kind, e instanceof ProviderError ? e.retryable : false)
    }
  }

  private record(
    origin: Origin,
    connectionId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    costUsd: number | null,
    latencyMs: number,
    status: 'ok' | 'error' | 'cancelled',
    error: string | null
  ): void {
    this.db.run(
      `INSERT INTO llm_calls (id, project_id, run_id, task_id, agent_id, connection_id, model, kind, input_tokens, output_tokens, cost_usd, latency_ms, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'chat', ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(),
      origin.projectId,
      origin.runId ?? null,
      origin.taskId ?? null,
      origin.agentId,
      connectionId,
      model,
      inputTokens,
      outputTokens,
      costUsd,
      latencyMs,
      status,
      error,
      Date.now()
    )
  }

  /** Usage grouped by agent (optionally for one project). Calls made outside any agent, and calls of an agent that was deleted (the database clears their agent), are grouped under null. */
  usageByAgent(projectId?: string): AgentUsageRow[] {
    interface Row {
      agent_id: string | null
      name: string | null
      role: string | null
      calls: number
      in_tok: number
      out_tok: number
      cost: number
      unpriced: number
      failed: number
    }
    return this.db
      .all<Row>(
        `SELECT l.agent_id, a.name, a.role,
                COUNT(*) calls,
                COALESCE(SUM(l.input_tokens), 0) in_tok,
                COALESCE(SUM(l.output_tokens), 0) out_tok,
                COALESCE(SUM(l.cost_usd), 0) cost,
                SUM(CASE WHEN l.status = 'ok' AND l.cost_usd IS NULL THEN 1 ELSE 0 END) unpriced,
                SUM(CASE WHEN l.status != 'ok' THEN 1 ELSE 0 END) failed
           FROM llm_calls l LEFT JOIN agents a ON a.id = l.agent_id
          WHERE (? IS NULL OR l.project_id = ?)
          GROUP BY l.agent_id
          ORDER BY cost DESC, calls DESC`,
        projectId ?? null,
        projectId ?? null
      )
      .map((r) => ({
        agentId: r.agent_id,
        agentName: r.name ?? '(no agent: Playground, tests, deleted agents)',
        role: r.role,
        calls: r.calls,
        inputTokens: r.in_tok,
        outputTokens: r.out_tok,
        costUsd: r.cost,
        unpricedCalls: r.unpriced,
        failedCalls: r.failed
      }))
  }

  /** Usage grouped by model; survives connection deletion (the call rows keep their model name). */
  usageByModel(): ModelUsageRow[] {
    interface Row {
      connection_id: string | null
      name: string | null
      model: string
      calls: number
      in_tok: number
      out_tok: number
      cost: number
      unpriced: number
      failed: number
    }
    return this.db
      .all<Row>(
        `SELECT l.connection_id, c.name, l.model,
                COUNT(*) calls,
                COALESCE(SUM(l.input_tokens), 0) in_tok,
                COALESCE(SUM(l.output_tokens), 0) out_tok,
                COALESCE(SUM(l.cost_usd), 0) cost,
                SUM(CASE WHEN l.status = 'ok' AND l.cost_usd IS NULL THEN 1 ELSE 0 END) unpriced,
                SUM(CASE WHEN l.status != 'ok' THEN 1 ELSE 0 END) failed
           FROM llm_calls l LEFT JOIN provider_connections c ON c.id = l.connection_id
          GROUP BY l.connection_id, l.model
          ORDER BY cost DESC, calls DESC`
      )
      .map((r) => ({
        connectionId: r.connection_id,
        connectionName: r.name ?? '(deleted connection)',
        model: r.model,
        calls: r.calls,
        inputTokens: r.in_tok,
        outputTokens: r.out_tok,
        costUsd: r.cost,
        unpricedCalls: r.unpriced,
        failedCalls: r.failed
      }))
  }
}

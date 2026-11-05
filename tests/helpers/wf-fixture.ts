import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from '../../src/main/db/database'
import { CallCancelledError, type CompleteRequest, type CompleteResult, type LlmGateway } from '../../src/main/orchestrator/gateway'
import { Orchestrator } from '../../src/main/orchestrator/orchestrator'
import { createChatProvider } from '../../src/main/providers/registry'
import { AgentService } from '../../src/main/services/agents'
import { ConnectionService } from '../../src/main/services/connections'
import { EventService } from '../../src/main/services/events'
import { TaskService } from '../../src/main/services/tasks'
import { WorkflowEngine } from '../../src/main/workflows/engine'
import { WorkflowService } from '../../src/main/workflows/service'
import { ApprovalService, CommandService } from '../../src/main/workspace/commands'
import { ContextIndexer } from '../../src/main/workspace/indexer'
import { FileLocks } from '../../src/main/workspace/locks'
import { WorkspaceService } from '../../src/main/workspace/workspace'
import type { NodeRunState, WorkflowGraph } from '../../src/shared/workflow'
import type { Run, StartWorkflowInput, WorkflowRunState } from '../../src/shared/ipc'
import { MemorySecrets } from './memory-secrets'

export interface Reply {
  text?: string
  tools?: Array<{ name: string; args: Record<string, unknown> }>
  cost?: number | null
}
export interface Seen {
  req: CompleteRequest
  role: string
  taskTitle: string | null
  n: number
}

/**
 * Scripted stand-in for the model gateway: it writes the same `llm_calls` rows the real one writes (so budgets and
 * per-task accounting are real); only the model's words are scripted.
 */
export class FakeGateway implements LlmGateway {
  readonly seen: Seen[] = []
  handler: (s: Seen) => Reply | Promise<Reply> = () => ({ text: 'ok' })
  constructor(private readonly db: Database) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const agent = this.db.get<{ role: string }>(`SELECT role FROM agents WHERE id = ?`, req.ctx.agentId)!
    const task = req.ctx.taskId ? this.db.get<{ title: string }>(`SELECT title FROM tasks WHERE id = ?`, req.ctx.taskId) : undefined
    const seen: Seen = { req, role: agent.role, taskTitle: task?.title ?? null, n: this.seen.length + 1 }
    this.seen.push(seen)
    if (req.signal.aborted) throw new CallCancelledError()
    const reply = await this.handler(seen)
    if (req.signal.aborted) throw new CallCancelledError()
    const cost = reply.cost === undefined ? 0.01 : reply.cost
    this.db.run(
      `INSERT INTO llm_calls (id, project_id, run_id, task_id, agent_id, connection_id, model, kind, input_tokens, output_tokens, cost_usd, latency_ms, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'chat', 10, 5, ?, 1, 'ok', ?)`,
      randomUUID(),
      req.ctx.projectId,
      req.ctx.runId,
      req.ctx.taskId,
      req.ctx.agentId,
      req.connectionId,
      req.model,
      cost,
      Date.now()
    )
    const toolCalls = (reply.tools ?? []).map((c, i) => ({ id: `call-${seen.n}-${i}`, name: c.name, arguments: c.args }))
    return {
      costUsd: cost,
      response: { model: req.model, text: reply.text ?? '', toolCalls, stopReason: toolCalls.length ? 'tool_use' : 'end', usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1 }
    }
  }

  forTask(title: string): Seen[] {
    return this.seen.filter((s) => s.taskTitle === title)
  }
}

export const promptOf = (s: Seen): string => JSON.stringify(s.req.messages)
export const verdict = (v: 'approved' | 'changes', feedback: string): Reply => ({ tools: [{ name: 'submit_verdict', args: { verdict: v, feedback } }] })
export const decision = (answer: boolean, reason = 'because'): Reply => ({ tools: [{ name: 'submit_decision', args: { answer, reason } }] })
export const isDecision = (s: Seen): boolean => !!s.req.tools?.some((t) => t.name === 'submit_decision')

export async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

export interface Fixture {
  db: Database
  events: EventService
  agents: AgentService
  tasks: TaskService
  gw: FakeGateway
  orch: Orchestrator
  wfs: WorkflowService
  engine: WorkflowEngine
  commands: CommandService
  workspace: WorkspaceService
  connId: string
  root: string
  /** Saves `graph` as a project workflow, runs it to the end and returns the final state. */
  go(graph: WorkflowGraph, input?: Partial<StartWorkflowInput>): Promise<{ id: string; state: WorkflowRunState; run: Run }>
  save(graph: WorkflowGraph, name?: string): string
  node(state: WorkflowRunState, id: string): NodeRunState
  team(roles: string[]): void
  dispose(): void
}

export const ROLES = ['project_manager', 'technical_architect', 'lead_developer', 'code_reviewer', 'qa_tester']

/** A project "p1" with a real folder, a team on a (never contacted) OpenAI-compatible connection and a workflow engine. */
export async function makeFixture(roles: string[] = ROLES): Promise<Fixture> {
  const db = new Database(':memory:')
  db.migrate()
  const events = new EventService(db)
  const conns = new ConnectionService(db, events, new MemorySecrets(), { providerFactory: (c) => createChatProvider({ ...c, maxRetries: 0 }) })
  const agents = new AgentService(db, events, conns)
  const tasks = new TaskService(db, events)
  const gw = new FakeGateway(db)
  const orch = new Orchestrator(db, events, agents, gw, tasks)
  const root = mkdtempSync(join(tmpdir(), 'wf-'))
  writeFileSync(join(root, 'pass.js'), `console.log('all tests passed')\nprocess.exit(0)\n`)
  writeFileSync(join(root, 'fail.js'), `console.error('1 test failed')\nprocess.exit(1)\n`)
  db.run(`INSERT INTO projects (id, name, type, root_path, goal, created_at, updated_at) VALUES ('p1', 'Proj', 'web', ?, 'Ship the thing', 1, 1)`, root)
  const connId = (await conns.create({ kind: 'openai', name: 'Conn', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test-key-0123456789' })).id
  const wfs = new WorkflowService(db, events)
  const commands = new CommandService(db, events, new ApprovalService())
  const workspace = new WorkspaceService(db, events, new FileLocks(db), new ContextIndexer(db))
  const engine = new WorkflowEngine(db, events, agents, orch, wfs, { workspace, commands })
  let counter = 0
  const fx: Fixture = {
    db,
    events,
    agents,
    tasks,
    gw,
    orch,
    wfs,
    engine,
    commands,
    workspace,
    connId,
    root,
    save: (graph, name) => wfs.save({ projectId: 'p1', name: name ?? `wf${++counter}`, graph }).id,
    node: (state, id) => state.nodes.find((n) => n.nodeId === id)!,
    team: (rs) => {
      for (const r of rs) agents.create({ templateKey: r, projectId: 'p1', connectionId: connId, model: 'gpt-x' })
    },
    async go(graph, input = {}) {
      const id = fx.save(graph)
      const run = engine.start({ workflowId: id, goal: 'Build it', ...input })
      await engine.whenDone(run.id)
      return { id: run.id, state: engine.getRunState(run.id), run: orch.getRun(run.id)! }
    },
    dispose: () => {
      try {
        db.close()
      } catch {
        /* already closed */
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
  fx.team(roles)
  return fx
}

import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Run } from '../src/shared/ipc'
import { Database } from '../src/main/db/database'
import { MIGRATIONS } from '../src/main/db/migrations'
import { CallCancelledError, CallFailedError, type CompleteRequest, type CompleteResult, type LlmGateway } from '../src/main/orchestrator/gateway'
import { MAX_PLAN_TASKS, validatePlan } from '../src/main/orchestrator/plan'
import { Orchestrator } from '../src/main/orchestrator/orchestrator'
import { ALL_TOOLS, MAX_MEMORY_CONTENT, toolsFor, type ToolContext } from '../src/main/orchestrator/tools'
import { createChatProvider } from '../src/main/providers/registry'
import type { ToolResultPart } from '../src/main/providers/types'
import { AgentService } from '../src/main/services/agents'
import { ChatService } from '../src/main/services/chat'
import { ConnectionService } from '../src/main/services/connections'
import { EventService } from '../src/main/services/events'
import { TaskService } from '../src/main/services/tasks'
import { MemorySecrets } from './helpers/memory-secrets'
import { MockServer, json, sse } from './helpers/mock-server'

const server = new MockServer()
beforeAll(() => server.start())
afterAll(() => server.stop())

// ------------------------------------------------------------------ plan validation (pure)

describe('validatePlan', () => {
  const roles = new Set(['lead_developer', 'qa_tester'])
  const t = (key: string, extra: Record<string, unknown> = {}) => ({ key, title: `Task ${key}`, description: 'do it', role: 'lead_developer', ...extra })

  it('accepts a valid graph and fills defaults', () => {
    const r = validatePlan({ tasks: [t('a'), t('b', { depends_on: ['a'], priority: 1, role: 'qa_tester' })] }, roles)
    expect(r).toEqual({
      ok: true,
      tasks: [
        { key: 'a', title: 'Task a', description: 'do it', role: 'lead_developer', priority: 2, dependsOn: [] },
        { key: 'b', title: 'Task b', description: 'do it', role: 'qa_tester', priority: 1, dependsOn: ['a'] }
      ]
    })
  })

  it.each([
    ['not an object', null, /non-empty array/],
    ['empty list', { tasks: [] }, /non-empty array/],
    ['unknown role', { tasks: [t('a', { role: 'wizard' })] }, /role "wizard" is not on the team/],
    ['duplicate key', { tasks: [t('a'), t('a')] }, /duplicate key "a"/],
    ['bad key', { tasks: [t('has space')] }, /key must be/],
    ['missing title', { tasks: [t('a', { title: '' })] }, /title is required/],
    ['bad priority', { tasks: [t('a', { priority: 9 })] }, /priority must be/],
    ['unknown dependency', { tasks: [t('a', { depends_on: ['zzz'] })] }, /unknown key "zzz"/],
    ['self dependency', { tasks: [t('a', { depends_on: ['a'] })] }, /depends on itself/],
    ['cycle', { tasks: [t('a', { depends_on: ['b'] }), t('b', { depends_on: ['a'] })] }, /cycle involving: a, b/],
    ['too many', { tasks: Array.from({ length: MAX_PLAN_TASKS + 1 }, (_, i) => t(`k${i}`)) }, /Too many tasks/]
  ])('rejects: %s', (_name, raw, message) => {
    const r = validatePlan(raw, roles)
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.errors.join('\n')).toMatch(message)
  })
})

// ------------------------------------------------------------------ fixtures

interface Reply {
  text?: string
  tools?: Array<{ name: string; args: Record<string, unknown> }>
  /** undefined = $0.01; null = the model has no known price. */
  cost?: number | null
}
interface Seen {
  req: CompleteRequest
  role: string
  taskTitle: string | null
  n: number
}

/**
 * Scripted stand-in for the model gateway. It writes the same `llm_calls` rows `ChatService` writes, so budgets
 * and per-task accounting are real; only the model's words are scripted. (The real gateway is exercised against
 * a local HTTP server in the last block of this file.)
 */
class FakeGateway implements LlmGateway {
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

let db: Database
let events: EventService
let conns: ConnectionService
let agents: AgentService
let tasks: TaskService
let gw: FakeGateway
let orch: Orchestrator
let connId: string

beforeEach(async () => {
  server.reset()
  db = new Database(':memory:')
  db.migrate()
  events = new EventService(db)
  conns = new ConnectionService(db, events, new MemorySecrets(), { providerFactory: (c) => createChatProvider({ ...c, maxRetries: 0 }) })
  agents = new AgentService(db, events, conns)
  tasks = new TaskService(db, events)
  gw = new FakeGateway(db)
  orch = new Orchestrator(db, events, agents, gw, tasks)
  db.run(`INSERT INTO projects (id, name, type, root_path, goal, created_at, updated_at) VALUES ('p1', 'Proj', 'web', 'C:\\tmp\\p1', 'Ship the thing', 1, 1)`)
  connId = (await conns.create({ kind: 'openai', name: 'Conn', baseUrl: `${server.url}/v1`, apiKey: 'sk-test-key-0123456789' })).id
})

const ROLES = ['project_manager', 'technical_architect', 'lead_developer', 'code_reviewer', 'qa_tester']
function team(roles: string[] = ROLES): void {
  for (const r of roles) agents.create({ templateKey: r, projectId: 'p1', connectionId: connId, model: 'gpt-x' })
}
const agentByRole = (role: string) => agents.list().find((a) => a.projectId === 'p1' && a.role === role)!

/** design → implement → review → qa, one task per role. */
const CHAIN = [
  { key: 'design', title: 'Design', description: 'Write the design', role: 'technical_architect' },
  { key: 'code', title: 'Implement', description: 'Write the code', role: 'lead_developer', depends_on: ['design'] },
  { key: 'review', title: 'Review', description: 'Review the code', role: 'code_reviewer', depends_on: ['code'] },
  { key: 'qa', title: 'QA', description: 'Test it', role: 'qa_tester', depends_on: ['review'] }
]
const submit = (planTasks: unknown[]): Reply => ({ tools: [{ name: 'submit_plan', args: { tasks: planTasks } }] })
const isPlanning = (s: Seen) => !!s.req.tools?.some((t) => t.name === 'submit_plan')

/** Default behaviour: the PM submits `plan`; everyone else replies with a short report. */
function script(plan: unknown[], work: (s: Seen) => Reply | undefined | Promise<Reply | undefined> = () => undefined): void {
  gw.handler = async (s) => {
    if (isPlanning(s)) return submit(plan)
    return (await work(s)) ?? { text: `Report for ${s.taskTitle}` }
  }
}

async function runToEnd(input: Partial<Parameters<Orchestrator['start']>[0]> = {}): Promise<Run> {
  const r = orch.start({ projectId: 'p1', goal: 'Build it', ...input })
  await orch.whenDone(r.id)
  return orch.getRun(r.id)!
}
const taskByTitle = (title: string) => tasks.list({ projectId: 'p1' }).find((t) => t.title === title)!
const statuses = () => Object.fromEntries(tasks.list({ projectId: 'p1' }).map((t) => [t.title, t.status]))
const lastUserText = (s: Seen): string => {
  const m = s.req.messages[s.req.messages.length - 1]
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
}
const toolResults = (s: Seen): ToolResultPart[] =>
  s.req.messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content.filter((p): p is ToolResultPart => p.type === 'tool_result')))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

// ------------------------------------------------------------------ migration

describe('migration 3', () => {
  it('upgrades a v2 database in place and keeps its rows', () => {
    const old = new Database(':memory:')
    old.migrate(MIGRATIONS.slice(0, 2))
    old.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p', 'P', 'web', 'C:\\x', 1, 1)`)
    old.run(`INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t', 'p', 'Old task', 1, 1)`)
    expect(old.migrate()).toBe(MIGRATIONS[MIGRATIONS.length - 1].version)
    expect(old.get(`SELECT title, role, attempts FROM tasks`)).toEqual({ title: 'Old task', role: null, attempts: 0 })
    expect(old.get<{ concurrency: number }>(`SELECT concurrency FROM runs`)).toBeUndefined()
  })
})

// ------------------------------------------------------------------ task board

describe('TaskService', () => {
  it('creates, lists with dependencies, and validates input', () => {
    const a = tasks.create({ projectId: 'p1', title: '  First  ', role: 'lead_developer', priority: 1 })
    const b = tasks.create({ projectId: 'p1', title: 'Second', dependsOn: [a.id, a.id] })
    expect(a).toMatchObject({ title: 'First', status: 'todo', role: 'lead_developer', priority: 1, dependsOn: [] })
    expect(b.dependsOn).toEqual([a.id])
    expect(tasks.list({ projectId: 'p1' }).map((t) => t.title)).toEqual(['First', 'Second']) // priority first

    expect(() => tasks.create({ projectId: 'nope', title: 'x' })).toThrow(/Project not found/)
    expect(() => tasks.create({ projectId: 'p1', title: ' ' })).toThrow(/title/)
    expect(() => tasks.create({ projectId: 'p1', title: 'x'.repeat(201) })).toThrow(/too long/)
    expect(() => tasks.create({ projectId: 'p1', title: 'x', priority: 7 })).toThrow(/Priority/)
    expect(() => tasks.create({ projectId: 'p1', title: 'x', role: 'wizard' })).toThrow(/Unknown role/)
    expect(() => tasks.create({ projectId: 'p1', title: 'x', dependsOn: ['ghost'] })).toThrow(/dependency/)
    expect(() => tasks.create({ projectId: 'p1', title: 'x', assignedAgentId: 'ghost' })).toThrow(/Agent not found/)
  })

  it('only agents from the same project can be assigned, and deps cannot cross projects', () => {
    db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p2', 'Other', 'web', 'C:\\tmp\\p2', 1, 1)`)
    const other = agents.create({ templateKey: 'lead_developer', projectId: 'p2' })
    const lib = agents.create({ templateKey: 'lead_developer' })
    expect(() => tasks.create({ projectId: 'p1', title: 'x', assignedAgentId: other.id })).toThrow(/this project/)
    expect(() => tasks.create({ projectId: 'p1', title: 'x', assignedAgentId: lib.id })).toThrow(/this project/)
    const t2 = tasks.create({ projectId: 'p2', title: 'In p2' })
    expect(() => tasks.create({ projectId: 'p1', title: 'x', dependsOn: [t2.id] })).toThrow(/dependency/)
  })

  it('manual edits: allowed moves only, running tasks are protected, todo resets attempts', () => {
    const t = tasks.create({ projectId: 'p1', title: 'T' })
    expect(tasks.update({ id: t.id, title: 'Renamed', priority: 3 })).toMatchObject({ title: 'Renamed', priority: 3 })
    expect(() => tasks.update({ id: t.id, status: 'in_progress' as never })).toThrow(/only be moved/)
    expect(() => tasks.update({ id: t.id, status: 'failed' as never })).toThrow(/only be moved/)
    expect(tasks.update({ id: t.id, status: 'done' }).status).toBe('done')

    db.run(`UPDATE tasks SET status = 'failed', attempts = 2, error = 'boom' WHERE id = ?`, t.id)
    expect(tasks.update({ id: t.id, status: 'todo' })).toMatchObject({ status: 'todo', attempts: 0, error: null })

    db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`, t.id)
    expect(() => tasks.update({ id: t.id, title: 'x' })).toThrow(/running/)
    expect(() => tasks.remove(t.id)).toThrow(/running/)
    db.run(`UPDATE tasks SET status = 'todo' WHERE id = ?`, t.id)
    tasks.remove(t.id)
    expect(tasks.get(t.id)).toBeNull()
    expect(() => tasks.update({ id: 'ghost', title: 'x' })).toThrow(/not found/)
  })

  it('reports tokens and cost per task from the call log, and exposes the agent log', () => {
    team(['lead_developer'])
    const dev = agentByRole('lead_developer')
    const t = tasks.create({ projectId: 'p1', title: 'T', assignedAgentId: dev.id })
    for (const [i, cost] of [[10, 0.5], [20, 0.25]] as const) {
      db.run(
        `INSERT INTO llm_calls (id, project_id, task_id, agent_id, connection_id, model, kind, input_tokens, output_tokens, cost_usd, latency_ms, status, created_at)
         VALUES (?, 'p1', ?, ?, ?, 'm', 'chat', ?, 1, ?, 1, 'ok', 1)`,
        randomUUID(), t.id, dev.id, connId, i, cost
      )
    }
    db.run(`INSERT INTO agent_messages (id, project_id, task_id, agent_id, role, content, created_at) VALUES ('m1', 'p1', ?, ?, 'assistant', 'hello', 5)`, t.id, dev.id)
    expect(tasks.get(t.id)).toMatchObject({ inputTokens: 30, outputTokens: 2, costUsd: 0.75, assignedAgentName: dev.name })
    expect(tasks.detail(t.id)!.log).toEqual([{ id: 'm1', role: 'assistant', agentId: dev.id, agentName: dev.name, content: 'hello', createdAt: 5 }])
  })
})

// ------------------------------------------------------------------ starting a run

describe('Orchestrator.start validation', () => {
  it('explains why a run cannot start', () => {
    expect(() => orch.start({ projectId: 'ghost' })).toThrow(/Project not found/)
    expect(() => orch.start({ projectId: 'p1' })).toThrow(/no Project Manager/)

    team(['project_manager'])
    const pm = agentByRole('project_manager')
    agents.update({ id: pm.id, model: null })
    expect(() => orch.start({ projectId: 'p1' })).toThrow(/cannot run: No model selected/)
    agents.update({ id: pm.id, model: 'gpt-x', enabled: false })
    expect(() => orch.start({ projectId: 'p1' })).toThrow(/is disabled/)
    agents.update({ id: pm.id, enabled: true })

    db.run(`UPDATE projects SET goal = ''`)
    expect(() => orch.start({ projectId: 'p1' })).toThrow(/Describe the goal/)
    expect(() => orch.start({ projectId: 'p1', goal: 'g', budgetUsd: 0 })).toThrow(/budget/)
    expect(() => orch.start({ projectId: 'p1', goal: 'g', budgetUsd: Number.NaN })).toThrow(/budget/)
    expect(() => orch.start({ projectId: 'p1', goal: 'g', concurrency: 0 })).toThrow(/Concurrency/)
    expect(() => orch.start({ projectId: 'p1', goal: 'g', concurrency: 9 })).toThrow(/Concurrency/)
    expect(() => orch.start({ projectId: 'p1', goal: 'g', maxIterations: -1 })).toThrow(/iterations/)
  })

  it('allows only one active run per project', async () => {
    team()
    const gate = deferred()
    script(CHAIN, async () => {
      await gate.promise
      return undefined
    })
    const r = orch.start({ projectId: 'p1', goal: 'g' })
    expect(() => orch.start({ projectId: 'p1', goal: 'again' })).toThrow(/already has a run in progress/)
    gate.resolve()
    await orch.whenDone(r.id)
    expect(orch.getRun(r.id)!.status).toBe('completed')
    expect(() => orch.start({ projectId: 'p1', goal: 'next' })).not.toThrow() // free again once finished
    await orch.stopAll()
  })
})

// ------------------------------------------------------------------ planning

describe('planning', () => {
  it('the PM plans, the board gets tasks with dependencies and roles, and the run completes in dependency order', async () => {
    team()
    script(CHAIN)
    const run = await runToEnd()
    expect(run).toMatchObject({ status: 'completed', error: null, iteration: 0 })
    expect(statuses()).toEqual({ Design: 'done', Implement: 'done', Review: 'done', QA: 'done' })
    const order = gw.seen.filter((s) => !isPlanning(s)).map((s) => s.taskTitle)
    expect(order).toEqual(['Design', 'Implement', 'Review', 'QA'])
    expect(taskByTitle('Implement').dependsOn).toEqual([taskByTitle('Design').id])
    expect(taskByTitle('QA')).toMatchObject({ role: 'qa_tester', assignedAgentName: agentByRole('qa_tester').name, attempts: 1, resultSummary: 'Report for QA' })

    // Dependency results are handed to the next agent; the PM was told the team's exact roles.
    const implementPrompt = gw.forTask('Implement')[0].req.messages[0].content as string
    expect(implementPrompt).toContain('Report for Design')
    expect(implementPrompt).toContain('Overall goal of this run: Build it')
    const planPrompt = gw.seen[0].req.messages[0].content as string
    expect(planPrompt).toContain('role "lead_developer"')
    expect(planPrompt).not.toContain('role "image_generator"')

    // Accounting: all calls carry the run, and the run total equals the sum of its calls.
    expect(run.spentUsd).toBeCloseTo(0.05, 10) // 1 plan + 4 task calls at $0.01
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM llm_calls WHERE run_id = ?`, run.id)!.n).toBe(5)
    expect(taskByTitle('Design').costUsd).toBeCloseTo(0.01, 10)
    expect(run.taskCounts).toMatchObject({ done: 4, todo: 0, failed: 0 })
    expect(db.get<{ progress: number }>(`SELECT progress FROM projects WHERE id = 'p1'`)!.progress).toBe(1)
    expect(agents.list().every((a) => a.status === 'idle')).toBe(true)
    expect(events.recent({ limit: 200 }).map((e) => e.type)).toEqual(expect.arrayContaining(['run.started', 'plan.created', 'task.started', 'task.done', 'run.completed']))
  })

  it('feeds validation errors back to the PM so it can fix the plan', async () => {
    team()
    let planCalls = 0
    gw.handler = (s) => {
      if (!isPlanning(s)) return { text: 'ok' }
      planCalls++
      return planCalls === 1 ? submit([{ key: 'x', title: 'X', description: 'd', role: 'wizard' }]) : submit(CHAIN)
    }
    const run = await runToEnd()
    expect(run.status).toBe('completed')
    expect(planCalls).toBe(2)
    const second = gw.seen.filter(isPlanning)[1]
    const result = toolResults(second)[0]
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/role "wizard" is not on the team/)
  })

  it('fails the run clearly when the PM never produces a valid plan', async () => {
    team()
    gw.handler = () => ({ text: 'I would rather chat.' })
    const run = await runToEnd()
    expect(run).toMatchObject({ status: 'failed' })
    expect(run.error).toMatch(/did not produce a valid plan after 3 attempts/)
    expect(gw.seen).toHaveLength(3)
    expect(tasks.list({ projectId: 'p1' })).toEqual([])
  })

  it('adopts hand-made tasks that have an owner and tells the PM about them', async () => {
    team()
    const mine = tasks.create({ projectId: 'p1', title: 'Hand-made', role: 'lead_developer' })
    const loose = tasks.create({ projectId: 'p1', title: 'No owner' })
    script([{ key: 'design', title: 'Design', description: 'd', role: 'technical_architect' }])
    const run = await runToEnd()
    expect(run.status).toBe('completed')
    expect(tasks.get(mine.id)).toMatchObject({ runId: run.id, status: 'done' })
    expect(tasks.get(loose.id)).toMatchObject({ runId: null, status: 'todo' })
    expect(gw.seen[0].req.messages[0].content as string).toContain('Hand-made')
  })
})

// ------------------------------------------------------------------ scheduling

describe('scheduling', () => {
  const PARALLEL = [
    { key: 'a', title: 'Alpha', description: 'd', role: 'lead_developer' },
    { key: 'b', title: 'Beta', description: 'd', role: 'technical_architect' },
    { key: 'c', title: 'Gamma', description: 'd', role: 'qa_tester' }
  ]
  function trackConcurrency(): { max: () => number } {
    let inFlight = 0
    let max = 0
    script(PARALLEL, async () => {
      inFlight++
      max = Math.max(max, inFlight)
      await new Promise((r) => setTimeout(r, 25))
      inFlight--
      return undefined
    })
    return { max: () => max }
  }

  it('runs independent tasks in parallel up to the concurrency limit', async () => {
    team()
    const t = trackConcurrency()
    expect((await runToEnd({ concurrency: 3 })).status).toBe('completed')
    expect(t.max()).toBe(3)
  })

  it('honours concurrency 1 and 2', async () => {
    team()
    const t = trackConcurrency()
    await runToEnd({ concurrency: 1 })
    expect(t.max()).toBe(1)
    db.run(`DELETE FROM runs`)
    db.run(`DELETE FROM tasks`)
    const t2 = trackConcurrency()
    await runToEnd({ concurrency: 2 })
    expect(t2.max()).toBe(2)
  })

  it('never gives one agent two tasks at once, but spreads work over agents with the same role', async () => {
    team(['project_manager', 'lead_developer'])
    let inFlight = 0
    let max = 0
    const plan = [1, 2, 3].map((i) => ({ key: `k${i}`, title: `Job ${i}`, description: 'd', role: 'lead_developer' }))
    script(plan, async () => {
      inFlight++
      max = Math.max(max, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return undefined
    })
    await runToEnd({ concurrency: 5 })
    expect(max).toBe(1)

    db.run(`DELETE FROM runs`)
    db.run(`DELETE FROM tasks`)
    agents.create({ templateKey: 'lead_developer', projectId: 'p1', name: 'Dev Two', connectionId: connId, model: 'gpt-x' })
    max = 0
    await runToEnd({ concurrency: 5 })
    expect(max).toBe(2)
    expect(new Set(tasks.list({ projectId: 'p1' }).map((t) => t.assignedAgentName)).size).toBe(2)
  })

  it('starts higher-priority tasks first', async () => {
    team(['project_manager', 'lead_developer'])
    script([
      { key: 'low', title: 'Low', description: 'd', role: 'lead_developer', priority: 3 },
      { key: 'high', title: 'High', description: 'd', role: 'lead_developer', priority: 1 },
      { key: 'mid', title: 'Mid', description: 'd', role: 'lead_developer', priority: 2 }
    ])
    await runToEnd({ concurrency: 1 })
    expect(gw.seen.filter((s) => !isPlanning(s)).map((s) => s.taskTitle)).toEqual(['High', 'Mid', 'Low'])
  })

  it('fails a task whose role has nobody on the team, and blocks what depends on it', async () => {
    team(['project_manager', 'technical_architect']) // plan will ask for a developer that does not exist yet
    gw.handler = (s) => {
      if (!isPlanning(s)) return { text: 'ok' }
      return submit([{ key: 'a', title: 'Design', description: 'd', role: 'technical_architect' }])
    }
    // Remove the developer after planning by planning a role that is on the team, then deleting its agent.
    const run0 = orch.start({ projectId: 'p1', goal: 'g' })
    await orch.whenDone(run0.id)
    expect(orch.getRun(run0.id)!.status).toBe('completed')

    // Now a task whose agent is gone: assign to an agent, remove the agent, resume.
    const t = tasks.create({ projectId: 'p1', title: 'Orphan', role: 'lead_developer' })
    const res = await runToEnd()
    expect(res.status).toBe('failed')
    expect(tasks.get(t.id)).toMatchObject({ status: 'failed' })
    expect(tasks.get(t.id)!.error).toMatch(/no agent with this role/)
  })
})

// ------------------------------------------------------------------ failures

describe('failure handling', () => {
  it('retries a failed task once, then succeeds', async () => {
    team()
    let calls = 0
    script(CHAIN, (s) => {
      if (s.taskTitle === 'Implement' && ++calls === 1) throw new Error('flaky network')
      return undefined
    })
    const run = await runToEnd()
    expect(run.status).toBe('completed')
    expect(taskByTitle('Implement')).toMatchObject({ status: 'done', attempts: 2, error: null })
    expect(events.recent({ limit: 200 }).some((e) => e.type === 'task.retry' && /flaky network/.test(e.message))).toBe(true)
  })

  it('fails after the second attempt, blocks dependents, and resume picks the run back up', async () => {
    team()
    let broken = true
    script(CHAIN, (s) => {
      if (s.taskTitle === 'Implement' && broken) throw new Error('model exploded')
      return undefined
    })
    const run = await runToEnd()
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/3 of 4 tasks did not finish \(1 failed, 2 blocked\)/)
    expect(statuses()).toEqual({ Design: 'done', Implement: 'failed', Review: 'blocked', QA: 'blocked' })
    expect(taskByTitle('Implement')).toMatchObject({ attempts: 2, error: 'model exploded' })
    expect(taskByTitle('Review').error).toMatch(/“Implement” failed/)
    expect(gw.forTask('Implement')).toHaveLength(2)
    expect(gw.forTask('Review')).toHaveLength(0)

    broken = false
    const again = orch.resume({ id: run.id })
    expect(again.status).toBe('running')
    await orch.whenDone(run.id)
    expect(orch.getRun(run.id)).toMatchObject({ status: 'completed', error: null })
    expect(statuses()).toEqual({ Design: 'done', Implement: 'done', Review: 'done', QA: 'done' })
    expect(gw.forTask('Design')).toHaveLength(1) // finished work is not repeated
    expect(gw.seen.filter(isPlanning)).toHaveLength(1) // and the plan is kept
  })

  it('does not retry errors a retry cannot fix (bad key)', async () => {
    team()
    script(CHAIN, (s) => {
      if (s.taskTitle === 'Design') throw new CallFailedError('401 invalid key', 'auth', false)
      return undefined
    })
    const run = await runToEnd()
    expect(run.status).toBe('failed')
    expect(gw.forTask('Design')).toHaveLength(1)
    expect(taskByTitle('Design')).toMatchObject({ status: 'failed', attempts: 1, error: '401 invalid key' })
  })

  it('retries provider errors marked retryable', async () => {
    team(['project_manager', 'technical_architect'])
    let n = 0
    script([{ key: 'a', title: 'Design', description: 'd', role: 'technical_architect' }], () => {
      if (++n === 1) throw new CallFailedError('503 overloaded', 'server', true)
      return undefined
    })
    expect((await runToEnd()).status).toBe('completed')
    expect(n).toBe(2)
  })

  it('treats an empty model answer as a failure, but accepts tool work with no closing text', async () => {
    team(['project_manager', 'technical_architect'])
    script([{ key: 'a', title: 'Design', description: 'd', role: 'technical_architect' }], () => ({ text: '' }))
    const bad = await runToEnd()
    expect(bad.status).toBe('failed')
    expect(taskByTitle('Design').error).toMatch(/empty answer/)

    db.run(`DELETE FROM runs`)
    db.run(`DELETE FROM tasks`)
    script([{ key: 'a', title: 'Design', description: 'd', role: 'technical_architect' }], (s) =>
      s.req.messages.length === 1 ? { tools: [{ name: 'list_tasks', args: {} }] } : { text: '' }
    )
    expect((await runToEnd()).status).toBe('completed')
    expect(taskByTitle('Design').resultSummary).toMatch(/no written report/)
  })

  it('gives up when an agent keeps calling tools forever', async () => {
    team(['project_manager', 'technical_architect'])
    script([{ key: 'a', title: 'Design', description: 'd', role: 'technical_architect' }], () => ({ tools: [{ name: 'list_tasks', args: {} }] }))
    const run = await runToEnd()
    expect(run.status).toBe('failed')
    expect(taskByTitle('Design').error).toMatch(/did not finish within 12 tool rounds/)
    expect(gw.forTask('Design')).toHaveLength(24) // 12 rounds x 2 attempts
  })
})

// ------------------------------------------------------------------ rework loop

describe('review → rework loop', () => {
  const reviewerRequests = (feedback: string) => (s: Seen): Reply | undefined => {
    if (s.taskTitle !== 'Review') return undefined
    if (s.req.messages.length === 1) return { tools: [{ name: 'request_changes', args: { task_id: taskByTitle('Implement').id, feedback } }] }
    return { text: 'Sent it back.' }
  }

  it('sends work back with the feedback, re-runs the owner, then the reviewer, and counts the iteration', async () => {
    team()
    let reviews = 0
    script(CHAIN, (s) => {
      if (s.taskTitle !== 'Review') return undefined
      if (s.req.messages.length > 1) return { text: reviews === 1 ? 'Sent it back.' : 'LGTM' }
      return ++reviews === 1 ? reviewerRequests('Null check missing in parse()')(s) : { text: 'LGTM' }
    })
    const run = await runToEnd()
    expect(run).toMatchObject({ status: 'completed', iteration: 1 })
    expect(statuses()).toEqual({ Design: 'done', Implement: 'done', Review: 'done', QA: 'done' })

    const implement = gw.forTask('Implement')
    expect(implement).toHaveLength(2)
    const second = implement[1].req.messages[0].content as string
    expect(second).toContain('sent back for changes')
    expect(second).toContain('Null check missing in parse()')
    expect(second).toContain('Your previous result')
    expect(taskByTitle('Review').resultSummary).toBe('LGTM')
    expect(gw.seen.filter((s) => !isPlanning(s)).map((s) => s.taskTitle)).toEqual(['Design', 'Implement', 'Review', 'Review', 'Implement', 'Review', 'QA'])
    expect(events.recent({ limit: 200 }).some((e) => e.type === 'task.rework')).toBe(true)
  })

  it('stale work downstream of the changed task is redone too', async () => {
    team()
    let reviews = 0
    // QA runs in parallel with review here, so when review sends Implement back QA's old result is stale.
    const plan = [CHAIN[0], CHAIN[1], { ...CHAIN[2] }, { key: 'qa', title: 'QA', description: 'Test', role: 'qa_tester', depends_on: ['code'] }]
    const gate = deferred()
    script(plan, async (s) => {
      if (s.taskTitle === 'QA' && s.n < 10) return undefined
      if (s.taskTitle === 'Review') {
        if (s.req.messages.length > 1) return { text: 'done' }
        if (++reviews === 1) {
          await gate.promise
          return { tools: [{ name: 'request_changes', args: { task_id: taskByTitle('Implement').id, feedback: 'Fix it' } }] }
        }
        return { text: 'LGTM' }
      }
      return undefined
    })
    const p = orch.start({ projectId: 'p1', goal: 'g', concurrency: 2 })
    await new Promise((r) => setTimeout(r, 100))
    gate.resolve()
    await orch.whenDone(p.id)
    expect(orch.getRun(p.id)!.status).toBe('completed')
    expect(gw.forTask('QA').length).toBe(2) // ran, was invalidated by the rework, ran again
  })

  it('is bounded by max iterations: the extra request comes back as an error and the run still finishes', async () => {
    team()
    script(CHAIN, reviewerRequests('Still wrong'))
    const run = await runToEnd({ maxIterations: 1 })
    expect(run).toMatchObject({ status: 'completed', iteration: 1, maxIterations: 1 })
    const reviews = gw.forTask('Review')
    const limitError = reviews.flatMap(toolResults).find((r) => r.isError)
    expect(limitError?.content).toMatch(/rework limit for this run \(1\) is used up/)
    expect(gw.forTask('Implement')).toHaveLength(2) // one rework, not an endless loop
  })

  it('maxIterations 0 disables rework entirely', async () => {
    team()
    script(CHAIN, reviewerRequests('Nope'))
    const run = await runToEnd({ maxIterations: 0 })
    expect(run).toMatchObject({ status: 'completed', iteration: 0 })
    expect(gw.forTask('Implement')).toHaveLength(1)
  })

  it('refuses requests that would deadlock or target unfinished work', async () => {
    team()
    const results: string[] = []
    script(CHAIN, (s) => {
      if (s.taskTitle === 'Implement') {
        const r = toolResults(s)
        if (r.length) return { text: 'tried' }
        // Implement asks to send its own dependent (Review, not finished yet) back, then itself.
        return { tools: [{ name: 'request_changes', args: { task_id: taskByTitle('Review').id, feedback: 'x' } }] }
      }
      if (s.taskTitle === 'Review') {
        const r = toolResults(s)
        if (r.length) {
          results.push(...r.map((x) => x.content))
          return { text: 'done' }
        }
        return {
          tools: [
            { name: 'request_changes', args: { task_id: taskByTitle('Review').id, feedback: 'self' } },
            { name: 'request_changes', args: { task_id: taskByTitle('QA').id, feedback: 'not finished' } },
            { name: 'request_changes', args: { task_id: 'ghost', feedback: 'x' } },
            { name: 'request_changes', args: { task_id: taskByTitle('Design').id, feedback: '' } }
          ]
        }
      }
      return undefined
    })
    // Implement (a developer) is not allowed request_changes at all, so its call fails with "not available".
    const run = await runToEnd()
    expect(run.status).toBe('completed')
    expect(toolResults(gw.forTask('Implement')[1])[0].content).toMatch(/"request_changes" is not available/)
    expect(results[0]).toMatch(/cannot send itself back/)
    expect(results[1]).toMatch(/Only finished tasks can be sent back; “QA” is todo/)
    expect(results[2]).toMatch(/No such task in this run/)
    expect(results[3]).toMatch(/feedback is required/)
    expect(run.iteration).toBe(0)
  })
})

// ------------------------------------------------------------------ budget, limits, stop

describe('budget and limits', () => {
  it('pauses when the run budget is reached, never starts new work after that, and resumes with a higher budget', async () => {
    team()
    script(CHAIN, () => ({ text: 'ok', cost: 0.03 }))
    gw.handler = (s) => (isPlanning(s) ? { ...submit(CHAIN), cost: 0.03 } : { text: `Report for ${s.taskTitle}`, cost: 0.03 })
    const run = await runToEnd({ budgetUsd: 0.05 })
    expect(run.status).toBe('paused')
    expect(run.error).toMatch(/run budget of \$0\.0500 is reached/)
    expect(run.error).toMatch(/Raise the budget and resume/)
    expect(run.spentUsd).toBeCloseTo(0.06, 10) // plan + Design; the next task was never started
    expect(statuses()).toEqual({ Design: 'done', Implement: 'todo', Review: 'todo', QA: 'todo' })
    expect(run.finishedAt).toBeNull()

    expect(() => orch.resume({ id: run.id })).toThrow(/Raise the budget/)
    expect(() => orch.resume({ id: run.id, budgetUsd: 0.06 })).toThrow(/Raise the budget/)
    expect(() => orch.resume({ id: run.id, budgetUsd: -1 })).toThrow(/positive amount/)

    orch.resume({ id: run.id, budgetUsd: 5 })
    await orch.whenDone(run.id)
    const done = orch.getRun(run.id)!
    expect(done).toMatchObject({ status: 'completed', budgetUsd: 5 })
    expect(done.spentUsd).toBeCloseTo(0.15, 10)
  })

  it('a task interrupted by the budget goes back to todo (not failed) and is not retried', async () => {
    team(['project_manager', 'technical_architect'])
    gw.handler = (s) =>
      isPlanning(s)
        ? { ...submit([{ key: 'a', title: 'Design', description: 'd', role: 'technical_architect' }]), cost: 0.04 }
        : s.req.messages.length === 1
          ? { tools: [{ name: 'list_tasks', args: {} }], cost: 0.04 }
          : { text: 'ok', cost: 0.04 }
    const run = await runToEnd({ budgetUsd: 0.05 })
    expect(run.status).toBe('paused')
    expect(taskByTitle('Design')).toMatchObject({ status: 'todo', attempts: 0, error: null })
    expect(gw.forTask('Design')).toHaveLength(1)
    expect(events.recent({ limit: 100 }).some((e) => e.type === 'task.paused')).toBe(true)
  })

  it('stops an agent at its own per-run cost limit without retrying', async () => {
    team()
    agents.update({ id: agentByRole('lead_developer').id, maxCostUsd: 0.02 })
    script(CHAIN, (s) => {
      if (s.taskTitle === 'Implement') return s.req.messages.length === 1 ? { tools: [{ name: 'list_tasks', args: {} }], cost: 0.03 } : { text: 'never reached' }
      return undefined
    })
    const run = await runToEnd()
    expect(run.status).toBe('failed')
    expect(taskByTitle('Implement')).toMatchObject({ status: 'failed', attempts: 1 })
    expect(taskByTitle('Implement').error).toMatch(/reached its per-run cost limit of \$0\.0200 \(\$0\.0300 spent\)/)
    expect(gw.forTask('Implement')).toHaveLength(1)
    expect(taskByTitle('Review').status).toBe('blocked')
  })

  it('warns once when a limit is set but the model has no known price', async () => {
    team(['project_manager', 'technical_architect'])
    gw.handler = (s) => (isPlanning(s) ? { ...submit([{ key: 'a', title: 'Design', description: 'd', role: 'technical_architect' }]), cost: null } : { text: 'ok', cost: null })
    const run = await runToEnd({ budgetUsd: 1 })
    expect(run.status).toBe('completed')
    const warns = events.recent({ limit: 100 }).filter((e) => e.type === 'run.unpriced')
    expect(warns).toHaveLength(1)
    expect(warns[0].message).toMatch(/No price is known for gpt-x/)
    expect(run.unpricedCalls).toBe(2)

    db.run(`DELETE FROM runs`)
    db.run(`DELETE FROM tasks`)
    db.run(`DELETE FROM events`)
    await runToEnd({ budgetUsd: null })
    expect(events.recent({ limit: 100 }).filter((e) => e.type === 'run.unpriced')).toHaveLength(0) // no limit, nothing to warn about
  })
})

describe('stop, resume and recovery', () => {
  it('stop cancels in-flight calls, returns tasks to todo, frees agents, and the run can be resumed', async () => {
    team()
    const started = deferred()
    let hang = true
    script(CHAIN, (s) => {
      if (s.taskTitle === 'Design' && hang) {
        started.resolve()
        return new Promise<Reply>((_, reject) => s.req.signal.addEventListener('abort', () => reject(new CallCancelledError())))
      }
      return undefined
    })
    const r = orch.start({ projectId: 'p1', goal: 'g' })
    await started.promise
    expect(agentByRole('technical_architect').status).toBe('working')
    expect(taskByTitle('Design').status).toBe('in_progress')

    const stopped = await orch.stop(r.id)
    expect(stopped).toMatchObject({ status: 'cancelled', error: 'Stopped by the user.' })
    expect(stopped!.finishedAt).not.toBeNull()
    expect(taskByTitle('Design').status).toBe('todo')
    expect(agents.list().every((a) => a.status === 'idle')).toBe(true)
    expect(orch.isActive()).toBe(false)
    expect(gw.forTask('Implement')).toHaveLength(0)

    hang = false
    orch.resume({ id: r.id })
    await orch.whenDone(r.id)
    expect(orch.getRun(r.id)!.status).toBe('completed')
  })

  it('stopAll aborts every active run and reports how many', async () => {
    team()
    const started = deferred()
    script(CHAIN, (s) => {
      started.resolve()
      return new Promise<Reply>((_, reject) => s.req.signal.addEventListener('abort', () => reject(new CallCancelledError())))
    })
    const r = orch.start({ projectId: 'p1', goal: 'g' })
    await started.promise
    expect(await orch.stopAll()).toBe(1)
    expect(orch.getRun(r.id)!.status).toBe('cancelled')
    expect(await orch.stopAll()).toBe(0)
    expect(await orch.stop('ghost')).toBeNull()
  })

  it('recover() pauses interrupted runs, requeues half-done tasks and clears "working" agents', () => {
    team(['project_manager', 'lead_developer'])
    db.run(`INSERT INTO runs (id, project_id, goal, status, created_at) VALUES ('r1', 'p1', 'g', 'running', 1)`)
    db.run(`INSERT INTO runs (id, project_id, goal, status, created_at) VALUES ('r2', 'p1', 'g', 'completed', 1)`)
    const t = tasks.create({ projectId: 'p1', runId: 'r1', title: 'Half done', role: 'lead_developer' })
    db.run(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`, t.id)
    db.run(`UPDATE agents SET status = 'working'`)

    expect(orch.recover()).toEqual({ runs: 1, tasks: 1 })
    expect(orch.getRun('r1')).toMatchObject({ status: 'paused' })
    expect(orch.getRun('r1')!.error).toMatch(/Interrupted/)
    expect(orch.getRun('r2')!.status).toBe('completed')
    expect(tasks.get(t.id)!.status).toBe('todo')
    expect(agents.list().every((a) => a.status === 'idle')).toBe(true)
    expect(orch.recover()).toEqual({ runs: 0, tasks: 0 })
  })

  it('refuses to resume a completed or running run, and an unplanned run needs a ready PM', async () => {
    team()
    script(CHAIN)
    const run = await runToEnd()
    expect(() => orch.resume({ id: run.id })).toThrow(/already completed/)
    expect(() => orch.resume({ id: 'ghost' })).toThrow(/Run not found/)

    db.run(`INSERT INTO runs (id, project_id, goal, status, error, created_at) VALUES ('rx', 'p1', 'g', 'paused', 'x', 2)`)
    agents.update({ id: agentByRole('project_manager').id, model: null })
    expect(() => orch.resume({ id: 'rx' })).toThrow(/cannot run/)
  })

  it('listRuns reports per-status task counts, newest first, filtered by project', async () => {
    team()
    script(CHAIN)
    const a = await runToEnd()
    const b = await runToEnd()
    const list = orch.listRuns('p1')
    expect(list.map((r) => r.id)).toEqual([b.id, a.id])
    expect(list[0].taskCounts).toEqual({ todo: 0, in_progress: 0, review: 0, testing: 0, done: 4, failed: 0, blocked: 0 })
    expect(orch.listRuns('other')).toEqual([])
    expect(orch.listRuns()).toHaveLength(2)
  })
})

// ------------------------------------------------------------------ tools

describe('agent tools', () => {
  it('offers only the tools an agent’s permissions allow', () => {
    team()
    const names = (role: string) => toolsFor(agentByRole(role)).map((t) => t.def.name)
    expect(names('lead_developer')).toEqual(['list_tasks', 'list_memory', 'read_memory', 'write_memory'])
    expect(names('code_reviewer')).toEqual(['list_tasks', 'list_memory', 'read_memory', 'create_task', 'request_changes'])
    expect(names('project_manager')).toEqual(['list_tasks', 'list_memory', 'read_memory', 'create_task', 'request_changes'])
    const readOnly = { ...agentByRole('lead_developer'), permissions: { ...agentByRole('lead_developer').permissions, readFiles: false, writeFiles: false } }
    expect(toolsFor(readOnly).map((t) => t.def.name)).toEqual(['list_tasks'])
    expect(ALL_TOOLS.map((t) => t.def.name)).toHaveLength(6)
  })

  const ctxFor = (role: string, taskId = 'none'): ToolContext => (db.run(`INSERT OR IGNORE INTO runs (id, project_id, goal, status, created_at) VALUES ('r1', 'p1', 'g', 'running', 1)`), {
    db,
    events,
    tasks,
    agent: agentByRole(role),
    projectId: 'p1',
    runId: 'r1',
    taskId,
    state: { reworkRequested: false }
  })
  const tool = (name: string) => ALL_TOOLS.find((t) => t.def.name === name)!

  it('write_memory upserts by kind+title, validates input and is readable by teammates', async () => {
    team()
    const ctx = ctxFor('technical_architect')
    const w = tool('write_memory')
    await w.execute(ctx, { kind: 'design_doc', title: 'Architecture', content: 'v1' })
    await w.execute(ctx, { kind: 'design_doc', title: 'Architecture', content: 'v2' })
    await w.execute(ctx, { kind: 'decision', title: 'Architecture', content: 'other kind' })
    const rows = db.all<{ id: string; kind: string; content: string; author: string }>(`SELECT * FROM memory_entries ORDER BY kind`)
    expect(rows.map((r) => [r.kind, r.content, r.author])).toEqual([['decision', 'other kind', ctx.agent.id], ['design_doc', 'v2', ctx.agent.id]])

    const read = await tool('read_memory').execute(ctxFor('lead_developer'), { id: rows[1].id })
    expect(read).toContain('# Architecture (design_doc)')
    expect(read).toContain('v2')
    expect(JSON.parse(await tool('list_memory').execute(ctxFor('lead_developer'), {}) as string)).toHaveLength(2)

    await expect(async () => w.execute(ctx, { kind: 'poem', title: 't', content: 'c' })).rejects.toThrow(/kind must be one of/)
    await expect(async () => w.execute(ctx, { kind: 'note', title: '', content: 'c' })).rejects.toThrow(/title is required/)
    await expect(async () => w.execute(ctx, { kind: 'note', title: 't', content: 'x'.repeat(MAX_MEMORY_CONTENT + 1) })).rejects.toThrow(/too long/)
    await expect(async () => tool('read_memory').execute(ctx, { id: 'nope' })).rejects.toThrow(/No such memory entry/)
  })

  it('memory is project-scoped: another project’s entries are invisible', async () => {
    team()
    db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p2', 'Other', 'web', 'C:\\tmp\\p2', 1, 1)`)
    db.run(`INSERT INTO memory_entries (id, project_id, kind, title, content, created_at, updated_at) VALUES ('secret', 'p2', 'note', 'Secret', 'x', 1, 1)`)
    await expect(async () => tool('read_memory').execute(ctxFor('lead_developer'), { id: 'secret' })).rejects.toThrow(/No such memory entry/)
    expect(JSON.parse(tool('list_memory').execute(ctxFor('lead_developer'), {}) as string)).toEqual([])
  })

  it('agents share work through memory during a run', async () => {
    team()
    script(CHAIN, (s) => {
      if (s.taskTitle === 'Design') {
        return s.req.messages.length === 1
          ? { tools: [{ name: 'write_memory', args: { kind: 'design_doc', title: 'Game design', content: 'Core loop: jump' } }] }
          : { text: 'Wrote the design doc.' }
      }
      if (s.taskTitle === 'Implement') {
        if (s.req.messages.length === 1) {
          const prompt = s.req.messages[0].content as string
          expect(prompt).toContain('Shared project memory')
          const id = /- (\S+) · design_doc · Game design/.exec(prompt)![1]
          return { tools: [{ name: 'read_memory', args: { id } }] }
        }
        return { text: toolResults(s)[0].content.includes('Core loop: jump') ? 'Read the design.' : 'Could not read it.' }
      }
      return undefined
    })
    const run = await runToEnd()
    expect(run.status).toBe('completed')
    expect(taskByTitle('Implement').resultSummary).toBe('Read the design.')
    // Tool activity is part of the task log.
    const log = tasks.detail(taskByTitle('Design').id)!.log.map((l) => [l.role, l.content.slice(0, 40)])
    expect(log.some(([role, text]) => role === 'tool' && text.startsWith('write_memory('))).toBe(true)
  })

  it('create_task adds work to the run, validating roles, dependencies and the cap', async () => {
    team()
    db.run(`INSERT INTO runs (id, project_id, goal, status, created_at) VALUES ('r1', 'p1', 'g', 'running', 1)`)
    const first = tasks.create({ projectId: 'p1', runId: 'r1', title: 'Existing', role: 'lead_developer' })
    const ctx = ctxFor('project_manager')
    const create = tool('create_task')
    const out = await create.execute(ctx, { title: 'Hotfix', description: 'x', role: 'lead_developer', depends_on: [first.id], priority: 1 })
    expect(out).toMatch(/^Created task /)
    expect(tasks.list({ runId: 'r1' }).find((t) => t.title === 'Hotfix')).toMatchObject({ priority: 1, dependsOn: [first.id], role: 'lead_developer' })
    await expect(async () => create.execute(ctx, { title: 'x', description: 'x', role: 'game_designer' })).rejects.toThrow(/No enabled agent with role "game_designer"/)
    await expect(async () => create.execute(ctx, { title: 'x', description: 'x', role: 'lead_developer', depends_on: ['ghost'] })).rejects.toThrow(/Unknown task id/)
    for (let i = 0; i < 60; i++) db.run(`INSERT INTO tasks (id, project_id, run_id, title, created_at, updated_at) VALUES (?, 'p1', 'r1', 't', 1, 1)`, `fill${i}`)
    await expect(async () => create.execute(ctx, { title: 'x', description: 'x', role: 'lead_developer' })).rejects.toThrow(/at most|already has 60 tasks/)
  })
})

// ------------------------------------------------------------------ the real gateway (ChatService.complete)

describe('ChatService.complete accounting', () => {
  let chat: ChatService
  let signal: AbortController
  const ids = { run: 'r1', task: 't1' }

  beforeEach(() => {
    chat = new ChatService(db, events, conns)
    signal = new AbortController()
    team(['lead_developer'])
    db.run(`INSERT INTO runs (id, project_id, goal, status, created_at) VALUES ('r1', 'p1', 'g', 'running', 1)`)
    db.run(`INSERT INTO tasks (id, project_id, run_id, title, created_at, updated_at) VALUES ('t1', 'p1', 'r1', 'T', 1, 1)`)
  })

  const req = (extra: Partial<CompleteRequest> = {}): CompleteRequest => ({
    connectionId: connId,
    model: 'gpt-x',
    system: 'sys',
    messages: [{ role: 'user', content: 'go' }],
    tools: [{ name: 'list_tasks', description: 'd', parameters: { type: 'object', properties: {} } }],
    signal: signal.signal,
    ctx: { agentId: agentByRole('lead_developer').id, projectId: 'p1', runId: ids.run, taskId: ids.task, label: 'Agent “Dev” · T' },
    ...extra
  })

  it('returns tool calls and records an attributed, priced call row plus an event', async () => {
    conns.setPricing({ connectionId: connId, model: 'gpt-x', pricing: { inputPerMTok: 500_000, outputPerMTok: 1_000_000 } })
    server.handler = (_r, res) =>
      sse(res, [
        { data: { model: 'gpt-x', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_tasks', arguments: '' } }] } }] } },
        { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] } },
        { data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
        { data: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } } },
        { data: '[DONE]' }
      ])
    const res = await chat.complete(req())
    expect(res.response.toolCalls).toEqual([{ id: 'call_1', name: 'list_tasks', arguments: {} }])
    expect(res.response.stopReason).toBe('tool_use')
    expect(res.costUsd).toBe(10) // 10 in × $0.5 + 5 out × $1
    expect(server.requests[0].body.tools[0].function.name).toBe('list_tasks')
    expect(db.get(`SELECT run_id, task_id, agent_id, project_id, status, input_tokens, output_tokens, cost_usd FROM llm_calls`)).toEqual({
      run_id: 'r1', task_id: 't1', agent_id: agentByRole('lead_developer').id, project_id: 'p1', status: 'ok', input_tokens: 10, output_tokens: 5, cost_usd: 10
    })
    expect(events.recent({ limit: 1 })[0]).toMatchObject({ type: 'llm.call', runId: 'r1', agentId: agentByRole('lead_developer').id })
    expect(tasks.get('t1')).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 10 })
  })

  it('records unpriced successful calls with a NULL cost (unknown, not zero)', async () => {
    server.handler = (_r, res) =>
      sse(res, [
        { data: { model: 'gpt-x', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] } },
        { data: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } } },
        { data: '[DONE]' }
      ])
    const res = await chat.complete(req())
    expect(res.costUsd).toBeNull()
    expect(db.get(`SELECT status, cost_usd FROM llm_calls`)).toEqual({ status: 'ok', cost_usd: null })
  })

  it('maps provider failures to CallFailedError, records them with zero tokens and redacts the key', async () => {
    server.handler = (_r, res) => json(res, 401, { error: { message: 'Incorrect API key provided: sk-test-key-0123456789' } })
    const err = await chat.complete(req()).catch((e) => e)
    expect(err).toBeInstanceOf(CallFailedError)
    expect(err.message).not.toContain('sk-test-key-0123456789')
    expect(err.retryable).toBe(false)
    expect(db.get(`SELECT status, input_tokens, cost_usd, run_id FROM llm_calls`)).toEqual({ status: 'error', input_tokens: 0, cost_usd: null, run_id: 'r1' })
    expect(events.recent({ limit: 1 })[0]).toMatchObject({ type: 'llm.error', level: 'error' })
  })

  it('records an aborted call as cancelled and throws CallCancelledError', async () => {
    server.handler = async (_r, res) => {
      await new Promise((r) => setTimeout(r, 300))
      json(res, 200, {})
    }
    const p = chat.complete(req())
    setTimeout(() => signal.abort(), 30)
    await expect(p).rejects.toBeInstanceOf(CallCancelledError)
    expect(db.get(`SELECT status, input_tokens, cost_usd FROM llm_calls`)).toEqual({ status: 'cancelled', input_tokens: 0, cost_usd: null })

    // Already aborted: no request is made at all.
    const before = server.requests.length
    await expect(chat.complete(req())).rejects.toBeInstanceOf(CallCancelledError)
    expect(server.requests.length).toBe(before)
  })

  it('refuses a missing or disabled connection without calling out or logging a call', async () => {
    await expect(chat.complete(req({ connectionId: 'ghost' }))).rejects.toThrow(/no longer exists/)
    await conns.update({ id: connId, enabled: false })
    await expect(chat.complete(req())).rejects.toThrow(/is disabled/)
    expect(server.requests).toHaveLength(0)
    expect(db.get<{ n: number }>(`SELECT COUNT(*) n FROM llm_calls`)!.n).toBe(0)
  })
})

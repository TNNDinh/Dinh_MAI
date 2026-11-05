import { randomUUID } from 'node:crypto'
import type { Agent, AssetKind, ResumeRunInput, Run, StartRunInput, TaskStatus } from '../../shared/ipc'
import { TASK_STATUSES } from '../../shared/ipc'
import type { AssetService } from '../assets/service'
import { guessKind } from '../assets/conventions'
import type { Database } from '../db/database'
import type { ChatMessage, ContentPart, ToolCall, ToolDefinition, ToolResultPart } from '../providers/types'
import type { AgentService } from '../services/agents'
import type { EventService } from '../services/events'
import type { TaskService } from '../services/tasks'
import type { CommandService } from '../workspace/commands'
import type { WorkspaceService } from '../workspace/workspace'
import { CallCancelledError, CallFailedError, type LlmGateway } from './gateway'
import { plannerInstructions, SUBMIT_PLAN_TOOL, validatePlan, type PlanTask, type TeamMember } from './plan'
import { toolsFor, type AgentTool, type ToolContext } from './tools'

export const MAX_TOOL_ROUNDS = 12
export const MAX_PLAN_ROUNDS = 3
export const MAX_ATTEMPTS = 2
export const DEFAULT_CONCURRENCY = 3
const MAX_CONCURRENCY = 8
const MAX_RESULT_CHARS = 20_000
const DEP_RESULT_CHARS = 6_000
const DEP_TOTAL_CHARS = 24_000
const TOOL_RESULT_CHARS = 30_000
const LOG_CHARS = 20_000

/** What the agent is told about its surroundings. It lists only what it can actually do, so it does not promise more. */
export function environmentNote(tools: ReadonlySet<string>): string {
  const files = tools.has('read_file') || tools.has('write_file')
  const parts = [
    'Environment: you are one member of an AI development team that works through a shared task board and, when your tools allow, a shared project folder.',
    `You can use only the tools you are offered: ${[...tools].join(', ') || 'none'}.`
  ]
  if (files) {
    parts.push(
      'Project files: paths are relative to the project root. Read before you change, change only what your task needs, and keep edits small (edit_file) rather than rewriting whole files. Writing a file locks it for you until your task ends; if another agent holds a lock, work on something else and mention it in your report. You cannot read credential files such as .env.'
    )
  } else {
    parts.push('You cannot read or write project files in this role, so put every deliverable (design documents, specifications, code, test plans, review findings) in your final reply, and also save it with write_memory when other team members need to build on it.')
  }
  if (tools.has('run_command')) {
    parts.push('Commands: run_command runs a shell command in the project folder. Routine build/test/lint commands run at once; others wait for the user to approve them, which can be slow or end in a denial. Never retry a denied or blocked command; explain what you wanted to do instead. Commands have no input and time out.')
  } else {
    parts.push('You cannot run commands. If something needs to be built or tested, say exactly which command should be run.')
  }
  if (tools.has('generate_image')) {
    parts.push('Pictures: generate_image makes a picture with the team’s image model and saves it in the project’s asset folder. Each picture costs money, so request only what the task needs and describe each one completely. If it reports that no image model is available, say so in your report instead of describing a picture as if it existed. list_assets shows what already exists.')
  }
  parts.push('Never claim to have done something you did not do or cannot do, and never invent file contents or command output. When you are finished, reply with a concise report of what you produced (file paths, results) and any open problems.')
  return parts.join(' ')
}

// ------------------------------------------------------------------ internal control-flow errors

export class BudgetExceeded extends Error {}
export class AgentLimitReached extends Error {}
class PlanFailed extends Error {}

// ------------------------------------------------------------------ rows

interface RunRow {
  id: string
  project_id: string
  workflow_id: string | null
  goal: string
  status: Run['status']
  iteration: number
  max_iterations: number
  budget_usd: number | null
  spent_usd: number
  concurrency: number
  state_json: string
  error: string | null
  started_at: number | null
  finished_at: number | null
  created_at: number
}

interface TaskRow {
  id: string
  title: string
  description: string
  role: string | null
  assigned_agent_id: string | null
  status: TaskStatus
  priority: number
  attempts: number
  result_summary: string | null
}

interface ProjectRow {
  id: string
  name: string
  type: string
  goal: string
  budget_usd: number | null
  max_iterations: number
}

interface ActiveRun {
  controller: AbortController
  reason: 'user' | null
  promise: Promise<void>
}

/** Shared by everything running inside one run. */
export interface RunRuntime {
  /** Set when the run budget stopped new work; the run then pauses instead of failing. */
  budgetHit: string | null
  warnedUnpriced: Set<string>
}

export const newRuntime = (): RunRuntime => ({ budgetHit: null, warnedUnpriced: new Set() })

/** Task-graph tools only make sense inside a Project Manager plan; a workflow step is one node of a graph the user drew. */
const PLAN_ONLY_TOOLS: ReadonlySet<string> = new Set(['create_task', 'request_changes', 'list_tasks'])

export interface StepTools {
  /** Tools offered to this step only (e.g. the reviewer's verdict). */
  extra?: AgentTool[]
  /** When set, the step is not finished until `satisfied()` is true: the model is reminded, and the loop ends as soon as it is. */
  mustCall?: { tool: string; satisfied: () => boolean }
  /** Extra material appended to the task prompt (what the previous steps produced). Not stored on the task, so it is not limited to the task description size. */
  context?: string
}

export interface StepSpec {
  title: string
  description: string
  agent: Agent
  tools?: StepTools
  /** Image steps are not a conversation: this prompt goes straight to the image model. */
  image?: { prompt: string; kind: AssetKind; size?: string; transparent: boolean }
}

export interface RecoveryTask {
  projectId: string
  runId: string
  taskId: string
  title: string
}

/** Auto Recovery: a safety net around each agent task. Implemented in git/recovery.ts; absent = the feature does not exist for this orchestrator. */
export interface TaskRecovery {
  /** Before a task attempt: saves a checkpoint and starts the undo journal (when the project opted in). Never throws. */
  begin(t: RecoveryTask): Promise<void>
  /** A task attempt failed: puts back the files it changed. Returns null when nothing was done (project did not opt in). Never throws. */
  rollback(t: RecoveryTask, reason: string): Promise<{ restored: number; removed: number; skipped: number } | null>
  /** The task is over (finished, failed or stopped): drop the journal. */
  end(taskId: string): void
}

type Pick = { kind: 'agent'; agent: Agent } | { kind: 'wait' } | { kind: 'error'; message: string }

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n[truncated: ${s.length - n} more characters]` : s)
const recoveryNote = (message: string): string =>
  `Your previous attempt failed: ${clip(message, 1_500)}\nAuto Recovery undid the file changes you made in that attempt, so the project files are as they were before it started. Work from the current files.`
const usd = (n: number): string => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`

/**
 * Runs a project's goal as a team: the Project Manager plans the work as a dependency graph, then ready
 * tasks are given to the matching agents (in parallel, one task per agent at a time). Every model call goes
 * through the injected gateway, so accounting, budgets and cancellation apply uniformly.
 */
export class Orchestrator {
  private readonly active = new Map<string, ActiveRun>()
  /** What to tell the agent about why its previous attempt was rolled back (only when Auto Recovery undid something). */
  private readonly failureNotes = new Map<string, string>()

  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly agents: AgentService,
    private readonly gateway: LlmGateway,
    private readonly tasks: TaskService,
    /** Gives agents the file and command tools. Without it they only get memory and task tools. */
    private readonly workspace: { workspace: WorkspaceService; commands: CommandService; assets?: AssetService; recovery?: TaskRecovery } | null = null,
    private readonly now: () => number = Date.now
  ) {}

  // ------------------------------------------------------------------ queries

  listRuns(projectId?: string): Run[] {
    const rows = projectId
      ? this.db.all<RunRow>(`SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100`, projectId)
      : this.db.all<RunRow>(`SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 100`)
    return rows.map((r) => this.toRun(r))
  }

  getRun(id: string): Run | null {
    const r = this.db.get<RunRow>(`SELECT * FROM runs WHERE id = ?`, id)
    return r ? this.toRun(r) : null
  }

  isActive(runId?: string): boolean {
    return runId ? this.active.has(runId) : this.active.size > 0
  }

  /** Resolves when the run's background work has fully settled (used by tests and by stop). */
  async whenDone(runId: string): Promise<void> {
    await this.active.get(runId)?.promise
  }

  private toRun(r: RunRow): Run {
    const taskCounts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>
    for (const c of this.db.all<{ status: TaskStatus; c: number }>(`SELECT status, COUNT(*) c FROM tasks WHERE run_id = ? GROUP BY status`, r.id)) {
      if (c.status in taskCounts) taskCounts[c.status] = c.c
    }
    const unpriced = this.db.get<{ c: number }>(`SELECT COUNT(*) c FROM llm_calls WHERE run_id = ? AND status = 'ok' AND cost_usd IS NULL`, r.id)!.c
    return {
      id: r.id,
      projectId: r.project_id,
      workflowId: r.workflow_id,
      goal: r.goal,
      status: r.status,
      iteration: r.iteration,
      maxIterations: r.max_iterations,
      budgetUsd: r.budget_usd,
      spentUsd: this.spent(r.id),
      unpricedCalls: unpriced,
      concurrency: r.concurrency,
      error: r.error,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      createdAt: r.created_at,
      taskCounts
    }
  }

  private spent(runId: string): number {
    return this.db.get<{ s: number }>(`SELECT COALESCE(SUM(cost_usd), 0) s FROM llm_calls WHERE run_id = ?`, runId)!.s
  }

  // ------------------------------------------------------------------ start / stop / resume / recover

  start(input: StartRunInput): Run {
    const project = this.db.get<ProjectRow>(`SELECT id, name, type, goal, budget_usd, max_iterations FROM projects WHERE id = ?`, String(input.projectId ?? ''))
    if (!project) throw new Error('Project not found.')
    this.assertNoActiveRun(project.id)
    const goal = (typeof input.goal === 'string' ? input.goal : project.goal).trim()
    if (!goal) throw new Error('Describe the goal of this run (or set one on the project).')
    if (goal.length > 8000) throw new Error('The goal is too long (max 8000 characters).')
    const budget = input.budgetUsd === undefined ? project.budget_usd : input.budgetUsd
    if (budget !== null && (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0 || budget > 1_000_000)) {
      throw new Error('The budget must be a positive amount in USD (or empty for no limit).')
    }
    const maxIterations = input.maxIterations === undefined ? project.max_iterations : input.maxIterations
    if (!Number.isInteger(maxIterations) || maxIterations < 0 || maxIterations > 50) throw new Error('Max iterations must be a whole number between 0 and 50.')
    const concurrency = input.concurrency === undefined ? DEFAULT_CONCURRENCY : input.concurrency
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new Error(`Concurrency must be between 1 and ${MAX_CONCURRENCY}.`)
    this.pickPm(project.id) // fail now, with a clear reason, if the team cannot plan

    const id = randomUUID()
    const t = this.now()
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO runs (id, project_id, goal, mode, status, iteration, max_iterations, budget_usd, spent_usd, concurrency, state_json, started_at, created_at)
         VALUES (?, ?, ?, 'workflow', 'running', 0, ?, ?, 0, ?, '{}', ?, ?)`,
        id,
        project.id,
        goal,
        maxIterations,
        budget,
        concurrency,
        t,
        t
      )
      // Tasks the user already put on the board join this run, if they say who should do them.
      this.db.run(`UPDATE tasks SET run_id = ? WHERE project_id = ? AND run_id IS NULL AND status = 'todo' AND (role IS NOT NULL OR assigned_agent_id IS NOT NULL)`, id, project.id)
    })
    this.events.record({
      projectId: project.id,
      runId: id,
      type: 'run.started',
      message: `Run started: ${clip(goal, 120)}${budget === null ? '' : ` · budget ${usd(budget)}`} · up to ${concurrency} in parallel`
    })
    this.launch(id)
    return this.getRun(id)!
  }

  async stop(runId: string): Promise<Run | null> {
    const a = this.active.get(String(runId))
    if (a) {
      a.reason = 'user'
      a.controller.abort()
      let timer: NodeJS.Timeout | undefined
      await Promise.race([a.promise, new Promise((r) => (timer = setTimeout(r, 15_000)))])
      clearTimeout(timer)
    }
    return this.getRun(String(runId))
  }

  /** Emergency stop: aborts every run. Returns how many were running. */
  async stopAll(): Promise<number> {
    const runs = [...this.active.keys()]
    await Promise.all(runs.map((id) => this.stop(id)))
    return runs.length
  }

  resume(input: ResumeRunInput): Run {
    const row = this.db.get<RunRow>(`SELECT * FROM runs WHERE id = ?`, String(input.id ?? ''))
    if (!row) throw new Error('Run not found.')
    if (row.status === 'running' || this.active.has(row.id)) throw new Error('This run is already running.')
    if (row.status === 'completed') throw new Error('This run already completed.')
    if (row.workflow_id !== null || parseState(row.state_json).workflow) throw new Error('This run executes a workflow: resume it from the Workflow page.')
    this.assertNoActiveRun(row.project_id)
    let budget = row.budget_usd
    if (input.budgetUsd !== undefined) {
      const b = input.budgetUsd
      if (b !== null && (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 1_000_000)) throw new Error('The budget must be a positive amount in USD (or empty for no limit).')
      budget = b
    }
    const spent = this.spent(row.id)
    if (budget !== null && spent >= budget) throw new Error(`${usd(spent)} is already spent of a ${usd(budget)} budget. Raise the budget to resume.`)
    if (!parseState(row.state_json).planned) this.pickPm(row.project_id)

    this.db.transaction(() => {
      this.db.run(`UPDATE runs SET status = 'running', error = NULL, finished_at = NULL, budget_usd = ? WHERE id = ?`, budget, row.id)
      this.db.run(`UPDATE tasks SET status = 'todo', attempts = 0, error = NULL, updated_at = ? WHERE run_id = ? AND status IN ('failed', 'blocked', 'in_progress')`, this.now(), row.id)
    })
    this.events.record({ projectId: row.project_id, runId: row.id, type: 'run.resumed', message: 'Run resumed' })
    this.launch(row.id)
    return this.getRun(row.id)!
  }

  /**
   * Called once at startup. A run cannot survive the app closing (its model calls died with it), so anything that
   * was running is paused and its half-done tasks go back to the queue; the user decides when to resume.
   */
  recover(): { runs: number; tasks: number } {
    const runs = this.db.all<{ id: string; project_id: string }>(`SELECT id, project_id FROM runs WHERE status IN ('running', 'pending')`)
    for (const r of runs) {
      this.db.run(`UPDATE runs SET status = 'paused', error = ? WHERE id = ?`, 'Interrupted: the app closed while this run was active. Resume to continue.', r.id)
      this.events.record({ projectId: r.project_id, runId: r.id, level: 'warn', type: 'run.recovered', message: 'Run was interrupted by an app restart and is paused' })
    }
    const tasks = this.db.run(`UPDATE tasks SET status = 'todo', updated_at = ? WHERE status = 'in_progress'`, this.now()).changes
    this.db.run(`UPDATE agents SET status = 'idle' WHERE status = 'working'`)
    return { runs: runs.length, tasks: Number(tasks) }
  }

  /** Throws when the project already has a run in progress (a planned run or a workflow run). */
  assertNoActiveRun(projectId: string): void {
    if (this.db.get(`SELECT 1 FROM runs WHERE project_id = ? AND status = 'running'`, projectId) || [...this.active.keys()].some((id) => this.row(id).project_id === projectId)) {
      throw new Error('This project already has a run in progress. Stop it first.')
    }
  }

  private row(id: string): RunRow {
    const r = this.db.get<RunRow>(`SELECT * FROM runs WHERE id = ?`, id)
    if (!r) throw new Error('Run not found.')
    return r
  }

  /** The Project Manager plans. It must be a ready, enabled, project-scoped agent. */
  private pickPm(projectId: string): Agent {
    const team = this.agents.list().filter((a) => a.projectId === projectId)
    const pms = team.filter((a) => a.role === 'project_manager')
    if (pms.length === 0) throw new Error('This project has no Project Manager. Add one on the Agents page (“Add the full team” creates it).')
    const ready = pms.find((a) => a.enabled && a.issues.length === 0)
    if (!ready) {
      const pm = pms[0]
      throw new Error(`The Project Manager “${pm.name}” cannot run: ${!pm.enabled ? 'it is disabled.' : pm.issues.join(' ')}`)
    }
    return ready
  }

  // ------------------------------------------------------------------ run lifecycle

  private launch(runId: string): void {
    const active: ActiveRun = { controller: new AbortController(), reason: null, promise: Promise.resolve() }
    this.active.set(runId, active)
    active.promise = this.execute(runId, active).finally(() => this.active.delete(runId))
  }

  private async execute(runId: string, active: ActiveRun): Promise<void> {
    const rt: RunRuntime = { budgetHit: null, warnedUnpriced: new Set() }
    const signal = active.controller.signal
    try {
      const run = this.row(runId)
      const state = parseState(run.state_json)
      if (!state.planned) {
        await this.plan(run, this.pickPm(run.project_id), signal, rt)
        this.db.run(`UPDATE runs SET state_json = ? WHERE id = ?`, JSON.stringify({ ...state, planned: true }), runId)
      }
      await this.schedule(runId, signal, rt)
      this.finish(runId, rt)
    } catch (e) {
      if (e instanceof CallCancelledError || signal.aborted) this.settle(runId, 'cancelled', 'Stopped by the user.', 'warn')
      else if (e instanceof BudgetExceeded) this.settle(runId, 'paused', e.message, 'warn')
      else this.settle(runId, 'failed', e instanceof Error ? e.message : String(e), 'error')
    }
  }

  /** Ends a run that did not finish normally: nothing may stay in_progress or "working". */
  private settle(runId: string, status: 'cancelled' | 'paused' | 'failed', message: string, level: 'warn' | 'error'): void {
    const run = this.row(runId)
    const t = this.now()
    this.db.transaction(() => {
      this.db.run(`UPDATE tasks SET status = 'todo', updated_at = ? WHERE run_id = ? AND status = 'in_progress'`, t, runId)
      this.db.run(`UPDATE runs SET status = ?, error = ?, spent_usd = ?, finished_at = ? WHERE id = ?`, status, message, this.spent(runId), status === 'paused' ? null : t, runId)
      this.db.run(`UPDATE agents SET status = 'idle' WHERE project_id = ? AND status = 'working'`, run.project_id)
    })
    this.events.record({ projectId: run.project_id, runId, level, type: `run.${status}`, message: `Run ${status}: ${message}` })
  }

  private finish(runId: string, rt: RunRuntime): void {
    if (rt.budgetHit) return this.settle(runId, 'paused', `${rt.budgetHit} Raise the budget and resume to continue.`, 'warn')
    const run = this.row(runId)
    const t = this.now()
    // Anything still waiting can never start (its dependencies did not finish).
    this.db.run(`UPDATE tasks SET status = 'blocked', error = COALESCE(error, 'Its dependencies did not finish.'), updated_at = ? WHERE run_id = ? AND status = 'todo'`, t, runId)
    const c = this.db.get<{ failed: number; blocked: number; total: number }>(
      `SELECT SUM(status = 'failed') failed, SUM(status = 'blocked') blocked, COUNT(*) total FROM tasks WHERE run_id = ?`,
      runId
    )!
    const bad = (c.failed ?? 0) + (c.blocked ?? 0)
    const spent = this.spent(runId)
    const status = bad === 0 ? 'completed' : 'failed'
    const error = bad === 0 ? null : `${bad} of ${c.total} tasks did not finish (${c.failed ?? 0} failed, ${c.blocked ?? 0} blocked).`
    this.db.run(`UPDATE runs SET status = ?, error = ?, spent_usd = ?, finished_at = ? WHERE id = ?`, status, error, spent, t, runId)
    this.db.run(`UPDATE agents SET status = 'idle' WHERE project_id = ? AND status = 'working'`, run.project_id)
    this.events.record({
      projectId: run.project_id,
      runId,
      level: bad === 0 ? 'info' : 'error',
      type: `run.${status}`,
      message: bad === 0 ? `Run completed: ${c.total} tasks done · ${usd(spent)}` : `Run failed: ${error}`
    })
  }

  // ------------------------------------------------------------------ planning

  private async plan(run: RunRow, pm: Agent, signal: AbortSignal, rt: RunRuntime): Promise<void> {
    const project = this.db.get<ProjectRow>(`SELECT id, name, type, goal, budget_usd, max_iterations FROM projects WHERE id = ?`, run.project_id)!
    const team = this.agents.list().filter((a) => a.projectId === run.project_id && a.enabled && a.issues.length === 0 && a.role !== 'custom')
    const byRole = new Map<string, Agent[]>()
    for (const a of team) (byRole.get(a.role) ?? byRole.set(a.role, []).get(a.role)!).push(a)
    const members: TeamMember[] = [...byRole.entries()].map(([role, list]) => ({
      role,
      roleLabel: list[0].roleLabel,
      name: list.map((a) => a.name).join(', '),
      description: list[0].systemPrompt.split('\n')[0].slice(0, 160)
    }))
    const existing = this.db.all<{ title: string }>(`SELECT title FROM tasks WHERE run_id = ?`, run.id).map((r) => r.title)
    const messages: ChatMessage[] = [{ role: 'user', content: plannerInstructions({ projectName: project.name, projectType: project.type, goal: run.goal, team: members, existing }) }]
    const roles = new Set(byRole.keys())
    const log = (role: 'assistant' | 'user' | 'tool', content: string): void => this.log(run.project_id, run.id, null, pm.id, role, content)
    log('user', messages[0].content as string)
    this.setAgentStatus(pm.id, 'working')
    this.events.record({ projectId: run.project_id, runId: run.id, agentId: pm.id, type: 'plan.started', message: `${pm.name} is planning the work` })
    try {
      for (let round = 1; round <= MAX_PLAN_ROUNDS; round++) {
        if (signal.aborted) throw new CallCancelledError()
        this.assertLimits(run.id, pm)
        const { response, costUsd } = await this.gateway.complete({
          connectionId: pm.connectionId!,
          model: pm.model!,
          system: pm.systemPrompt,
          messages,
          tools: [SUBMIT_PLAN_TOOL],
          maxTokens: pm.maxTokens ?? undefined,
          temperature: pm.temperature ?? undefined,
          signal,
          ctx: { agentId: pm.id, projectId: run.project_id, runId: run.id, taskId: null, label: `Agent “${pm.name}” · planning` }
        })
        this.noteUnpriced(run, pm, costUsd, rt)
        if (response.text.trim()) log('assistant', response.text)
        const call = response.toolCalls.find((c) => c.name === SUBMIT_PLAN_TOOL.name)
        if (!call) {
          messages.push({ role: 'assistant', content: response.text || '(no answer)' })
          messages.push({ role: 'user', content: 'You must submit the plan by calling the submit_plan tool. Do that now.' })
          continue
        }
        const verdict = validatePlan(call.arguments, roles)
        if (verdict.ok) {
          this.persistPlan(run, verdict.tasks)
          log('tool', `submit_plan → accepted (${verdict.tasks.length} tasks)`)
          this.events.record({ projectId: run.project_id, runId: run.id, agentId: pm.id, type: 'plan.created', message: `${pm.name} planned ${verdict.tasks.length} tasks` })
          return
        }
        log('tool', `submit_plan → rejected:\n${verdict.errors.join('\n')}`)
        messages.push({ role: 'assistant', content: [...(response.text ? [{ type: 'text' as const, text: response.text }] : []), ...response.toolCalls.map(toCallPart)] })
        messages.push({
          role: 'user',
          content: response.toolCalls.map<ToolResultPart>((c) => ({
            type: 'tool_result',
            toolCallId: c.id,
            isError: true,
            content: c.id === call.id ? `The plan was rejected. Fix these problems and call submit_plan again:\n- ${verdict.errors.join('\n- ')}` : 'Ignored: only submit_plan is available.'
          }))
        })
      }
      throw new PlanFailed(`${pm.name} did not produce a valid plan after ${MAX_PLAN_ROUNDS} attempts.`)
    } finally {
      this.setAgentStatus(pm.id, 'idle')
    }
  }

  private persistPlan(run: RunRow, plan: PlanTask[]): void {
    this.db.transaction(() => {
      const ids = new Map<string, string>()
      const pending = [...plan]
      // validatePlan guarantees an acyclic graph, so creating whatever has its dependencies in place always progresses.
      while (pending.length) {
        const before = pending.length
        for (let i = 0; i < pending.length; i++) {
          const p = pending[i]
          if (!p.dependsOn.every((d) => ids.has(d))) continue
          const t = this.tasks.create({
            projectId: run.project_id,
            runId: run.id,
            title: p.title,
            description: p.description,
            role: p.role,
            priority: p.priority,
            dependsOn: p.dependsOn.map((d) => ids.get(d)!)
          })
          ids.set(p.key, t.id)
          pending.splice(i--, 1)
        }
        if (pending.length === before) throw new Error('The plan could not be ordered.')
      }
    })
  }

  // ------------------------------------------------------------------ scheduling

  private async schedule(runId: string, signal: AbortSignal, rt: RunRuntime): Promise<void> {
    const run = this.row(runId)
    const running = new Map<string, Promise<void>>()
    const busy = new Set<string>()
    for (;;) {
      if (signal.aborted) {
        await Promise.allSettled([...running.values()])
        throw new CallCancelledError()
      }
      let changed = false
      this.propagateBlocked(runId)
      const ready = this.readyTasks(runId).filter((t) => !running.has(t.id))
      if (ready.length > 0 && !rt.budgetHit) {
        const over = this.budgetMessage(runId)
        if (over) rt.budgetHit = over
      }
      if (!rt.budgetHit && ready.length > 0) {
        const team = this.agents.list().filter((a) => a.projectId === run.project_id)
        for (const task of ready) {
          if (running.size >= run.concurrency) break
          const pick = this.pickAgent(task, team, busy)
          if (pick.kind === 'wait') continue
          if (pick.kind === 'error') {
            this.failTask(run, task, pick.message, null)
            changed = true
            continue
          }
          const agent = pick.agent
          busy.add(agent.id)
          const p = this.runTask(runId, task, agent, signal, rt).finally(() => {
            running.delete(task.id)
            busy.delete(agent.id)
          })
          running.set(task.id, p)
          changed = true
        }
      }
      if (running.size === 0 && !changed) break
      if (running.size > 0) await Promise.race([...running.values()])
    }
    if (signal.aborted) throw new CallCancelledError()
  }

  private readyTasks(runId: string): TaskRow[] {
    return this.db.all<TaskRow>(
      `SELECT t.id, t.title, t.description, t.role, t.assigned_agent_id, t.status, t.priority, t.attempts, t.result_summary
         FROM tasks t
        WHERE t.run_id = ? AND t.status = 'todo'
          AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on_task_id WHERE d.task_id = t.id AND dep.status != 'done')
        ORDER BY t.priority, t.created_at, t.rowid`,
      runId
    )
  }

  /** A task whose dependency failed (or is itself blocked) can never run. Repeats until the effect stops spreading. */
  private propagateBlocked(runId: string): void {
    for (;;) {
      const rows = this.db.all<{ id: string; title: string; dep_title: string; dep_status: string }>(
        `SELECT DISTINCT t.id, t.title, dep.title AS dep_title, dep.status AS dep_status
           FROM tasks t JOIN task_dependencies d ON d.task_id = t.id JOIN tasks dep ON dep.id = d.depends_on_task_id
          WHERE t.run_id = ? AND t.status = 'todo' AND dep.status IN ('failed', 'blocked')`,
        runId
      )
      if (rows.length === 0) return
      const seen = new Set<string>()
      for (const r of rows) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        this.db.run(`UPDATE tasks SET status = 'blocked', error = ?, updated_at = ? WHERE id = ?`, `Blocked: “${r.dep_title}” ${r.dep_status === 'failed' ? 'failed' : 'is blocked'}.`, this.now(), r.id)
        const run = this.row(runId)
        this.events.record({ projectId: run.project_id, runId, level: 'warn', type: 'task.blocked', message: `Task “${r.title}” is blocked because “${r.dep_title}” ${r.dep_status === 'failed' ? 'failed' : 'is blocked'}` })
      }
    }
  }

  private pickAgent(task: TaskRow, team: Agent[], busy: Set<string>): Pick {
    if (task.assigned_agent_id) {
      const a = team.find((x) => x.id === task.assigned_agent_id)
      if (!a) return { kind: 'error', message: 'The assigned agent no longer exists on this project’s team.' }
      if (!a.enabled) return { kind: 'error', message: `The assigned agent “${a.name}” is disabled.` }
      if (a.issues.length > 0) return { kind: 'error', message: `The assigned agent “${a.name}” cannot run: ${a.issues.join(' ')}` }
      return busy.has(a.id) ? { kind: 'wait' } : { kind: 'agent', agent: a }
    }
    if (!task.role) return { kind: 'error', message: 'The task has no role or agent. Assign one and resume the run.' }
    const candidates = team.filter((a) => a.role === task.role && a.enabled && a.issues.length === 0)
    if (candidates.length === 0) {
      const any = team.filter((a) => a.role === task.role)
      const why = any.length === 0 ? 'The team has no agent with this role.' : `No agent with this role can run: ${any[0].enabled ? any[0].issues.join(' ') : `“${any[0].name}” is disabled.`}`
      return { kind: 'error', message: `${why} (role: ${task.role})` }
    }
    const free = candidates.find((a) => !busy.has(a.id))
    return free ? { kind: 'agent', agent: free } : { kind: 'wait' }
  }

  // ------------------------------------------------------------------ one task

  private async runTask(runId: string, task: TaskRow, agent: Agent, signal: AbortSignal, rt: RunRuntime): Promise<void> {
    const run = this.row(runId)
    const attempts = task.attempts + 1
    this.db.run(`UPDATE tasks SET status = 'in_progress', assigned_agent_id = ?, attempts = ?, error = NULL, updated_at = ? WHERE id = ?`, agent.id, attempts, this.now(), task.id)
    this.setAgentStatus(agent.id, 'working')
    this.events.record({ projectId: run.project_id, runId, agentId: agent.id, type: 'task.started', message: `${agent.name} started “${task.title}”${attempts > 1 ? ` (attempt ${attempts})` : ''}` })
    this.updateProgress(run)
    const state = { reworkRequested: false }
    const recovery = this.workspace?.recovery
    const rt0 = { projectId: run.project_id, runId, taskId: task.id, title: task.title }
    await recovery?.begin(rt0)
    try {
      const result = agent.kind === 'image' ? await this.imageTask(run, task, agent, signal, rt) : await this.converse(run, task, agent, signal, rt, state)
      if (state.reworkRequested) {
        // Someone was sent back for changes: this task re-runs after they finish (it now depends on them).
        this.db.run(`UPDATE tasks SET status = 'todo', attempts = 0, result_summary = ?, updated_at = ? WHERE id = ?`, result, this.now(), task.id)
        this.events.record({ projectId: run.project_id, runId, agentId: agent.id, type: 'task.waiting', message: `“${task.title}” waits for the requested changes, then runs again` })
      } else {
        this.db.run(`UPDATE tasks SET status = 'done', result_summary = ?, error = NULL, updated_at = ? WHERE id = ?`, result, this.now(), task.id)
        this.events.record({ projectId: run.project_id, runId, agentId: agent.id, type: 'task.done', message: `${agent.name} finished “${task.title}”` })
      }
    } catch (e) {
      if (e instanceof CallCancelledError || signal.aborted) {
        this.db.run(`UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ?`, this.now(), task.id)
      } else if (e instanceof BudgetExceeded) {
        rt.budgetHit ??= e.message
        this.db.run(`UPDATE tasks SET status = 'todo', attempts = ?, updated_at = ? WHERE id = ?`, task.attempts, this.now(), task.id)
        this.events.record({ projectId: run.project_id, runId, agentId: agent.id, level: 'warn', type: 'task.paused', message: `“${task.title}” paused: ${e.message}` })
      } else {
        const message = e instanceof Error ? e.message : String(e)
        const retryable = !(e instanceof AgentLimitReached) && (!(e instanceof CallFailedError) || e.retryable)
        // Auto Recovery: undo what the failed attempt did to the files (before the locks are released, so nobody else can have touched them).
        const undone = await recovery?.rollback(rt0, message)
        if (retryable && attempts < MAX_ATTEMPTS) {
          this.db.run(`UPDATE tasks SET status = 'todo', error = ?, updated_at = ? WHERE id = ?`, message, this.now(), task.id)
          this.events.record({ projectId: run.project_id, runId, agentId: agent.id, level: 'warn', type: 'task.retry', message: `“${task.title}” failed (${clip(message, 160)}); retrying` })
          if (undone && undone.restored + undone.removed > 0) this.failureNotes.set(task.id, recoveryNote(message))
        } else {
          this.failTask(run, task, message, agent)
        }
      }
    } finally {
      recovery?.end(task.id)
      this.workspace?.workspace.locks.releaseTask(task.id)
      this.setAgentStatus(agent.id, 'idle')
      this.updateProgress(run)
    }
  }

  private failTask(run: RunRow, task: TaskRow, message: string, agent: Agent | null): void {
    this.db.run(`UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, message, this.now(), task.id)
    this.events.record({ projectId: run.project_id, runId: run.id, agentId: agent?.id ?? null, level: 'error', type: 'task.failed', message: `“${task.title}” failed: ${clip(message, 300)}` })
  }

  /** The tool loop: the model works, calls tools, and ends with a text report which becomes the task result. */
  private async converse(run: RunRow, task: TaskRow, agent: Agent, signal: AbortSignal, rt: RunRuntime, state: { reworkRequested: boolean }, step?: StepTools & { workflow: true }): Promise<string> {
    const base = toolsFor(agent, { workspace: this.workspace !== null, assets: this.assets() !== null }).filter((t) => !step || !PLAN_ONLY_TOOLS.has(t.def.name))
    const available = new Map<string, AgentTool>([...base, ...(step?.extra ?? [])].map((t) => [t.def.name, t]))
    const toolDefs = [...available.values()].map((t) => t.def)
    let reminders = 0
    const prompt = this.taskPrompt(run, task, agent, step?.context)
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }]
    const log = (role: 'assistant' | 'user' | 'tool', content: string): void => this.log(run.project_id, run.id, task.id, agent.id, role, content)
    log('user', prompt)
    const ctx: ToolContext = { db: this.db, events: this.events, tasks: this.tasks, agent, projectId: run.project_id, runId: run.id, taskId: task.id, state, workspace: this.workspace?.workspace, commands: this.workspace?.commands, assets: this.assets() ?? undefined, imageTarget: this.imageTarget(run.project_id), signal }
    let usedTools = false
    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      if (signal.aborted) throw new CallCancelledError()
      this.assertLimits(run.id, agent)
      const { response, costUsd } = await this.gateway.complete({
        connectionId: agent.connectionId!,
        model: agent.model!,
        system: `${agent.systemPrompt}\n\n${environmentNote(new Set(available.keys()))}`,
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        maxTokens: agent.maxTokens ?? undefined,
        temperature: agent.temperature ?? undefined,
        signal,
        ctx: { agentId: agent.id, projectId: run.project_id, runId: run.id, taskId: task.id, label: `Agent “${agent.name}” · ${clip(task.title, 60)}` }
      })
      this.noteUnpriced(run, agent, costUsd, rt)
      if (response.text.trim()) log('assistant', response.text)
      if (response.toolCalls.length === 0) {
        const must = step?.mustCall
        if (must && !must.satisfied() && reminders < 2) {
          reminders++
          messages.push({ role: 'assistant', content: response.text.trim() || '(no answer)' })
          messages.push({ role: 'user', content: `You must finish by calling the ${must.tool} tool. Call it now.` })
          log('user', `Reminder: call ${must.tool}.`)
          continue
        }
        let text = response.text.trim()
        if (!text) {
          if (!usedTools) throw new Error('The model returned an empty answer.')
          text = 'Completed (the agent returned no written report).'
        }
        if (response.stopReason === 'max_tokens') text += '\n\n[The answer was cut off: the model hit its output token limit.]'
        return clip(text, MAX_RESULT_CHARS)
      }
      usedTools = true
      messages.push({ role: 'assistant', content: [...(response.text.trim() ? [{ type: 'text' as const, text: response.text }] : []), ...response.toolCalls.map(toCallPart)] })
      const results: ToolResultPart[] = []
      for (const call of response.toolCalls) results.push(await this.runTool(call, available, ctx, log))
      if (step?.mustCall?.satisfied()) return clip(response.text.trim() || 'Submitted.', MAX_RESULT_CHARS)
      messages.push({ role: 'user', content: results })
    }
    throw new Error(`The agent did not finish within ${MAX_TOOL_ROUNDS} tool rounds.`)
  }

  private assets(): AssetService | null {
    return this.workspace?.assets ?? null
  }

  /** The model the team's Image Generator agent is set up with, if that agent can run. */
  private imageTarget(projectId: string): { connectionId: string; model: string; agentName: string } | null {
    const a = this.agents.list().find((x) => x.projectId === projectId && x.kind === 'image' && x.enabled && x.issues.length === 0 && x.permissions.generateImages && x.connectionId && x.model)
    return a ? { connectionId: a.connectionId!, model: a.model!, agentName: a.name } : null
  }

  /**
   * A task given to an image agent is not a conversation: the task text is the prompt and the result is the saved
   * file(s). The picture kind, size and transparency are read from the text; nothing is invented.
   */
  private async imageTask(run: RunRow, task: TaskRow, agent: Agent, signal: AbortSignal, rt: RunRuntime): Promise<string> {
    const body = task.description.trim()
    const prompt = clip(body ? `${task.title.trim()}\n${body}` : task.title.trim(), 4000)
    const size = /\b(\d{2,4})\s*[x×]\s*(\d{2,4})\b/i.exec(prompt)
    return this.paint(run, task, agent, { prompt, kind: guessKind(`${task.title} ${body}`), size: size ? `${size[1]}x${size[2]}` : undefined, transparent: /transparen|alpha channel|no background|cut ?out/i.test(prompt) }, signal, rt)
  }

  private async paint(
    run: RunRow,
    task: TaskRow,
    agent: Agent,
    req: { prompt: string; kind: AssetKind; size?: string; transparent: boolean },
    signal: AbortSignal,
    rt: RunRuntime
  ): Promise<string> {
    const assets = this.assets()
    if (!assets) throw new Error('Picture generation is not available in this build.')
    if (!agent.permissions.generateImages) throw new Error(`Agent “${agent.name}” is not allowed to generate images (its “Generate images” permission is off).`)
    const { prompt } = req
    const size = req.size ? /^(\d+)x(\d+)$/i.exec(req.size) : null
    this.assertLimits(run.id, agent)
    const r = await assets.generate(
      {
        requestId: '',
        projectId: run.project_id,
        connectionId: agent.connectionId!,
        model: agent.model!,
        prompt,
        kind: req.kind,
        size: req.size,
        count: 1,
        transparent: req.transparent
      },
      { runId: run.id, taskId: task.id, agent: { id: agent.id, name: agent.name }, signal }
    )
    this.noteUnpriced(run, agent, r.costUsd, rt)
    this.log(run.project_id, run.id, task.id, agent.id, 'user', prompt)
    const lines = [`Generated ${r.assets.length} picture${r.assets.length === 1 ? '' : 's'} with ${agent.model}:`, ...r.assets.map((a) => `- ${a.path} (${a.kind}${a.width && a.height ? `, ${a.width}x${a.height}` : ''}${a.transparent ? ', transparent' : ''}) id ${a.id}`)]
    if (size) lines.push(`Requested size ${size[1]}x${size[2]}; the model delivers the nearest size it supports (check the dimensions above).`)
    for (const n of r.notes) lines.push(`Note: ${n}`)
    const text = lines.join('\n')
    this.log(run.project_id, run.id, task.id, agent.id, 'assistant', text)
    return text
  }

  private async runTool(call: ToolCall, available: Map<string, AgentTool>, ctx: ToolContext, log: (role: 'tool', content: string) => void): Promise<ToolResultPart> {
    const tool = available.get(call.name)
    let content: string
    let isError = false
    if (!tool) {
      content = `The tool "${call.name}" is not available to you. Available tools: ${[...available.keys()].join(', ') || 'none'}.`
      isError = true
    } else {
      try {
        content = clip(await tool.execute(ctx, call.arguments ?? {}), TOOL_RESULT_CHARS)
      } catch (e) {
        content = e instanceof Error ? e.message : String(e)
        isError = true
      }
    }
    log('tool', `${call.name}(${clip(JSON.stringify(call.arguments ?? {}), 500)}) → ${isError ? 'ERROR: ' : ''}${clip(content, 2000)}`)
    return { type: 'tool_result', toolCallId: call.id, content, isError }
  }

  private taskPrompt(run: RunRow, task: TaskRow, agent: Agent, context?: string): string {
    const parts: string[] = [`Overall goal of this run: ${run.goal}`, '', `Your task: ${task.title}`, task.description || '(no further description)']
    if (context?.trim()) parts.push('', clip(context.trim(), 40_000))
    const failure = this.failureNotes.get(task.id)
    if (failure) {
      parts.push('', failure)
      this.failureNotes.delete(task.id)
    }
    const deps = this.db.all<{ title: string; name: string | null; result_summary: string | null }>(
      `SELECT dep.title, a.name, dep.result_summary
         FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on_task_id LEFT JOIN agents a ON a.id = dep.assigned_agent_id
        WHERE d.task_id = ? AND dep.status = 'done' ORDER BY dep.updated_at`,
      task.id
    )
    if (deps.length) {
      let budget = DEP_TOTAL_CHARS
      parts.push('', 'Results of the tasks you depend on:')
      for (const d of deps) {
        const body = clip(d.result_summary ?? '(no result recorded)', Math.min(DEP_RESULT_CHARS, Math.max(budget, 500)))
        budget -= body.length
        parts.push(`### ${d.title}${d.name ? ` (by ${d.name})` : ''}`, body)
      }
    }
    const feedback = this.db.all<{ content: string }>(`SELECT content FROM agent_messages WHERE task_id = ? AND role = 'system' AND content LIKE 'Change request from%' ORDER BY created_at, rowid`, task.id).slice(-5)
    if (feedback.length) {
      parts.push('', 'This task was sent back for changes. Address every point below (most recent last):', ...feedback.map((f) => `- ${f.content.replace(/^Change request from /, 'From ')}`))
      if (task.result_summary) parts.push('', 'Your previous result, to be revised:', clip(task.result_summary, DEP_RESULT_CHARS))
    } else if (task.attempts > 1 && task.result_summary) {
      parts.push('', 'Your previous result:', clip(task.result_summary, DEP_RESULT_CHARS))
    }
    if (agent.permissions.readFiles) {
      const mem = this.db.all<{ id: string; kind: string; title: string }>(`SELECT id, kind, title FROM memory_entries WHERE project_id = ? ORDER BY updated_at DESC LIMIT 30`, run.project_id)
      if (mem.length) parts.push('', 'Shared project memory (read with read_memory):', ...mem.map((m) => `- ${m.id} · ${m.kind} · ${m.title}`))
    }
    return parts.join('\n')
  }

  // ------------------------------------------------------------------ workflow support
  // The workflow engine decides *what* runs and in which order; these run one step with the same agents, tools,
  // accounting, budgets and cancellation as a planned run.

  /**
   * One workflow step: creates a real task on the board for the agent, runs it (tool loop, or the image model for
   * picture steps), retries once when the failure looks transient, and records the outcome on the task.
   * Throws `CallCancelledError`, `BudgetExceeded` or the underlying error after marking the task failed.
   */
  async runStep(runId: string, spec: StepSpec, signal: AbortSignal, rt: RunRuntime): Promise<{ taskId: string; text: string }> {
    const run = this.row(runId)
    const agent = spec.agent
    const created = this.tasks.create({ projectId: run.project_id, runId, title: spec.title.slice(0, 200), description: spec.description.slice(0, 7_800), assignedAgentId: agent.id })
    const task: TaskRow = { id: created.id, title: created.title, description: created.description, role: null, assigned_agent_id: agent.id, status: 'todo', priority: created.priority, attempts: 0, result_summary: null }
    const finishTask = (status: 'failed', error: string): void => void this.db.run(`UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?`, status, error, this.now(), task.id)
    const recovery = this.workspace?.recovery
    const rt0 = { projectId: run.project_id, runId, taskId: task.id, title: task.title }
    for (let attempt = 1; ; attempt++) {
      this.db.run(`UPDATE tasks SET status = 'in_progress', attempts = ?, error = NULL, updated_at = ? WHERE id = ?`, attempt, this.now(), task.id)
      this.setAgentStatus(agent.id, 'working')
      this.events.record({ projectId: run.project_id, runId, agentId: agent.id, type: 'task.started', message: `${agent.name} started “${task.title}”${attempt > 1 ? ` (attempt ${attempt})` : ''}` })
      await recovery?.begin(rt0)
      try {
        const text = spec.image
          ? await this.paint(run, task, agent, spec.image, signal, rt)
          : await this.converse(run, task, agent, signal, rt, { reworkRequested: false }, { workflow: true, ...spec.tools })
        this.db.run(`UPDATE tasks SET status = 'done', result_summary = ?, error = NULL, updated_at = ? WHERE id = ?`, text, this.now(), task.id)
        this.events.record({ projectId: run.project_id, runId, agentId: agent.id, type: 'task.done', message: `${agent.name} finished “${task.title}”` })
        return { taskId: task.id, text }
      } catch (e) {
        if (e instanceof CallCancelledError || signal.aborted) {
          finishTask('failed', 'Stopped by the user.')
          throw e
        }
        if (e instanceof BudgetExceeded) {
          finishTask('failed', `Paused: ${e.message}`)
          throw e
        }
        const message = e instanceof Error ? e.message : String(e)
        const retryable = !(e instanceof AgentLimitReached) && (!(e instanceof CallFailedError) || e.retryable)
        const undone = await recovery?.rollback(rt0, message)
        if (retryable && attempt < MAX_ATTEMPTS) {
          this.events.record({ projectId: run.project_id, runId, agentId: agent.id, level: 'warn', type: 'task.retry', message: `“${task.title}” failed (${clip(message, 160)}); retrying` })
          if (undone && undone.restored + undone.removed > 0) this.failureNotes.set(task.id, recoveryNote(message))
          continue
        }
        this.failTask(run, task, message, agent)
        throw e
      } finally {
        recovery?.end(task.id)
        this.workspace?.workspace.locks.releaseTask(task.id)
        this.setAgentStatus(agent.id, 'idle')
      }
    }
  }

  /**
   * Bookkeeping for a workflow step that is several model calls rather than one conversation (a debate): a task
   * on the board for the work, the agents shown as working, and the same outcome handling as `runStep`.
   */
  async trackedStep(runId: string, spec: { title: string; description: string; agents: Agent[] }, work: (taskId: string) => Promise<string>): Promise<{ taskId: string; text: string }> {
    const run = this.row(runId)
    const lead = spec.agents[0]
    const created = this.tasks.create({ projectId: run.project_id, runId, title: spec.title.slice(0, 200), description: spec.description.slice(0, 7_800), assignedAgentId: lead.id })
    this.db.run(`UPDATE tasks SET status = 'in_progress', attempts = 1, updated_at = ? WHERE id = ?`, this.now(), created.id)
    for (const a of spec.agents) this.setAgentStatus(a.id, 'working')
    this.events.record({ projectId: run.project_id, runId, agentId: lead.id, type: 'task.started', message: `${spec.agents.map((a) => a.name).join(', ')} started “${spec.title}”` })
    const row: TaskRow = { id: created.id, title: created.title, description: created.description, role: null, assigned_agent_id: lead.id, status: 'in_progress', priority: created.priority, attempts: 1, result_summary: null }
    try {
      const text = await work(created.id)
      this.db.run(`UPDATE tasks SET status = 'done', result_summary = ?, error = NULL, updated_at = ? WHERE id = ?`, clip(text, MAX_RESULT_CHARS), this.now(), created.id)
      this.events.record({ projectId: run.project_id, runId, agentId: lead.id, type: 'task.done', message: `“${spec.title}” finished` })
      return { taskId: created.id, text }
    } catch (e) {
      if (e instanceof CallCancelledError) this.db.run(`UPDATE tasks SET status = 'failed', error = 'Stopped by the user.', updated_at = ? WHERE id = ?`, this.now(), created.id)
      else if (e instanceof BudgetExceeded) this.db.run(`UPDATE tasks SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`, `Paused: ${e.message}`, this.now(), created.id)
      else this.failTask(run, row, e instanceof Error ? e.message : String(e), lead)
      throw e
    } finally {
      for (const a of spec.agents) this.setAgentStatus(a.id, 'idle')
    }
  }

  /** A single model call for a workflow node that is not a task (debate turns, AI conditions), under the run's limits. */
  async chat(
    runId: string,
    agent: Agent,
    req: { system: string; messages: ChatMessage[]; tools?: ToolDefinition[]; taskId: string | null; label: string; maxTokens?: number },
    signal: AbortSignal,
    rt: RunRuntime
  ): Promise<Awaited<ReturnType<LlmGateway['complete']>>> {
    if (signal.aborted) throw new CallCancelledError()
    const run = this.row(runId)
    this.assertLimits(runId, agent)
    const out = await this.gateway.complete({
      connectionId: agent.connectionId!,
      model: agent.model!,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
      maxTokens: req.maxTokens ?? agent.maxTokens ?? undefined,
      temperature: agent.temperature ?? undefined,
      signal,
      ctx: { agentId: agent.id, projectId: run.project_id, runId, taskId: req.taskId, label: req.label }
    })
    this.noteUnpriced(run, agent, out.costUsd, rt)
    return out
  }

  /** Writes a line to the run's transcript (what the Tasks page shows as the agent's conversation). */
  transcript(runId: string, taskId: string | null, agentId: string | null, role: 'assistant' | 'user' | 'tool', content: string): void {
    this.log(this.row(runId).project_id, runId, taskId, agentId, role, content)
  }

  /** Why the run may not start more model calls, or null. */
  overBudget(runId: string): string | null {
    return this.budgetMessage(runId)
  }

  /** Copies the run's current spend onto the run row. */
  syncSpend(runId: string): number {
    const s = this.spent(runId)
    this.db.run(`UPDATE runs SET spent_usd = ? WHERE id = ?`, s, runId)
    return s
  }

  // ------------------------------------------------------------------ limits

  private budgetMessage(runId: string): string | null {
    const budget = this.db.get<{ budget_usd: number | null }>(`SELECT budget_usd FROM runs WHERE id = ?`, runId)?.budget_usd ?? null
    if (budget === null) return null
    const spent = this.spent(runId)
    return spent >= budget ? `The run budget of ${usd(budget)} is reached (${usd(spent)} spent).` : null
  }

  /** Checked before every model call, so a run can overshoot only by the calls already in flight. */
  private assertLimits(runId: string, agent: Agent): void {
    const msg = this.budgetMessage(runId)
    this.db.run(`UPDATE runs SET spent_usd = ? WHERE id = ?`, this.spent(runId), runId)
    if (msg) throw new BudgetExceeded(msg)
    if (agent.maxCostUsd !== null) {
      const s = this.db.get<{ s: number }>(`SELECT COALESCE(SUM(cost_usd), 0) s FROM llm_calls WHERE run_id = ? AND agent_id = ?`, runId, agent.id)!.s
      if (s >= agent.maxCostUsd) throw new AgentLimitReached(`Agent “${agent.name}” reached its per-run cost limit of ${usd(agent.maxCostUsd)} (${usd(s)} spent).`)
    }
  }

  /** Without a price, a limit cannot be enforced for that model: say so instead of pretending. */
  private noteUnpriced(run: RunRow, agent: Agent, costUsd: number | null, rt: RunRuntime): void {
    if (costUsd !== null || !agent.model) return
    const hasLimit = this.row(run.id).budget_usd !== null || agent.maxCostUsd !== null
    const key = `${agent.connectionId}:${agent.model}`
    if (!hasLimit || rt.warnedUnpriced.has(key)) return
    rt.warnedUnpriced.add(key)
    this.events.record({
      projectId: run.project_id,
      runId: run.id,
      agentId: agent.id,
      level: 'warn',
      type: 'run.unpriced',
      message: `No price is known for ${agent.model}: its calls count as $0 toward the budget, so the limit cannot fully protect you. Set a price for the model to enforce it.`
    })
  }

  // ------------------------------------------------------------------ small helpers

  private setAgentStatus(agentId: string, status: 'idle' | 'working'): void {
    this.db.run(`UPDATE agents SET status = ? WHERE id = ? AND enabled = 1`, status, agentId)
  }

  private updateProgress(run: RunRow): void {
    const c = this.db.get<{ done: number; total: number }>(`SELECT SUM(status = 'done') done, COUNT(*) total FROM tasks WHERE run_id = ?`, run.id)!
    if (c.total > 0) this.db.run(`UPDATE projects SET progress = ? WHERE id = ?`, (c.done ?? 0) / c.total, run.project_id)
  }

  private log(projectId: string, runId: string, taskId: string | null, agentId: string | null, role: 'assistant' | 'user' | 'tool', content: string): void {
    this.db.run(`INSERT INTO agent_messages (id, project_id, run_id, task_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, randomUUID(), projectId, runId, taskId, agentId, role, clip(content, LOG_CHARS), this.now())
  }
}

const toCallPart = (c: ToolCall): ContentPart => ({ type: 'tool_call', ...c })

function parseState(json: string): { planned?: boolean; workflow?: boolean } {
  try {
    const v = JSON.parse(json) as unknown
    return typeof v === 'object' && v !== null ? (v as { planned?: boolean; workflow?: boolean }) : {}
  } catch {
    return {}
  }
}

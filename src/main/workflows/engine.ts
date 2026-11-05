import { randomUUID } from 'node:crypto'
import type { Agent, ResumeRunInput, Run, StartWorkflowInput, WorkflowRunState } from '../../shared/ipc'
import {
  agentReady,
  candidatesFor,
  checkGraph,
  checkTeam,
  debateCalls,
  fillTemplate,
  sanitizeGraph,
  type AgentRef,
  type NodeConfigs,
  type NodeRunState,
  type NodeStatus,
  type WorkflowGraph,
  type WorkflowNode
} from '../../shared/workflow'
import type { Database } from '../db/database'
import { BudgetExceeded, DEFAULT_CONCURRENCY, newRuntime, type Orchestrator, type RunRuntime } from '../orchestrator/orchestrator'
import { CallCancelledError } from '../orchestrator/gateway'
import type { AgentTool } from '../orchestrator/tools'
import type { ChatMessage } from '../providers/types'
import type { AgentService } from '../services/agents'
import type { EventService } from '../services/events'
import { CommandRefusedError, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, type CommandService } from '../workspace/commands'
import type { WorkspaceService } from '../workspace/workspace'
import { FlowState, joinInputs, type FlowSnapshot } from './flow-state'
import type { WorkflowService } from './service'

const MAX_CONCURRENCY = 8
/** How much of what the earlier steps produced one step is shown. */
const INPUT_CHARS = 24_000
const APPROVAL_WAIT_MS = 12 * 60 * 60 * 1000
const POSITION_TOKENS = 1_500
const DECISION_TOKENS = 2_000

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n[truncated: ${s.length - n} more characters]` : s)
const usd = (n: number): string => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`

interface ActiveFlow {
  controller: AbortController
  reason: 'user' | null
  promise: Promise<void>
}

interface RunRow {
  id: string
  project_id: string
  workflow_id: string | null
  goal: string
  status: Run['status']
  budget_usd: number | null
  concurrency: number
  state_json: string
}

interface StoredState {
  workflow?: boolean
  graph?: unknown
  flow?: FlowSnapshot
}

interface NodeRow {
  node_id: string
  status: NodeStatus
  output_json: string | null
  error: string | null
  started_at: number | null
  finished_at: number | null
}

/** Everything one running workflow shares. */
interface Flight {
  runId: string
  projectId: string
  projectName: string
  goal: string
  concurrency: number
  controller: AbortController
  signal: AbortSignal
  rt: RunRuntime
  fs: FlowState
  /** Agents that are working on a step of this run right now: one step at a time per agent. */
  busy: Set<string>
}

/** The agents a step will use, chosen when it starts. */
interface Assignment {
  agent?: Agent
  participants?: Agent[]
  moderator?: Agent
  ids: string[]
}

interface StepResult {
  output: string
  handle: string
  taskId?: string | null
  note?: string | null
}

type Pick1 = { kind: 'ok'; agent: Agent } | { kind: 'wait' } | { kind: 'error'; message: string }

/**
 * Runs a drawn workflow. `FlowState` decides what may start; this class does the work of each step with the
 * real agents (through the orchestrator, so tasks, tools, budgets and cancellation behave as in any run), keeps
 * the run's state in the database after every change, and can pick the run up again after a stop or restart.
 */
export class WorkflowEngine {
  private readonly active = new Map<string, ActiveFlow>()

  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly agents: AgentService,
    private readonly orchestrator: Orchestrator,
    private readonly workflows: WorkflowService,
    /** Without it, "Run tests" steps cannot run. */
    private readonly workspace: { workspace: WorkspaceService; commands: CommandService } | null = null,
    private readonly now: () => number = Date.now
  ) {}

  // ------------------------------------------------------------------ queries

  isActive(runId?: string): boolean {
    return runId ? this.active.has(runId) : this.active.size > 0
  }

  async whenDone(runId: string): Promise<void> {
    await this.active.get(runId)?.promise
  }

  /** True for a run that executes a workflow (so stop/resume go to this engine rather than the planner). */
  isWorkflowRun(runId: string): boolean {
    const r = this.db.get<{ workflow_id: string | null; state_json: string }>(`SELECT workflow_id, state_json FROM runs WHERE id = ?`, String(runId ?? ''))
    return !!r && (r.workflow_id !== null || parseState(r.state_json).workflow === true)
  }

  listRuns(workflowId: string): Run[] {
    return this.db
      .all<{ id: string }>(`SELECT id FROM runs WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50`, String(workflowId ?? ''))
      .map((r) => this.orchestrator.getRun(r.id))
      .filter((r): r is Run => r !== null)
  }

  getRunState(runId: string): WorkflowRunState {
    const row = this.db.get<RunRow>(`SELECT * FROM runs WHERE id = ?`, String(runId ?? ''))
    const run = row ? this.orchestrator.getRun(row.id) : null
    if (!row || !run) throw new Error('Run not found.')
    const graph = this.storedGraph(row)
    const stored = new Map(this.db.all<NodeRow>(`SELECT * FROM run_node_states WHERE run_id = ?`, row.id).map((r) => [r.node_id, r]))
    const nodes = (graph?.nodes ?? []).map((n): NodeRunState => {
      const r = stored.get(n.id)
      if (!r) return { nodeId: n.id, status: 'pending', output: null, handle: null, error: null, note: null, runs: 0, taskId: null, startedAt: null, finishedAt: null }
      const o = parseOutput(r.output_json)
      return { nodeId: n.id, status: r.status, output: o.text, handle: o.handle, error: r.error, note: o.note, runs: o.runs, taskId: o.taskId, startedAt: r.started_at, finishedAt: r.finished_at }
    })
    return { run, nodes }
  }

  private storedGraph(row: RunRow): WorkflowGraph | null {
    const s = parseState(row.state_json)
    if (!s.graph) return null
    try {
      return sanitizeGraph(s.graph)
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------------ start / stop / resume / recover

  start(input: StartWorkflowInput): Run {
    const wf = this.workflows.get(String(input.workflowId ?? ''))
    if (!wf) throw new Error('Workflow not found.')
    const projectId = wf.projectId ?? (typeof input.projectId === 'string' ? input.projectId : null)
    if (!projectId) throw new Error('This workflow is shared by all projects: choose the project to run it in.')
    if (wf.projectId && input.projectId && input.projectId !== wf.projectId) throw new Error('This workflow belongs to another project.')
    const project = this.db.get<{ id: string; name: string; goal: string; budget_usd: number | null }>(`SELECT id, name, goal, budget_usd FROM projects WHERE id = ?`, projectId)
    if (!project) throw new Error('Project not found.')
    this.orchestrator.assertNoActiveRun(project.id)
    const goal = (typeof input.goal === 'string' ? input.goal : project.goal).trim()
    if (!goal) throw new Error('Describe the goal of this run (or set one on the project).')
    if (goal.length > 8000) throw new Error('The goal is too long (max 8000 characters).')
    const budget = input.budgetUsd === undefined ? project.budget_usd : input.budgetUsd
    if (budget !== null && (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= 0 || budget > 1_000_000)) {
      throw new Error('The budget must be a positive amount in USD (or empty for no limit).')
    }
    const concurrency = input.concurrency === undefined ? DEFAULT_CONCURRENCY : input.concurrency
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) throw new Error(`Concurrency must be between 1 and ${MAX_CONCURRENCY}.`)
    this.assertRunnable(wf.graph, project.id)

    const id = randomUUID()
    const t = this.now()
    const fs = new FlowState(wf.graph, this.now)
    const state: StoredState = { workflow: true, graph: wf.graph, flow: fs.snapshot() }
    this.db.run(
      `INSERT INTO runs (id, project_id, workflow_id, goal, mode, status, iteration, max_iterations, budget_usd, spent_usd, concurrency, state_json, started_at, created_at)
       VALUES (?, ?, ?, ?, 'workflow', 'running', 0, 0, ?, 0, ?, ?, ?, ?)`,
      id,
      project.id,
      wf.id,
      goal,
      budget,
      concurrency,
      JSON.stringify(state),
      t,
      t
    )
    this.events.record({
      projectId: project.id,
      runId: id,
      type: 'run.started',
      message: `Workflow “${wf.name}” started: ${clip(goal, 120)}${budget === null ? '' : ` · budget ${usd(budget)}`} · up to ${concurrency} steps in parallel`
    })
    this.launch(id, project.name, fs)
    return this.orchestrator.getRun(id)!
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
    return this.orchestrator.getRun(String(runId))
  }

  async stopAll(): Promise<number> {
    const runs = [...this.active.keys()]
    await Promise.all(runs.map((id) => this.stop(id)))
    return runs.length
  }

  /** Continues a stopped, paused or failed run: finished steps stay finished, the rest runs again. */
  resume(input: ResumeRunInput): Run {
    const row = this.db.get<RunRow>(`SELECT * FROM runs WHERE id = ?`, String(input.id ?? ''))
    if (!row) throw new Error('Run not found.')
    if (row.status === 'running' || this.active.has(row.id)) throw new Error('This run is already running.')
    if (row.status === 'completed') throw new Error('This run already completed.')
    const graph = this.storedGraph(row)
    if (!graph) throw new Error('This run has no saved workflow to continue.')
    this.orchestrator.assertNoActiveRun(row.project_id)
    let budget = row.budget_usd
    if (input.budgetUsd !== undefined) {
      const b = input.budgetUsd
      if (b !== null && (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 1_000_000)) throw new Error('The budget must be a positive amount in USD (or empty for no limit).')
      budget = b
    }
    const spent = this.orchestrator.syncSpend(row.id)
    if (budget !== null && spent >= budget) throw new Error(`${usd(spent)} is already spent of a ${usd(budget)} budget. Raise the budget to resume.`)
    this.assertRunnable(graph, row.project_id)

    const nodes = this.db.all<NodeRow>(`SELECT * FROM run_node_states WHERE run_id = ?`, row.id).map(toNodeState)
    const fs = FlowState.restore(graph, nodes, parseState(row.state_json).flow ?? null, this.now)
    fs.prepareResume()
    this.db.transaction(() => {
      this.db.run(`UPDATE runs SET status = 'running', error = NULL, finished_at = NULL, budget_usd = ? WHERE id = ?`, budget, row.id)
      // Work that was queued or half done when the run stopped is not coming back: the step starts over with a new task.
      this.db.run(`UPDATE tasks SET status = 'failed', error = COALESCE(error, 'Interrupted before it finished.'), updated_at = ? WHERE run_id = ? AND status IN ('todo', 'in_progress')`, this.now(), row.id)
    })
    this.events.record({ projectId: row.project_id, runId: row.id, type: 'run.resumed', message: 'Workflow resumed' })
    const project = this.db.get<{ name: string }>(`SELECT name FROM projects WHERE id = ?`, row.project_id)!
    this.launch(row.id, project.name, fs)
    return this.orchestrator.getRun(row.id)!
  }

  /**
   * Called at startup after the orchestrator paused the runs the app interrupted: a step that was in flight when
   * the app closed did not finish, so it is shown as interrupted rather than as still working.
   */
  recover(): number {
    return Number(
      this.db.run(
        `UPDATE run_node_states SET status = 'failed', error = 'Interrupted: the app closed while this step was working.', finished_at = ?
         WHERE status IN ('running', 'waiting') AND run_id IN (SELECT id FROM runs WHERE status != 'running' AND (workflow_id IS NOT NULL OR json_extract(state_json, '$.workflow') = 1))`,
        this.now()
      ).changes
    )
  }

  /** Refuses a workflow that cannot run, saying what is wrong, before anything is created or paid for. */
  private assertRunnable(graph: WorkflowGraph, projectId: string): void {
    const team = this.agents.list().filter((a) => a.projectId === projectId)
    const errors = [...checkGraph(graph), ...checkTeam(graph, team)].filter((i) => i.severity === 'error')
    if (errors.length === 0) return
    const shown = errors.slice(0, 5).map((e) => `- ${e.message}`)
    throw new Error(`This workflow cannot run yet:\n${shown.join('\n')}${errors.length > shown.length ? `\n…and ${errors.length - shown.length} more.` : ''}`)
  }

  // ------------------------------------------------------------------ run lifecycle

  private launch(runId: string, projectName: string, fs: FlowState): void {
    const row = this.db.get<RunRow>(`SELECT * FROM runs WHERE id = ?`, runId)!
    const controller = new AbortController()
    const active: ActiveFlow = { controller, reason: null, promise: Promise.resolve() }
    const flight: Flight = {
      runId,
      projectId: row.project_id,
      projectName,
      goal: row.goal,
      concurrency: row.concurrency,
      controller,
      signal: controller.signal,
      rt: newRuntime(),
      fs,
      busy: new Set()
    }
    this.active.set(runId, active)
    active.promise = this.execute(flight).finally(() => this.active.delete(runId))
  }

  private async execute(f: Flight): Promise<void> {
    try {
      await this.drive(f)
      this.conclude(f)
    } catch (e) {
      // Not a step failing (those are recorded on the step): the engine itself broke, or the run vanished.
      const message = e instanceof Error ? e.message : String(e)
      try {
        f.fs.failInFlight(`The workflow engine stopped: ${message}`)
        this.commit(f)
        this.settle(f, 'failed', message, 'error')
      } catch {
        /* the run no longer exists (its project was deleted): nothing is left to update */
      }
    }
  }

  private async drive(f: Flight): Promise<void> {
    const inflight = new Map<string, Promise<void>>()
    const stopping = (): boolean => f.signal.aborted || f.rt.budgetHit !== null
    for (;;) {
      // Once the run is stopping, what the interrupted steps left behind must not be propagated (a loop would judge a
      // half-finished round and block everything after it): resume picks the state up exactly as it stands.
      if (!stopping()) f.fs.settle()
      this.commit(f)
      if (!stopping()) {
        for (const id of f.fs.ready()) {
          if (inflight.size >= f.concurrency) break
          const node = f.fs.graph.nodes.find((n) => n.id === id)!
          const a = this.assign(f, node)
          if (a === 'wait') continue
          if ('error' in a) {
            f.fs.start(id)
            f.fs.fail(id, a.error)
            this.note(f, node, 'failed', a.error)
            this.commit(f)
            continue
          }
          for (const aid of a.ids) f.busy.add(aid)
          f.fs.start(id)
          this.note(f, node, 'started')
          this.commit(f)
          inflight.set(
            id,
            this.runNode(f, node, a).finally(() => inflight.delete(id))
          )
        }
        // A step that failed straight away may have unblocked or blocked others.
        if (f.fs.ready().some((id) => !inflight.has(id) && this.canLaunch(f, id)) && inflight.size < f.concurrency) continue
      }
      if (inflight.size > 0) {
        await Promise.race(inflight.values())
        continue
      }
      if (stopping()) return
      // Nothing is running and nothing can start: whatever is still waiting never will.
      if (f.fs.pendingIds().length === 0) return
      f.fs.blockPending('It never became ready: the steps before it did not lead to it.')
      f.fs.settle()
      this.commit(f)
      if (f.fs.pendingIds().length === 0) return
    }
  }

  /** True when a step that is ready would actually be started on the next pass (an agent may be busy, or the step may already be handled). */
  private canLaunch(f: Flight, id: string): boolean {
    const node = f.fs.graph.nodes.find((n) => n.id === id)!
    if (f.fs.status(id) !== 'pending') return false
    const a = this.assign(f, node)
    return a !== 'wait'
  }

  /** Decides how the run ended and records it. */
  private conclude(f: Flight): void {
    f.fs.failInFlight('Stopped by the user.')
    this.commit(f)
    if (f.signal.aborted) return this.settle(f, 'cancelled', 'Stopped by the user.', 'warn')
    if (f.rt.budgetHit) return this.settle(f, 'paused', `${f.rt.budgetHit} Raise the budget and resume to continue.`, 'warn')
    const c = f.fs.counts()
    const bad = c.failed + c.blocked
    const open = c.pending + c.running + c.waiting
    const total = f.fs.graph.nodes.length
    const spent = this.orchestrator.syncSpend(f.runId)
    const t = this.now()
    const status = bad === 0 && open === 0 ? 'completed' : 'failed'
    const error = status === 'completed' ? null : `${bad + open} of ${total} steps did not finish (${c.failed} failed, ${c.blocked} blocked${open ? `, ${open} left open` : ''}).`
    this.db.run(`UPDATE runs SET status = ?, error = ?, spent_usd = ?, finished_at = ? WHERE id = ?`, status, error, spent, t, f.runId)
    this.db.run(`UPDATE agents SET status = 'idle' WHERE project_id = ? AND status = 'working'`, f.projectId)
    this.events.record({
      projectId: f.projectId,
      runId: f.runId,
      level: status === 'completed' ? 'info' : 'error',
      type: `run.${status}`,
      message: status === 'completed' ? `Workflow completed: ${c.done} steps done${c.skipped ? `, ${c.skipped} skipped` : ''} · ${usd(spent)}` : `Workflow failed: ${error}`
    })
  }

  private settle(f: Flight, status: 'cancelled' | 'paused' | 'failed', message: string, level: 'warn' | 'error'): void {
    const t = this.now()
    this.db.transaction(() => {
      this.db.run(`UPDATE runs SET status = ?, error = ?, spent_usd = ?, finished_at = ? WHERE id = ?`, status, message, this.orchestrator.syncSpend(f.runId), status === 'paused' ? null : t, f.runId)
      this.db.run(`UPDATE agents SET status = 'idle' WHERE project_id = ? AND status = 'working'`, f.projectId)
    })
    this.events.record({ projectId: f.projectId, runId: f.runId, level, type: `run.${status}`, message: `Workflow ${status}: ${message}` })
  }

  /** Writes what changed to the database: the steps' states and the flow's position, so a restart can continue from here. */
  private commit(f: Flight): void {
    const dirty = f.fs.takeDirty()
    try {
      for (const n of dirty) {
        this.db.run(
          `INSERT INTO run_node_states (run_id, node_id, status, output_json, error, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, node_id) DO UPDATE SET status = excluded.status, output_json = excluded.output_json, error = excluded.error, started_at = excluded.started_at, finished_at = excluded.finished_at`,
          f.runId,
          n.nodeId,
          n.status,
          JSON.stringify({ text: n.output, handle: n.handle, note: n.note, runs: n.runs, taskId: n.taskId }),
          n.error,
          n.startedAt,
          n.finishedAt
        )
      }
      this.db.run(`UPDATE runs SET state_json = json_set(state_json, '$.flow', json(?)) WHERE id = ?`, JSON.stringify(f.fs.snapshot()), f.runId)
    } catch (e) {
      // The run's rows are gone (the project was deleted while it ran): there is nothing to continue.
      f.controller.abort()
      throw e
    }
  }

  private note(f: Flight, node: WorkflowNode, what: 'started' | 'done' | 'failed', detail?: string): void {
    this.events.record({
      projectId: f.projectId,
      runId: f.runId,
      level: what === 'failed' ? 'error' : 'info',
      type: `workflow.step.${what}`,
      message: `Step “${node.label}” ${what === 'started' ? 'started' : what === 'done' ? 'finished' : `failed: ${clip(detail ?? '', 300)}`}`,
      data: { nodeId: node.id }
    })
  }

  // ------------------------------------------------------------------ one step

  private async runNode(f: Flight, node: WorkflowNode, a: Assignment): Promise<void> {
    try {
      const out = await this.exec(f, node, a)
      f.fs.complete(node.id, out)
      this.note(f, node, 'done')
    } catch (e) {
      if (e instanceof CallCancelledError || f.signal.aborted) f.fs.fail(node.id, 'Stopped by the user.')
      else if (e instanceof BudgetExceeded) {
        f.rt.budgetHit = e.message
        f.fs.fail(node.id, `Paused: ${e.message}`)
      } else {
        const message = e instanceof Error ? e.message : String(e)
        f.fs.fail(node.id, message)
        this.note(f, node, 'failed', message)
      }
    } finally {
      for (const id of a.ids) f.busy.delete(id)
      try {
        this.commit(f)
      } catch {
        /* reported by the engine loop */
      }
    }
  }

  private exec(f: Flight, node: WorkflowNode, a: Assignment): Promise<StepResult> {
    switch (node.type) {
      case 'agent':
        return this.execAgent(f, node as Extract<WorkflowNode, { type: 'agent' }>, a.agent!)
      case 'image':
        return this.execImage(f, node as Extract<WorkflowNode, { type: 'image' }>, a.agent!)
      case 'review':
        return this.execReview(f, node as Extract<WorkflowNode, { type: 'review' }>, a.agent!)
      case 'test':
        return this.execTest(f, node as Extract<WorkflowNode, { type: 'test' }>)
      case 'condition':
        return this.execCondition(f, node as Extract<WorkflowNode, { type: 'condition' }>, a.agent)
      case 'approval':
        return this.execApproval(f, node as Extract<WorkflowNode, { type: 'approval' }>)
      case 'debate':
        return this.execDebate(f, node as Extract<WorkflowNode, { type: 'debate' }>, a.participants!, a.moderator!)
      case 'loop':
        return Promise.reject(new Error('A loop is driven by the flow, not run as a step.'))
    }
  }

  private inputOf(f: Flight, node: WorkflowNode): string {
    return clip(joinInputs(f.fs.inputs(node.id)), INPUT_CHARS)
  }

  private async execAgent(f: Flight, node: Extract<WorkflowNode, { type: 'agent' }>, agent: Agent): Promise<StepResult> {
    const input = this.inputOf(f, node)
    const cfg = node.config
    const instruction = fillTemplate(cfg.instruction, { goal: f.goal, input: clip(input, 6000) }).trim() || `Do the work of the step “${node.label}”.`
    if (agent.kind === 'image') {
      const r = await this.orchestrator.runStep(f.runId, { title: node.label, description: instruction, agent, image: { prompt: instruction, kind: 'other', transparent: false } }, f.signal, f.rt)
      return { output: r.text, handle: 'out', taskId: r.taskId }
    }
    const parts: string[] = []
    if (input && !/\{\{\s*input\s*\}\}/i.test(cfg.instruction)) parts.push(`## What the previous steps produced\n${input}`)
    const previous = f.fs.node(node.id)
    if (previous.runs > 0 && previous.output) parts.push(`## Your previous result for this step\nThe workflow came back to this step (for example after a review asked for changes). Improve on this result instead of starting over:\n${clip(previous.output, 8000)}`)
    const r = await this.orchestrator.runStep(f.runId, { title: node.label, description: instruction, agent, tools: { context: parts.join('\n\n') } }, f.signal, f.rt)
    return { output: r.text, handle: 'out', taskId: r.taskId }
  }

  private async execImage(f: Flight, node: Extract<WorkflowNode, { type: 'image' }>, agent: Agent): Promise<StepResult> {
    const cfg = node.config
    const input = this.inputOf(f, node)
    const prompt = fillTemplate(cfg.prompt, { goal: f.goal, input: clip(input, 2000) }).trim()
    if (!prompt) throw new Error('This image step has no prompt.')
    const r = await this.orchestrator.runStep(
      f.runId,
      { title: node.label, description: prompt, agent, image: { prompt, kind: cfg.kind, size: cfg.size || undefined, transparent: cfg.transparent } },
      f.signal,
      f.rt
    )
    return { output: r.text, handle: 'out', taskId: r.taskId }
  }

  private async execReview(f: Flight, node: Extract<WorkflowNode, { type: 'review' }>, agent: Agent): Promise<StepResult> {
    const input = this.inputOf(f, node)
    const criteria = fillTemplate(node.config.criteria, { goal: f.goal, input: '' }).trim()
    let verdict: { verdict: 'approved' | 'changes'; feedback: string } | null = null
    const submit: AgentTool = {
      def: {
        name: 'submit_verdict',
        description: 'Give your verdict on the work under review. Call it once, when you are done reviewing. “approved” means it meets the criteria as it is; “changes” sends it back with feedback.',
        parameters: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['approved', 'changes'] },
            feedback: { type: 'string', description: 'What is good, and for “changes” exactly what must be fixed, so the author can act on it without guessing.' }
          },
          required: ['verdict', 'feedback']
        }
      },
      allowed: () => true,
      execute: (_ctx, args) => {
        if (args.verdict !== 'approved' && args.verdict !== 'changes') throw new Error('verdict must be “approved” or “changes”.')
        const feedback = typeof args.feedback === 'string' ? args.feedback.trim() : ''
        if (args.verdict === 'changes' && !feedback) throw new Error('Say what must change.')
        verdict = { verdict: args.verdict, feedback }
        return 'Verdict recorded. Finish with a one-line summary.'
      }
    }
    const description = [
      `Review the work of the previous step${input ? '' : ' (nothing was passed in: look at the project files if you can)'}.`,
      criteria ? `Review criteria:\n${criteria}` : 'Judge it on correctness, completeness and whether it fulfils the goal.',
      'You can read project files with your tools when you need to check something. When you are done, call submit_verdict exactly once.'
    ].join('\n\n')
    const r = await this.orchestrator.runStep(
      f.runId,
      { title: node.label, description, agent, tools: { extra: [submit], mustCall: { tool: 'submit_verdict', satisfied: () => verdict !== null }, context: input ? `## The work under review\n${input}` : '' } },
      f.signal,
      f.rt
    )
    const v = verdict as { verdict: 'approved' | 'changes'; feedback: string } | null
    if (!v) throw new Error(`“${agent.name}” finished the review without giving a verdict.`)
    return { output: v.feedback || (v.verdict === 'approved' ? 'Approved.' : 'Changes requested.'), handle: v.verdict, taskId: r.taskId, note: v.verdict === 'approved' ? 'Approved' : 'Changes requested' }
  }

  private async execTest(f: Flight, node: Extract<WorkflowNode, { type: 'test' }>): Promise<StepResult> {
    if (!this.workspace) throw new Error('Running commands is not available.')
    const cfg = node.config
    const timeoutMs = Math.min(Math.max(1, cfg.timeoutSec || DEFAULT_TIMEOUT_MS / 1000), MAX_TIMEOUT_MS / 1000) * 1000
    try {
      const r = await this.workspace.commands.run({
        projectId: f.projectId,
        projectName: f.projectName,
        sandbox: this.workspace.workspace.sandbox(f.projectId),
        command: cfg.command.trim(),
        cwd: cfg.cwd.trim() || undefined,
        origin: 'agent',
        // Commands on the allow-list run; anything else waits for the user, exactly as for an agent's own command.
        policy: 'allowlist',
        agent: null,
        runId: f.runId,
        taskId: null,
        taskTitle: node.label,
        timeoutMs,
        signal: f.signal
      })
      if (f.signal.aborted) throw new CallCancelledError()
      const passed = r.outcome === 'exited' && r.exitCode === 0
      const head = r.outcome === 'exited' ? `Exit code ${r.exitCode} after ${(r.durationMs / 1000).toFixed(1)}s.` : r.outcome === 'timeout' ? `Timed out after ${(timeoutMs / 1000).toFixed(0)}s and was killed.` : `${r.outcome}${r.message ? `: ${r.message}` : ''}`
      return { output: `$ ${cfg.command.trim()}\n${head}${r.truncated ? ' (output was clipped)' : ''}\n${r.output || '(no output)'}`, handle: passed ? 'pass' : 'fail', note: passed ? 'Passed' : r.outcome === 'timeout' ? 'Timed out' : `Failed (exit ${r.exitCode ?? '–'})` }
    } catch (e) {
      if (e instanceof CommandRefusedError) {
        if (f.signal.aborted) throw new CallCancelledError()
        throw new Error(`The command was not run: ${e.message}`)
      }
      throw e
    }
  }

  private async execCondition(f: Flight, node: Extract<WorkflowNode, { type: 'condition' }>, agent: Agent | undefined): Promise<StepResult> {
    const input = this.inputOf(f, node)
    const cfg = node.config
    const value = fillTemplate(cfg.value, { goal: f.goal, input: '' }).trim()
    let yes: boolean
    let note: string | null = null
    if (cfg.mode === 'contains') yes = input.toLowerCase().includes(value.toLowerCase())
    else if (cfg.mode === 'regex') yes = new RegExp(value, 'i').test(input.slice(0, 100_000))
    else {
      const r = await this.askYesNo(f, node, agent!, value, input)
      yes = r.yes
      note = r.reason
    }
    return { output: input, handle: yes ? 'true' : 'false', note: note ?? (yes ? 'Yes' : 'No') }
  }

  /** An "ask the AI" condition: one model call that must answer through a tool, so the answer is never guessed from prose. */
  private async askYesNo(f: Flight, node: WorkflowNode, agent: Agent, question: string, material: string): Promise<{ yes: boolean; reason: string | null }> {
    const messages: ChatMessage[] = [{ role: 'user', content: `Question: ${question}\n\nWork to judge:\n${material || '(nothing was passed in)'}\n\nAnswer by calling submit_decision.` }]
    const tool = {
      name: 'submit_decision',
      description: 'Answer the yes/no question.',
      parameters: { type: 'object', properties: { answer: { type: 'boolean' }, reason: { type: 'string', description: 'One sentence.' } }, required: ['answer'] }
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { response } = await this.orchestrator.chat(
        f.runId,
        agent,
        { system: `${agent.systemPrompt}\n\nYou are making a yes/no decision inside an automated workflow. Answer only by calling submit_decision.`, messages, tools: [tool], taskId: null, label: `Agent “${agent.name}” · decision for “${node.label}”`, maxTokens: 500 },
        f.signal,
        f.rt
      )
      const call = response.toolCalls.find((c) => c.name === 'submit_decision')
      if (call && typeof call.arguments.answer === 'boolean') return { yes: call.arguments.answer, reason: typeof call.arguments.reason === 'string' ? call.arguments.reason.trim().slice(0, 300) || null : null }
      messages.push({ role: 'assistant', content: response.text.trim() || '…' }, { role: 'user', content: 'Call submit_decision with answer true or false.' })
    }
    throw new Error(`“${agent.name}” did not answer the question with submit_decision.`)
  }

  private async execApproval(f: Flight, node: Extract<WorkflowNode, { type: 'approval' }>): Promise<StepResult> {
    const approvals = this.workspace?.commands.approvals
    if (!approvals) throw new Error('Approvals are not available.')
    const input = this.inputOf(f, node)
    const question = fillTemplate(node.config.message, { goal: f.goal, input: '' }).trim() || 'Continue the workflow?'
    f.fs.wait(node.id, 'Waiting for your decision')
    this.commit(f)
    const req = approvals.request(
      { kind: 'workflow', projectId: f.projectId, projectName: f.projectName, agentId: null, agentName: null, taskTitle: node.label, command: question, cwd: '', reason: 'A workflow step needs your decision.', detail: input || null },
      { signal: f.signal, runId: f.runId, timeoutMs: APPROVAL_WAIT_MS, now: this.now() }
    )
    this.events.record({ projectId: f.projectId, runId: f.runId, level: 'warn', type: 'workflow.approval_requested', message: `Step “${node.label}” waits for your decision: ${clip(question, 160)}` })
    const ok = await req.decision
    if (f.signal.aborted) throw new CallCancelledError()
    return { output: input, handle: ok ? 'approved' : 'rejected', note: ok ? 'Approved by you' : 'Rejected (or nobody answered in time)' }
  }

  /**
   * Several agents answer the same question, read each other's answers and answer again, and a moderator writes
   * the decision. Every turn is a real model call: `debateCalls(participants, rounds)` in total.
   */
  private async execDebate(f: Flight, node: Extract<WorkflowNode, { type: 'debate' }>, participants: Agent[], moderator: Agent): Promise<StepResult> {
    const cfg: NodeConfigs['debate'] = node.config
    const input = this.inputOf(f, node)
    const question = fillTemplate(cfg.question, { goal: f.goal, input: clip(input, 4000) }).trim()
    const context = input && !/\{\{\s*input\s*\}\}/i.test(cfg.question) ? `\n\nWhat the previous steps produced:\n${clip(input, 8000)}` : ''
    const agents = [...new Map([...participants, moderator].map((a) => [a.id, a])).values()]
    const { taskId, text } = await this.orchestrator.trackedStep(f.runId, { title: node.label, description: `Debate: ${question}`.slice(0, 7800), agents }, async (taskId) => {
      this.orchestrator.transcript(f.runId, taskId, null, 'user', `Debate question: ${question}${context}`)
      const turn = async (agent: Agent, label: string, prompt: string, maxTokens: number): Promise<string> => {
        const { response } = await this.orchestrator.chat(
          f.runId,
          agent,
          {
            system: `${agent.systemPrompt}\n\nYou are one voice in a structured debate between several specialists. Argue from your own expertise, be concrete, disagree where you actually disagree, and keep it under 300 words.`,
            messages: [{ role: 'user', content: prompt }],
            taskId,
            label: `Agent “${agent.name}” · ${label}`,
            maxTokens
          },
          f.signal,
          f.rt
        )
        const out = response.text.trim()
        if (!out) throw new Error(`“${agent.name}” gave an empty answer in the debate.`)
        this.orchestrator.transcript(f.runId, taskId, agent.id, 'assistant', `[${label}]\n${out}`)
        return out
      }
      const all = async (jobs: Array<() => Promise<string>>): Promise<string[]> => {
        const results = await Promise.allSettled(jobs.map((j) => j()))
        const bad = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
        if (bad) throw bad.reason
        return results.map((r) => (r as PromiseFulfilledResult<string>).value)
      }
      const show = (positions: string[], except?: number): string => positions.map((p, i) => (i === except ? null : `### ${participants[i].name} (${participants[i].roleLabel})\n${p}`)).filter(Boolean).join('\n\n')

      let positions = await all(participants.map((a) => () => turn(a, 'opening position', `Question for the debate:\n${question}${context}\n\nGive your position and the strongest reasons for it.`, POSITION_TOKENS)))
      for (let round = 1; round <= cfg.rounds; round++) {
        const prev = positions
        positions = await all(
          participants.map((a, i) => () =>
            turn(
              a,
              `critique round ${round}`,
              `Question for the debate:\n${question}\n\nYour position so far:\n${prev[i]}\n\nThe other positions:\n${show(prev, i)}\n\nCritique them where they are wrong or risky, concede what they got right, and state your updated position.`,
              POSITION_TOKENS
            )
          )
        )
      }
      const decision = await turn(
        moderator,
        'decision',
        `You moderate this debate and decide.\n\nQuestion:\n${question}${context}\n\nFinal positions:\n${show(positions)}\n\nWrite the decision as: **Decision** (one clear choice), **Why** (the reasons that decided it), **Risks** (what the losing side warned about that still matters), **Next steps** (concrete, in order). Do not hedge: pick.`,
        DECISION_TOKENS
      )
      if (cfg.saveToMemory) this.saveDecision(f, moderator, question, decision, positions, participants)
      return decision
    })
    const calls = debateCalls(participants.length, cfg.rounds)
    return { output: text, handle: 'out', taskId, note: `${participants.length} agents · ${cfg.rounds} critique round${cfg.rounds === 1 ? '' : 's'} · ${calls} calls${cfg.saveToMemory ? ' · saved to project memory' : ''}` }
  }

  private saveDecision(f: Flight, moderator: Agent, question: string, decision: string, positions: string[], participants: Agent[]): void {
    const t = this.now()
    const content = `${decision}\n\n---\nFinal positions of the debate:\n${positions.map((p, i) => `\n### ${participants[i].name} (${participants[i].roleLabel})\n${p}`).join('\n')}`
    this.db.run(
      `INSERT INTO memory_entries (id, project_id, kind, title, content, author, created_at, updated_at) VALUES (?, ?, 'decision', ?, ?, ?, ?, ?)`,
      randomUUID(),
      f.projectId,
      `Debate: ${question.replace(/\s+/g, ' ').slice(0, 120)}`,
      clip(content, 20_000),
      moderator.id,
      t,
      t
    )
    this.events.record({ projectId: f.projectId, runId: f.runId, agentId: moderator.id, type: 'memory.written', message: `The debate decision was saved to project memory` })
  }

  // ------------------------------------------------------------------ choosing agents

  /** Who does this step. A step waits while its agent is busy with another step of the same run. */
  private assign(f: Flight, node: WorkflowNode): Assignment | 'wait' | { error: string } {
    const team = this.agents.list().filter((a) => a.projectId === f.projectId)
    const one = (ref: AgentRef, kind: 'chat' | 'image', what: string, taken: ReadonlySet<string> = new Set()): Pick1 => {
      const ids = new Set(candidatesFor(team, ref, kind).map((a) => a.id))
      const list = team.filter((a) => ids.has(a.id) && !taken.has(a.id))
      if (list.length === 0) return { kind: 'error', message: `No ready agent is available for ${what}.` }
      const free = list.find((a) => !f.busy.has(a.id))
      return free ? { kind: 'ok', agent: free } : { kind: 'wait' }
    }
    const single = (r: Pick1): Assignment | 'wait' | { error: string } => (r.kind === 'ok' ? { agent: r.agent, ids: [r.agent.id] } : r.kind === 'wait' ? 'wait' : { error: r.message })
    switch (node.type) {
      case 'agent': {
        const asked = node.config.agent.agentId ? team.find((a) => a.id === node.config.agent.agentId) : undefined
        return single(one(node.config.agent, asked?.kind === 'image' ? 'image' : 'chat', `“${node.label}”`))
      }
      case 'review':
        return single(one(node.config.agent, 'chat', `the reviewer of “${node.label}”`))
      case 'condition':
        return node.config.mode === 'ai' ? single(one(node.config.agent, 'chat', `the question of “${node.label}”`)) : { ids: [] }
      case 'image': {
        const ready = team.filter((a) => a.kind === 'image' && agentReady(a) && a.permissions.generateImages && (!node.config.agentId || a.id === node.config.agentId))
        if (ready.length === 0) return { error: `No ready image agent can generate the pictures of “${node.label}”.` }
        const free = ready.find((a) => !f.busy.has(a.id))
        return free ? { agent: free, ids: [free.id] } : 'wait'
      }
      case 'debate': {
        const taken = new Set<string>()
        const participants: Agent[] = []
        let waiting = false
        for (const [i, p] of node.config.participants.entries()) {
          const r = one(p, 'chat', `participant ${i + 1} of “${node.label}”`, taken)
          if (r.kind === 'error') return { error: r.message }
          if (r.kind === 'wait') {
            waiting = true
            continue
          }
          taken.add(r.agent.id)
          participants.push(r.agent)
        }
        if (waiting) return 'wait'
        const ids = new Set(candidatesFor(team, node.config.moderator, 'chat').map((a) => a.id))
        const mods = team.filter((a) => ids.has(a.id))
        if (mods.length === 0) return { error: `No ready agent can moderate “${node.label}”.` }
        // The moderator may be one of the participants (it speaks after them); otherwise it must be free.
        const moderator = mods.find((a) => taken.has(a.id)) ?? mods.find((a) => !f.busy.has(a.id))
        if (!moderator) return 'wait'
        return { participants, moderator, ids: [...new Set([...participants.map((a) => a.id), moderator.id])] }
      }
      default:
        return { ids: [] }
    }
  }
}

// ------------------------------------------------------------------ stored data

function parseState(json: string): StoredState {
  try {
    const v = JSON.parse(json) as unknown
    return typeof v === 'object' && v !== null ? (v as StoredState) : {}
  } catch {
    return {}
  }
}

function parseOutput(json: string | null): { text: string | null; handle: string | null; note: string | null; runs: number; taskId: string | null } {
  const empty = { text: null, handle: null, note: null, runs: 0, taskId: null }
  if (!json) return empty
  try {
    const v = JSON.parse(json) as Partial<{ text: string | null; handle: string | null; note: string | null; runs: number; taskId: string | null }>
    return {
      text: typeof v.text === 'string' ? v.text : null,
      handle: typeof v.handle === 'string' ? v.handle : null,
      note: typeof v.note === 'string' ? v.note : null,
      runs: typeof v.runs === 'number' ? v.runs : 0,
      taskId: typeof v.taskId === 'string' ? v.taskId : null
    }
  } catch {
    return empty
  }
}

function toNodeState(r: NodeRow): NodeRunState {
  const o = parseOutput(r.output_json)
  return { nodeId: r.node_id, status: r.status, output: o.text, handle: o.handle, error: r.error, note: o.note, runs: o.runs, taskId: o.taskId, startedAt: r.started_at, finishedAt: r.finished_at }
}

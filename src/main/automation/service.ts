import { randomUUID } from 'node:crypto'
import type { AutomationKind, AutomationRun, AutomationStatus, AutomationTask } from '../../shared/ipc'
import type { EventService } from '../services/events'
import { CommandRefusedError, type CommandService } from '../workspace/commands'
import type { WorkspaceService } from '../workspace/workspace'
import { detectTasks } from './detect'
import { parseProblems, parseTests, stripAnsi } from './parsers'

const KEEP_PER_PROJECT = 20
const LIVE_TAIL = 60_000
const PUSH_EVERY_MS = 250
const RUN_TIMEOUT_MS = 10 * 60_000

/**
 * Runs the project's own build / test / lint / type-check commands (found by `detectTasks`) through the same command service as the terminal,
 * so the safety rules, the log and "stop everything" apply. Output is parsed into problems and a test summary; the full text is kept next to them.
 */
export class AutomationService {
  private readonly runs = new Map<string, AutomationRun[]>()
  private readonly byCommand = new Map<string, AutomationRun>()
  private readonly listeners = new Set<(r: AutomationRun) => void>()
  private readonly lastPush = new Map<string, number>()

  constructor(
    private readonly events: EventService,
    private readonly workspace: WorkspaceService,
    private readonly commands: CommandService
  ) {
    // Live output: the terminal stream carries every command's text; keep the tail of the ones we started.
    commands.subscribe((e) => {
      if (e.type !== 'output') return
      const run = this.byCommand.get(e.id)
      if (!run) return
      run.output = (run.output + stripAnsi(e.text)).slice(-LIVE_TAIL)
      const now = Date.now()
      if (now - (this.lastPush.get(run.id) ?? 0) >= PUSH_EVERY_MS) this.push(run)
    })
  }

  subscribe(cb: (r: AutomationRun) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private push(run: AutomationRun): void {
    this.lastPush.set(run.id, Date.now())
    const snap = { ...run }
    for (const l of this.listeners) l(snap)
  }

  detect(projectId: string): AutomationTask[] {
    return detectTasks(this.workspace.sandbox(projectId).root)
  }

  list(projectId: string): AutomationRun[] {
    return (this.runs.get(projectId) ?? []).map((r) => ({ ...r }))
  }

  get(id: string): AutomationRun | null {
    for (const list of this.runs.values()) {
      const r = list.find((x) => x.id === id)
      if (r) return { ...r }
    }
    return null
  }

  /** Starts a run and returns at once; progress and the result arrive through `subscribe`. */
  start(projectId: string, kind: AutomationKind): AutomationRun {
    const project = this.workspace.project(projectId)
    const sandbox = this.workspace.sandbox(projectId)
    const task = detectTasks(sandbox.root).find((t) => t.kind === kind)
    if (!task) throw new Error(`This project does not define a ${kind} command. Add one (for example an npm script) or run it by hand in the terminal.`)
    const list = this.runs.get(projectId) ?? []
    if (list.some((r) => r.kind === kind && r.status === 'running')) throw new Error(`A ${kind} run is already in progress for this project.`)

    const id = randomUUID()
    const run: AutomationRun = {
      id,
      projectId,
      kind,
      label: task.label,
      command: task.command,
      status: 'running',
      exitCode: null,
      output: '',
      truncated: false,
      startedAt: Date.now(),
      durationMs: null,
      problems: [],
      tests: null,
      message: null
    }
    list.unshift(run)
    // Only the newest runs are kept; one that is still running is never dropped.
    while (list.length > KEEP_PER_PROJECT) {
      const idx = list.map((r) => r.status !== 'running').lastIndexOf(true)
      if (idx < 0) break
      list.splice(idx, 1)
    }
    this.runs.set(projectId, list)
    this.byCommand.set(id, run)
    this.events.record({ projectId, type: 'automation.started', message: `${task.label}: ${task.command}` })
    this.push(run)

    void this.commands
      .run({ projectId, projectName: project.name, sandbox, command: task.command, origin: 'user', timeoutMs: RUN_TIMEOUT_MS }, id)
      .then((res) => {
        run.output = stripAnsi(res.output)
        run.truncated = res.truncated
        run.exitCode = res.exitCode
        run.durationMs = res.durationMs
        run.message = res.message
        run.status = res.outcome === 'exited' ? (res.exitCode === 0 ? 'passed' : 'failed') : res.outcome === 'cancelled' ? 'cancelled' : res.outcome === 'timeout' ? 'failed' : 'error'
        this.finish(run, sandbox.root)
      })
      .catch((e) => {
        run.status = 'error'
        run.durationMs = Date.now() - run.startedAt
        run.message = e instanceof CommandRefusedError || e instanceof Error ? e.message : String(e)
        this.finish(run, sandbox.root)
      })
    return { ...run }
  }

  private finish(run: AutomationRun, root: string): void {
    this.byCommand.delete(run.id)
    try {
      run.problems = parseProblems(run.output, root)
      run.tests = run.kind === 'test' ? parseTests(run.output) : null
    } catch {
      /* a parser bug must not hide the output */
    }
    const where: Record<AutomationStatus, string> = { running: '', passed: 'passed', failed: 'failed', cancelled: 'was stopped', error: 'could not run' }
    const extra = run.tests ? ` (${run.tests.passed} passed, ${run.tests.failed} failed)` : run.problems.length > 0 ? ` (${run.problems.length} problem${run.problems.length === 1 ? '' : 's'})` : ''
    this.events.record({
      projectId: run.projectId,
      level: run.status === 'passed' ? 'info' : 'warn',
      type: 'automation.finished',
      message: `${run.label} ${where[run.status]}${extra}`
    })
    this.push(run)
  }

  cancel(id: string): boolean {
    return this.commands.kill(id)
  }
}

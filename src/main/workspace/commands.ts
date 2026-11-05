import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { CommandLogEntry, CommandOrigin, CommandOutcome, CommandPolicy, PendingApproval, TerminalEvent } from '../../shared/ipc'
import type { Database } from '../db/database'
import { decideCommand } from '../security/command-policy'
import type { EventService } from '../services/events'
import { WorkspaceError, type Sandbox } from './sandbox'

export const APPROVAL_TIMEOUT_MS = 15 * 60_000
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 15 * 60_000
const OUTPUT_HEAD = 40_000
const OUTPUT_TAIL = 40_000

// ------------------------------------------------------------------ approvals

interface PendingEntry {
  info: PendingApproval
  resolve: (allowed: boolean) => void
  cleanup: () => void
  runId: string | null
}

/**
 * Commands that the policy wants a human to look at wait here. Nothing is persisted: if the app closes, every
 * waiting command is simply never run. The agent's tool call stays blocked until the user answers, the
 * request times out, or the run is stopped.
 */
export class ApprovalService {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly listeners = new Set<(list: PendingApproval[]) => void>()

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.info).sort((a, b) => a.createdAt - b.createdAt)
  }

  subscribe(cb: (list: PendingApproval[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private notify(): void {
    const list = this.list()
    for (const l of this.listeners) l(list)
  }

  /** Resolves true when the user approves, false on denial, timeout or abort. */
  request(info: Omit<PendingApproval, 'id' | 'createdAt' | 'expiresAt'>, opts: { signal?: AbortSignal; runId?: string | null; timeoutMs?: number; now?: number } = {}): { id: string; decision: Promise<boolean> } {
    const id = randomUUID()
    const createdAt = opts.now ?? Date.now()
    const timeoutMs = opts.timeoutMs ?? APPROVAL_TIMEOUT_MS
    const full: PendingApproval = { ...info, id, createdAt, expiresAt: createdAt + timeoutMs }
    const decision = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(id, false), timeoutMs)
      const onAbort = (): void => void this.settle(id, false)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        info: full,
        resolve,
        runId: opts.runId ?? null,
        cleanup: () => {
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
        }
      })
      if (opts.signal?.aborted) onAbort()
    })
    this.notify()
    return { id, decision }
  }

  private settle(id: string, allowed: boolean): boolean {
    const p = this.pending.get(id)
    if (!p) return false
    this.pending.delete(id)
    p.cleanup()
    p.resolve(allowed)
    this.notify()
    return true
  }

  respond(id: string, allow: boolean): boolean {
    return this.settle(id, allow)
  }

  /** Emergency stop: everything waiting is denied. */
  denyAll(): number {
    const ids = [...this.pending.keys()]
    for (const id of ids) this.settle(id, false)
    return ids.length
  }
}

// ------------------------------------------------------------------ running

export interface RunCommandOptions {
  projectId: string
  projectName: string
  sandbox: Sandbox
  command: string
  /** Project-relative working folder. */
  cwd?: string
  origin: CommandOrigin
  /** Only used for agents. A user typing in the terminal is not subject to approval. */
  policy?: CommandPolicy
  agent?: { id: string; name: string } | null
  runId?: string | null
  taskId?: string | null
  taskTitle?: string | null
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CommandResult {
  id: string
  outcome: CommandOutcome
  exitCode: number | null
  /** stdout and stderr interleaved in arrival order; long output keeps its beginning and end. */
  output: string
  truncated: boolean
  durationMs: number
  message: string | null
}

export class CommandRefusedError extends Error {
  constructor(
    message: string,
    readonly outcome: 'denied' | 'blocked'
  ) {
    super(message)
    this.name = 'CommandRefusedError'
  }
}

/** Environment passed to commands: the app's own settings and anything that looks like a credential stay out. */
export function sanitizedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(source)) {
    if (v === undefined) continue
    if (/^(ELECTRON_|MADS_|NODE_OPTIONS$|VSCODE_)/i.test(k)) continue
    if (/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i.test(k)) continue
    env[k] = v
  }
  env.FORCE_COLOR = '0'
  env.NO_COLOR = '1'
  env.CI = env.CI ?? '1'
  return env
}

interface Running {
  child: ChildProcess
  projectId: string
  runId: string | null
  kill: (why: 'cancelled' | 'timeout') => void
}

class BoundedOutput {
  private head = ''
  private tail = ''
  private dropped = 0
  append(text: string): void {
    if (this.head.length < OUTPUT_HEAD) {
      const room = OUTPUT_HEAD - this.head.length
      this.head += text.slice(0, room)
      text = text.slice(room)
    }
    if (!text) return
    this.tail += text
    if (this.tail.length > OUTPUT_TAIL) {
      const cut = this.tail.length - OUTPUT_TAIL
      this.dropped += cut
      this.tail = this.tail.slice(cut)
    }
  }
  get truncated(): boolean {
    return this.dropped > 0
  }
  toString(): string {
    return this.dropped > 0 ? `${this.head}\n[... ${this.dropped} characters omitted ...]\n${this.tail}` : this.head + this.tail
  }
}

export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => undefined)
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

/**
 * Runs shell commands inside a project folder, one decision at a time: blocked -> never; denied by policy -> never;
 * needs approval -> waits for the user; otherwise runs. Every attempt is recorded in `command_log` and streamed to the UI.
 */
export class CommandService {
  private readonly running = new Map<string, Running>()
  private readonly listeners = new Set<(e: TerminalEvent) => void>()

  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    readonly approvals: ApprovalService,
    private readonly now: () => number = Date.now
  ) {}

  subscribe(cb: (e: TerminalEvent) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(e: TerminalEvent): void {
    for (const l of this.listeners) l(e)
  }

  history(projectId: string, limit = 50): CommandLogEntry[] {
    return this.db
      .all<{
        id: string
        project_id: string | null
        agent_name: string | null
        origin: string
        command: string
        cwd: string
        decision: CommandLogEntry['decision']
        reason: string | null
        exit_code: number | null
        duration_ms: number | null
        created_at: number
      }>(
        `SELECT c.*, a.name AS agent_name FROM command_log c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.project_id = ? ORDER BY c.created_at DESC, c.rowid DESC LIMIT ?`,
        projectId,
        limit
      )
      .map((r) => ({
        id: r.id,
        projectId: r.project_id,
        agentName: r.agent_name,
        origin: r.origin === 'user' ? 'user' : 'agent',
        command: r.command,
        cwd: r.cwd,
        decision: r.decision,
        reason: r.reason,
        exitCode: r.exit_code,
        durationMs: r.duration_ms,
        createdAt: r.created_at
      }))
  }

  /** Stops one running command. Returns false if it already finished. */
  kill(id: string): boolean {
    const r = this.running.get(id)
    if (!r) return false
    r.kill('cancelled')
    return true
  }

  /** Emergency stop: kills every running command and denies every waiting approval. */
  killAll(): { killed: number; denied: number } {
    const denied = this.approvals.denyAll()
    const all = [...this.running.values()]
    for (const r of all) r.kill('cancelled')
    return { killed: all.length, denied }
  }

  killForRun(runId: string): number {
    let n = 0
    for (const r of this.running.values()) if (r.runId === runId) (r.kill('cancelled'), n++)
    return n
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  /**
   * Runs the command and resolves with its result. Throws CommandRefusedError when the policy blocks it,
   * the agent may not run commands, or the user denies it. Never throws for a non-zero exit code.
   */
  async run(opts: RunCommandOptions, preassignedId?: string): Promise<CommandResult> {
    const id = preassignedId ?? randomUUID()
    const started = this.now()
    const agent = opts.agent ?? null
    let cwdRel: string
    let cwdFull: string
    try {
      const r = opts.sandbox.resolve(opts.cwd ?? '')
      cwdRel = r.rel
      cwdFull = r.full
      if (!statSync(cwdFull).isDirectory()) throw new Error('not a directory')
    } catch (e) {
      const msg = e instanceof WorkspaceError ? e.message : `The working folder "${opts.cwd ?? ''}" does not exist inside the project.`
      this.emit({ type: 'start', id, projectId: opts.projectId, command: opts.command, cwd: opts.cwd ?? '', origin: opts.origin, agentName: agent?.name ?? null, note: null })
      this.emit({ type: 'end', id, outcome: 'error', exitCode: null, durationMs: 0, message: msg })
      throw new CommandRefusedError(msg, 'denied')
    }
    const cwdLabel = cwdRel || '.'

    // Hard blocks apply to everyone; the policy only matters for agents.
    const verdict = decideCommand(opts.origin === 'user' ? 'allowlist' : (opts.policy ?? 'none'), opts.command)
    this.emit({ type: 'start', id, projectId: opts.projectId, command: opts.command, cwd: cwdLabel, origin: opts.origin, agentName: agent?.name ?? null, note: verdict.action === 'ask' && opts.origin === 'agent' ? verdict.reason : null })

    const refuse = (decision: 'blocked' | 'user_denied', outcome: 'blocked' | 'denied', reason: string, level: 'warn' | 'info' = 'warn'): never => {
      this.log(id, opts, cwdLabel, decision, reason, null, 0)
      this.emit({ type: 'end', id, outcome, exitCode: null, durationMs: this.now() - started, message: reason })
      this.events.record({ projectId: opts.projectId, runId: opts.runId ?? null, agentId: agent?.id ?? null, level, type: outcome === 'blocked' ? 'command.blocked' : 'command.denied', message: `${agent?.name ?? 'You'}: “${opts.command.slice(0, 160)}” was not run. ${reason}` })
      throw new CommandRefusedError(reason, outcome)
    }

    if (verdict.action === 'blocked') refuse('blocked', 'blocked', verdict.reason)
    if (verdict.action === 'deny') refuse('blocked', 'denied', verdict.reason)

    let decision: CommandLogEntry['decision'] = opts.origin === 'user' ? 'user_approved' : 'auto_allowed'
    let reason = opts.origin === 'user' ? 'Typed by the user.' : verdict.reason
    // Only agents need approval. A person who typed the command in the terminal has already decided.
    if (verdict.action === 'ask' && opts.origin === 'agent') {
      const req = this.approvals.request(
        { projectId: opts.projectId, projectName: opts.projectName, agentId: agent?.id ?? null, agentName: agent?.name ?? null, taskTitle: opts.taskTitle ?? null, command: opts.command, cwd: cwdLabel, reason: verdict.reason },
        { signal: opts.signal, runId: opts.runId ?? null, now: this.now() }
      )
      this.events.record({ projectId: opts.projectId, runId: opts.runId ?? null, agentId: agent?.id ?? null, level: 'warn', type: 'command.approval_requested', message: `${agent?.name ?? 'An agent'} wants to run “${opts.command.slice(0, 160)}” and waits for your approval` })
      const allowed = await req.decision
      if (!allowed) refuse('user_denied', 'denied', opts.signal?.aborted ? 'Stopped before the command was approved.' : 'The command was not approved (denied, timed out, or stopped).', 'info')
      decision = 'user_approved'
      reason = 'Approved by the user.'
    }

    return this.spawnAndWait(id, opts, cwdLabel, cwdFull, decision, reason, started)
  }

  private spawnAndWait(id: string, opts: RunCommandOptions, cwdLabel: string, cwdFull: string, decision: CommandLogEntry['decision'], reason: string, started: number): Promise<CommandResult> {
    const agent = opts.agent ?? null
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS)
    const out = new BoundedOutput()
    this.log(id, opts, cwdLabel, decision, reason, null, null)
    this.events.record({ projectId: opts.projectId, runId: opts.runId ?? null, agentId: agent?.id ?? null, type: 'command.started', message: `${agent?.name ?? 'You'} ran “${opts.command.slice(0, 160)}” in ${cwdLabel}` })

    return new Promise<CommandResult>((resolve) => {
      let settled = false
      let why: 'cancelled' | 'timeout' | null = null
      let child: ChildProcess | undefined
      let timer: NodeJS.Timeout | undefined
      const onAbort = (): void => kill('cancelled')
      const kill = (w: 'cancelled' | 'timeout'): void => {
        why ??= w
        if (child) killTree(child)
      }
      const finish = (outcome: CommandOutcome, exitCode: number | null, message: string | null): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
        this.running.delete(id)
        const durationMs = this.now() - started
        this.db.run(`UPDATE command_log SET exit_code = ?, duration_ms = ?, output_tail = ? WHERE id = ?`, exitCode, durationMs, out.toString().slice(-4000), id)
        this.emit({ type: 'end', id, outcome, exitCode, durationMs, message })
        this.events.record({
          projectId: opts.projectId,
          runId: opts.runId ?? null,
          agentId: agent?.id ?? null,
          level: outcome === 'exited' && exitCode === 0 ? 'info' : 'warn',
          type: 'command.finished',
          message: `“${opts.command.slice(0, 120)}” ${outcome === 'exited' ? `exited with code ${exitCode}` : outcome} after ${(durationMs / 1000).toFixed(1)}s`
        })
        resolve({ id, outcome, exitCode, output: out.toString(), truncated: out.truncated, durationMs, message })
      }

      try {
        child = spawn(opts.command, { cwd: cwdFull, env: sanitizedEnv(), shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
      } catch (e) {
        finish('error', null, e instanceof Error ? e.message : String(e))
        return
      }
      const proc = child
      this.running.set(id, { child: proc, projectId: opts.projectId, runId: opts.runId ?? null, kill })
      timer = setTimeout(() => kill('timeout'), timeoutMs)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (opts.signal?.aborted) onAbort()

      const feed = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        out.append(text)
        this.emit({ type: 'output', id, stream, text })
      }
      proc.stdout?.on('data', feed('stdout'))
      proc.stderr?.on('data', feed('stderr'))
      proc.on('error', (e) => finish('error', null, e.message))
      proc.on('close', (code) => {
        if (why === 'timeout') finish('timeout', code, `Stopped after ${Math.round(timeoutMs / 1000)}s (time limit).`)
        else if (why === 'cancelled') finish('cancelled', code, 'Stopped.')
        else finish('exited', code, null)
      })
    })
  }

  private log(id: string, opts: RunCommandOptions, cwd: string, decision: CommandLogEntry['decision'], reason: string, exitCode: number | null, durationMs: number | null): void {
    const exists = this.db.get(`SELECT 1 FROM command_log WHERE id = ?`, id)
    if (exists) return
    this.db.run(
      `INSERT INTO command_log (id, project_id, run_id, agent_id, command, cwd, decision, reason, exit_code, duration_ms, created_at, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, opts.projectId, opts.runId ?? null, opts.agent?.id ?? null, opts.command, cwd, decision, reason, exitCode, durationMs, this.now(), opts.origin
    )
  }
}

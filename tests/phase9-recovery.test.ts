import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from '../src/main/db/database'
import { AutoRecovery } from '../src/main/git/recovery'
import { GitService } from '../src/main/git/service'
import { CallCancelledError, type CompleteRequest, type CompleteResult, type LlmGateway } from '../src/main/orchestrator/gateway'
import { Orchestrator } from '../src/main/orchestrator/orchestrator'
import { AgentService } from '../src/main/services/agents'
import { ConnectionService } from '../src/main/services/connections'
import { EventService } from '../src/main/services/events'
import { ProjectService } from '../src/main/services/projects'
import { TaskService } from '../src/main/services/tasks'
import { createChatProvider } from '../src/main/providers/registry'
import { ApprovalService, CommandService } from '../src/main/workspace/commands'
import { ContextIndexer } from '../src/main/workspace/indexer'
import { JOURNAL_FILE_LIMIT, TaskJournal } from '../src/main/workspace/journal'
import { FileLocks } from '../src/main/workspace/locks'
import { Sandbox } from '../src/main/workspace/sandbox'
import { WorkspaceService } from '../src/main/workspace/workspace'
import { MemorySecrets } from './helpers/memory-secrets'

// The model is a scripted stand-in (FakeGateway); everything else (files, sqlite, git, the orchestrator) is real.

const roots: string[] = []
const tmp = (): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'mads-rec-')))
  roots.push(d)
  return d
}
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})

const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8')

describe('TaskJournal', () => {
  let root: string
  let sb: Sandbox
  beforeEach(() => {
    root = tmp()
    sb = new Sandbox(root)
  })

  const write = async (j: TaskJournal, rel: string, content: string): Promise<void> => {
    await j.capture(sb, rel)
    await sb.write(rel, content, {})
    await j.settle(sb, rel, false)
  }

  it('restores a file to what it was before the task and removes files the task created', async () => {
    await sb.write('a.txt', 'original')
    const j = new TaskJournal()
    await write(j, 'a.txt', 'v1')
    await write(j, 'a.txt', 'v2')
    await write(j, 'src/new.ts', 'export {}')
    const r = await j.rollback(sb)
    expect(r).toEqual({ restored: ['a.txt'], removed: ['src/new.ts'], skipped: [] })
    expect(read(root, 'a.txt')).toBe('original')
    expect(existsSync(join(root, 'src/new.ts'))).toBe(false)
  })

  it('brings back a file the task deleted', async () => {
    await sb.write('gone.txt', 'keep me')
    const j = new TaskJournal()
    await j.capture(sb, 'gone.txt')
    await sb.remove('gone.txt')
    await j.settle(sb, 'gone.txt', true)
    expect((await j.rollback(sb)).restored).toEqual(['gone.txt'])
    expect(read(root, 'gone.txt')).toBe('keep me')
  })

  it('leaves a file alone that something else changed after the task wrote it', async () => {
    await sb.write('a.txt', 'original')
    const j = new TaskJournal()
    await write(j, 'a.txt', 'by the task')
    writeFileSync(join(root, 'a.txt'), 'by the user afterwards')
    const r = await j.rollback(sb)
    expect(r.skipped).toEqual(['a.txt'])
    expect(read(root, 'a.txt')).toBe('by the user afterwards')
  })

  it('does not keep a copy of files over the size limit, and says so', async () => {
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(JOURNAL_FILE_LIMIT + 1, 1))
    const j = new TaskJournal()
    await write(j, 'big.bin', 'small now')
    const r = await j.rollback(sb)
    expect(r).toEqual({ restored: [], removed: [], skipped: ['big.bin'] })
    expect(read(root, 'big.bin')).toBe('small now')
  })

  it('only records the first touch, and a rollback with nothing recorded does nothing', async () => {
    const j = new TaskJournal()
    expect(await j.rollback(sb)).toEqual({ restored: [], removed: [], skipped: [] })
    await sb.write('a.txt', '1')
    await write(j, 'a.txt', '2')
    await write(j, 'a.txt', '3')
    expect(j.size).toBe(1)
  })
})

// ------------------------------------------------------------------ the orchestrator with Auto Recovery

type Reply = { text?: string; tools?: Array<{ name: string; args: Record<string, unknown> }> }
interface Seen {
  req: CompleteRequest
  taskTitle: string | null
  round: number
}

class FakeGateway implements LlmGateway {
  readonly seen: Seen[] = []
  handler: (s: Seen) => Reply = () => ({ text: 'ok' })
  constructor(private readonly db: Database) {}
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const task = req.ctx.taskId ? this.db.get<{ title: string }>(`SELECT title FROM tasks WHERE id = ?`, req.ctx.taskId) : undefined
    const round = req.messages.filter((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'tool_result')).length + 1
    const seen: Seen = { req, taskTitle: task?.title ?? null, round }
    this.seen.push(seen)
    if (req.signal.aborted) throw new CallCancelledError()
    const reply = this.handler(seen)
    this.db.run(
      `INSERT INTO llm_calls (id, project_id, run_id, task_id, agent_id, connection_id, model, kind, input_tokens, output_tokens, cost_usd, latency_ms, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'chat', 10, 5, 0.01, 1, 'ok', ?)`,
      randomUUID(), req.ctx.projectId, req.ctx.runId, req.ctx.taskId, req.ctx.agentId, req.connectionId, req.model, Date.now()
    )
    const toolCalls = (reply.tools ?? []).map((c, i) => ({ id: `call-${this.seen.length}-${i}`, name: c.name, arguments: c.args }))
    return { costUsd: 0.01, response: { model: req.model, text: reply.text ?? '', toolCalls, stopReason: toolCalls.length ? 'tool_use' : 'end', usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1 } }
  }
}

describe('Auto Recovery in the orchestrator', () => {
  let db: Database
  let events: EventService
  let tasks: TaskService
  let agents: AgentService
  let ws: WorkspaceService
  let git: GitService
  let projects: ProjectService
  let orch: Orchestrator
  let gw: FakeGateway
  let root: string

  const plan = (): Reply => ({ tools: [{ name: 'submit_plan', args: { tasks: [{ key: 'impl', title: 'Implement', description: 'Write the code', role: 'lead_developer' }] } }] })
  const isPlanning = (s: Seen): boolean => !!s.req.tools?.some((t) => t.name === 'submit_plan')
  const eventTypes = (): string[] => db.all<{ type: string }>(`SELECT type FROM events ORDER BY rowid`).map((e) => e.type)

  beforeEach(async () => {
    root = tmp()
    db = new Database(':memory:')
    db.migrate()
    events = new EventService(db)
    const conns = new ConnectionService(db, events, new MemorySecrets(), { providerFactory: (c) => createChatProvider({ ...c, maxRetries: 0 }) })
    agents = new AgentService(db, events, conns)
    tasks = new TaskService(db, events)
    const locks = new FileLocks(db)
    ws = new WorkspaceService(db, events, locks, new ContextIndexer(db))
    const commands = new CommandService(db, events, new ApprovalService())
    git = new GitService(db, events, ws)
    projects = new ProjectService(db, events, { defaultProjectsRoot: tmp(), gitInit: async () => true })
    db.run(`INSERT INTO projects (id, name, type, root_path, goal, created_at, updated_at) VALUES ('p1', 'Proj', 'web', ?, 'Ship', 1, 1)`, root)
    const connId = (await conns.create({ kind: 'openai', name: 'Conn', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test-key-0123456789' })).id
    for (const role of ['project_manager', 'lead_developer']) agents.create({ templateKey: role, projectId: 'p1', connectionId: connId, model: 'gpt-x' })
    gw = new FakeGateway(db)
    orch = new Orchestrator(db, events, agents, gw, tasks, { workspace: ws, commands, recovery: new AutoRecovery(db, events, git, ws) })
  })
  afterEach(async () => {
    await orch.stopAll()
  })

  /** Attempt 1 rewrites a.txt, creates b.txt, then the model call fails; attempt 2 only answers. */
  const failingFirstAttempt = (): void => {
    gw.handler = (s) => {
      if (isPlanning(s)) return plan()
      const attempt = gw.seen.filter((x) => x.taskTitle === 'Implement' && x.round === 1).length
      if (attempt === 1) {
        if (s.round === 1) return { tools: [{ name: 'write_file', args: { path: 'a.txt', content: 'half-done' } }, { name: 'write_file', args: { path: 'b.txt', content: 'junk' } }] }
        throw new Error('model exploded')
      }
      return { text: 'done on the second try' }
    }
  }

  it('is a project setting that defaults to off, validated and recorded', () => {
    expect(projects.get('p1')?.autoRecovery).toBe(false)
    expect(projects.update({ id: 'p1', autoRecovery: true }).autoRecovery).toBe(true)
    expect(() => projects.update({ id: 'p1', autoRecovery: 'yes' as never })).toThrow(/on or off/)
    expect(eventTypes()).toContain('project.auto_recovery')
    expect(projects.update({ id: 'p1', name: 'Renamed' }).autoRecovery).toBe(true)
  })

  it('undoes the files of a failed attempt before the retry and tells the agent', async () => {
    writeFileSync(join(root, 'a.txt'), 'original')
    projects.update({ id: 'p1', autoRecovery: true })
    failingFirstAttempt()
    let filesAtRetry = ''
    const base = gw.handler
    gw.handler = (s) => {
      const r = base(s)
      if (s.taskTitle === 'Implement' && s.round === 1 && gw.seen.filter((x) => x.taskTitle === 'Implement' && x.round === 1).length === 2) {
        filesAtRetry = `${read(root, 'a.txt')}|${existsSync(join(root, 'b.txt'))}`
      }
      return r
    }
    const run = orch.start({ projectId: 'p1', goal: 'x' })
    await orch.whenDone(run.id)
    expect(filesAtRetry).toBe('original|false')
    expect(read(root, 'a.txt')).toBe('original')
    expect(existsSync(join(root, 'b.txt'))).toBe(false)
    expect(eventTypes()).toEqual(expect.arrayContaining(['recovery.rolled_back', 'task.retry']))
    const retryPrompt = JSON.stringify(gw.seen.filter((s) => s.taskTitle === 'Implement' && s.round === 1)[1].req.messages)
    expect(retryPrompt).toContain('Your previous attempt failed: model exploded')
    expect(retryPrompt).toContain('Auto Recovery undid the file changes')
    expect(orch.getRun(run.id)?.status).toBe('completed')
  })

  it('rolls back for good when the last attempt fails, leaving the project as it was', async () => {
    writeFileSync(join(root, 'a.txt'), 'original')
    projects.update({ id: 'p1', autoRecovery: true })
    gw.handler = (s) => {
      if (isPlanning(s)) return plan()
      if (s.round === 1) return { tools: [{ name: 'write_file', args: { path: 'a.txt', content: 'broken' } }] }
      throw new Error('still broken')
    }
    const run = orch.start({ projectId: 'p1', goal: 'x' })
    await orch.whenDone(run.id)
    expect(tasks.list({ projectId: 'p1' })[0].status).toBe('failed')
    expect(read(root, 'a.txt')).toBe('original')
    expect(db.all(`SELECT 1 FROM events WHERE type = 'recovery.rolled_back'`).length).toBeGreaterThanOrEqual(1)
    expect(ws.lockList('p1')).toEqual([])
  })

  it('does nothing when the project did not opt in', async () => {
    writeFileSync(join(root, 'a.txt'), 'original')
    failingFirstAttempt()
    const run = orch.start({ projectId: 'p1', goal: 'x' })
    await orch.whenDone(run.id)
    expect(read(root, 'a.txt')).toBe('half-done')
    expect(read(root, 'b.txt')).toBe('junk')
    expect(eventTypes()).not.toContain('recovery.rolled_back')
    const retryPrompt = JSON.stringify(gw.seen.filter((s) => s.taskTitle === 'Implement' && s.round === 1)[1].req.messages)
    expect(retryPrompt).not.toContain('Auto Recovery undid')
  })

  it('does not roll back when the user stops the run', async () => {
    projects.update({ id: 'p1', autoRecovery: true })
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    gw.handler = (s) => {
      if (isPlanning(s)) return plan()
      return { tools: [{ name: 'write_file', args: { path: 'c.txt', content: 'work in progress' } }] }
    }
    const complete = gw.complete.bind(gw)
    gw.complete = async (req) => {
      if (req.messages.some((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'tool_result'))) {
        release()
        await new Promise((_, rej) => req.signal.addEventListener('abort', () => rej(new CallCancelledError())))
      }
      return complete(req)
    }
    const run = orch.start({ projectId: 'p1', goal: 'x' })
    await gate
    await orch.stop(run.id)
    await orch.whenDone(run.id)
    expect(read(root, 'c.txt')).toBe('work in progress')
    expect(eventTypes()).not.toContain('recovery.rolled_back')
  })

  it('saves an automatic checkpoint before the task when the project is a git repository', async () => {
    writeFileSync(join(root, 'a.txt'), 'original')
    await git.init('p1')
    projects.update({ id: 'p1', autoRecovery: true })
    gw.handler = (s) => (isPlanning(s) ? plan() : { text: 'ok' })
    const run = orch.start({ projectId: 'p1', goal: 'x' })
    await orch.whenDone(run.id)
    const cps = git.checkpoints.list('p1')
    expect(cps).toHaveLength(1)
    expect(cps[0]).toMatchObject({ kind: 'auto', label: 'Before “Implement”' })
  })

  it('keeps working when no checkpoint can be made (not a repository)', async () => {
    projects.update({ id: 'p1', autoRecovery: true })
    gw.handler = (s) => (isPlanning(s) ? plan() : { text: 'ok' })
    const run = orch.start({ projectId: 'p1', goal: 'x' })
    await orch.whenDone(run.id)
    expect(orch.getRun(run.id)?.status).toBe('completed')
    expect(git.checkpoints.list('p1')).toHaveLength(0)
  })
})

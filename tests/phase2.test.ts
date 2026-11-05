import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { ApprovalService, CommandService } from '../src/main/workspace/commands'
import { ContextIndexer } from '../src/main/workspace/indexer'
import { FileLocks } from '../src/main/workspace/locks'
import { WorkspaceService } from '../src/main/workspace/workspace'
import { homedir, tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IPC_CHANNELS, type ActivityEvent } from '../src/shared/ipc'
import { AssetService } from '../src/main/assets/service'
import { Database } from '../src/main/db/database'
import { AutomationService } from '../src/main/automation/service'
import { GitService } from '../src/main/git/service'
import { PreviewService } from '../src/main/preview/service'
import { assertSafeProjectRoot, isPathInside, normalizePath, toFolderName } from '../src/main/security/path-guard'
import { detectProjectType } from '../src/main/workspace/detect-project-type'
import { EventService } from '../src/main/services/events'
import { ProjectService } from '../src/main/services/projects'
import { DashboardService } from '../src/main/services/dashboard'
import { ConnectionService } from '../src/main/services/connections'
import { AgentService } from '../src/main/services/agents'
import { ChatService } from '../src/main/services/chat'
import { TaskService } from '../src/main/services/tasks'
import { Orchestrator } from '../src/main/orchestrator/orchestrator'
import { MemorySecrets } from './helpers/memory-secrets'
import { createHandlers } from '../src/main/ipc/handlers'
import { WorkflowEngine } from '../src/main/workflows/engine'
import { WorkflowService } from '../src/main/workflows/service'
import { registerIpc, type IpcMainLike } from '../src/main/ipc/register'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mads-p2-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function touch(path: string, content = ''): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

describe('path-guard', () => {
  it('rejects relative paths, drive roots and the home folder', () => {
    expect(() => assertSafeProjectRoot('relative/dir')).toThrow(/absolute/)
    expect(() => assertSafeProjectRoot(parse(dir).root)).toThrow(/drive root/)
    expect(() => assertSafeProjectRoot(homedir())).toThrow(/home folder/)
  })

  it.runIf(process.platform === 'win32')('rejects Windows system folders, case-insensitively', () => {
    const root = parse(dir).root
    expect(() => assertSafeProjectRoot(`${root}Windows`)).toThrow(/System folders/)
    expect(() => assertSafeProjectRoot(`${root}WINDOWS\\System32\\drivers`)).toThrow(/System folders/)
    expect(() => assertSafeProjectRoot(`${root}Program Files\\Foo`)).toThrow(/System folders/)
  })

  it('accepts an ordinary folder', () => {
    expect(assertSafeProjectRoot(dir)).toBe(dir)
  })

  it('isPathInside resolves ".." and refuses siblings that merely share a prefix', () => {
    const root = join(dir, 'proj')
    expect(isPathInside(root, root)).toBe(true)
    expect(isPathInside(root, join(root, 'a', 'b.txt'))).toBe(true)
    expect(isPathInside(root, join(root, '..', 'proj-evil', 'x'))).toBe(false)
    expect(isPathInside(root, join(root, 'a', '..', '..', 'other'))).toBe(false)
  })

  it('normalizePath ignores trailing separators', () => {
    expect(normalizePath(`${dir}\\`)).toBe(normalizePath(dir))
  })

  it('toFolderName makes Windows-safe names', () => {
    expect(toFolderName('My: Game?*')).toBe('My- Game--')
    expect(toFolderName('CON')).toBe('CON-project')
    expect(toFolderName('   ')).toBe('project')
    expect(toFolderName('name. ')).toBe('name')
  })
})

describe('detectProjectType', () => {
  const make = (files: string[], pkg?: object) => {
    const d = mkdtempSync(join(dir, 't-'))
    for (const f of files) touch(join(d, f))
    if (pkg) writeFileSync(join(d, 'package.json'), JSON.stringify(pkg))
    return d
  }
  it('recognises engines and stacks', () => {
    expect(detectProjectType(make(['ProjectSettings/x.asset', 'Assets/a.cs']))).toBe('unity')
    expect(detectProjectType(make(['Game.uproject']))).toBe('unreal')
    expect(detectProjectType(make(['project.godot']))).toBe('godot')
    expect(detectProjectType(make([], { dependencies: { next: '1', react: '1' } }))).toBe('nextjs')
    expect(detectProjectType(make([], { devDependencies: { react: '1' } }))).toBe('react')
    expect(detectProjectType(make([], { name: 'x' }))).toBe('web')
    expect(detectProjectType(make(['index.html']))).toBe('web')
    expect(detectProjectType(make(['requirements.txt']))).toBe('python')
    expect(detectProjectType(make(['App.csproj']))).toBe('csharp')
    expect(detectProjectType(make(['CMakeLists.txt']))).toBe('cpp')
    expect(detectProjectType(make(['notes.txt']))).toBe('other')
  })
  it('survives a missing folder and a corrupt package.json', () => {
    expect(detectProjectType(join(dir, 'nope'))).toBe('other')
    const d = make([])
    writeFileSync(join(d, 'package.json'), '{not json')
    expect(detectProjectType(d)).toBe('other')
  })
})

describe('EventService', () => {
  let db: Database
  beforeEach(() => {
    db = new Database(':memory:')
    db.migrate()
  })

  it('records, returns newest-first, filters by level and project', () => {
    let t = 1000
    const ev = new EventService(db, () => t++)
    ev.record({ type: 'a', message: 'one' })
    ev.record({ type: 'b', message: 'two', level: 'warn' })
    ev.record({ type: 'c', message: 'three', level: 'error' })
    expect(ev.recent().map((e) => e.message)).toEqual(['three', 'two', 'one'])
    expect(ev.recent({ minLevel: 'warn' }).map((e) => e.message)).toEqual(['three', 'two'])
    expect(ev.recent({ limit: 1 })).toHaveLength(1)
  })

  it('notifies subscribers, supports unsubscribe, and isolates a throwing listener', () => {
    const ev = new EventService(db)
    const seen: ActivityEvent[] = []
    ev.subscribe(() => {
      throw new Error('boom')
    })
    const off = ev.subscribe((e) => seen.push(e))
    expect(() => ev.record({ type: 'x', message: 'm' })).not.toThrow()
    off()
    ev.record({ type: 'x', message: 'm2' })
    expect(seen.map((e) => e.message)).toEqual(['m'])
  })

  it('prunes to the newest N rows', () => {
    const ev = new EventService(db)
    for (let i = 0; i < 10; i++) ev.record({ type: 'x', message: String(i) })
    expect(ev.prune(3)).toBe(7)
    expect(ev.recent().map((e) => e.message)).toEqual(['9', '8', '7'])
  })
})

describe('ProjectService', () => {
  let db: Database
  let events: EventService
  let svc: ProjectService
  let gitCalls: string[]
  let gitOk: boolean
  let root: string

  beforeEach(() => {
    db = new Database(':memory:')
    db.migrate()
    events = new EventService(db)
    gitCalls = []
    gitOk = true
    root = join(dir, 'projects')
    svc = new ProjectService(db, events, {
      defaultProjectsRoot: root,
      gitInit: async (d) => {
        gitCalls.push(d)
        if (gitOk) mkdirSync(join(d, '.git'), { recursive: true })
        return gitOk
      }
    })
  })

  it('creates a project in a new default folder and initialises git', async () => {
    const p = await svc.create({ name: 'My Game', goal: '  a goal  ' })
    expect(p.rootPath).toBe(join(root, 'My Game'))
    expect(existsSync(p.rootPath)).toBe(true)
    expect(p.goal).toBe('a goal')
    expect(p.status).toBe('active')
    expect(p.maxIterations).toBe(5)
    expect(gitCalls).toEqual([p.rootPath])
    expect(events.recent().map((e) => e.type)).toEqual(expect.arrayContaining(['project.created', 'git.initialized']))
  })

  it('adopts an existing folder, keeps its files, auto-detects the type and skips git init if already a repo', async () => {
    const d = join(dir, 'existing')
    touch(join(d, 'project.godot'), 'x')
    mkdirSync(join(d, '.git'))
    const p = await svc.create({ name: 'Godot thing', rootPath: d })
    expect(p.type).toBe('godot')
    expect(readFileSync(join(d, 'project.godot'), 'utf8')).toBe('x')
    expect(gitCalls).toEqual([])
  })

  it('warns, but still succeeds, when git cannot be initialised', async () => {
    gitOk = false
    const p = await svc.create({ name: 'NoGit' })
    expect(p.id).toBeTruthy()
    const warn = events.recent().find((e) => e.type === 'git.init_failed')
    expect(warn?.level).toBe('warn')
  })

  it('validates input', async () => {
    await expect(svc.create({ name: '  ' })).rejects.toThrow(/name is required/)
    await expect(svc.create({ name: 'x'.repeat(81) })).rejects.toThrow(/80/)
    await expect(svc.create({ name: 'a', budgetUsd: -1 })).rejects.toThrow(/Budget/)
    await expect(svc.create({ name: 'a', maxIterations: 0 })).rejects.toThrow(/iterations/)
    await expect(svc.create({ name: 'a', maxIterations: 51 })).rejects.toThrow(/iterations/)
    await expect(svc.create({ name: 'a', maxIterations: 2.5 })).rejects.toThrow(/iterations/)
    await expect(svc.create({ name: 'a', type: 'cobol' as never })).rejects.toThrow(/Unknown project type/)
    expect(svc.list()).toHaveLength(0)
  })

  it('refuses unsafe roots and files', async () => {
    await expect(svc.create({ name: 'a', rootPath: parse(dir).root })).rejects.toThrow(/drive root/)
    await expect(svc.create({ name: 'a', rootPath: homedir() })).rejects.toThrow(/home folder/)
    const f = join(dir, 'file.txt')
    writeFileSync(f, 'hi')
    await expect(svc.create({ name: 'a', rootPath: f })).rejects.toThrow(/file, not a folder/)
  })

  it('refuses to silently reuse a populated default folder, and duplicate registration (even with different casing/slash)', async () => {
    touch(join(root, 'Taken', 'file.txt'))
    await expect(svc.create({ name: 'Taken' })).rejects.toThrow(/already exists and is not empty/)

    const d = join(dir, 'dup')
    await svc.create({ name: 'one', rootPath: d })
    await expect(svc.create({ name: 'two', rootPath: `${d}\\` })).rejects.toThrow(/already a project/)
    if (process.platform === 'win32') {
      await expect(svc.create({ name: 'three', rootPath: d.toUpperCase() })).rejects.toThrow(/already a project/)
    }
    expect(svc.list()).toHaveLength(1)
  })

  it('inspectFolder reports state without side effects', async () => {
    const d = join(dir, 'insp')
    expect(svc.inspectFolder(d)).toMatchObject({ exists: false, isEmpty: true, alreadyRegistered: false, detectedType: 'other' })
    expect(existsSync(d)).toBe(false)
    touch(join(d, 'index.html'))
    expect(svc.inspectFolder(d)).toMatchObject({ exists: true, isEmpty: false, detectedType: 'web', isGitRepo: false })
    await svc.create({ name: 'i', rootPath: d })
    expect(svc.inspectFolder(d)).toMatchObject({ alreadyRegistered: true, isGitRepo: true })
  })

  it('updates fields selectively, logs status changes and validates', async () => {
    const p = await svc.create({ name: 'U', budgetUsd: 5 })
    const u = svc.update({ id: p.id, name: 'Renamed', status: 'completed', maxIterations: 9 })
    expect(u).toMatchObject({ name: 'Renamed', status: 'completed', maxIterations: 9, budgetUsd: 5, goal: '' })
    expect(events.recent().some((e) => e.type === 'project.status')).toBe(true)
    expect(svc.update({ id: p.id, budgetUsd: null }).budgetUsd).toBeNull()
    expect(() => svc.update({ id: p.id, status: 'nope' as never })).toThrow(/Unknown status/)
    expect(() => svc.update({ id: 'missing' })).toThrow(/not found/)
  })

  it('remove unregisters but never deletes files', async () => {
    const p = await svc.create({ name: 'R' })
    touch(join(p.rootPath, 'keep.txt'), 'data')
    svc.remove(p.id)
    expect(svc.get(p.id)).toBeNull()
    expect(readFileSync(join(p.rootPath, 'keep.txt'), 'utf8')).toBe('data')
    expect(() => svc.remove(p.id)).not.toThrow() // idempotent
  })
})

describe('DashboardService', () => {
  it('aggregates real rows, keeps unpriced calls out of the cost sum and flags them', () => {
    const db = new Database(':memory:')
    db.migrate()
    const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime()
    const YESTERDAY = NOW - 26 * 3600_000
    const dash = new DashboardService(db, () => NOW)

    expect(dash.stats().usage.total).toEqual({ callCount: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0 })

    db.run(`INSERT INTO projects (id,name,type,root_path,goal,status,progress,budget_usd,max_iterations,created_at,updated_at) VALUES ('p1','A','web','C:\\a','','active',0.9,NULL,5,1,2)`)
    db.run(`INSERT INTO projects (id,name,type,root_path,goal,status,progress,budget_usd,max_iterations,created_at,updated_at) VALUES ('p2','B','web','C:\\b','','completed',1,NULL,5,1,1)`)
    for (const [id, st] of [['t1', 'done'], ['t2', 'todo'], ['t3', 'failed'], ['t4', 'in_progress'], ['t5', 'blocked']]) {
      db.run(`INSERT INTO tasks (id,project_id,title,status,created_at,updated_at) VALUES (?, 'p1', ?, ?, 1, 1)`, id, id, st)
    }
    db.run(`INSERT INTO provider_connections (id,kind,name,base_url,status,created_at,updated_at) VALUES ('c1','openai','x','u','ok',1,1),('c2','groq','y','u','error',1,1),('c3','ollama','z','u','unknown',1,1)`)
    const call = (id: string, inT: number, outT: number, cost: number | null, at: number) =>
      db.run(`INSERT INTO llm_calls (id,project_id,model,input_tokens,output_tokens,cost_usd,status,created_at) VALUES (?, 'p1','m',?,?,?, 'ok', ?)`, id, inT, outT, cost, at)
    call('a', 100, 50, 0.01, NOW - 1000)
    call('b', 200, 100, null, NOW - 500)
    call('c', 1000, 1000, 1, YESTERDAY)

    const s = dash.stats()
    expect(s.projects).toEqual({ active: 1, completed: 1, total: 2 })
    expect(s.tasks).toEqual({ pending: 2, inProgress: 1, failed: 1, done: 1 })
    expect(s.connections).toEqual({ total: 3, ok: 1, error: 1 })
    expect(s.usage.today).toEqual({ callCount: 2, inputTokens: 300, outputTokens: 150, costUsd: 0.01, unpricedCalls: 1 })
    expect(s.usage.total).toMatchObject({ callCount: 3, inputTokens: 1300, costUsd: 1.01, unpricedCalls: 1 })

    const p1 = s.projectProgress.find((p) => p.id === 'p1')!
    expect(p1).toMatchObject({ tasksDone: 1, tasksTotal: 5 })
    expect(p1.progress).toBeCloseTo(0.2) // derived from tasks, not the stored 0.9
    expect(s.projectProgress.find((p) => p.id === 'p2')).toMatchObject({ tasksTotal: 0, progress: 1 }) // no tasks: stored value
  })
})

describe('IPC registration', () => {
  function setup(trusted = true) {
    const db = new Database(':memory:')
    db.migrate()
    const events = new EventService(db)
    const projects = new ProjectService(db, events, { defaultProjectsRoot: join(dir, 'p'), gitInit: async () => true })
    const revealed: string[] = []
    const connections = new ConnectionService(db, events, new MemorySecrets())
    const chat = new ChatService(db, events, connections)
    const agents = new AgentService(db, events, connections)
    const tasks = new TaskService(db, events)
    const commands = new CommandService(db, events, new ApprovalService())
    const workspace = new WorkspaceService(db, events, new FileLocks(db), new ContextIndexer(db))
    const orchestrator = new Orchestrator(db, events, agents, chat, tasks)
    const workflows = new WorkflowService(db, events)
    const handlers = createHandlers({
      projects,
      events,
      dashboard: new DashboardService(db),
      connections,
      chat,
      agents,
      tasks,
      orchestrator,
      workspace,
      commands,
      assets: new AssetService({ db, events, workspace, connections }),
      workflows,
      workflowEngine: new WorkflowEngine(db, events, agents, orchestrator, workflows),
      git: new GitService(db, events, workspace),
      automation: new AutomationService(events, workspace, commands),
      preview: new PreviewService(events, workspace),
      host: {
        emitChat: () => undefined,
        appInfo: () => ({ name: 't', version: '0', electron: '0', node: '0', platform: 'win32', userDataPath: '', defaultProjectsRoot: '', dbVersion: 1, encryptionAvailable: true }),
        pickFolder: async () => null,
        revealInFolder: (p) => revealed.push(p)
      }
    })
    const registered = new Map<string, (e: { senderFrame?: { url: string } | null }, ...a: unknown[]) => unknown>()
    const errors: string[] = []
    const ipc: IpcMainLike = { handle: (c, l) => void registered.set(c, l) }
    registerIpc(ipc, handlers, {
      isTrustedSender: (u) => trusted && u === 'file:///app/index.html',
      onError: (c, e) => errors.push(`${c}: ${e instanceof Error ? e.message : e}`)
    })
    const call = (c: string, ...a: unknown[]) => registered.get(c)!({ senderFrame: { url: 'file:///app/index.html' } }, ...a) as Promise<{ ok: boolean; data?: unknown; error?: { message: string } }>
    return { registered, call, errors, revealed, ipc, handlers }
  }

  it('registers exactly the allow-listed channels (contract and runtime list cannot drift)', () => {
    const { registered } = setup()
    expect([...registered.keys()].sort()).toEqual(Object.keys(IPC_CHANNELS).sort())
  })

  it('wraps success in {ok:true,data} and maps undefined to null', async () => {
    const { call } = setup()
    expect(await call('projects:list')).toEqual({ ok: true, data: [] })
    expect(await call('projects:remove', 'nope')).toEqual({ ok: true, data: null })
  })

  it('wraps thrown errors in {ok:false} with the real message, and reports them', async () => {
    const { call, errors } = setup()
    const r = await call('projects:create', { name: '' })
    expect(r).toEqual({ ok: false, error: { message: 'Project name is required.' } })
    expect(errors[0]).toContain('projects:create')
  })

  it('rejects calls from an untrusted frame without running the handler', async () => {
    const { registered, errors } = setup()
    const r = (await registered.get('projects:create')!({ senderFrame: { url: 'https://evil.example' } }, { name: 'pwn' })) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect((await registered.get('projects:list')!({ senderFrame: { url: 'file:///app/index.html' } })) as { data: unknown[] }).toMatchObject({ data: [] })
    expect(errors[0]).toMatch(/untrusted/i)
    // missing frame (e.g. detached/destroyed) is also untrusted
    expect(((await registered.get('projects:list')!({ senderFrame: null })) as { ok: boolean }).ok).toBe(false)
  })

  it('reveal refuses unknown projects and passes the stored path (not caller input) to the host', async () => {
    const { call, revealed } = setup()
    expect((await call('projects:reveal', 'ghost')).ok).toBe(false)
    const created = (await call('projects:create', { name: 'Rev' })) as { data: { id: string; rootPath: string } }
    expect((await call('projects:reveal', created.data.id)).ok).toBe(true)
    expect(revealed).toEqual([created.data.rootPath])
  })
})

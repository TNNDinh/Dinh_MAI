import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetService } from '../src/main/assets/service'
import { encodePng, newRaster } from '../src/main/assets/pixels'
import { Database } from '../src/main/db/database'
import { AgentService } from '../src/main/services/agents'
import { ChatService } from '../src/main/services/chat'
import { ConnectionService } from '../src/main/services/connections'
import { EventService } from '../src/main/services/events'
import { TaskService } from '../src/main/services/tasks'
import { ContextIndexer } from '../src/main/workspace/indexer'
import { FileLocks } from '../src/main/workspace/locks'
import { FolderWatcher } from '../src/main/workspace/watcher'
import { WorkspaceService } from '../src/main/workspace/workspace'
import type { FsChange } from '../src/shared/ipc'
import { newNode, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from '../src/shared/workflow'
import { GraphHistory, autoLayout, copyFragment, pasteFragment } from '../src/shared/workflow-edit'
import { MAX_TEXT, MAX_TURNS, loadPlayground, savePlayground } from '../src/renderer/src/lib/playground-history'
import { MemorySecrets } from './helpers/memory-secrets'

// Real folders, a real in-memory SQLite database and the operating system's real file watcher. No provider is called.

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'mads-p10-'))
  roots.push(d)
  return d
}
const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 15))
  }
}
const quiet = (ms: number) => new Promise((r) => setTimeout(r, ms))
const png = (size = 8): Buffer => {
  const img = newRaster(size, size)
  for (let i = 0; i < img.data.length; i += 4) img.data.set([200, 30, 30, 255], i)
  return encodePng(img)
}

describe('FolderWatcher', () => {
  it('reports a file created by another program, once, and its removal', async () => {
    const root = tmp()
    const seen: Array<[string, boolean]> = []
    const w = new FolderWatcher(root, (p, e) => seen.push([p, e]), { debounceMs: 40 })
    expect(w.start()).toBe(true)
    expect(w.running).toBe(true)
    try {
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'a.txt'), 'one')
      writeFileSync(join(root, 'src', 'a.txt'), 'two')
      await until(() => seen.some(([p, e]) => p === 'src/a.txt' && e))
      expect(seen.filter(([p]) => p === 'src/a.txt').length).toBe(1) // the two writes were coalesced
      rmSync(join(root, 'src', 'a.txt'))
      await until(() => seen.some(([p, e]) => p === 'src/a.txt' && !e))
    } finally {
      w.stop()
    }
    expect(w.running).toBe(false)
  })

  it('does not report .git, node_modules or other hidden folders', async () => {
    const root = tmp()
    mkdirSync(join(root, '.git'))
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    const seen: string[] = []
    const w = new FolderWatcher(root, (p) => seen.push(p), { debounceMs: 30 })
    w.start()
    try {
      writeFileSync(join(root, '.git', 'index'), 'x')
      writeFileSync(join(root, 'node_modules', 'pkg', 'i.js'), 'x')
      writeFileSync(join(root, 'visible.txt'), 'x')
      await until(() => seen.includes('visible.txt'))
      await quiet(150)
      expect(seen).toEqual(['visible.txt'])
    } finally {
      w.stop()
    }
  })

  it('ignores the sandbox\'s temporary write files but reports similar-looking real files', async () => {
    const root = tmp()
    const seen: string[] = []
    const w = new FolderWatcher(root, (p) => seen.push(p), { debounceMs: 30 })
    w.start()
    try {
      writeFileSync(join(root, '.a.txt.0123abcd.tmp'), 'x')
      writeFileSync(join(root, '.hidden.tmp'), 'x')
      await until(() => seen.includes('.hidden.tmp'))
      await quiet(120)
      expect(seen).toEqual(['.hidden.tmp'])
    } finally {
      w.stop()
    }
  })

  it('stops reporting after stop() and caps a burst of distinct files', async () => {
    const root = tmp()
    const seen: string[] = []
    const w = new FolderWatcher(root, (p) => seen.push(p), { debounceMs: 30, maxPending: 5 })
    w.start()
    for (let i = 0; i < 40; i++) writeFileSync(join(root, `f${i}.txt`), 'x')
    await until(() => seen.length > 0)
    await quiet(150)
    expect(seen.length).toBeLessThanOrEqual(5)
    w.stop()
    const n = seen.length
    writeFileSync(join(root, 'late.txt'), 'x')
    await quiet(200)
    expect(seen.length).toBe(n)
  })

  it('returns false for a folder that does not exist', () => {
    const w = new FolderWatcher(join(tmp(), 'missing'), () => undefined)
    expect(w.start()).toBe(false)
    expect(w.running).toBe(false)
  })
})

describe('WorkspaceService.watchProject', () => {
  let db: Database
  let ws: WorkspaceService
  let root: string
  let changes: FsChange[]

  beforeEach(() => {
    root = tmp()
    db = new Database(':memory:')
    db.migrate()
    const events = new EventService(db)
    ws = new WorkspaceService(db, events, new FileLocks(db), new ContextIndexer(db))
    db.run(`INSERT INTO projects (id, name, type, root_path, goal, created_at, updated_at) VALUES ('p1', 'Proj', 'web', ?, 'g', 1, 1)`, root)
    changes = []
    ws.onChange((c) => changes.push(c))
  })
  afterEach(() => ws.stopWatching())

  it('reports edits made outside the app as by "external"', async () => {
    expect(ws.watchProject('p1')).toBe(true)
    writeFileSync(join(root, 'outside.txt'), 'hello')
    await until(() => changes.some((c) => c.path === 'outside.txt'))
    expect(changes.find((c) => c.path === 'outside.txt')).toMatchObject({ projectId: 'p1', kind: 'write', by: 'external' })
    rmSync(join(root, 'outside.txt'))
    await until(() => changes.some((c) => c.path === 'outside.txt' && c.kind === 'remove'))
  })

  it('does not echo the app\'s own writes, deletes and renames back as external changes', async () => {
    ws.watchProject('p1')
    await ws.write({ projectId: 'p1', path: 'mine.txt', content: 'a' })
    await ws.write({ projectId: 'p1', path: 'dir/inner.txt', content: 'a' })
    await ws.rename('p1', 'mine.txt', 'renamed.txt')
    await ws.remove('p1', 'dir')
    await quiet(500)
    expect(changes.filter((c) => c.by === 'external')).toEqual([])
    expect(changes.some((c) => c.by !== 'external')).toBe(true)
  })

  it('moves to another project, stops with null, and is idempotent for the same project', async () => {
    const other = tmp()
    db.run(`INSERT INTO projects (id, name, type, root_path, goal, created_at, updated_at) VALUES ('p2', 'Other', 'web', ?, 'g', 1, 1)`, other)
    expect(ws.watchProject('p1')).toBe(true)
    expect(ws.watchProject('p1')).toBe(true)
    expect(ws.watchProject('p2')).toBe(true)
    writeFileSync(join(root, 'old.txt'), 'x') // p1 is no longer watched
    writeFileSync(join(other, 'new.txt'), 'x')
    await until(() => changes.some((c) => c.projectId === 'p2'))
    await quiet(200)
    expect(changes.some((c) => c.projectId === 'p1')).toBe(false)
    expect(ws.watchProject(null)).toBe(true)
    writeFileSync(join(other, 'after.txt'), 'x')
    await quiet(300)
    expect(changes.some((c) => c.path === 'after.txt')).toBe(false)
  })

  it('returns false for an unknown project', () => {
    expect(ws.watchProject('nope')).toBe(false)
  })

  it('reports an external rename as a removal plus a write', async () => {
    writeFileSync(join(root, 'before.txt'), 'x')
    ws.watchProject('p1')
    await quiet(100)
    renameSync(join(root, 'before.txt'), join(root, 'after.txt'))
    await until(() => changes.some((c) => c.path === 'before.txt' && c.kind === 'remove') && changes.some((c) => c.path === 'after.txt' && c.kind === 'write'))
    expect(changes.every((c) => c.by === 'external')).toBe(true)
  })
})

describe('ChatService.usageByAgent', () => {
  it('groups calls per agent, groups deleted-agent and agent-less calls under null, and filters by project', () => {
    const db = new Database(':memory:')
    db.migrate()
    const events = new EventService(db)
    const conns = new ConnectionService(db, events, new MemorySecrets())
    const chat = new ChatService(db, events, conns)
    const agents = new AgentService(db, events, conns)
    db.run(`INSERT INTO projects (id, name, type, root_path, goal, created_at, updated_at) VALUES ('p1', 'A', 'web', 'x', 'g', 1, 1), ('p2', 'B', 'web', 'y', 'g', 1, 1)`)
    const a1 = agents.create({ templateKey: agents.templates()[0].key, projectId: 'p1' })
    const a2 = agents.create({ templateKey: agents.templates()[1].key, projectId: 'p1' })
    const call = (project: string | null, agent: string | null, inTok: number, cost: number | null, status = 'ok') =>
      db.run(
        `INSERT INTO llm_calls (id, project_id, agent_id, connection_id, model, kind, input_tokens, output_tokens, cost_usd, latency_ms, status, created_at)
         VALUES (lower(hex(randomblob(8))), ?, ?, NULL, 'm', 'chat', ?, 10, ?, 5, ?, 1)`,
        project,
        agent,
        inTok,
        cost,
        status
      )
    call('p1', a1.id, 100, 0.5)
    call('p1', a1.id, 100, 0.25)
    call('p1', a2.id, 50, null) // unpriced
    call('p1', a2.id, 50, 0.01, 'error') // failed
    call('p2', a1.id, 1000, 9)
    call(null, null, 7, 0.001)
    const a3 = agents.create({ templateKey: agents.templates()[2].key, projectId: 'p1' })
    call('p1', a3.id, 3, 0.002)
    agents.remove(a3.id) // the database clears agent_id on its calls

    const all = chat.usageByAgent()
    expect(all[0]).toMatchObject({ agentId: a1.id, calls: 3, inputTokens: 1200 })
    expect(all[0].costUsd).toBeCloseTo(9.75)
    expect(all.find((r) => r.agentId === null)?.agentName).toMatch(/no agent/)
    expect(all.find((r) => r.agentId === null)).toMatchObject({ calls: 2, inputTokens: 10 })

    const p1 = chat.usageByAgent('p1')
    expect(p1.find((r) => r.agentId === a1.id)).toMatchObject({ calls: 2, inputTokens: 200, unpricedCalls: 0, failedCalls: 0 })
    expect(p1.find((r) => r.agentId === a1.id)?.costUsd).toBeCloseTo(0.75)
    expect(p1.find((r) => r.agentId === a2.id)).toMatchObject({ calls: 2, unpricedCalls: 1, failedCalls: 1 })
    expect(p1.find((r) => r.agentId === null)).toMatchObject({ calls: 1, inputTokens: 3 }) // only the deleted agent's call belongs to p1
  })
})

describe('AssetService scan and importFiles', () => {
  let db: Database
  let ws: WorkspaceService
  let assets: AssetService
  let root: string
  const put = (rel: string, data: Buffer | string): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), data)
  }

  beforeEach(() => {
    root = tmp()
    db = new Database(':memory:')
    db.migrate()
    const events = new EventService(db)
    const conns = new ConnectionService(db, events, new MemorySecrets())
    ws = new WorkspaceService(db, events, new FileLocks(db), new ContextIndexer(db))
    assets = new AssetService({ db, events, workspace: ws, connections: conns })
    db.run(`INSERT INTO projects (id, name, type, root_path, goal, created_at, updated_at) VALUES ('p1', 'Proj', 'game', ?, 'g', 1, 1)`, root)
  })

  it('lists only pictures that are not in the library yet, skipping ignored folders and credential files', async () => {
    put('art/hero.png', png())
    put('art/photo.JPG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))
    put('notes.txt', 'not a picture')
    put('node_modules/pkg/logo.png', png())
    put('.env.png', png())
    const r = await assets.scan('p1')
    expect(r.files.map((f) => f.path).sort()).toEqual(['art/hero.png', 'art/photo.JPG'])
    expect(r.truncated).toBe(false)
  })

  it('imports pictures without touching the files, reads size from the content and guesses the kind', async () => {
    const data = png(12)
    put('assets/sprites/hero.png', data)
    const out = await assets.importFiles({ projectId: 'p1', paths: ['assets/sprites/hero.png'] })
    expect(out.skipped).toEqual([])
    expect(out.imported).toHaveLength(1)
    expect(out.imported[0]).toMatchObject({ name: 'hero.png', path: 'assets/sprites/hero.png', origin: 'imported', width: 12, height: 12, exists: true })
    expect(out.imported[0].kind).toBe('sprite')
    expect(out.imported[0].bytes).toBe(data.length)
    // It is listed now, so a second scan no longer offers it, and importing it again is refused.
    expect((await assets.scan('p1')).files).toEqual([])
    const again = await assets.importFiles({ projectId: 'p1', paths: ['assets/sprites/hero.png'] })
    expect(again.imported).toEqual([])
    expect(again.skipped[0].reason).toMatch(/Already/)
  })

  it('skips credential files, wrong extensions, fake pictures and paths outside the project, and takes an explicit kind', async () => {
    put('fake.png', 'this is text, not a PNG')
    put('doc.txt', 'x')
    put('.env.png', png())
    put('ok.png', png())
    const out = await assets.importFiles({ projectId: 'p1', paths: ['fake.png', 'doc.txt', '.env.png', '../escape.png', 'missing.png', 'ok.png', 'ok.png'], kind: 'icon' })
    expect(out.imported.map((a) => [a.name, a.kind])).toEqual([['ok.png', 'icon']])
    const reasons = Object.fromEntries(out.skipped.map((s) => [s.path, s.reason]))
    expect(reasons['fake.png']).toMatch(/does not match/)
    expect(reasons['doc.txt']).toMatch(/Only PNG/)
    expect(reasons['.env.png']).toMatch(/Credential/)
    expect(reasons['../escape.png']).toBeTruthy()
    expect(reasons['missing.png']).toBeTruthy()
    expect(out.skipped).toHaveLength(5) // the duplicate "ok.png" is ignored, not reported
  })

  it('validates the request', async () => {
    await expect(assets.importFiles({ projectId: 'p1', paths: [] })).rejects.toThrow(/at least one/)
    await expect(assets.importFiles({ projectId: 'p1', paths: Array.from({ length: 201 }, (_, i) => `a${i}.png`) })).rejects.toThrow(/at most 200/)
    await expect(assets.importFiles({ projectId: 'p1', paths: ['a.png'], kind: 'bogus' as never })).rejects.toThrow(/Unknown picture kind/)
    await expect(assets.scan('nope')).rejects.toThrow()
  })
})

describe('AgentService role editing', () => {
  const setup = () => {
    const db = new Database(':memory:')
    db.migrate()
    const events = new EventService(db)
    const agents = new AgentService(db, events, new ConnectionService(db, events, new MemorySecrets()))
    return { db, agents }
  }

  it('changes the role to another template of the same kind or to custom, keeping prompt and permissions', () => {
    const { agents } = setup()
    const a = agents.create({ templateKey: 'lead_developer' })
    const b = agents.update({ id: a.id, role: 'code_reviewer' })
    expect(b).toMatchObject({ role: 'code_reviewer', roleLabel: 'Code Reviewer', kind: 'chat' })
    expect(b.systemPrompt).toBe(a.systemPrompt)
    expect(b.permissions).toEqual(a.permissions)
    expect(agents.update({ id: a.id, role: 'custom' })).toMatchObject({ role: 'custom', roleLabel: 'Custom' })
  })

  it('refuses unknown roles and roles of the other kind', () => {
    const { agents } = setup()
    const chat = agents.create({ templateKey: 'lead_developer' })
    const img = agents.create({ templateKey: 'image_generator' })
    expect(() => agents.update({ id: chat.id, role: 'wizard' })).toThrow(/Unknown role/)
    expect(() => agents.update({ id: chat.id, role: 'image_generator' })).toThrow(/for image agents/)
    expect(() => agents.update({ id: img.id, role: 'qa_tester' })).toThrow(/for chat agents/)
    expect(agents.get(chat.id)?.role).toBe('lead_developer')
  })

  it('refuses while the agent is working', () => {
    const { agents, db } = setup()
    const a = agents.create({ templateKey: 'lead_developer' })
    db.run(`UPDATE agents SET status = 'working' WHERE id = ?`, a.id)
    expect(() => agents.update({ id: a.id, role: 'qa_tester' })).toThrow(/working right now/)
  })
})

describe('Playground history', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
  }
  const turn = (id: number, status: string, extra: object = {}) => ({ id, user: `q${id}`, text: `a${id}`, status, ...extra }) as never

  it('round-trips finished turns and the connection\'s model and system prompt', () => {
    const s = memory()
    const stats = { inputTokens: 5, outputTokens: 7, costUsd: null, latencyMs: 12, ttftMs: 3, stopReason: 'stop' }
    savePlayground('connection:c1', { turns: [turn(1, 'ok', { stats }), turn(2, 'error', { error: 'boom' })], model: 'gpt-x', system: 'be brief' }, s)
    const got = loadPlayground('connection:c1', s)
    expect(got.model).toBe('gpt-x')
    expect(got.system).toBe('be brief')
    expect(got.turns).toEqual([
      { id: 1, user: 'q1', text: 'a1', status: 'ok', stats },
      { id: 2, user: 'q2', text: 'a2', status: 'error', error: 'boom' }
    ])
    expect(loadPlayground('connection:other', s).turns).toEqual([]) // scopes are separate
  })

  it('never stores a turn that is still streaming, keeps the newest 40, and removes the entry when empty', () => {
    const s = memory()
    const many = Array.from({ length: 55 }, (_, i) => turn(i + 1, 'ok'))
    savePlayground('agent:a', { turns: [...many, turn(99, 'streaming')] }, s)
    const got = loadPlayground('agent:a', s).turns
    expect(got).toHaveLength(MAX_TURNS)
    expect(got[0].id).toBe(16)
    expect(got.at(-1)?.id).toBe(55)
    savePlayground('agent:a', { turns: [] }, s)
    expect(s.m.size).toBe(0)
  })

  it('survives corrupt, hostile or missing storage', () => {
    const s = memory()
    for (const bad of ['{not json', '42', 'null', '{"turns":"x"}', '{"turns":[null,1,{"id":"x"},{"id":1,"status":"streaming"}]}']) {
      s.m.set('playground:x', bad)
      expect(loadPlayground('x', s).turns, bad).toEqual([])
    }
    expect(loadPlayground('x', null).turns).toEqual([])
    const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') }, removeItem: () => undefined }
    expect(loadPlayground('x', throwing).turns).toEqual([])
    expect(() => savePlayground('x', { turns: [turn(1, 'ok')] }, throwing)).not.toThrow()
  })

  it('clips oversized text', () => {
    const s = memory()
    savePlayground('x', { turns: [{ id: 1, user: 'u'.repeat(MAX_TEXT + 500), text: 't', status: 'ok' } as never] }, s)
    expect(loadPlayground('x', s).turns[0].user).toHaveLength(MAX_TEXT)
  })
})

describe('workflow editing helpers', () => {
  const node = (id: string, type: WorkflowNode['type'] = 'agent', x = 0, y = 0): WorkflowNode => newNode(type, id, { x, y }) as WorkflowNode
  const edge = (id: string, source: string, target: string, targetHandle: string | null = null): WorkflowEdge => ({ id, source, target, sourceHandle: null, targetHandle })
  const graph = (nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowGraph => ({ nodes, edges })

  describe('GraphHistory', () => {
    it('undoes and redoes edits, and a new edit clears the redo stack', () => {
      const h = new GraphHistory()
      const g0 = graph([node('a')])
      const g1 = graph([node('a'), node('b')])
      const g2 = graph([node('a'), node('b'), node('c')])
      h.reset(g0)
      expect(h.canUndo || h.canRedo).toBe(false)
      expect(h.record(g1)).toBe(true)
      expect(h.record(g1)).toBe(false) // unchanged
      h.record(g2)
      expect(h.undo()).toEqual(g1)
      expect(h.undo()).toEqual(g0)
      expect(h.undo()).toBeNull()
      expect(h.redo()).toEqual(g1)
      const g3 = graph([node('z')])
      h.record(g3)
      expect(h.canRedo).toBe(false)
      expect(h.undo()).toEqual(g1)
    })

    it('counts a moved step as an edit, never aliases what it was given, and is bounded', () => {
      const h = new GraphHistory(3)
      const g = graph([node('a', 'agent', 0, 0)])
      h.reset(g)
      g.nodes[0].position.x = 50 // mutating the caller's object must not change the stored snapshot
      expect(h.record(graph([node('a', 'agent', 50, 0)]))).toBe(true)
      expect(h.undo()?.nodes[0].position.x).toBe(0)
      h.reset(graph([node('s')]))
      for (let i = 1; i <= 10; i++) h.record(graph([node('s', 'agent', i, 0)]))
      let steps = 0
      while (h.undo()) steps++
      expect(steps).toBe(3)
    })
  })

  describe('copy and paste', () => {
    it('copies the chosen steps and only the connections between them', () => {
      const g = graph([node('a'), node('b'), node('c')], [edge('e1', 'a', 'b'), edge('e2', 'b', 'c')])
      const f = copyFragment(g, new Set(['a', 'b']))!
      expect(f.nodes.map((n) => n.id)).toEqual(['a', 'b'])
      expect(f.edges.map((e) => e.id)).toEqual(['e1'])
      expect(copyFragment(g, new Set())).toBeNull()
      expect(copyFragment(g, new Set(['nope']))).toBeNull()
    })

    it('pastes with new ids, remapped connections, moved positions and independent configs', () => {
      const g = graph([node('a', 'agent', 10, 20), node('l', 'loop', 300, 20)], [edge('e1', 'a', 'l'), edge('e2', 'l', 'a', 'again')])
      const f = copyFragment(g, new Set(['a', 'l']))!
      let n = 0
      const p = pasteFragment(f, new Set(['a', 'l', 'e1', 'e2']), { x: 40, y: 40 }, (prefix) => `${prefix}-${n++ < 2 ? 'a' : n}`)
      const ids = [...p.nodes.map((x) => x.id), ...p.edges.map((x) => x.id)]
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.some((i) => ['a', 'l', 'e1', 'e2'].includes(i))).toBe(false)
      expect(p.nodes.map((x) => x.position)).toEqual([{ x: 50, y: 60 }, { x: 340, y: 60 }])
      expect(p.edges[0]).toMatchObject({ source: p.nodes[0].id, target: p.nodes[1].id })
      expect(p.edges[1]).toMatchObject({ source: p.nodes[1].id, target: p.nodes[0].id, targetHandle: 'again' })
      ;(p.nodes[0] as { label: string }).label = 'changed'
      expect(f.nodes[0].label).not.toBe('changed')
      expect(g.nodes[0].label).not.toBe('changed')
    })
  })

  describe('autoLayout', () => {
    it('puts each step one column after the steps that feed it and centres shorter columns', () => {
      const g = graph(
        [node('s'), node('a'), node('b'), node('j'), node('end')],
        [edge('1', 's', 'a'), edge('2', 's', 'b'), edge('3', 'a', 'j'), edge('4', 'b', 'j'), edge('5', 'j', 'end')]
      )
      const p = autoLayout(g, { columnWidth: 100, rowHeight: 50 })
      expect(p.get('s')).toEqual({ x: 0, y: 25 })
      expect([p.get('a')?.x, p.get('b')?.x]).toEqual([100, 100])
      expect(new Set([p.get('a')?.y, p.get('b')?.y]).size).toBe(2)
      expect(p.get('j')?.x).toBe(200)
      expect(p.get('end')?.x).toBe(300)
    })

    it('uses the longest path, so a shortcut does not pull a step left', () => {
      const g = graph([node('a'), node('b'), node('c')], [edge('1', 'a', 'b'), edge('2', 'b', 'c'), edge('3', 'a', 'c')])
      expect(autoLayout(g).get('c')?.x).toBe(autoLayout(g).get('b')!.x + 330)
    })

    it('lays a loop out in a straight line: the "again" connection does not move anything', () => {
      const g = graph([node('w'), node('r', 'review'), node('l', 'loop')], [edge('1', 'w', 'r'), edge('2', 'r', 'l'), edge('3', 'l', 'w', 'again')])
      const p = autoLayout(g, { columnWidth: 100 })
      expect([p.get('w')?.x, p.get('r')?.x, p.get('l')?.x]).toEqual([0, 100, 200])
    })

    it('survives other cycles, self loops, dangling connections, disconnected steps and an empty graph', () => {
      const g = graph([node('a'), node('b'), node('c'), node('lone')], [edge('1', 'a', 'b'), edge('2', 'b', 'a'), edge('3', 'b', 'b'), edge('4', 'b', 'ghost'), edge('5', 'c', 'c')])
      const p = autoLayout(g)
      expect([...p.keys()].sort()).toEqual(['a', 'b', 'c', 'lone'])
      expect(p.get('b')!.x).toBeGreaterThan(p.get('a')!.x)
      expect(autoLayout(graph([])).size).toBe(0)
    })

    it('does not put two steps on the same spot', () => {
      const nodes = Array.from({ length: 12 }, (_, i) => node(`n${i}`))
      const edges = nodes.slice(1).map((n, i) => edge(`e${i}`, i % 3 === 0 ? 'n0' : nodes[i].id, n.id))
      const p = autoLayout(graph(nodes, edges))
      const spots = [...p.values()].map((v) => `${v.x},${v.y}`)
      expect(new Set(spots).size).toBe(spots.length)
    })
  })
})

describe('TaskService.team (team conversation feed)', () => {
  it('lists agent replies and change requests newest first, hides prompts and tool output, clips, filters and limits', () => {
    const db = new Database(':memory:')
    db.migrate()
    const events = new EventService(db)
    const conns = new ConnectionService(db, events, new MemorySecrets())
    const agents = new AgentService(db, events, conns)
    const tasks = new TaskService(db, events)
    db.run(`INSERT INTO projects (id, name, type, root_path, goal, created_at, updated_at) VALUES ('p1', 'Alpha', 'web', 'x', 'g', 1, 1), ('p2', 'Beta', 'web', 'y', 'g', 1, 1)`)
    const dev = agents.create({ templateKey: agents.templates()[0].key, projectId: 'p1' })
    const t1 = tasks.create({ projectId: 'p1', title: 'Build the login page' })
    const t2 = tasks.create({ projectId: 'p2', title: 'Other project task' })
    let n = 0
    const msg = (project: string, task: string | null, agent: string | null, role: string, content: string) =>
      db.run(`INSERT INTO agent_messages (id, project_id, run_id, task_id, agent_id, role, content, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`, `m${n}`, project, task, agent, role, content, 100 + n++)
    msg('p1', t1.id, dev.id, 'user', 'the prompt sent to the model') // hidden
    msg('p1', t1.id, dev.id, 'tool', 'file contents ...') // hidden
    msg('p1', t1.id, dev.id, 'assistant', 'I wrote the form.')
    msg('p1', t1.id, dev.id, 'assistant', '   ') // blank: hidden
    msg('p1', t1.id, dev.id, 'system', 'Change request from Reviewer: add a label') // shown
    msg('p1', t1.id, dev.id, 'system', 'Some other system note') // hidden
    msg('p2', t2.id, null, 'assistant', 'x'.repeat(1000))

    const all = tasks.team()
    expect(all.map((m) => m.kind)).toEqual(['reply', 'change-request', 'reply'])
    expect(all[0]).toMatchObject({ projectName: 'Beta', taskTitle: 'Other project task', agentName: null })
    expect(all[0].content.length).toBe(601) // 600 + ellipsis
    expect(all[1]).toMatchObject({ agentName: dev.name, taskId: t1.id })
    expect(all[2].content).toBe('I wrote the form.')

    expect(tasks.team({ projectId: 'p1' }).length).toBe(2)
    expect(tasks.team({ limit: 1 }).length).toBe(1)
    expect(tasks.team({ limit: 0 }).length).toBe(1) // clamped to at least 1
    expect(tasks.team({ limit: 9999 }).length).toBe(3)

    // deleting the task keeps what was said (the log outlives the task), without a task title
    db.run(`DELETE FROM tasks WHERE id = ?`, t1.id)
    const after = tasks.team({ projectId: 'p1' })
    expect(after.length).toBe(2)
    expect(after.every((m) => m.taskTitle === null && m.taskId === null)).toBe(true)
  })
})

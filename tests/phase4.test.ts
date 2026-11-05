import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ChatStreamEvent } from '../src/shared/ipc'
import { AGENT_TEMPLATES, NO_PERMISSIONS } from '../src/main/agents/templates'
import { Database } from '../src/main/db/database'
import { MIGRATIONS } from '../src/main/db/migrations'
import { createChatProvider } from '../src/main/providers/registry'
import { AgentService, normalizePermissions } from '../src/main/services/agents'
import { ChatService } from '../src/main/services/chat'
import { ConnectionService } from '../src/main/services/connections'
import { EventService } from '../src/main/services/events'
import { MemorySecrets } from './helpers/memory-secrets'
import { MockServer, json, sse } from './helpers/mock-server'

const KEY = 'sk-test-key-0123456789'
const server = new MockServer()
beforeAll(() => server.start())
afterAll(() => server.stop())

let db: Database
let events: EventService
let conns: ConnectionService
let agents: AgentService
let chat: ChatService

beforeEach(() => {
  server.reset()
  db = new Database(':memory:')
  db.migrate()
  events = new EventService(db)
  conns = new ConnectionService(db, events, new MemorySecrets(), { providerFactory: (c) => createChatProvider({ ...c, maxRetries: 0 }) })
  agents = new AgentService(db, events, conns)
  chat = new ChatService(db, events, conns)
})

const addConn = (name = 'Conn') => conns.create({ kind: 'openai', name, baseUrl: `${server.url}/v1`, apiKey: KEY })
const addProject = (id = 'p1') =>
  db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES (?, ?, 'web', ?, 1, 1)`, id, `Project ${id}`, `C:\\tmp\\${id}`)

describe('migration 2', () => {
  it('adds agents.max_cost_usd on top of a v1 database without losing rows', () => {
    const old = new Database(':memory:')
    old.migrate([MIGRATIONS[0]])
    expect(old.userVersion()).toBe(1)
    old.run(
      `INSERT INTO agents (id, name, role, system_prompt, permissions_json, created_at, updated_at) VALUES ('a', 'Old', 'custom', 'p', '{}', 1, 1)`
    )
    expect(old.migrate()).toBe(MIGRATIONS[MIGRATIONS.length - 1].version)
    expect(old.get<{ name: string; max_cost_usd: number | null }>(`SELECT name, max_cost_usd FROM agents`)).toEqual({ name: 'Old', max_cost_usd: null })
  })
})

describe('permissions', () => {
  it('every template starts from least privilege and none enables the internet by default', () => {
    for (const t of AGENT_TEMPLATES) expect(t.permissions.internet, t.key).toBe(false)
    expect(NO_PERMISSIONS).toMatchObject({ writeFiles: false, runCommands: 'none', internet: false, gitCommit: false })
  })

  it('merges partial input, drops unknown keys and rejects wrong types', () => {
    expect(normalizePermissions({ writeFiles: true, bogus: true })).toEqual({ ...NO_PERMISSIONS, writeFiles: true })
    expect(() => normalizePermissions({ writeFiles: 'yes' })).toThrow(/true or false/)
    expect(() => normalizePermissions({ runCommands: 'sudo' })).toThrow(/none, ask or allowlist/)
    expect(() => normalizePermissions([])).toThrow(/object/)
  })

  it('falls back to least privilege when a stored row is corrupt', () => {
    const a = agents.create({ templateKey: 'lead_developer' })
    db.run(`UPDATE agents SET permissions_json = '{not json' WHERE id = ?`, a.id)
    expect(agents.get(a.id)!.permissions).toEqual(NO_PERMISSIONS)
  })
})

describe('AgentService create', () => {
  it('lists the 12 templates', () => {
    expect(agents.templates()).toHaveLength(12)
  })

  it('copies a template into an editable agent', () => {
    const a = agents.create({ templateKey: 'code_reviewer' })
    expect(a).toMatchObject({
      name: 'Code Reviewer',
      role: 'code_reviewer',
      roleLabel: 'Code Reviewer',
      kind: 'chat',
      projectId: null,
      enabled: true,
      status: 'idle',
      temperature: 0.1,
      maxTokens: null,
      maxCostUsd: null
    })
    expect(a.permissions.writeFiles).toBe(false)
    expect(a.systemPrompt).toContain('Code Reviewer')
  })

  it('creates a custom agent but requires a name and a prompt', () => {
    const a = agents.create({ name: '  Docs   Writer ', systemPrompt: 'Write docs.', permissions: { writeFiles: true } })
    expect(a).toMatchObject({ name: 'Docs Writer', role: 'custom', roleLabel: 'Custom', temperature: null })
    expect(a.permissions).toEqual({ ...NO_PERMISSIONS, writeFiles: true })
    expect(() => agents.create({ systemPrompt: 'x' })).toThrow(/name/)
    expect(() => agents.create({ name: 'x' })).toThrow(/system prompt/)
    expect(() => agents.create({ templateKey: 'nope' })).toThrow(/Unknown template/)
  })

  it('validates numeric limits', () => {
    const base = { name: 'A', systemPrompt: 'p' }
    expect(() => agents.create({ ...base, temperature: 3 })).toThrow(/Temperature/)
    expect(() => agents.create({ ...base, maxTokens: 1.5 })).toThrow(/Max tokens/)
    expect(() => agents.create({ ...base, maxTokens: 0 })).toThrow(/Max tokens/)
    expect(() => agents.create({ ...base, maxCostUsd: -1 })).toThrow(/Cost limit/)
    expect(() => agents.create({ ...base, maxCostUsd: Number.NaN })).toThrow(/Cost limit/)
    expect(agents.create({ ...base, maxTokens: 4096, maxCostUsd: 2.5, temperature: 0 })).toMatchObject({ maxTokens: 4096, maxCostUsd: 2.5, temperature: 0 })
  })

  it('enforces unique names per scope, case-insensitively, but allows the same name in another scope', () => {
    addProject('p1')
    agents.create({ templateKey: 'qa_tester' })
    expect(() => agents.create({ templateKey: 'qa_tester', name: 'QA TESTER' })).toThrow(/already exists in the library/)
    expect(agents.create({ templateKey: 'qa_tester', projectId: 'p1' }).projectId).toBe('p1')
    expect(() => agents.create({ templateKey: 'qa_tester', projectId: 'p1' })).toThrow(/already exists in this project/)
    expect(() => agents.create({ templateKey: 'qa_tester', projectId: 'missing' })).toThrow(/Project not found/)
  })

  it('rejects an unknown connection and a model without a connection', async () => {
    expect(() => agents.create({ name: 'A', systemPrompt: 'p', connectionId: 'nope' })).toThrow(/does not exist/)
    expect(() => agents.create({ name: 'A', systemPrompt: 'p', model: 'gpt-x' })).toThrow(/Choose a connection/)
  })

  it('records an activity event', () => {
    agents.create({ templateKey: 'game_designer' })
    expect(events.recent({ limit: 1 })[0]).toMatchObject({ type: 'agent.created' })
  })
})

describe('AgentService update', () => {
  it('changes only the supplied fields', () => {
    const a = agents.create({ templateKey: 'lead_developer' })
    const b = agents.update({ id: a.id, name: 'Chief Dev', temperature: null, maxTokens: 2048, permissions: { internet: true } })
    expect(b).toMatchObject({ name: 'Chief Dev', temperature: null, maxTokens: 2048, systemPrompt: a.systemPrompt })
    // partial permission update keeps the template's other grants
    expect(b.permissions).toEqual({ ...a.permissions, internet: true })
    expect(b.updatedAt).toBeGreaterThanOrEqual(a.updatedAt)
  })

  it('rejects a duplicate name but allows keeping its own', () => {
    agents.create({ templateKey: 'qa_tester' })
    const b = agents.create({ templateKey: 'code_reviewer' })
    expect(() => agents.update({ id: b.id, name: 'qa tester' })).toThrow(/already exists/)
    expect(agents.update({ id: b.id, name: 'Code Reviewer' }).name).toBe('Code Reviewer')
  })

  it('clears the model when the connection changes, because model ids belong to one connection', async () => {
    const c1 = await addConn('one')
    const c2 = await addConn('two')
    const a = agents.create({ templateKey: 'lead_developer', connectionId: c1.id, model: 'gpt-x' })
    expect(a).toMatchObject({ connectionId: c1.id, connectionName: 'one', model: 'gpt-x' })
    expect(agents.update({ id: a.id, connectionId: c2.id })).toMatchObject({ connectionId: c2.id, model: null })
    expect(agents.update({ id: a.id, connectionId: c1.id, model: 'm2' })).toMatchObject({ connectionId: c1.id, model: 'm2' })
    expect(agents.update({ id: a.id, model: 'm3' })).toMatchObject({ connectionId: c1.id, model: 'm3' })
    expect(agents.update({ id: a.id, connectionId: null })).toMatchObject({ connectionId: null, model: null })
  })

  it('enable/disable toggles status and logs it', () => {
    const a = agents.create({ templateKey: 'qa_tester' })
    const off = agents.update({ id: a.id, enabled: false })
    expect(off).toMatchObject({ enabled: false, status: 'disabled', issues: [] })
    expect(events.recent({ limit: 1 })[0].type).toBe('agent.disabled')
    expect(agents.update({ id: a.id, enabled: true })).toMatchObject({ enabled: true, status: 'idle' })
    expect(events.recent({ limit: 1 })[0].type).toBe('agent.enabled')
  })

  it('refuses to disable or delete a working agent', () => {
    const a = agents.create({ templateKey: 'qa_tester' })
    db.run(`UPDATE agents SET status = 'working' WHERE id = ?`, a.id)
    expect(() => agents.update({ id: a.id, enabled: false })).toThrow(/working/)
    expect(() => agents.remove(a.id)).toThrow(/working/)
  })

  it('throws for an unknown agent', () => {
    expect(() => agents.update({ id: 'nope', name: 'x' })).toThrow(/not found/)
  })
})

describe('duplicate and remove', () => {
  it('duplicates everything with a fresh identity and a unique name', async () => {
    const c = await addConn()
    const a = agents.create({ templateKey: 'lead_developer', connectionId: c.id, model: 'gpt-x', maxTokens: 1000, maxCostUsd: 1 })
    const d1 = agents.duplicate(a.id)
    const d2 = agents.duplicate(a.id)
    expect(d1.name).toBe('Lead Developer (copy)')
    expect(d2.name).toBe('Lead Developer (copy) 2')
    expect(d1.id).not.toBe(a.id)
    expect(d1).toMatchObject({ role: a.role, connectionId: c.id, model: 'gpt-x', maxTokens: 1000, maxCostUsd: 1, systemPrompt: a.systemPrompt, permissions: a.permissions })
    // editing the copy leaves the original alone
    agents.update({ id: d1.id, systemPrompt: 'changed' })
    expect(agents.get(a.id)!.systemPrompt).toBe(a.systemPrompt)
  })

  it('a duplicate of a disabled agent stays disabled', () => {
    const a = agents.create({ templateKey: 'qa_tester', enabled: false })
    expect(agents.duplicate(a.id)).toMatchObject({ enabled: false, status: 'disabled' })
  })

  it('remove deletes the agent but keeps its usage history', async () => {
    const c = await addConn()
    const a = agents.create({ templateKey: 'qa_tester', connectionId: c.id, model: 'gpt-x' })
    db.run(`INSERT INTO llm_calls (id, agent_id, model, status, created_at) VALUES ('l1', ?, 'gpt-x', 'ok', 1)`, a.id)
    agents.remove(a.id)
    expect(agents.get(a.id)).toBeNull()
    expect(db.get<{ agent_id: string | null }>(`SELECT agent_id FROM llm_calls WHERE id='l1'`)).toEqual({ agent_id: null })
    expect(events.recent({ limit: 1 })[0]).toMatchObject({ type: 'agent.removed' })
    expect(() => agents.remove(a.id)).toThrow(/not found/)
  })

  it('deleting a project removes its team but not library agents', () => {
    addProject('p1')
    agents.create({ templateKey: 'qa_tester' })
    agents.create({ templateKey: 'qa_tester', projectId: 'p1' })
    db.run(`DELETE FROM projects WHERE id = 'p1'`)
    expect(agents.list().map((a) => a.projectId)).toEqual([null])
  })
})

describe('createTeam', () => {
  it('creates one agent per template and is idempotent', () => {
    addProject('p1')
    const first = agents.createTeam('p1')
    expect(first).toHaveLength(12)
    expect(new Set(first.map((a) => a.role)).size).toBe(12)
    expect(first.every((a) => a.projectId === 'p1')).toBe(true)
    expect(agents.createTeam('p1')).toEqual([])
  })

  it('only adds missing roles, even when an existing agent was renamed', () => {
    addProject('p1')
    const dev = agents.create({ templateKey: 'lead_developer', projectId: 'p1', name: 'Ada' })
    const added = agents.createTeam('p1')
    expect(added).toHaveLength(11)
    expect(added.some((a) => a.role === 'lead_developer')).toBe(false)
    expect(agents.get(dev.id)!.name).toBe('Ada')
  })

  it('rejects an unknown project and is atomic with the library scope', () => {
    expect(() => agents.createTeam('missing')).toThrow(/Project not found/)
    expect(agents.createTeam(null)).toHaveLength(12)
  })
})

describe('readiness issues (checked against real connection state)', () => {
  it('reports each reason an agent cannot run', async () => {
    const a = agents.create({ templateKey: 'lead_developer' })
    expect(a.issues).toEqual(['No model connection selected.'])

    const c = await addConn('Work')
    expect(agents.update({ id: a.id, connectionId: c.id }).issues).toEqual(['No model selected.'])

    expect(agents.update({ id: a.id, model: 'gpt-x' }).issues).toEqual([]) // no cached model list: nothing to contradict

    conns.update({ id: c.id, enabled: false })
    expect(agents.get(a.id)!.issues).toEqual(['Connection “Work” is disabled.'])
    conns.update({ id: c.id, enabled: true })

    server.handler = (_r, res) => {
      res.statusCode = 401
      res.end('{}')
    }
    await conns.test(c.id)
    expect(agents.get(a.id)!.issues[0]).toMatch(/failed its last test/)
  })

  it('checks the chosen model against the discovered list and its kind', async () => {
    server.handler = (_r, res) => json(res, 200, { data: [{ id: 'gpt-x' }, { id: 'text-embedding-3-small' }] })
    const c = await addConn()
    await conns.discoverModels(c.id)
    const a = agents.create({ templateKey: 'lead_developer', connectionId: c.id, model: 'gpt-x' })
    expect(a.issues).toEqual([])
    expect(agents.update({ id: a.id, model: 'gpt-y' }).issues[0]).toMatch(/not in the connection’s model list/)
    expect(agents.update({ id: a.id, model: 'text-embedding-3-small' }).issues[0]).toMatch(/embedding model, not a chat model/)
  })

  it('checks image agents against their connection and reports a deleted connection', async () => {
    const img = agents.create({ templateKey: 'image_generator' })
    expect(img.kind).toBe('image')
    expect(img.issues).toEqual(['No model connection selected.'])

    const c = await addConn()
    const a = agents.create({ templateKey: 'qa_tester', connectionId: c.id, model: 'gpt-x' })
    await conns.remove(c.id)
    expect(agents.get(a.id)).toMatchObject({ connectionId: null, issues: ['No model connection selected.'] })
  })
})

// ------------------------------------------------------------------ chat attribution

function run(input: Parameters<ChatService['start']>[0]): Promise<ChatStreamEvent[]> {
  return new Promise((resolve, reject) => {
    const got: ChatStreamEvent[] = []
    chat.start(input, (e) => {
      got.push(e)
      if (e.type === 'done' || e.type === 'error' || e.type === 'cancelled') resolve(got)
    })
    setTimeout(() => reject(new Error('chat timed out')), 8000)
  })
}

describe('chat calls made as an agent', () => {
  const ok = (res: Parameters<typeof sse>[0]) =>
    sse(res, [
      { data: { model: 'gpt-x', choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }] } },
      { data: { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } } },
      { data: '[DONE]' }
    ])

  it('attributes the call (and its event) to the agent and its project', async () => {
    addProject('p1')
    server.handler = (_r, res) => ok(res)
    const c = await addConn()
    const a = agents.create({ templateKey: 'qa_tester', projectId: 'p1', connectionId: c.id, model: 'gpt-x' })
    const got = await run({ connectionId: c.id, model: 'gpt-x', system: a.systemPrompt, agentId: a.id, messages: [{ role: 'user', content: 'go' }] })
    expect(got[got.length - 1].type).toBe('done')
    expect(db.get(`SELECT agent_id, project_id, status FROM llm_calls`)).toEqual({ agent_id: a.id, project_id: 'p1', status: 'ok' })
    expect(events.recent({ limit: 1 })[0]).toMatchObject({ type: 'llm.call', agentId: a.id, projectId: 'p1' })
    expect(events.recent({ limit: 1 })[0].message).toContain('QA Tester')
  })

  it('failed calls are attributed too', async () => {
    server.handler = (_r, res) => {
      res.statusCode = 401
      res.end('{"error":{"message":"bad key"}}')
    }
    const c = await addConn()
    const a = agents.create({ templateKey: 'qa_tester', connectionId: c.id, model: 'gpt-x' })
    const got = await run({ connectionId: c.id, model: 'gpt-x', agentId: a.id, messages: [{ role: 'user', content: 'go' }] })
    expect(got[got.length - 1].type).toBe('error')
    expect(db.get(`SELECT agent_id, status FROM llm_calls`)).toEqual({ agent_id: a.id, status: 'error' })
  })

  it('refuses unknown or disabled agents before any request is made', async () => {
    const c = await addConn()
    const a = agents.create({ templateKey: 'qa_tester', enabled: false })
    const input = { connectionId: c.id, model: 'gpt-x', messages: [{ role: 'user' as const, content: 'go' }] }
    expect(() => chat.start({ ...input, agentId: 'nope' }, () => undefined)).toThrow(/Agent not found/)
    expect(() => chat.start({ ...input, agentId: a.id }, () => undefined)).toThrow(/disabled/)
    expect(server.requests).toHaveLength(0)
  })

  it('playground calls stay unattributed', async () => {
    server.handler = (_r, res) => ok(res)
    const c = await addConn()
    await run({ connectionId: c.id, model: 'gpt-x', messages: [{ role: 'user', content: 'go' }] })
    expect(db.get(`SELECT agent_id, project_id FROM llm_calls`)).toEqual({ agent_id: null, project_id: null })
  })
})

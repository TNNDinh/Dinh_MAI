import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_TEMPLATES, getTemplate } from '../src/main/agents/templates'
import { Database } from '../src/main/db/database'
import { EncryptedFileSecretStore, type Cipher } from '../src/main/secrets/secret-store'
import { PROVIDER_CATALOG, PROVIDER_KINDS } from '../src/main/providers'
import { estimateCostUsd } from '../src/main/providers/usage'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mads-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('Database + migrations', () => {
  it('creates the full schema and is idempotent', () => {
    const db = new Database(':memory:')
    const v = db.migrate()
    expect(v).toBeGreaterThanOrEqual(1)
    expect(db.migrate()).toBe(v)
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((t) => t.name)
    for (const t of ['projects', 'agents', 'tasks', 'runs', 'llm_calls', 'file_locks', 'assets', 'checkpoints', 'provider_connections']) {
      expect(tables).toContain(t)
    }
  })

  it('enforces foreign keys and cascades project deletion', () => {
    const db = new Database(':memory:')
    db.migrate()
    const now = Date.now()
    expect(() =>
      db.run(`INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t', 'missing', 'x', ?, ?)`, now, now)
    ).toThrow()

    db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p','P','web','C:/p',?,?)`, now, now)
    db.run(`INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('t','p','x',?,?)`, now, now)
    db.run(`DELETE FROM projects WHERE id='p'`)
    expect(db.get(`SELECT COUNT(*) c FROM tasks`)).toEqual({ c: 0 })
  })

  it('rolls back failed transactions and supports nesting', () => {
    const db = new Database(':memory:')
    db.migrate()
    const now = Date.now()
    const insert = (id: string) =>
      db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES (?,?,?,?,?,?)`, id, id, 'web', `C:/${id}`, now, now)
    expect(() =>
      db.transaction(() => {
        insert('a')
        db.transaction(() => insert('b'))
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(db.get(`SELECT COUNT(*) c FROM projects`)).toEqual({ c: 0 })
    db.transaction(() => insert('c'))
    expect(db.get(`SELECT COUNT(*) c FROM projects`)).toEqual({ c: 1 })
  })

  it('enforces one lock per file (agents cannot double-lock)', () => {
    const db = new Database(':memory:')
    db.migrate()
    const now = Date.now()
    db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p','P','web','C:/p',?,?)`, now, now)
    const lock = (agent: string) =>
      db.run(`INSERT INTO file_locks (project_id, path, agent_id, acquired_at, expires_at) VALUES ('p','src/a.ts',?,?,?)`, agent, now, now + 1000)
    lock('agent1')
    expect(() => lock('agent2')).toThrow(/UNIQUE|constraint/i)
  })

  it('persists to disk and reopens', () => {
    const file = join(dir, 'app.db')
    const a = new Database(file)
    a.migrate()
    a.run(`INSERT INTO settings (key, value_json, updated_at) VALUES ('k','"v"',1)`)
    a.close()
    const b = new Database(file)
    expect(b.migrate()).toBeGreaterThanOrEqual(1)
    expect(b.get(`SELECT value_json v FROM settings WHERE key='k'`)).toEqual({ v: '"v"' })
    b.close()
  })
})

// Reversible stand-in for DPAPI; the real cipher is Electron's safeStorage.
const fakeCipher = (available = true): Cipher => ({
  isEncryptionAvailable: async () => available,
  encryptString: async (s) => Buffer.from(s.split('').reverse().join(''), 'utf8'),
  decryptString: async (b) => b.toString('utf8').split('').reverse().join('')
})

describe('EncryptedFileSecretStore', () => {
  it('never writes the plaintext key to disk and round-trips', async () => {
    const file = join(dir, 'secrets.json')
    const s = new EncryptedFileSecretStore(file, fakeCipher())
    await s.set('conn1', 'sk-super-secret')
    expect(readFileSync(file, 'utf8')).not.toContain('sk-super-secret')
    expect(await new EncryptedFileSecretStore(file, fakeCipher()).get('conn1')).toBe('sk-super-secret')
    s.delete('conn1')
    expect(s.has('conn1')).toBe(false)
    expect(await s.get('conn1')).toBeUndefined()
  })

  it('refuses to store secrets when OS encryption is unavailable', async () => {
    const s = new EncryptedFileSecretStore(join(dir, 's.json'), fakeCipher(false))
    await expect(s.set('a', 'b')).rejects.toThrow(/plaintext/)
  })

  it('recovers from a corrupt file instead of crashing', async () => {
    const file = join(dir, 's.json')
    writeFileSync(file, '{not json')
    const s = new EncryptedFileSecretStore(file, fakeCipher())
    expect(await s.get('x')).toBeUndefined()
    await s.set('x', 'y')
    expect(await s.get('x')).toBe('y')
  })

  it('does not lose entries when several secrets are saved concurrently', async () => {
    const s = new EncryptedFileSecretStore(join(dir, 's.json'), fakeCipher())
    await Promise.all(['a', 'b', 'c', 'd'].map((k) => s.set(k, `v-${k}`)))
    for (const k of ['a', 'b', 'c', 'd']) expect(await s.get(k)).toBe(`v-${k}`)
  })
})

describe('catalog, templates, usage', () => {
  it('has a catalog entry for every required provider', () => {
    for (const k of ['anthropic', 'openai', 'gemini', 'openrouter', 'deepseek', 'groq', 'ollama', 'custom']) {
      expect(PROVIDER_KINDS).toContain(k)
    }
    expect(PROVIDER_CATALOG.ollama.requiresApiKey).toBe(false)
  })

  it('ships all 12 required agent templates with unique keys', () => {
    const keys = AGENT_TEMPLATES.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of ['lead_developer', 'backend_developer', 'frontend_developer', 'game_developer', 'game_designer', 'concept_artist', 'image_generator', 'ui_ux_designer', 'code_reviewer', 'qa_tester', 'project_manager', 'technical_architect']) {
      expect(getTemplate(k), k).toBeDefined()
    }
    // reviewers must not be able to modify code
    expect(getTemplate('code_reviewer')!.permissions.writeFiles).toBe(false)
    expect(getTemplate('image_generator')!.kind).toBe('image')
  })

  it('returns null cost for unknown pricing instead of guessing', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 500_000 }
    expect(estimateCostUsd(usage, undefined)).toBeNull()
    expect(estimateCostUsd(usage, { inputPerMTok: 3, outputPerMTok: 15 })).toBeCloseTo(10.5)
    expect(estimateCostUsd(usage, { inputPerMTok: 0, outputPerMTok: 0 })).toBe(0) // local models
  })
})

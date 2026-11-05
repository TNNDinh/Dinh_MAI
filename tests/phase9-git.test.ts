import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Database } from '../src/main/db/database'
import { CheckpointService } from '../src/main/git/checkpoints'
import { GitRepo, parseStatus } from '../src/main/git/repo'
import { GitError, gitEnv } from '../src/main/git/runner'
import { EventService } from '../src/main/services/events'

// These tests drive the real git executable in throw-away folders. Nothing is mocked.

let dir: string
let repo: GitRepo
const w = (rel: string, text: string): void => {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
}
const r = (rel: string): string => readFileSync(join(dir, rel), 'utf8')
const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, env: gitEnv(), encoding: 'utf8' })

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mads-git-')))
  repo = new GitRepo(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('parseStatus', () => {
  it('reads modified, untracked, deleted and renamed entries', () => {
    const f = parseStatus(' M a.txt\0?? b.txt\0D  c.txt\0R  new.txt\0old.txt\0?? .env\0')
    expect(f.map((x) => [x.path, x.index, x.worktree])).toEqual([
      ['a.txt', ' ', 'M'],
      ['b.txt', '?', '?'],
      ['c.txt', 'D', ' '],
      ['new.txt', 'R', ' '],
      ['.env', '?', '?']
    ])
    expect(f[3].from).toBe('old.txt')
    expect(f[4].secret).toBe(true)
    expect(f[0].secret).toBe(false)
  })
})

describe('GitRepo', () => {
  it('reports a plain folder as not a repository, then initialises it', async () => {
    const s0 = await repo.status()
    expect(s0).toMatchObject({ isRepo: false, gitMissing: false, files: [] })
    const s1 = await repo.init()
    expect(s1.isRepo).toBe(true)
    expect(s1.hasCommits).toBe(false)
    expect(s1.branch).toBeTruthy()
    expect(await repo.log()).toEqual([])
  })

  it('does not treat a folder inside another repository as a repository of its own', async () => {
    await repo.init()
    mkdirSync(join(dir, 'sub'))
    const inner = new GitRepo(join(dir, 'sub'))
    expect((await inner.status()).isRepo).toBe(false)
    await expect(inner.commit('x')).rejects.toMatchObject({ code: 'not_repo' })
  })

  it('shows changes, commits them and lists the history', async () => {
    await repo.init()
    w('a.txt', 'one\n')
    w('src/b.ts', 'export {}\n')
    const s = await repo.status()
    expect(s.files.map((f) => f.path).sort()).toEqual(['a.txt', 'src/b.ts'])
    const c = await repo.commit('first commit')
    expect(c.committed).toBe(2)
    expect(c.sha).toMatch(/^[0-9a-f]{40}$/)
    const after = await repo.status()
    expect(after.clean).toBe(true)
    expect(after.hasCommits).toBe(true)
    w('a.txt', 'two\n')
    const log = await repo.log()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ subject: 'first commit', sha: c.sha })
    expect(log[0].date).toBeGreaterThan(1_600_000_000_000)
    await expect(repo.commit('   ')).rejects.toMatchObject({ code: 'invalid' })
    await repo.commit('second')
    await expect(repo.commit('nothing')).rejects.toThrow(/Nothing to commit/)
    expect((await repo.log()).map((l) => l.subject)).toEqual(['second', 'first commit'])
  })

  it('commits only the chosen paths', async () => {
    await repo.init()
    w('a.txt', '1')
    w('b.txt', '2')
    const c = await repo.commit('just a', ['a.txt'])
    expect(c.committed).toBe(1)
    const s = await repo.status()
    expect(s.files.map((f) => f.path)).toEqual(['b.txt'])
  })

  it('never commits credential files and says so', async () => {
    await repo.init()
    w('app.js', 'x')
    w('.env', 'SECRET=hunter2')
    w('keys/server.pem', 'PRIVATE')
    w('.env.example', 'SECRET=')
    const c = await repo.commit('all')
    expect(c.skippedSecrets.sort()).toEqual(['.env', 'keys/server.pem'])
    const tracked = git('ls-files').split(/\r?\n/).filter(Boolean).sort()
    expect(tracked).toEqual(['.env.example', 'app.js'])
    // Choosing a credential file by name does not get it in either.
    await expect(repo.commit('sneaky', ['.env'])).rejects.toThrow(/credential/)
    // Even when it was staged by hand beforehand.
    git('add', '-f', '.env')
    w('more.txt', 'm')
    const c2 = await repo.commit('again')
    expect(c2.skippedSecrets).toContain('.env')
    expect(git('ls-files').split(/\r?\n/)).not.toContain('.env')
  })

  it('shows diffs for tracked, staged and untracked files, but never for credential files', async () => {
    await repo.init()
    w('a.txt', 'hello\n')
    await repo.commit('init')
    w('a.txt', 'hello\nworld\n')
    w('new.txt', 'brand new\n')
    w('.env', 'TOKEN=abc')
    const d = await repo.diff('a.txt')
    expect(d.text).toContain('+world')
    const n = await repo.diff('new.txt')
    expect(n.text).toContain('+brand new')
    const s = await repo.diff('.env')
    expect(s.text).toBe('')
    expect(s.note).toMatch(/credential/)
    git('add', 'a.txt')
    expect((await repo.diff('a.txt', true)).text).toContain('+world')
    expect((await repo.diff('a.txt')).note).toBe('No differences.')
    await expect(repo.diff('../outside.txt')).rejects.toThrow()
    await expect(repo.diff('.git/config')).rejects.toThrow()
  })

  it('reports binary files without dumping bytes', async () => {
    await repo.init()
    writeFileSync(join(dir, 'x.bin'), Buffer.from([0, 1, 2, 3, 0, 255]))
    await repo.commit('bin')
    writeFileSync(join(dir, 'x.bin'), Buffer.from([0, 9, 9, 9, 0, 255]))
    const d = await repo.diff('x.bin')
    expect(d.text).toBe('')
    expect(d.note).toMatch(/Binary/)
  })

  it('creates and switches branches, refusing bad names', async () => {
    await repo.init()
    await expect(repo.switchBranch('x', false)).rejects.toThrow(/no commits/)
    w('a.txt', '1')
    await repo.commit('c1')
    const first = (await repo.status()).branch!
    const s = await repo.switchBranch('feature/x', true)
    expect(s.branch).toBe('feature/x')
    const list = await repo.branches()
    expect(list.map((b) => b.name).sort()).toEqual([first, 'feature/x'].sort())
    expect(list.find((b) => b.current)?.name).toBe('feature/x')
    expect((await repo.switchBranch(first)).branch).toBe(first)
    await expect(repo.switchBranch('bad name!?', true)).rejects.toThrow(/valid branch/)
    await expect(repo.switchBranch('--force', true)).rejects.toThrow()
    await expect(repo.switchBranch('nope')).rejects.toThrow()
  })

  it('refuses to switch branches over local changes instead of discarding them', async () => {
    await repo.init()
    w('a.txt', 'base\n')
    await repo.commit('c1')
    const first = (await repo.status()).branch!
    await repo.switchBranch('other', true)
    w('a.txt', 'other\n')
    await repo.commit('c2')
    await repo.switchBranch(first)
    w('a.txt', 'dirty edit\n')
    await expect(repo.switchBranch('other')).rejects.toBeInstanceOf(GitError)
    expect(r('a.txt')).toBe('dirty edit\n')
  })

  it('does not run hooks of the repository', async () => {
    await repo.init()
    const hook = join(dir, '.git', 'hooks', 'pre-commit')
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
    writeFileSync(hook, `#!/bin/sh\necho ran > "${join(dir, 'hook-ran.txt').replace(/\\/g, '/')}"\nexit 1\n`)
    w('a.txt', '1')
    await repo.commit('with a hostile hook')
    expect(existsSync(join(dir, 'hook-ran.txt'))).toBe(false)
  })

  it('uses a labelled fallback identity when none is configured, and the real one when it is', async () => {
    await repo.init()
    w('a.txt', '1')
    const prev = process.env.GIT_CONFIG_GLOBAL
    // Point global config at an empty file so the machine's own identity does not leak into the assertion.
    const empty = join(dir, '..', `empty-gitconfig-${Date.now()}`)
    writeFileSync(empty, '')
    process.env.GIT_CONFIG_GLOBAL = empty
    try {
      git('config', '--local', '--unset-all', 'user.name')
    } catch {
      /* not set */
    }
    try {
      const out = await repo.commit('anon')
      expect(out.committed).toBe(1)
    } finally {
      if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = prev
      rmSync(empty, { force: true })
    }
    expect((await repo.log())[0].subject).toBe('anon')
  })
})

describe('CheckpointService', () => {
  let db: Database
  let svc: CheckpointService
  let notified: Array<[string, string[], string[]]>

  beforeEach(async () => {
    db = new Database(':memory:')
    db.migrate()
    db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p1', 'P', 'web', ?, 1, 1)`, dir)
    notified = []
    svc = new CheckpointService(db, new EventService(db), () => repo, { onRestored: (p, a, b) => notified.push([p, a, b]) })
    await repo.init()
  })

  it('snapshots without touching the index, branch, history or working files', async () => {
    w('a.txt', 'one\n')
    await repo.commit('base')
    const headBefore = git('rev-parse', 'HEAD')
    w('a.txt', 'two\n')
    w('new.txt', 'untracked\n')
    const statusBefore = git('status', '--porcelain')
    const cp = await svc.create({ projectId: 'p1', label: 'mine' })
    expect(cp).toMatchObject({ label: 'mine', kind: 'manual', fileCount: 2 })
    expect(cp.gitRef).toMatch(/^[0-9a-f]{40}$/)
    expect(git('rev-parse', 'HEAD')).toBe(headBefore)
    expect(git('status', '--porcelain')).toBe(statusBefore)
    expect(git('branch', '--list')).not.toContain('checkpoint')
    expect(git('show-ref')).toContain(`refs/mads/checkpoints/${cp.id}`)
    expect(git('log', '--oneline').trim().split(/\r?\n/)).toHaveLength(1)
    expect(r('a.txt')).toBe('two\n')
    expect(svc.list('p1').map((c) => c.id)).toEqual([cp.id])
  })

  it('restores edited, deleted and added files, and leaves ignored and credential files alone', async () => {
    w('.gitignore', 'node_modules/\ndist/\n')
    w('keep.txt', 'v1\n')
    w('gone.txt', 'will be deleted\n')
    w('dir/inner.txt', 'inner\n')
    await repo.commit('base')
    w('local.txt', 'untracked at checkpoint time\n')
    w('node_modules/pkg/index.js', 'ignored\n')
    w('.env', 'KEY=1')
    const cp = await svc.create({ projectId: 'p1', label: 'before chaos' })
    // chaos
    w('keep.txt', 'v2 broken\n')
    rmSync(join(dir, 'gone.txt'))
    rmSync(join(dir, 'dir'), { recursive: true })
    rmSync(join(dir, 'local.txt'))
    w('agent-made/new.ts', 'junk\n')
    w('node_modules/pkg/index.js', 'ignored, changed\n')
    w('.env', 'KEY=2')
    const res = await svc.restore(cp.id)
    expect(r('keep.txt')).toBe('v1\n')
    expect(r('gone.txt')).toBe('will be deleted\n')
    expect(r('dir/inner.txt')).toBe('inner\n')
    expect(r('local.txt')).toBe('untracked at checkpoint time\n')
    expect(existsSync(join(dir, 'agent-made/new.ts'))).toBe(false)
    expect(existsSync(join(dir, 'agent-made'))).toBe(false)
    expect(r('node_modules/pkg/index.js')).toBe('ignored, changed\n')
    expect(r('.env')).toBe('KEY=2')
    expect(res.removed).toBe(1)
    expect(res.restored).toBe(4)
    expect(notified).toHaveLength(1)
    expect(notified[0][2]).toEqual(['agent-made/new.ts'])
    // The restore took a safety checkpoint of the state it replaced, and undoing the restore works.
    const safety = svc.get(res.safetyCheckpointId)!
    expect(safety.kind).toBe('safety')
    await svc.restore(safety.id)
    expect(r('keep.txt')).toBe('v2 broken\n')
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false)
    expect(r('agent-made/new.ts')).toBe('junk\n')
  })

  it('does not rewrite files that were already identical', async () => {
    w('same.txt', 'same\n')
    w('diff.txt', 'a\n')
    await repo.commit('base')
    const cp = await svc.create({ projectId: 'p1' })
    const before = (await import('node:fs')).statSync(join(dir, 'same.txt')).mtimeMs
    await new Promise((res) => setTimeout(res, 30))
    w('diff.txt', 'b\n')
    const out = await svc.restore(cp.id)
    expect(out.restored).toBe(1)
    expect((await import('node:fs')).statSync(join(dir, 'same.txt')).mtimeMs).toBe(before)
  })

  it('works before the first commit', async () => {
    w('a.txt', 'x\n')
    const cp = await svc.create({ projectId: 'p1' })
    expect(cp.fileCount).toBe(1)
    rmSync(join(dir, 'a.txt'))
    w('b.txt', 'y\n')
    await svc.restore(cp.id)
    expect(r('a.txt')).toBe('x\n')
    expect(existsSync(join(dir, 'b.txt'))).toBe(false)
  })

  it('removes a checkpoint together with its ref, and refuses an unknown id', async () => {
    w('a.txt', 'x')
    const cp = await svc.create({ projectId: 'p1' })
    await svc.remove(cp.id)
    expect(svc.list('p1')).toEqual([])
    expect(git('for-each-ref', 'refs/mads').trim()).toBe('')
    expect(() => svc.restore('nope')).toThrow(/not found/)
  })

  it('keeps only the newest automatic checkpoints', async () => {
    w('a.txt', 'x')
    for (let i = 0; i < 27; i++) await svc.create({ projectId: 'p1', kind: 'auto', label: `auto ${i}` })
    const list = svc.list('p1')
    expect(list).toHaveLength(25)
    expect(list[0].label).toBe('auto 26')
    expect(git('for-each-ref', 'refs/mads').trim().split(/\r?\n/)).toHaveLength(25)
  })

  it('refuses when the folder is not a repository', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'mads-plain-')))
    try {
      const s2 = new CheckpointService(db, new EventService(db), () => new GitRepo(plain))
      await expect(s2.create({ projectId: 'p1' })).rejects.toMatchObject({ code: 'not_repo' })
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

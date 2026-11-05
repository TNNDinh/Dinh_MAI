import type { GitBranchInfo, GitCommitInfo, GitCommitResult, GitDiffResult, GitFileChange, GitStatus } from '../../shared/ipc'
import { isSecretPath, normalizeRel } from '../workspace/sandbox'
import { GitError, runGit, type GitResult, type GitRunOptions } from './runner'

const MAX_FILES = 5000
const MAX_DIFF_BYTES = 200_000
export const FALLBACK_IDENT = { name: 'Multi-AI Studio', email: 'studio@localhost' }

/** Parses `git status --porcelain=v1 -z`. Exported for tests. */
export function parseStatus(raw: string): GitFileChange[] {
  const parts = raw.split('\0')
  const files: GitFileChange[] = []
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]
    if (e.length < 4) continue
    const x = e[0]
    const y = e[1]
    const path = e.slice(3)
    const f: GitFileChange = { path, index: x, worktree: y, secret: isSecretPath(path) }
    // A rename or copy is followed by the path it came from.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') f.from = parts[++i]
    files.push(f)
    if (files.length >= MAX_FILES) break
  }
  return files
}

/**
 * One git repository at a project's top folder. Only local operations exist here: no push, pull, fetch or remote of any kind.
 * Credential-looking files (.env, keys…) are never staged, committed or shown in a diff by this class.
 */
export class GitRepo {
  constructor(readonly root: string) {}

  run(args: string[], opts?: GitRunOptions): Promise<GitResult> {
    return runGit(this.root, args, opts)
  }

  /** The project folder is itself the top of a repository (not merely somewhere inside a bigger one). */
  async isRepo(): Promise<boolean> {
    try {
      const r = await this.run(['rev-parse', '--is-inside-work-tree', '--show-prefix'], { allowFailure: true })
      if (r.code !== 0) return false
      const [inside, prefix] = r.out.split(/\r?\n/)
      return inside.trim() === 'true' && (prefix ?? '').trim() === ''
    } catch (e) {
      if (e instanceof GitError && e.code === 'missing') throw e
      return false
    }
  }

  async requireRepo(): Promise<void> {
    if (!(await this.isRepo())) throw new GitError('This project folder is not a git repository yet. Use "Initialise git" first.', 'not_repo')
  }

  async head(): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '-q', 'HEAD'], { allowFailure: true })
    return r.code === 0 ? r.out.trim() : null
  }

  async branch(): Promise<{ name: string | null; detached: boolean }> {
    const r = await this.run(['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true })
    if (r.code === 0 && r.out.trim()) return { name: r.out.trim(), detached: false }
    return { name: null, detached: (await this.head()) !== null }
  }

  async status(): Promise<GitStatus> {
    const empty: GitStatus = { isRepo: false, gitMissing: false, branch: null, detached: false, hasCommits: false, head: null, files: [], clean: true }
    let repo: boolean
    try {
      repo = await this.isRepo()
    } catch (e) {
      if (e instanceof GitError && e.code === 'missing') return { ...empty, gitMissing: true }
      throw e
    }
    if (!repo) return empty
    const [head, br, st] = await Promise.all([this.head(), this.branch(), this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])])
    const files = parseStatus(st.out)
    return { isRepo: true, gitMissing: false, branch: br.name, detached: br.detached, hasCommits: head !== null, head, files, clean: files.length === 0 }
  }

  async init(): Promise<GitStatus> {
    if (!(await this.isRepo())) await this.run(['init', '-q'])
    return this.status()
  }

  async log(limit = 50): Promise<GitCommitInfo[]> {
    await this.requireRepo()
    if ((await this.head()) === null) return []
    const n = Math.max(1, Math.min(500, Math.floor(limit)))
    const r = await this.run(['log', `-n${n}`, '--no-color', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%at%x1e'])
    return r.out
      .split('\x1e')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((rec) => {
        const [sha, short, subject, author, at] = rec.split('\x1f')
        return { sha, short, subject, author, date: Number(at) * 1000 }
      })
  }

  async diff(path: string, staged = false): Promise<GitDiffResult> {
    await this.requireRepo()
    const rel = normalizeRel(path)
    if (!rel) throw new GitError('Choose a file to compare.', 'invalid')
    if (isSecretPath(rel)) return { path: rel, text: '', truncated: false, note: 'This looks like a credential file, so its content is never shown or committed by the app.' }
    let r: GitResult
    if (staged) {
      r = await this.run(['diff', '--cached', '--no-color', '--no-ext-diff', '--no-textconv', '--', rel], { maxBytes: MAX_DIFF_BYTES })
    } else {
      const tracked = (await this.run(['ls-files', '--error-unmatch', '--', rel], { allowFailure: true })).code === 0
      r = tracked
        ? await this.run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--', rel], { maxBytes: MAX_DIFF_BYTES })
        : await this.run(['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', '/dev/null', rel], { maxBytes: MAX_DIFF_BYTES, allowFailure: true })
    }
    const binary = /^Binary files .* differ$/m.test(r.out)
    return { path: rel, text: binary ? '' : r.out, truncated: r.truncated, note: binary ? 'Binary file: no text comparison is available.' : r.out.trim() === '' ? 'No differences.' : null }
  }

  /** Name and e-mail for commits: the user's git identity, or a clearly labelled fallback when none is configured. */
  async identityArgs(): Promise<string[]> {
    const get = async (k: string): Promise<string> => (await this.run(['config', '--get', k], { allowFailure: true })).out.trim()
    const [name, email] = await Promise.all([get('user.name'), get('user.email')])
    const args: string[] = []
    if (!name) args.push('-c', `user.name=${FALLBACK_IDENT.name}`)
    if (!email) args.push('-c', `user.email=${FALLBACK_IDENT.email}`)
    return args
  }

  /**
   * Commits the given paths (or every changed file). Hooks do not run and commits are never signed. Credential-looking files are left out
   * and reported. Other staged changes are included only when no paths were given.
   */
  async commit(message: string, paths?: string[]): Promise<GitCommitResult> {
    await this.requireRepo()
    const msg = typeof message === 'string' ? message.trim() : ''
    if (!msg) throw new GitError('A commit message is required.', 'invalid')
    if (msg.length > 5000) throw new GitError('The commit message is too long (5000 characters at most).', 'invalid')
    const status = await this.status()
    const skipped = new Set<string>()
    let chosen: string[] | null = null
    if (paths && paths.length > 0) {
      const byPath = new Map(status.files.map((f) => [f.path, f]))
      const set = new Set<string>()
      for (const p of paths) {
        const rel = normalizeRel(p)
        if (!rel) continue
        const f = byPath.get(rel)
        if (!f) continue
        if (f.secret) {
          skipped.add(rel)
          continue
        }
        set.add(rel)
        if (f.from) set.add(f.from)
      }
      chosen = [...set]
      if (chosen.length === 0) throw new GitError(skipped.size > 0 ? 'Only credential files were selected; they are never committed.' : 'None of the selected files has changes.', 'invalid')
      await this.run(['add', '-A', '--', ...chosen])
    } else {
      for (const f of status.files) if (f.secret) skipped.add(f.path)
      await this.run(['add', '-A'])
      if (skipped.size > 0) await this.unstage([...skipped], status.hasCommits)
    }
    const staged = (await this.run(['diff', '--cached', '--name-only', '-z', ...(chosen ? ['--', ...chosen] : [])], { allowFailure: true })).out.split('\0').filter(Boolean)
    if (staged.length === 0) throw new GitError('Nothing to commit.', 'invalid')
    const ident = await this.identityArgs()
    await this.run([...ident, 'commit', '--no-verify', '--no-gpg-sign', '-q', '-F', '-', ...(chosen ? ['--only', '--', ...chosen] : [])], { stdin: msg + '\n' })
    const sha = (await this.head()) as string
    return { sha, short: sha.slice(0, 7), committed: staged.length, skippedSecrets: [...skipped].sort() }
  }

  /** Removes paths from the index without touching the files. */
  async unstage(paths: string[], hasCommits: boolean): Promise<void> {
    if (paths.length === 0) return
    if (hasCommits) await this.run(['reset', '-q', 'HEAD', '--', ...paths], { allowFailure: true })
    else await this.run(['rm', '--cached', '-rq', '--ignore-unmatch', '--', ...paths], { allowFailure: true })
  }

  async branches(): Promise<GitBranchInfo[]> {
    await this.requireRepo()
    const r = await this.run(['for-each-ref', '--format=%(refname:short)%1f%(HEAD)', 'refs/heads'])
    const list = r.out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [name, head] = l.split('\x1f')
        return { name, current: head === '*' }
      })
    const cur = await this.branch()
    // A new repository has a branch name before its first commit, but no ref yet.
    if (cur.name && !list.some((b) => b.name === cur.name)) list.unshift({ name: cur.name, current: true })
    return list
  }

  async switchBranch(name: string, create = false): Promise<GitStatus> {
    await this.requireRepo()
    const n = typeof name === 'string' ? name.trim() : ''
    if (!n || n.startsWith('-')) throw new GitError('Enter a branch name.', 'invalid')
    const ok = await this.run(['check-ref-format', '--branch', n], { allowFailure: true })
    if (ok.code !== 0) throw new GitError(`"${n}" is not a valid branch name.`, 'invalid')
    const hasCommits = (await this.head()) !== null
    if (!hasCommits) {
      if (!create) throw new GitError('There are no commits yet, so there is no other branch to switch to.', 'invalid')
      await this.run(['symbolic-ref', 'HEAD', `refs/heads/${n}`])
    } else {
      // switch (unlike checkout) never discards local changes: it stops instead.
      await this.run(['switch', '--no-guess', ...(create ? ['-c'] : []), n])
    }
    return this.status()
  }
}

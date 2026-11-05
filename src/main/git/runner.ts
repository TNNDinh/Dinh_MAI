import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizedEnv } from '../workspace/commands'

export type GitErrorCode = 'missing' | 'not_repo' | 'failed' | 'invalid' | 'timeout'

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: GitErrorCode
  ) {
    super(message)
    this.name = 'GitError'
  }
}

export interface GitResult {
  code: number
  stdout: Buffer
  stderr: string
  /** More output than the cap arrived; the extra was dropped. */
  truncated: boolean
  /** stdout as text. */
  out: string
}

export interface GitRunOptions {
  stdin?: string | Buffer
  env?: Record<string, string>
  timeoutMs?: number
  /** Output kept per stream (default 8 MB). */
  maxBytes?: number
  /** Do not throw on a non-zero exit (the caller inspects `code`). */
  allowFailure?: boolean
}

/** A folder that never exists: git finds no hooks there, so a repository's own hooks cannot run code through us. */
const NO_HOOKS = join(tmpdir(), 'mads-no-git-hooks')

/**
 * Settings applied to every git call. Hooks, the file-system monitor, credential helpers and prompts are switched off so that opening a repository
 * that someone else configured cannot run programs or hang waiting for input. Nothing here talks to a remote.
 */
const SAFE_CONFIG = [
  '-c', `core.hooksPath=${NO_HOOKS}`,
  '-c', 'core.fsmonitor=false',
  '-c', 'core.quotepath=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'credential.helper=',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false'
]

/** Environment for git: no inherited GIT_* overrides (a stray GIT_DIR would point git at another repository). */
export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = sanitizedEnv()
  for (const k of Object.keys(env)) if (/^GIT_/i.test(k)) delete env[k]
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C', ...extra }
}

/** Runs `git <args>` in `cwd`. Rejects with GitError when git is missing, times out, or (unless allowFailure) exits non-zero. */
export function runGit(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
  const max = opts.maxBytes ?? 8_000_000
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('git', [...SAFE_CONFIG, ...args], { cwd, env: gitEnv(opts.env), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      reject(new GitError(`git could not be started: ${e instanceof Error ? e.message : String(e)}`, 'missing'))
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outSize = 0
    let errSize = 0
    let truncated = false
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      done(() => reject(new GitError(`git ${args[0] ?? ''} took longer than ${Math.round((opts.timeoutMs ?? 60_000) / 1000)} seconds and was stopped.`, 'timeout')))
    }, opts.timeoutMs ?? 60_000)
    child.stdout.on('data', (b: Buffer) => {
      if (outSize < max) {
        out.push(b)
        outSize += b.length
      } else truncated = true
    })
    child.stderr.on('data', (b: Buffer) => {
      if (errSize < 64_000) {
        err.push(b)
        errSize += b.length
      }
    })
    child.on('error', (e: NodeJS.ErrnoException) => {
      done(() => reject(new GitError(e.code === 'ENOENT' ? 'git is not installed or is not on the PATH.' : `git could not be started: ${e.message}`, 'missing')))
    })
    child.on('close', (code) => {
      done(() => {
        const stdout = Buffer.concat(out)
        const stderr = Buffer.concat(err).toString('utf8').trim()
        const res: GitResult = { code: code ?? -1, stdout, stderr, truncated, out: stdout.toString('utf8') }
        if (res.code !== 0 && !opts.allowFailure) {
          const first = (stderr || res.out).split(/\r?\n/).find((l) => l.trim()) ?? `exit code ${res.code}`
          reject(new GitError(`git ${args[0] ?? ''} failed: ${first}`, /not a git repository/i.test(stderr) ? 'not_repo' : 'failed'))
        } else resolve(res)
      })
    })
    child.stdin.on('error', () => undefined)
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin)
    else child.stdin.end()
  })
}

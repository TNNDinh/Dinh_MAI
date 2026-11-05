import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isSecretPath, normalizeRel } from '../workspace/sandbox'
import { FALLBACK_IDENT, type GitRepo } from './repo'
import { GitError } from './runner'

export const CHECKPOINT_REF_PREFIX = 'refs/mads/checkpoints/'

export interface Snapshot {
  /** Commit that holds the snapshot (not reachable from any branch). */
  sha: string
  tree: string
  /** Every file captured (project-relative, forward slashes). Credential files and ignored files are not part of a snapshot. */
  files: string[]
}

const split = (s: string): string[] => s.split('\0').filter(Boolean)

/**
 * Builds a throw-away index (never the real one) holding the working tree as it is now: what HEAD tracks plus every file that is not ignored.
 * The real index, the branch and the history stay untouched, so taking a snapshot is invisible to the user's own git use.
 */
async function withTempIndex<T>(repo: GitRepo, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const file = join(tmpdir(), `mads-index-${randomUUID()}`)
  try {
    return await fn({ GIT_INDEX_FILE: file })
  } finally {
    await fsp.rm(file, { force: true }).catch(() => undefined)
    await fsp.rm(file + '.lock', { force: true }).catch(() => undefined)
  }
}

export async function takeSnapshot(repo: GitRepo, refName: string, label: string): Promise<Snapshot> {
  await repo.requireRepo()
  return withTempIndex(repo, async (env) => {
    const head = await repo.head()
    if (head) await repo.run(['read-tree', head], { env })
    await repo.run(['add', '-A'], { env, timeoutMs: 300_000 })
    let files = split((await repo.run(['ls-files', '-z'], { env })).out)
    const secrets = files.filter(isSecretPath)
    if (secrets.length > 0) {
      await repo.run(['rm', '--cached', '-rq', '--ignore-unmatch', '--', ...secrets], { env })
      const drop = new Set(secrets)
      files = files.filter((f) => !drop.has(f))
    }
    const tree = (await repo.run(['write-tree'], { env })).out.trim()
    const commit = (
      await repo.run(['commit-tree', tree, '-m', label], {
        env: { ...env, GIT_AUTHOR_NAME: FALLBACK_IDENT.name, GIT_AUTHOR_EMAIL: FALLBACK_IDENT.email, GIT_COMMITTER_NAME: FALLBACK_IDENT.name, GIT_COMMITTER_EMAIL: FALLBACK_IDENT.email }
      })
    ).out.trim()
    await repo.run(['update-ref', CHECKPOINT_REF_PREFIX + refName, commit])
    return { sha: commit, tree, files }
  })
}

export async function dropSnapshotRef(repo: GitRepo, refName: string): Promise<void> {
  await repo.run(['update-ref', '-d', CHECKPOINT_REF_PREFIX + refName], { allowFailure: true })
}

export async function snapshotExists(repo: GitRepo, sha: string): Promise<boolean> {
  return (await repo.run(['cat-file', '-e', `${sha}^{commit}`], { allowFailure: true })).code === 0
}

export async function snapshotFiles(repo: GitRepo, sha: string): Promise<string[]> {
  return split((await repo.run(['ls-tree', '-r', '-z', '--name-only', sha])).out)
}

/**
 * Puts the working tree back to `sha`: files in the snapshot are rewritten, and files that exist now but are not in it are deleted.
 * `currentTree` is the tree of a snapshot taken a moment ago; comparing against it finds exactly what differs.
 * Ignored files (node_modules, build output) and credential files are never touched.
 */
export async function restoreSnapshot(repo: GitRepo, sha: string, currentTree: string): Promise<{ restored: number; removed: number; written: string[]; deleted: string[] }> {
  if (!(await snapshotExists(repo, sha))) throw new GitError('That checkpoint no longer exists in the repository (it may have been removed by git gc or by hand).', 'failed')
  // Only what differs is touched, so files that did not change keep their timestamps (dev servers and watchers stay quiet).
  const diff = split((await repo.run(['diff-tree', '-r', '-z', '--name-status', '--no-renames', currentTree, sha])).out)
  const write: string[] = []
  const gone: string[] = []
  for (let i = 0; i + 1 < diff.length; i += 2) {
    const path = diff[i + 1]
    if (isSecretPath(path)) continue
    if (diff[i] === 'D') gone.push(path)
    else write.push(path)
  }
  if (write.length > 0) {
    await withTempIndex(repo, async (env) => {
      await repo.run(['read-tree', sha], { env })
      await repo.run(['checkout-index', '-f', '-z', '--stdin'], { env, stdin: write.join('\0') + '\0', timeoutMs: 300_000 })
    })
  }
  let removed = 0
  const dirs = new Set<string>()
  for (const f of gone) {
    if (isSecretPath(f)) continue
    let rel: string
    try {
      rel = normalizeRel(f)
    } catch {
      continue
    }
    if (!rel) continue
    try {
      await fsp.rm(join(repo.root, rel))
      removed++
      dirs.add(dirname(rel))
    } catch {
      /* already gone */
    }
  }
  // Folders left empty by the deletions go too (deepest first), but never the project folder itself.
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    let cur = d
    while (cur && cur !== '.' && cur !== '/') {
      try {
        await fsp.rmdir(join(repo.root, cur))
      } catch {
        break
      }
      cur = dirname(cur)
    }
  }
  return { restored: write.length, removed, written: write, deleted: gone }
}

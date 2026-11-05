import type { Checkpoint, GitBranchInfo, GitCommitInfo, GitCommitInput, GitCommitResult, GitDiffInput, GitDiffResult, GitStatus, RestoreResult } from '../../shared/ipc'
import type { Database } from '../db/database'
import type { EventService } from '../services/events'
import type { WorkspaceService } from '../workspace/workspace'
import { CheckpointService, type CreateCheckpointInput } from './checkpoints'
import { GitRepo } from './repo'
import { GitError } from './runner'

const MAX_NOTIFY = 300

/** Project-aware git: finds the project's folder, keeps the file tree and open editors in step after changes, and refuses risky moves while agents work. */
export class GitService {
  readonly checkpoints: CheckpointService

  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly workspace: WorkspaceService
  ) {
    this.checkpoints = new CheckpointService(db, events, (id) => this.repo(id), {
      onRestored: (projectId, written, deleted) => {
        for (const p of written.slice(0, MAX_NOTIFY)) this.workspace.notify({ projectId, path: p, kind: 'write', by: 'agent' })
        for (const p of deleted.slice(0, MAX_NOTIFY)) this.workspace.notify({ projectId, path: p, kind: 'remove', by: 'agent' })
      }
    })
  }

  repo(projectId: string): GitRepo {
    return new GitRepo(this.workspace.sandbox(projectId).root)
  }

  /** A run is working on this project: its files are in flux, so wholesale rewrites (restore, branch switch) would fight it. */
  private assertIdle(projectId: string, what: string): void {
    const busy = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND status = 'running'`, projectId)
    if (busy && busy.n > 0) throw new GitError(`${what} is not possible while a run is working on this project. Stop the run first.`, 'invalid')
  }

  status(projectId: string): Promise<GitStatus> {
    return this.repo(projectId).status()
  }

  async init(projectId: string): Promise<GitStatus> {
    const s = await this.repo(projectId).init()
    this.events.record({ projectId, type: 'git.init', message: 'Git repository initialised' })
    return s
  }

  log(projectId: string, limit?: number): Promise<GitCommitInfo[]> {
    return this.repo(projectId).log(limit)
  }

  diff(input: GitDiffInput): Promise<GitDiffResult> {
    return this.repo(input.projectId).diff(input.path, input.staged === true)
  }

  async commit(input: GitCommitInput): Promise<GitCommitResult> {
    const res = await this.repo(input.projectId).commit(input.message, input.paths)
    this.events.record({ projectId: input.projectId, type: 'git.commit', message: `Committed ${res.committed} file(s) as ${res.short}: ${input.message.trim().split('\n')[0].slice(0, 100)}`, data: { sha: res.sha } })
    return res
  }

  branches(projectId: string): Promise<GitBranchInfo[]> {
    return this.repo(projectId).branches()
  }

  async switchBranch(projectId: string, branch: string, create = false): Promise<GitStatus> {
    this.assertIdle(projectId, 'Switching branches')
    const repo = this.repo(projectId)
    const before = await repo.head()
    const s = await repo.switchBranch(branch, create)
    this.events.record({ projectId, type: 'git.switch', message: `${create ? 'Created and switched to' : 'Switched to'} branch ${s.branch}` })
    if (before && s.head && before !== s.head) {
      const changed = (await repo.run(['diff', '--name-only', '-z', '--no-renames', before, s.head], { allowFailure: true })).out.split('\0').filter(Boolean)
      for (const p of changed.slice(0, MAX_NOTIFY)) this.workspace.notify({ projectId, path: p, kind: 'write', by: 'agent' })
    }
    return s
  }

  // ------------------------------------------------------------------ checkpoints

  listCheckpoints(projectId: string): Checkpoint[] {
    this.workspace.project(projectId)
    return this.checkpoints.list(projectId)
  }

  createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint> {
    this.workspace.project(input.projectId)
    return this.checkpoints.create(input)
  }

  restoreCheckpoint(id: string): Promise<RestoreResult> {
    const cp = this.checkpoints.get(id)
    if (!cp) throw new GitError('Checkpoint not found.', 'invalid')
    this.assertIdle(cp.projectId, 'Restoring a checkpoint')
    return this.checkpoints.restore(id)
  }

  removeCheckpoint(id: string): Promise<void> {
    return this.checkpoints.remove(id)
  }
}

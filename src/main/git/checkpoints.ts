import { randomUUID } from 'node:crypto'
import type { Checkpoint, RestoreResult } from '../../shared/ipc'
import type { Database } from '../db/database'
import type { EventService } from '../services/events'
import { GitRepo } from './repo'
import { GitError } from './runner'
import { dropSnapshotRef, restoreSnapshot, takeSnapshot } from './snapshot'

interface Row {
  id: string
  project_id: string
  run_id: string | null
  task_id: string | null
  git_ref: string
  branch: string | null
  label: string
  kind: Checkpoint['kind']
  file_count: number
  created_at: number
}

const toCheckpoint = (r: Row): Checkpoint => ({
  id: r.id,
  projectId: r.project_id,
  runId: r.run_id,
  taskId: r.task_id,
  label: r.label,
  gitRef: r.git_ref,
  branch: r.branch,
  kind: r.kind,
  fileCount: r.file_count,
  createdAt: r.created_at
})

/** Snapshots older than the newest N of each automatic kind are dropped, so a long project does not pile up commits. */
export const KEEP_AUTO = 25
export const KEEP_SAFETY = 10

export interface CreateCheckpointInput {
  projectId: string
  label?: string
  kind?: Checkpoint['kind']
  runId?: string | null
  taskId?: string | null
}

/**
 * Checkpoints: named snapshots of a project's files that can be put back. They are commits under refs/mads/checkpoints/, so they never show up
 * in the branch history, the index or `git status`, and the app records them in its own database.
 */
export class CheckpointService {
  /** One snapshot or restore at a time per project: both rewrite things and must not interleave. */
  private readonly busy = new Map<string, Promise<unknown>>()

  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly repoFor: (projectId: string) => GitRepo,
    private readonly opts: { now?: () => number; onRestored?: (projectId: string, written: string[], deleted: string[]) => void } = {}
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  private serial<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.busy.get(projectId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    this.busy.set(projectId, next)
    void next.finally(() => {
      if (this.busy.get(projectId) === next) this.busy.delete(projectId)
    }).catch(() => undefined)
    return next
  }

  list(projectId: string): Checkpoint[] {
    return this.db.all<Row>(`SELECT * FROM checkpoints WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`, projectId).map(toCheckpoint)
  }

  get(id: string): Checkpoint | null {
    const r = this.db.get<Row>(`SELECT * FROM checkpoints WHERE id = ?`, id)
    return r ? toCheckpoint(r) : null
  }

  create(input: CreateCheckpointInput): Promise<Checkpoint> {
    return this.serial(input.projectId, () => this.createNow(input))
  }

  private async createNow(input: CreateCheckpointInput): Promise<Checkpoint> {
    const repo = this.repoFor(input.projectId)
    const kind = input.kind ?? 'manual'
    const label = (input.label ?? '').trim().slice(0, 200) || (kind === 'manual' ? 'Manual checkpoint' : kind === 'auto' ? 'Before an agent task' : 'Before restore')
    const id = randomUUID()
    const snap = await takeSnapshot(repo, id, `Checkpoint: ${label}`)
    const branch = (await repo.branch()).name
    const createdAt = this.now()
    this.db.run(
      `INSERT INTO checkpoints (id, project_id, run_id, task_id, git_ref, branch, label, kind, file_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.projectId,
      input.runId ?? null,
      input.taskId ?? null,
      snap.sha,
      branch,
      label,
      kind,
      snap.files.length,
      createdAt
    )
    this.events.record({ projectId: input.projectId, runId: input.runId ?? null, type: 'checkpoint.created', message: `Checkpoint "${label}" saved (${snap.files.length} files)`, data: { id, kind } })
    await this.prune(input.projectId, kind)
    return this.get(id) as Checkpoint
  }

  private async prune(projectId: string, kind: Checkpoint['kind']): Promise<void> {
    if (kind === 'manual') return
    const keep = kind === 'auto' ? KEEP_AUTO : KEEP_SAFETY
    const old = this.db.all<Row>(`SELECT * FROM checkpoints WHERE project_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`, projectId, kind, keep)
    for (const r of old) await this.removeNow(r)
  }

  private async removeNow(r: Row): Promise<void> {
    await dropSnapshotRef(this.repoFor(r.project_id), r.id).catch(() => undefined)
    this.db.run(`DELETE FROM checkpoints WHERE id = ?`, r.id)
  }

  remove(id: string): Promise<void> {
    const r = this.db.get<Row>(`SELECT * FROM checkpoints WHERE id = ?`, id)
    if (!r) return Promise.resolve()
    return this.serial(r.project_id, () => this.removeNow(r))
  }

  /** Puts the project's files back to the checkpoint. A 'safety' checkpoint of the present state is taken first, so a restore can itself be undone. */
  restore(id: string): Promise<RestoreResult> {
    const r = this.db.get<Row>(`SELECT * FROM checkpoints WHERE id = ?`, id)
    if (!r) throw new GitError('Checkpoint not found.', 'invalid')
    return this.serial(r.project_id, async () => {
      const repo = this.repoFor(r.project_id)
      const safetyId = randomUUID()
      const safety = await takeSnapshot(repo, safetyId, `Safety: before restoring "${r.label}"`)
      const branch = (await repo.branch()).name
      this.db.run(
        `INSERT INTO checkpoints (id, project_id, run_id, task_id, git_ref, branch, label, kind, file_count, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, 'safety', ?, ?)`,
        safetyId,
        r.project_id,
        safety.sha,
        branch,
        `Before restoring "${r.label}"`,
        safety.files.length,
        this.now()
      )
      const res = await restoreSnapshot(repo, r.git_ref, safety.tree)
      this.events.record({
        projectId: r.project_id,
        level: 'warn',
        type: 'checkpoint.restored',
        message: `Restored "${r.label}": ${res.restored} file(s) written, ${res.removed} removed`,
        data: { id, safetyCheckpointId: safetyId }
      })
      await this.prune(r.project_id, 'safety')
      this.opts.onRestored?.(r.project_id, res.written, res.deleted)
      return { restored: res.restored, removed: res.removed, safetyCheckpointId: safetyId }
    })
  }
}

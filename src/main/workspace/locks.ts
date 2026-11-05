import type { Database, SqlValue } from '../db/database'

export const LOCK_LEASE_MS = 10 * 60_000

export interface FileLock {
  projectId: string
  path: string
  agentId: string
  agentName: string | null
  taskId: string | null
  taskTitle: string | null
  acquiredAt: number
  expiresAt: number
}

export class FileLockedError extends Error {
  constructor(
    readonly path: string,
    readonly holder: FileLock
  ) {
    super(
      `“${path}” is locked by ${holder.agentName ?? 'another agent'}${holder.taskTitle ? ` (task “${holder.taskTitle}”)` : ''}. ` +
        `It is released when that task ends (or at ${new Date(holder.expiresAt).toLocaleTimeString()} at the latest). Work on something else or describe the change you need in your report.`
    )
    this.name = 'FileLockedError'
  }
}

const IS_WINDOWS = process.platform === 'win32'
/** Windows paths are case-insensitive, so `Src/A.ts` and `src/a.ts` must contend for the same lock. */
const keyOf = (path: string): string => (IS_WINDOWS ? path.toLowerCase() : path)

interface LockRow {
  project_id: string
  path: string
  agent_id: string
  task_id: string | null
  acquired_at: number
  expires_at: number
  agent_name: string | null
  task_title: string | null
}

const toLock = (r: LockRow): FileLock => ({
  projectId: r.project_id,
  path: r.path,
  agentId: r.agent_id,
  agentName: r.agent_name,
  taskId: r.task_id,
  taskTitle: r.task_title,
  acquiredAt: r.acquired_at,
  expiresAt: r.expires_at
})

/**
 * Pessimistic write locks: an agent that writes a file holds it until its task ends, so two agents never edit
 * the same file at once. Leases expire so a crash cannot deadlock a file. All methods are synchronous and run
 * in a single transaction, which makes check-and-take atomic.
 */
export class FileLocks {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now
  ) {}

  private select(where: string, ...params: SqlValue[]): LockRow[] {
    return this.db.all<LockRow>(
      `SELECT l.*, a.name AS agent_name, t.title AS task_title
         FROM file_locks l LEFT JOIN agents a ON a.id = l.agent_id LEFT JOIN tasks t ON t.id = l.task_id
        WHERE ${where} ORDER BY l.acquired_at`,
      ...params
    )
  }

  /** Takes (or renews) the lock for this agent. Throws FileLockedError when another agent holds a live lock. */
  acquire(projectId: string, path: string, agentId: string, taskId: string | null, leaseMs = LOCK_LEASE_MS): void {
    const key = keyOf(path)
    this.db.transaction(() => {
      const t = this.now()
      const row = this.select(`l.project_id = ? AND l.path = ?`, projectId, key)[0]
      if (row && row.expires_at > t && row.agent_id !== agentId) throw new FileLockedError(path, toLock(row))
      this.db.run(
        `INSERT INTO file_locks (project_id, path, agent_id, task_id, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, path) DO UPDATE SET agent_id = excluded.agent_id, task_id = excluded.task_id,
           acquired_at = CASE WHEN file_locks.agent_id = excluded.agent_id THEN file_locks.acquired_at ELSE excluded.acquired_at END,
           expires_at = excluded.expires_at`,
        projectId, key, agentId, taskId, t, t + leaseMs
      )
    })
  }

  /** The live lock on a path held by someone other than `exceptAgentId`, if any. */
  heldByOther(projectId: string, path: string, exceptAgentId: string | null = null): FileLock | null {
    const row = this.select(`l.project_id = ? AND l.path = ? AND l.expires_at > ?`, projectId, keyOf(path), this.now())[0]
    return row && row.agent_id !== exceptAgentId ? toLock(row) : null
  }

  list(projectId: string): FileLock[] {
    this.db.run(`DELETE FROM file_locks WHERE expires_at <= ?`, this.now())
    return this.select(`l.project_id = ?`, projectId).map(toLock)
  }

  release(projectId: string, path: string): boolean {
    return this.db.run(`DELETE FROM file_locks WHERE project_id = ? AND path = ?`, projectId, keyOf(path)).changes > 0
  }

  releaseTask(taskId: string): number {
    return this.db.run(`DELETE FROM file_locks WHERE task_id = ?`, taskId).changes
  }

  /** Called at startup: no task can still be running, so every lock is stale. */
  clearAll(): number {
    return this.db.run(`DELETE FROM file_locks`).changes
  }
}

import type { Database } from '../db/database'
import type { TaskRecovery, RecoveryTask } from '../orchestrator/orchestrator'
import type { EventService } from '../services/events'
import type { WorkspaceService } from '../workspace/workspace'
import type { GitService } from './service'

const list = (files: string[]): string => (files.length <= 5 ? files.join(', ') : `${files.slice(0, 5).join(', ')} and ${files.length - 5} more`)

/**
 * Auto Recovery (opt-in per project). Before an agent task starts it saves an automatic checkpoint (when the project is a git repository) and starts
 * an undo journal; when the task fails, the files it changed through the write/delete tools are put back before the retry. Cancelling a run is not a
 * failure: the user stopped it, so nothing is rolled back.
 *
 * Limits, stated plainly: only changes made by the file tools are undone (not what a shell command did), and only a failed task triggers it
 * (the orchestrator does not judge the quality of a task that finished without an error).
 */
export class AutoRecovery implements TaskRecovery {
  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly git: GitService,
    private readonly workspace: WorkspaceService
  ) {}

  enabled(projectId: string): boolean {
    return this.db.get<{ a: number }>(`SELECT auto_recovery AS a FROM projects WHERE id = ?`, projectId)?.a === 1
  }

  async begin(t: RecoveryTask): Promise<void> {
    if (!this.enabled(t.projectId)) return
    this.workspace.beginJournal(t.taskId)
    try {
      if (!(await this.git.status(t.projectId)).isRepo) return
      await this.git.checkpoints.create({ projectId: t.projectId, label: `Before “${t.title}”`.slice(0, 120), kind: 'auto', runId: t.runId, taskId: t.taskId })
    } catch (e) {
      // A checkpoint is a safety net, never a reason to stop the work.
      this.events.record({
        projectId: t.projectId,
        runId: t.runId,
        level: 'warn',
        type: 'recovery.checkpoint_failed',
        message: `Could not save a checkpoint before “${t.title}”: ${e instanceof Error ? e.message : String(e)}`
      })
    }
  }

  async rollback(t: RecoveryTask, reason: string): Promise<{ restored: number; removed: number; skipped: number } | null> {
    if (!this.enabled(t.projectId)) return null
    try {
      const r = await this.workspace.rollbackJournal(t.projectId, t.taskId)
      const changed = r.restored.length + r.removed.length
      if (changed === 0 && r.skipped.length === 0) return { restored: 0, removed: 0, skipped: 0 }
      this.events.record({
        projectId: t.projectId,
        runId: t.runId,
        level: 'warn',
        type: 'recovery.rolled_back',
        message:
          `Auto Recovery undid ${changed} file change${changed === 1 ? '' : 's'} of “${t.title}” after it failed (${reason.slice(0, 120)})` +
          (r.restored.length ? `; restored: ${list(r.restored)}` : '') +
          (r.removed.length ? `; removed: ${list(r.removed)}` : '') +
          (r.skipped.length ? `; left as they are (too large to copy, or changed by someone else): ${list(r.skipped)}` : '')
      })
      return { restored: r.restored.length, removed: r.removed.length, skipped: r.skipped.length }
    } catch (e) {
      this.events.record({ projectId: t.projectId, runId: t.runId, level: 'error', type: 'recovery.failed', message: `Auto Recovery could not undo the changes of “${t.title}”: ${e instanceof Error ? e.message : String(e)}` })
      return null
    }
  }

  end(taskId: string): void {
    this.workspace.endJournal(taskId)
  }
}

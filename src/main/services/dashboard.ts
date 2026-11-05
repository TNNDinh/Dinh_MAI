import type { DashboardStats, ProjectProgress, ProjectStatus, ProjectType, UsageTotals } from '../../shared/ipc'
import type { Database } from '../db/database'

function startOfLocalDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export class DashboardService {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now
  ) {}

  private usage(since: number): UsageTotals {
    const r = this.db.get<{ calls: number; input: number; output: number; cost: number; unpriced: number }>(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0)  AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(cost_usd), 0)      AS cost,
              COALESCE(SUM(CASE WHEN cost_usd IS NULL AND status = 'ok' THEN 1 ELSE 0 END), 0) AS unpriced
       FROM llm_calls WHERE created_at >= ?`,
      since
    )!
    return { callCount: r.calls, inputTokens: r.input, outputTokens: r.output, costUsd: r.cost, unpricedCalls: r.unpriced }
  }

  stats(): DashboardStats {
    const db = this.db
    const count = (sql: string) => db.get<{ c: number }>(sql)!.c

    const projectProgress = db
      .all<{ id: string; name: string; type: ProjectType; status: ProjectStatus; progress: number; done: number; total: number }>(
        `SELECT p.id, p.name, p.type, p.status, p.progress,
                COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done,
                COUNT(t.id) AS total
         FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
         GROUP BY p.id ORDER BY p.updated_at DESC`
      )
      .map(
        (r): ProjectProgress => ({
          id: r.id,
          name: r.name,
          type: r.type,
          status: r.status,
          // Derived from the task board when there is one; otherwise the stored value.
          progress: r.total > 0 ? r.done / r.total : r.progress,
          tasksDone: r.done,
          tasksTotal: r.total
        })
      )

    return {
      projects: {
        active: count(`SELECT COUNT(*) c FROM projects WHERE status = 'active'`),
        completed: count(`SELECT COUNT(*) c FROM projects WHERE status = 'completed'`),
        total: count(`SELECT COUNT(*) c FROM projects`)
      },
      agents: {
        total: count(`SELECT COUNT(*) c FROM agents`),
        working: count(`SELECT COUNT(*) c FROM agents WHERE status = 'working'`)
      },
      tasks: {
        pending: count(`SELECT COUNT(*) c FROM tasks WHERE status IN ('todo', 'blocked')`),
        inProgress: count(`SELECT COUNT(*) c FROM tasks WHERE status IN ('in_progress', 'review', 'testing')`),
        failed: count(`SELECT COUNT(*) c FROM tasks WHERE status = 'failed'`),
        done: count(`SELECT COUNT(*) c FROM tasks WHERE status = 'done'`)
      },
      connections: {
        total: count(`SELECT COUNT(*) c FROM provider_connections`),
        ok: count(`SELECT COUNT(*) c FROM provider_connections WHERE status = 'ok'`),
        error: count(`SELECT COUNT(*) c FROM provider_connections WHERE status = 'error'`)
      },
      usage: { total: this.usage(0), today: this.usage(startOfLocalDay(this.now())) },
      projectProgress
    }
  }
}

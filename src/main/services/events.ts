import type { ActivityEvent, EventLevel, RecentEventsQuery } from '../../shared/ipc'
import type { Database } from '../db/database'

const LEVEL_ORDER: Record<EventLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface RecordEventInput {
  projectId?: string | null
  runId?: string | null
  agentId?: string | null
  level?: EventLevel
  /** Dotted identifier, e.g. `project.created`, `agent.started`. */
  type: string
  message: string
  data?: unknown
}

interface EventRow {
  id: number
  project_id: string | null
  run_id: string | null
  agent_id: string | null
  level: EventLevel
  type: string
  message: string
  created_at: number
}

const toEvent = (r: EventRow): ActivityEvent => ({
  id: r.id,
  projectId: r.project_id,
  runId: r.run_id,
  agentId: r.agent_id,
  level: r.level,
  type: r.type,
  message: r.message,
  createdAt: r.created_at
})

/** Persists the activity feed / application log and fans new events out to listeners (the UI). */
export class EventService {
  private readonly listeners = new Set<(e: ActivityEvent) => void>()

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now
  ) {}

  record(input: RecordEventInput): ActivityEvent {
    const createdAt = this.now()
    const r = this.db.run(
      `INSERT INTO events (project_id, run_id, agent_id, level, type, message, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      input.projectId ?? null,
      input.runId ?? null,
      input.agentId ?? null,
      input.level ?? 'info',
      input.type,
      input.message,
      input.data === undefined ? null : JSON.stringify(input.data),
      createdAt
    )
    const event: ActivityEvent = {
      id: Number(r.lastInsertRowid),
      projectId: input.projectId ?? null,
      runId: input.runId ?? null,
      agentId: input.agentId ?? null,
      level: input.level ?? 'info',
      type: input.type,
      message: input.message,
      createdAt
    }
    for (const l of this.listeners) {
      try {
        l(event)
      } catch {
        /* a broken listener must never break the caller */
      }
    }
    return event
  }

  /** Newest first. */
  recent(query: RecentEventsQuery = {}): ActivityEvent[] {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 100), 1), 1000)
    const min = LEVEL_ORDER[query.minLevel ?? 'debug']
    const levels = (Object.keys(LEVEL_ORDER) as EventLevel[]).filter((l) => LEVEL_ORDER[l] >= min)
    const where = [`level IN (${levels.map(() => '?').join(',')})`]
    const params: Array<string | number> = [...levels]
    if (query.projectId) {
      where.push('project_id = ?')
      params.push(query.projectId)
    }
    return this.db
      .all<EventRow>(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...params, limit)
      .map(toEvent)
  }

  /** Keep the table bounded: retain only the newest `keep` rows. */
  prune(keep = 20_000): number {
    return this.db.run(`DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM events) - ?`, keep).changes
  }

  subscribe(listener: (e: ActivityEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

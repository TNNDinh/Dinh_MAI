import { randomUUID } from 'node:crypto'
import type { CreateTaskInput, Task, TaskDetail, TaskFilter, TaskLogEntry, TaskStatus, TeamMessage, TeamMessagesInput, UpdateTaskInput } from '../../shared/ipc'
import { TASK_STATUSES } from '../../shared/ipc'
import { getTemplate } from '../agents/templates'
import type { Database } from '../db/database'
import type { EventService } from './events'

export const MAX_TITLE = 200
export const MAX_DESCRIPTION = 8000
export const MAX_TASKS_PER_PROJECT = 500

interface TaskRow {
  id: string
  project_id: string
  run_id: string | null
  title: string
  description: string
  role: string | null
  assigned_agent_id: string | null
  agent_name: string | null
  status: TaskStatus
  priority: number
  attempts: number
  result_summary: string | null
  error: string | null
  in_tok: number
  out_tok: number
  cost: number
  created_at: number
  updated_at: number
}

const SELECT = `
  SELECT t.id, t.project_id, t.run_id, t.title, t.description, t.role, t.assigned_agent_id, a.name AS agent_name,
         t.status, t.priority, t.attempts, t.result_summary, t.error, t.created_at, t.updated_at,
         COALESCE((SELECT SUM(input_tokens)  FROM llm_calls WHERE task_id = t.id), 0) AS in_tok,
         COALESCE((SELECT SUM(output_tokens) FROM llm_calls WHERE task_id = t.id), 0) AS out_tok,
         COALESCE((SELECT SUM(cost_usd)      FROM llm_calls WHERE task_id = t.id), 0) AS cost
    FROM tasks t LEFT JOIN agents a ON a.id = t.assigned_agent_id`

export interface NewTask extends CreateTaskInput {
  runId?: string | null
}

/** The shared task board: persistence and validation. The orchestrator drives status changes through the same service. */
export class TaskService {
  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly now: () => number = Date.now
  ) {}

  list(filter: TaskFilter = {}): Task[] {
    const where: string[] = []
    const params: string[] = []
    if (filter.projectId) (where.push('t.project_id = ?'), params.push(String(filter.projectId)))
    if (filter.runId) (where.push('t.run_id = ?'), params.push(String(filter.runId)))
    const rows = this.db.all<TaskRow>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.priority, t.created_at, t.rowid LIMIT 2000`, ...params)
    return this.hydrate(rows)
  }

  get(id: string): Task | null {
    const row = this.db.get<TaskRow>(`${SELECT} WHERE t.id = ?`, id)
    return row ? this.hydrate([row])[0] : null
  }

  detail(id: string): TaskDetail | null {
    const task = this.get(id)
    if (!task) return null
    const log = this.db
      .all<{ id: string; role: TaskLogEntry['role']; agent_id: string | null; name: string | null; content: string; created_at: number }>(
        `SELECT m.id, m.role, m.agent_id, a.name, m.content, m.created_at
           FROM agent_messages m LEFT JOIN agents a ON a.id = m.agent_id
          WHERE m.task_id = ? ORDER BY m.created_at, m.rowid LIMIT 500`,
        id
      )
      .map((m) => ({ id: m.id, role: m.role, agentId: m.agent_id, agentName: m.name, content: m.content, createdAt: m.created_at }))
    return { ...task, log }
  }

  /**
   * The team conversation, newest first: what agents said (their replies, on a task or not, not the prompts, tool calls or raw tool output)
   * and the change requests they sent each other. Built from the same per-task log as the task drawer.
   */
  team(input: TeamMessagesInput = {}): TeamMessage[] {
    const limit = Number.isInteger(input.limit) ? Math.min(200, Math.max(1, input.limit as number)) : 40
    const params: Array<string | number> = []
    let scope = ''
    if (input.projectId) {
      scope = 'AND m.project_id = ?'
      params.push(String(input.projectId))
    }
    return this.db
      .all<{ id: string; role: string; project_id: string; project_name: string; task_id: string | null; title: string | null; agent_id: string | null; agent_name: string | null; content: string; created_at: number }>(
        `SELECT m.id, m.role, m.project_id, p.name AS project_name, m.task_id, t.title, m.agent_id, a.name AS agent_name, m.content, m.created_at
           FROM agent_messages m
           JOIN projects p ON p.id = m.project_id
           LEFT JOIN tasks t ON t.id = m.task_id
           LEFT JOIN agents a ON a.id = m.agent_id
          WHERE ((m.role = 'assistant' AND TRIM(m.content) <> '')
              OR (m.role = 'system' AND m.content LIKE 'Change request from%')) ${scope}
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
        ...params,
        limit
      )
      .map((m) => ({
        id: m.id,
        kind: m.role === 'system' ? ('change-request' as const) : ('reply' as const),
        projectId: m.project_id,
        projectName: m.project_name,
        taskId: m.task_id,
        taskTitle: m.title,
        agentId: m.agent_id,
        agentName: m.agent_name,
        content: m.content.length > 600 ? `${m.content.slice(0, 600)}…` : m.content,
        createdAt: m.created_at
      }))
  }

  create(input: NewTask): Task {
    const projectId = String(input.projectId ?? '')
    if (!this.db.get(`SELECT 1 FROM projects WHERE id = ?`, projectId)) throw new Error('Project not found.')
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (!title) throw new Error('Give the task a title.')
    if (title.length > MAX_TITLE) throw new Error(`The title is too long (max ${MAX_TITLE} characters).`)
    const description = typeof input.description === 'string' ? input.description.trim() : ''
    if (description.length > MAX_DESCRIPTION) throw new Error(`The description is too long (max ${MAX_DESCRIPTION} characters).`)
    const priority = input.priority === undefined ? 2 : input.priority
    if (!Number.isInteger(priority) || priority < 1 || priority > 3) throw new Error('Priority must be 1 (high), 2 or 3 (low).')
    const role = this.cleanRole(input.role)
    const agentId = this.cleanAgent(input.assignedAgentId, projectId)
    const deps = [...new Set((input.dependsOn ?? []).map(String))]
    for (const d of deps) {
      const row = this.db.get<{ project_id: string }>(`SELECT project_id FROM tasks WHERE id = ?`, d)
      if (!row || row.project_id !== projectId) throw new Error('A dependency does not exist in this project.')
    }
    const total = this.db.get<{ c: number }>(`SELECT COUNT(*) c FROM tasks WHERE project_id = ?`, projectId)!.c
    if (total >= MAX_TASKS_PER_PROJECT) throw new Error(`A project can hold at most ${MAX_TASKS_PER_PROJECT} tasks. Delete finished ones first.`)

    const id = randomUUID()
    const t = this.now()
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO tasks (id, project_id, run_id, title, description, role, assigned_agent_id, status, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
        id,
        projectId,
        input.runId ?? null,
        title,
        description,
        role,
        agentId,
        priority,
        t,
        t
      )
      for (const d of deps) this.db.run(`INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`, id, d)
    })
    this.events.record({ projectId, runId: input.runId ?? null, agentId, type: 'task.created', message: `Task “${title}” created` })
    return this.get(id)!
  }

  /** Manual edit from the board. The orchestrator owns in_progress/failed, so a running task cannot be edited. */
  update(input: UpdateTaskInput): Task {
    const cur = this.get(String(input.id))
    if (!cur) throw new Error('Task not found.')
    if (cur.status === 'in_progress') throw new Error('This task is running. Stop the run before editing it.')
    const sets: string[] = []
    const params: Array<string | number | null> = []
    if (input.title !== undefined) {
      const title = String(input.title).trim()
      if (!title) throw new Error('Give the task a title.')
      if (title.length > MAX_TITLE) throw new Error(`The title is too long (max ${MAX_TITLE} characters).`)
      sets.push('title = ?')
      params.push(title)
    }
    if (input.description !== undefined) {
      const d = String(input.description).trim()
      if (d.length > MAX_DESCRIPTION) throw new Error(`The description is too long (max ${MAX_DESCRIPTION} characters).`)
      sets.push('description = ?')
      params.push(d)
    }
    if (input.priority !== undefined) {
      if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 3) throw new Error('Priority must be 1 (high), 2 or 3 (low).')
      sets.push('priority = ?')
      params.push(input.priority)
    }
    if (input.role !== undefined) (sets.push('role = ?'), params.push(this.cleanRole(input.role)))
    if (input.assignedAgentId !== undefined) (sets.push('assigned_agent_id = ?'), params.push(this.cleanAgent(input.assignedAgentId, cur.projectId)))
    if (input.status !== undefined) {
      if (input.status !== 'todo' && input.status !== 'blocked' && input.status !== 'done') throw new Error('Tasks can only be moved to To do, Blocked or Done by hand.')
      sets.push('status = ?')
      params.push(input.status)
      if (input.status === 'todo') sets.push('attempts = 0', 'error = NULL')
    }
    if (sets.length === 0) return cur
    sets.push('updated_at = ?')
    params.push(this.now())
    this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params, cur.id)
    const next = this.get(cur.id)!
    this.events.record({
      projectId: cur.projectId,
      runId: cur.runId,
      agentId: next.assignedAgentId,
      type: 'task.updated',
      message: input.status ? `Task “${next.title}” moved to ${input.status} by hand` : `Task “${next.title}” edited`
    })
    return next
  }

  remove(id: string): void {
    const cur = this.get(String(id))
    if (!cur) return
    if (cur.status === 'in_progress') throw new Error('This task is running. Stop the run before deleting it.')
    this.db.run(`DELETE FROM tasks WHERE id = ?`, cur.id)
    this.events.record({ projectId: cur.projectId, runId: cur.runId, type: 'task.deleted', message: `Task “${cur.title}” deleted` })
  }

  // ------------------------------------------------------------------ helpers

  private cleanRole(role: string | null | undefined): string | null {
    if (role === undefined || role === null || role === '') return null
    const r = String(role)
    if (!getTemplate(r)) throw new Error(`Unknown role “${r}”.`)
    return r
  }

  private cleanAgent(agentId: string | null | undefined, projectId: string): string | null {
    if (agentId === undefined || agentId === null || agentId === '') return null
    const a = this.db.get<{ project_id: string | null }>(`SELECT project_id FROM agents WHERE id = ?`, String(agentId))
    if (!a) throw new Error('Agent not found.')
    if (a.project_id !== projectId) throw new Error('Only agents from this project’s team can be assigned.')
    return String(agentId)
  }

  private hydrate(rows: TaskRow[]): Task[] {
    if (rows.length === 0) return []
    const ids = new Set(rows.map((r) => r.id))
    const deps = new Map<string, string[]>()
    const projects = [...new Set(rows.map((r) => r.project_id))]
    for (const p of projects) {
      for (const d of this.db.all<{ task_id: string; depends_on_task_id: string }>(
        `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE t.project_id = ?`,
        p
      )) {
        if (!ids.has(d.task_id)) continue
        ;(deps.get(d.task_id) ?? deps.set(d.task_id, []).get(d.task_id)!).push(d.depends_on_task_id)
      }
    }
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      runId: r.run_id,
      title: r.title,
      description: r.description,
      role: r.role,
      assignedAgentId: r.assigned_agent_id,
      assignedAgentName: r.agent_name,
      status: TASK_STATUSES.includes(r.status) ? r.status : 'todo',
      priority: r.priority,
      attempts: r.attempts,
      dependsOn: deps.get(r.id) ?? [],
      resultSummary: r.result_summary,
      error: r.error,
      inputTokens: r.in_tok,
      outputTokens: r.out_tok,
      costUsd: r.cost,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  }
}

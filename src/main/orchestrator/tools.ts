import { randomUUID } from 'node:crypto'
import type { Agent } from '../../shared/ipc'
import type { Database } from '../db/database'
import type { AssetService } from '../assets/service'
import type { ToolDefinition } from '../providers/types'
import type { EventService } from '../services/events'
import type { TaskService } from '../services/tasks'
import type { CommandService } from '../workspace/commands'
import type { WorkspaceService } from '../workspace/workspace'
import { ASSET_TOOLS } from './asset-tools'
import { WORKSPACE_TOOLS } from './file-tools'

export const MEMORY_KINDS = ['decision', 'design_doc', 'convention', 'summary', 'note'] as const
export const MAX_MEMORY_CONTENT = 60_000
export const MAX_TASKS_PER_RUN = 60
const READ_LIMIT = 30_000

/** What a tool can touch. Built per task by the orchestrator. */
export interface ToolContext {
  db: Database
  events: EventService
  tasks: TaskService
  agent: Agent
  projectId: string
  runId: string
  taskId: string
  /** Set by tools that need the orchestrator to act after the current task ends. */
  state: { reworkRequested: boolean }
  /** Present when the orchestrator was given a workspace: enables the file and command tools. */
  workspace?: WorkspaceService
  commands?: CommandService
  /** Present when the app can generate pictures. */
  assets?: AssetService
  /** The team's working image model (from its Image Generator agent); null when the team has none. */
  imageTarget?: { connectionId: string; model: string; agentName: string } | null
  /** Aborted when the run is stopped; long-running tools must honour it. */
  signal?: AbortSignal
}

export interface AgentTool {
  def: ToolDefinition
  /** Permission gate: a tool the agent may not use is never even offered to the model. */
  allowed(agent: Agent): boolean
  /** Throw to report a problem to the model; the text is returned as an error tool result. */
  execute(ctx: ToolContext, args: Record<string, unknown>): string | Promise<string>
}

const str = (v: unknown, max: number, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} is required.`)
  if (v.length > max) throw new Error(`${what} is too long (max ${max} characters).`)
  return v.trim()
}

function dependsTransitively(db: Database, task: string, on: string): boolean {
  const seen = new Set<string>()
  const stack = [task]
  while (stack.length) {
    const cur = stack.pop()!
    for (const d of db.all<{ depends_on_task_id: string }>(`SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?`, cur)) {
      if (d.depends_on_task_id === on) return true
      if (!seen.has(d.depends_on_task_id)) (seen.add(d.depends_on_task_id), stack.push(d.depends_on_task_id))
    }
  }
  return false
}

const listTasks: AgentTool = {
  def: { name: 'list_tasks', description: 'List the tasks of the current run with their ids, roles, statuses and dependencies.', parameters: { type: 'object', properties: {} } },
  allowed: () => true,
  execute: (ctx) =>
    JSON.stringify(
      ctx.tasks.list({ runId: ctx.runId }).map((t) => ({ id: t.id, title: t.title, role: t.role, assignee: t.assignedAgentName, status: t.status, dependsOn: t.dependsOn }))
    )
}

const listMemory: AgentTool = {
  def: { name: 'list_memory', description: 'List the shared project memory: design documents, decisions and notes written by the team.', parameters: { type: 'object', properties: {} } },
  allowed: (a) => a.permissions.readFiles,
  execute: (ctx) =>
    JSON.stringify(
      ctx.db.all(`SELECT id, kind, title, length(content) AS chars, updated_at AS updatedAt FROM memory_entries WHERE project_id = ? ORDER BY updated_at DESC LIMIT 200`, ctx.projectId)
    )
}

const readMemory: AgentTool = {
  def: {
    name: 'read_memory',
    description: 'Read one shared memory entry by id (see list_memory).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  allowed: (a) => a.permissions.readFiles,
  execute: (ctx, args) => {
    const row = ctx.db.get<{ title: string; kind: string; content: string }>(`SELECT title, kind, content FROM memory_entries WHERE id = ? AND project_id = ?`, String(args.id ?? ''), ctx.projectId)
    if (!row) throw new Error('No such memory entry in this project.')
    const text = row.content.length > READ_LIMIT ? `${row.content.slice(0, READ_LIMIT)}\n[truncated: ${row.content.length - READ_LIMIT} more characters]` : row.content
    return `# ${row.title} (${row.kind})\n\n${text}`
  }
}

const writeMemory: AgentTool = {
  def: {
    name: 'write_memory',
    description: 'Save a document to the shared project memory so other agents can read it (design docs, architecture decisions, conventions, summaries). Writing the same kind+title again replaces it.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...MEMORY_KINDS] },
        title: { type: 'string' },
        content: { type: 'string', description: 'Markdown.' }
      },
      required: ['kind', 'title', 'content']
    }
  },
  allowed: (a) => a.permissions.writeFiles,
  execute: (ctx, args) => {
    const kind = String(args.kind ?? '')
    if (!(MEMORY_KINDS as readonly string[]).includes(kind)) throw new Error(`kind must be one of: ${MEMORY_KINDS.join(', ')}.`)
    const title = str(args.title, 200, 'title')
    const content = str(args.content, MAX_MEMORY_CONTENT, 'content')
    const now = Date.now()
    const existing = ctx.db.get<{ id: string }>(`SELECT id FROM memory_entries WHERE project_id = ? AND kind = ? AND title = ?`, ctx.projectId, kind, title)
    let id: string
    if (existing) {
      id = existing.id
      ctx.db.run(`UPDATE memory_entries SET content = ?, author = ?, updated_at = ? WHERE id = ?`, content, ctx.agent.id, now, id)
    } else {
      id = randomUUID()
      ctx.db.run(`INSERT INTO memory_entries (id, project_id, kind, title, content, author, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, ctx.projectId, kind, title, content, ctx.agent.id, now, now)
    }
    ctx.events.record({ projectId: ctx.projectId, runId: ctx.runId, agentId: ctx.agent.id, type: 'memory.written', message: `${ctx.agent.name} saved ${kind} “${title}” (${content.length} chars)` })
    return `Saved ${kind} “${title}” (id ${id}).`
  }
}

const createTask: AgentTool = {
  def: {
    name: 'create_task',
    description: 'Add a task to the board for another team member. Use list_tasks to get ids for depends_on.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        role: { type: 'string', description: 'Role key of the team member who should do it.' },
        priority: { type: 'integer', description: '1 high, 2 normal, 3 low.' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Task ids that must finish first.' }
      },
      required: ['title', 'description', 'role']
    }
  },
  allowed: (a) => a.permissions.manageTasks,
  execute: (ctx, args) => {
    const role = String(args.role ?? '')
    const has = ctx.db.get(`SELECT 1 FROM agents WHERE project_id = ? AND role = ? AND enabled = 1`, ctx.projectId, role)
    if (!has) throw new Error(`No enabled agent with role "${role}" in this project.`)
    const inRun = ctx.db.get<{ c: number }>(`SELECT COUNT(*) c FROM tasks WHERE run_id = ?`, ctx.runId)!.c
    if (inRun >= MAX_TASKS_PER_RUN) throw new Error(`This run already has ${MAX_TASKS_PER_RUN} tasks; no more can be added.`)
    const deps = Array.isArray(args.depends_on) ? args.depends_on.map(String) : []
    for (const d of deps) {
      if (!ctx.db.get(`SELECT 1 FROM tasks WHERE id = ? AND run_id = ?`, d, ctx.runId)) throw new Error(`Unknown task id in depends_on: ${d}`)
    }
    const t = ctx.tasks.create({
      projectId: ctx.projectId,
      runId: ctx.runId,
      title: String(args.title ?? ''),
      description: typeof args.description === 'string' ? args.description : '',
      role,
      priority: typeof args.priority === 'number' ? args.priority : 2,
      dependsOn: deps
    })
    return `Created task ${t.id}: ${t.title}`
  }
}

const requestChanges: AgentTool = {
  def: {
    name: 'request_changes',
    description:
      'Send a finished task back to its owner with specific feedback (reviewers and testers use this when they find problems). The task is re-run with your feedback, then your own task runs again. Limited by the run’s iteration budget.',
    parameters: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'The finished task to send back.' }, feedback: { type: 'string', description: 'What exactly must change, with file/line or steps to reproduce.' } },
      required: ['task_id', 'feedback']
    }
  },
  allowed: (a) => a.permissions.manageTasks,
  execute: (ctx, args) => {
    const feedback = str(args.feedback, 4000, 'feedback')
    const targetId = String(args.task_id ?? '')
    return ctx.db.transaction(() => {
      const run = ctx.db.get<{ iteration: number; max_iterations: number }>(`SELECT iteration, max_iterations FROM runs WHERE id = ?`, ctx.runId)
      if (!run) throw new Error('The run no longer exists.')
      if (run.iteration >= run.max_iterations) {
        throw new Error(`The rework limit for this run (${run.max_iterations}) is used up. Do not request more changes: list the remaining problems in your final report instead.`)
      }
      const target = ctx.db.get<{ id: string; title: string; status: string }>(`SELECT id, title, status FROM tasks WHERE id = ? AND run_id = ?`, targetId, ctx.runId)
      if (!target) throw new Error('No such task in this run (use list_tasks).')
      if (target.id === ctx.taskId) throw new Error('A task cannot send itself back.')
      if (target.status !== 'done') throw new Error(`Only finished tasks can be sent back; “${target.title}” is ${target.status}.`)
      if (dependsTransitively(ctx.db, target.id, ctx.taskId)) throw new Error('That task depends on yours; sending it back would deadlock the run.')
      const now = Date.now()
      ctx.db.run(`UPDATE tasks SET status = 'todo', attempts = 0, error = NULL, updated_at = ? WHERE id = ?`, now, target.id)
      ctx.db.run(`INSERT INTO agent_messages (id, project_id, run_id, task_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, 'system', ?, ?)`, randomUUID(), ctx.projectId, ctx.runId, target.id, ctx.agent.id, `Change request from ${ctx.agent.name}: ${feedback}`, now)
      ctx.db.run(`INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`, ctx.taskId, target.id)
      // Finished work that was built on the old result is stale too. Tasks already running keep going on the old data.
      const stale = new Set<string>()
      const queue = [target.id]
      while (queue.length) {
        const cur = queue.shift()!
        for (const d of ctx.db.all<{ task_id: string }>(`SELECT d.task_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on_task_id = ? AND t.run_id = ?`, cur, ctx.runId)) {
          if (d.task_id !== ctx.taskId && !stale.has(d.task_id)) (stale.add(d.task_id), queue.push(d.task_id))
        }
      }
      for (const id of stale) ctx.db.run(`UPDATE tasks SET status = 'todo', attempts = 0, updated_at = ? WHERE id = ? AND status = 'done'`, now, id)
      ctx.db.run(`UPDATE runs SET iteration = iteration + 1 WHERE id = ?`, ctx.runId)
      ctx.state.reworkRequested = true
      ctx.events.record({ projectId: ctx.projectId, runId: ctx.runId, agentId: ctx.agent.id, level: 'warn', type: 'task.rework', message: `${ctx.agent.name} sent “${target.title}” back: ${feedback.slice(0, 200)}` })
      return `Sent “${target.title}” back (rework ${run.iteration + 1}/${run.max_iterations}). Finish your report now; your task will run again after the changes.`
    })
  }
}

export const ALL_TOOLS: AgentTool[] = [listTasks, listMemory, readMemory, writeMemory, createTask, requestChanges]

/** Tools this agent may use. File and command tools are only offered when the app has a workspace to act on. */
export function toolsFor(agent: Agent, opts: { workspace?: boolean; assets?: boolean } = {}): AgentTool[] {
  return [...ALL_TOOLS, ...(opts.workspace ? WORKSPACE_TOOLS : []), ...(opts.assets ? ASSET_TOOLS : [])].filter((t) => t.allowed(agent))
}

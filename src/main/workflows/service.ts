import { randomUUID } from 'node:crypto'
import type { SaveWorkflowInput } from '../../shared/ipc'
import { WORKFLOW_LIMITS, sanitizeGraph, type Workflow, type WorkflowGraph, type WorkflowSummary } from '../../shared/workflow'
import type { Database } from '../db/database'
import type { EventService } from '../services/events'

interface WorkflowRow {
  id: string
  project_id: string | null
  name: string
  graph_json: string
  version: number
  created_at: number
  updated_at: number
}

const EMPTY: WorkflowGraph = { nodes: [], edges: [] }

/** Saved workflow graphs. A draft may be incomplete: whether it can run is checked when it is started. */
export class WorkflowService {
  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly now: () => number = Date.now
  ) {}

  /** The project's own workflows plus the shared ones (no project). `null` lists only the shared ones. */
  list(projectId: string | null): WorkflowSummary[] {
    const rows =
      projectId === null
        ? this.db.all<WorkflowRow>(`SELECT * FROM workflows WHERE project_id IS NULL ORDER BY updated_at DESC, rowid DESC`)
        : this.db.all<WorkflowRow>(`SELECT * FROM workflows WHERE project_id = ? OR project_id IS NULL ORDER BY updated_at DESC, rowid DESC`, String(projectId))
    return rows.map((r) => ({ id: r.id, projectId: r.project_id, name: r.name, nodeCount: parseGraph(r.graph_json).nodes.length, version: r.version, updatedAt: r.updated_at }))
  }

  get(id: string): Workflow | null {
    const r = this.db.get<WorkflowRow>(`SELECT * FROM workflows WHERE id = ?`, String(id ?? ''))
    return r ? toWorkflow(r) : null
  }

  save(input: SaveWorkflowInput): Workflow {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) throw new Error('Give the workflow a name.')
    if (name.length > WORKFLOW_LIMITS.name) throw new Error(`The name is too long (max ${WORKFLOW_LIMITS.name} characters).`)
    const projectId = input.projectId === null || input.projectId === undefined ? null : String(input.projectId)
    if (projectId !== null && !this.db.get(`SELECT 1 FROM projects WHERE id = ?`, projectId)) throw new Error('Project not found.')
    const graph = sanitizeGraph(input.graph)
    const json = JSON.stringify(graph)
    const t = this.now()
    if (input.id) {
      const cur = this.db.get<WorkflowRow>(`SELECT * FROM workflows WHERE id = ?`, String(input.id))
      if (!cur) throw new Error('Workflow not found.')
      this.db.run(`UPDATE workflows SET project_id = ?, name = ?, graph_json = ?, version = version + 1, updated_at = ? WHERE id = ?`, projectId, name, json, t, cur.id)
      this.events.record({ projectId, type: 'workflow.saved', message: `Workflow “${name}” saved (${graph.nodes.length} steps)` })
      return this.get(cur.id)!
    }
    if (this.db.get(`SELECT 1 FROM workflows WHERE name = ? AND project_id IS ?`, name, projectId)) throw new Error(`A workflow called “${name}” already exists here.`)
    const id = randomUUID()
    this.db.run(`INSERT INTO workflows (id, project_id, name, graph_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`, id, projectId, name, json, t, t)
    this.events.record({ projectId, type: 'workflow.created', message: `Workflow “${name}” created (${graph.nodes.length} steps)` })
    return this.get(id)!
  }

  remove(id: string): void {
    const cur = this.db.get<WorkflowRow>(`SELECT * FROM workflows WHERE id = ?`, String(id ?? ''))
    if (!cur) return
    if (this.db.get(`SELECT 1 FROM runs WHERE workflow_id = ? AND status = 'running'`, cur.id)) throw new Error('A run of this workflow is in progress. Stop it first.')
    // Runs keep their own copy of the graph, so their history stays readable.
    this.db.run(`DELETE FROM workflows WHERE id = ?`, cur.id)
    this.events.record({ projectId: cur.project_id, type: 'workflow.removed', message: `Workflow “${cur.name}” deleted` })
  }
}

function parseGraph(json: string): WorkflowGraph {
  try {
    return sanitizeGraph(JSON.parse(json))
  } catch {
    return EMPTY
  }
}

function toWorkflow(r: WorkflowRow): Workflow {
  return { id: r.id, projectId: r.project_id, name: r.name, graph: parseGraph(r.graph_json), version: r.version, createdAt: r.created_at, updatedAt: r.updated_at }
}

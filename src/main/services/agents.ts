import { randomUUID } from 'node:crypto'
import type {
  Agent,
  AgentKind,
  AgentPermissions,
  AgentStatus,
  AgentTemplateInfo,
  CommandPolicy,
  CreateAgentInput,
  UpdateAgentInput
} from '../../shared/ipc'
import { AGENT_TEMPLATES, NO_PERMISSIONS, getTemplate } from '../agents/templates'
import { PROVIDER_CATALOG } from '../providers/catalog'
import type { Database } from '../db/database'
import type { ConnectionService } from './connections'
import type { EventService } from './events'

interface AgentRow {
  id: string
  project_id: string | null
  name: string
  role: string
  kind: AgentKind
  connection_id: string | null
  model: string | null
  system_prompt: string
  permissions_json: string
  temperature: number | null
  max_tokens: number | null
  max_cost_usd: number | null
  enabled: number
  status: AgentStatus
  created_at: number
  updated_at: number
}

const COMMAND_POLICIES: CommandPolicy[] = ['none', 'ask', 'allowlist']
const BOOLEAN_PERMISSIONS = ['readFiles', 'writeFiles', 'generateImages', 'internet', 'manageTasks', 'gitCommit'] as const

export const MAX_NAME = 80
export const MAX_PROMPT = 20_000

/**
 * Merge untrusted/partial permissions over a base. Unknown keys are dropped and
 * wrong types are rejected, so a malformed stored row can never grant more than
 * the base allows by accident.
 */
export function normalizePermissions(input: unknown, base: AgentPermissions = NO_PERMISSIONS): AgentPermissions {
  const out: AgentPermissions = { ...base }
  if (input === undefined || input === null) return out
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Permissions must be an object.')
  const p = input as Record<string, unknown>
  for (const key of BOOLEAN_PERMISSIONS) {
    if (p[key] === undefined) continue
    if (typeof p[key] !== 'boolean') throw new Error(`Permission "${key}" must be true or false.`)
    out[key] = p[key] as boolean
  }
  if (p.runCommands !== undefined) {
    if (!COMMAND_POLICIES.includes(p.runCommands as CommandPolicy)) throw new Error('Command policy must be none, ask or allowlist.')
    out.runCommands = p.runCommands as CommandPolicy
  }
  return out
}

/** Reads a stored permissions blob; falls back to least privilege if it is corrupt. */
function parseStoredPermissions(json: string): AgentPermissions {
  try {
    return normalizePermissions(JSON.parse(json))
  } catch {
    return { ...NO_PERMISSIONS }
  }
}

function optionalNumber(v: unknown, label: string, min: number, max: number, integer = false): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    throw new Error(`${label} must be ${integer ? 'a whole number' : 'a number'} between ${min} and ${max}.`)
  }
  return v
}

function cleanName(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error('Give the agent a name.')
  const name = v.trim().replace(/\s+/g, ' ')
  if (name.length > MAX_NAME) throw new Error(`The name can be at most ${MAX_NAME} characters.`)
  return name
}

function cleanPrompt(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error('The system prompt can’t be empty.')
  if (v.length > MAX_PROMPT) throw new Error(`The system prompt can be at most ${MAX_PROMPT} characters.`)
  return v
}

/**
 * CRUD for agents plus a computed "can this agent actually run" check.
 * Agents are plain data; the orchestrator (Phase 5) is what runs them.
 */
export class AgentService {
  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly connections: ConnectionService,
    private readonly now: () => number = Date.now
  ) {}

  templates(): AgentTemplateInfo[] {
    return AGENT_TEMPLATES.map((t) => ({
      key: t.key,
      label: t.label,
      kind: t.kind,
      description: t.description,
      systemPrompt: t.systemPrompt,
      permissions: { ...t.permissions },
      temperature: t.temperature ?? null,
      wants: [...t.wants]
    }))
  }

  // ------------------------------------------------------------------ reads

  list(): Agent[] {
    return this.db
      .all<AgentRow>(`SELECT * FROM agents ORDER BY (project_id IS NOT NULL), project_id, created_at, name COLLATE NOCASE`)
      .map((r) => this.toDto(r))
  }

  get(id: string): Agent | null {
    const r = this.db.get<AgentRow>(`SELECT * FROM agents WHERE id = ?`, String(id))
    return r ? this.toDto(r) : null
  }

  private row(id: string): AgentRow {
    const r = this.db.get<AgentRow>(`SELECT * FROM agents WHERE id = ?`, String(id))
    if (!r) throw new Error('Agent not found.')
    return r
  }

  private toDto(r: AgentRow): Agent {
    const conn = r.connection_id ? this.connections.get(r.connection_id) : null
    const label = r.role === 'custom' ? 'Custom' : (getTemplate(r.role)?.label ?? r.role)
    const enabled = r.enabled === 1
    return {
      id: r.id,
      projectId: r.project_id,
      name: r.name,
      role: r.role,
      roleLabel: label,
      kind: r.kind,
      connectionId: r.connection_id,
      connectionName: conn?.name ?? null,
      model: r.model,
      systemPrompt: r.system_prompt,
      permissions: parseStoredPermissions(r.permissions_json),
      temperature: r.temperature,
      maxTokens: r.max_tokens,
      maxCostUsd: r.max_cost_usd,
      enabled,
      status: enabled ? (r.status === 'disabled' ? 'idle' : r.status) : 'disabled',
      issues: this.issuesFor(r, enabled),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }

  /** Real checks against the current state of the connection: nothing is assumed to work. */
  private issuesFor(r: AgentRow, enabled: boolean): string[] {
    const issues: string[] = []
    if (!enabled) return issues
    if (r.kind === 'image') return this.imageIssues(r)
    if (!r.connection_id) {
      issues.push('No model connection selected.')
      return issues
    }
    const conn = this.connections.get(r.connection_id)
    if (!conn) {
      issues.push('Its model connection no longer exists.')
      return issues
    }
    if (!r.model) issues.push('No model selected.')
    if (!conn.enabled) issues.push(`Connection “${conn.name}” is disabled.`)
    else if (conn.status === 'error') issues.push(`Connection “${conn.name}” failed its last test.`)
    if (r.model) {
      const known = this.connections.listModels(conn.id)
      if (known.length > 0) {
        const entry = known.find((m) => m.model === r.model)
        if (!entry) issues.push(`Model “${r.model}” is not in the connection’s model list (refresh models, or pick another).`)
        else if (entry.kind !== 'chat') issues.push(`Model “${r.model}” is a ${entry.kind} model, not a chat model.`)
      }
    }
    return issues
  }

  /** An image agent needs a connection whose provider has an image API, a model, and permission to generate. */
  private imageIssues(r: AgentRow): string[] {
    const issues: string[] = []
    if (!r.connection_id) return ['No model connection selected.']
    const conn = this.connections.get(r.connection_id)
    if (!conn) return ['Its model connection no longer exists.']
    if (!PROVIDER_CATALOG[conn.kind]?.imageGeneration) return [`${PROVIDER_CATALOG[conn.kind]?.label ?? conn.kind} has no image-generation API. Pick a connection to OpenAI, Gemini or an OpenAI-compatible server.`]
    if (!r.model) issues.push('No image model selected.')
    if (!conn.enabled) issues.push(`Connection “${conn.name}” is disabled.`)
    else if (conn.status === 'error') issues.push(`Connection “${conn.name}” failed its last test.`)
    if (r.model) {
      const entry = this.connections.listModels(conn.id).find((m) => m.model === r.model)
      // A model the provider does not list is allowed (custom servers); one it lists as something else is not.
      if (entry && entry.kind !== 'image') issues.push(`Model “${r.model}” is a ${entry.kind} model, not an image model.`)
    }
    if (!parseStoredPermissions(r.permissions_json).generateImages) issues.push('The “Generate images” permission is off.')
    return issues
  }

  // ------------------------------------------------------------------ validation helpers

  private assertProject(projectId: string | null): void {
    if (projectId === null) return
    if (!this.db.get(`SELECT 1 FROM projects WHERE id = ?`, projectId)) throw new Error('Project not found.')
  }

  private assertUniqueName(name: string, projectId: string | null, exceptId?: string): void {
    const clash = this.db.get<{ id: string }>(
      `SELECT id FROM agents WHERE name = ? COLLATE NOCASE AND project_id IS ? AND id != ?`,
      name,
      projectId,
      exceptId ?? ''
    )
    if (clash) throw new Error(`An agent named “${name}” already exists${projectId ? ' in this project' : ' in the library'}.`)
  }

  private cleanModelRef(connectionId: unknown, model: unknown): { connectionId: string | null; model: string | null } {
    const cid = connectionId === undefined || connectionId === null || connectionId === '' ? null : String(connectionId)
    let m: string | null = null
    if (model !== undefined && model !== null && String(model).trim() !== '') {
      m = String(model).trim()
      if (m.length > 200) throw new Error('The model id is too long.')
    }
    if (cid && !this.connections.get(cid)) throw new Error('That connection does not exist.')
    if (!cid && m) throw new Error('Choose a connection for the model.')
    return { connectionId: cid, model: m }
  }

  private uniqueName(base: string, projectId: string | null): string {
    let name = base
    for (let n = 2; this.db.get(`SELECT 1 FROM agents WHERE name = ? COLLATE NOCASE AND project_id IS ?`, name, projectId); n++) {
      name = `${base} ${n}`
    }
    return name
  }

  // ------------------------------------------------------------------ writes

  create(input: CreateAgentInput): Agent {
    const projectId = input.projectId ?? null
    this.assertProject(projectId)

    const tpl = input.templateKey ? getTemplate(String(input.templateKey)) : undefined
    if (input.templateKey && !tpl) throw new Error(`Unknown template “${input.templateKey}”.`)

    const kind: AgentKind = tpl ? tpl.kind : input.kind === 'image' ? 'image' : 'chat'
    const name = cleanName(input.name ?? tpl?.label)
    const prompt = cleanPrompt(input.systemPrompt ?? tpl?.systemPrompt)
    const permissions = normalizePermissions(input.permissions, tpl?.permissions ?? NO_PERMISSIONS)
    const temperature = input.temperature === undefined ? (tpl?.temperature ?? null) : optionalNumber(input.temperature, 'Temperature', 0, 2)
    const maxTokens = optionalNumber(input.maxTokens, 'Max tokens', 1, 200_000, true)
    const maxCost = optionalNumber(input.maxCostUsd, 'Cost limit', 0.0001, 100_000)
    const ref = this.cleanModelRef(input.connectionId, input.model)
    this.assertUniqueName(name, projectId)

    const id = randomUUID()
    const t = this.now()
    this.db.run(
      `INSERT INTO agents (id, project_id, name, role, kind, connection_id, model, system_prompt, permissions_json,
                           temperature, max_tokens, max_cost_usd, enabled, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      projectId,
      name,
      tpl?.key ?? 'custom',
      kind,
      ref.connectionId,
      ref.model,
      prompt,
      JSON.stringify(permissions),
      temperature,
      maxTokens,
      maxCost,
      input.enabled === false ? 0 : 1,
      input.enabled === false ? 'disabled' : 'idle',
      t,
      t
    )
    this.events.record({ projectId, agentId: id, type: 'agent.created', message: `Agent “${name}” created${tpl ? ` from the ${tpl.label} template` : ''}` })
    return this.get(id)!
  }

  update(input: UpdateAgentInput): Agent {
    const cur = this.row(input.id)
    const sets: string[] = []
    const params: Array<string | number | null> = []
    const set = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`)
      params.push(v)
    }

    if (input.name !== undefined) {
      const name = cleanName(input.name)
      this.assertUniqueName(name, cur.project_id, cur.id)
      set('name', name)
    }
    let roleChange: string | null = null
    if (input.role !== undefined && input.role !== cur.role) {
      const role = String(input.role)
      const tpl = role === 'custom' ? undefined : getTemplate(role)
      if (role !== 'custom' && !tpl) throw new Error(`Unknown role “${role}”.`)
      if (tpl && tpl.kind !== cur.kind) throw new Error(`This is ${cur.kind === 'image' ? 'an image' : 'a chat'} agent: the ${tpl.label} role is for ${tpl.kind === 'image' ? 'image' : 'chat'} agents.`)
      if (cur.status === 'working') throw new Error('This agent is working right now. Stop the run before changing its role.')
      set('role', role)
      roleChange = role
    }
    if (input.systemPrompt !== undefined) set('system_prompt', cleanPrompt(input.systemPrompt))
    if (input.permissions !== undefined) {
      set('permissions_json', JSON.stringify(normalizePermissions(input.permissions, parseStoredPermissions(cur.permissions_json))))
    }
    if (input.temperature !== undefined) set('temperature', optionalNumber(input.temperature, 'Temperature', 0, 2))
    if (input.maxTokens !== undefined) set('max_tokens', optionalNumber(input.maxTokens, 'Max tokens', 1, 200_000, true))
    if (input.maxCostUsd !== undefined) set('max_cost_usd', optionalNumber(input.maxCostUsd, 'Cost limit', 0.0001, 100_000))

    if (input.connectionId !== undefined || input.model !== undefined) {
      // A model id only means something inside one connection: changing the connection clears the model unless a new one is given.
      const connChanged = input.connectionId !== undefined && (input.connectionId || null) !== cur.connection_id
      const ref = this.cleanModelRef(
        input.connectionId !== undefined ? input.connectionId : cur.connection_id,
        input.model !== undefined ? input.model : connChanged ? null : cur.model
      )
      set('connection_id', ref.connectionId)
      set('model', ref.model)
    }

    let enabledChange: boolean | null = null
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') throw new Error('Enabled must be true or false.')
      if (!input.enabled && cur.status === 'working') throw new Error('This agent is working right now. Stop the run before disabling it.')
      if (input.enabled !== (cur.enabled === 1)) enabledChange = input.enabled
      set('enabled', input.enabled ? 1 : 0)
      set('status', input.enabled ? 'idle' : 'disabled')
    }

    if (sets.length > 0) {
      set('updated_at', this.now())
      this.db.run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`, ...params, cur.id)
    }
    const next = this.get(cur.id)!
    if (enabledChange !== null) {
      this.events.record({ projectId: cur.project_id, agentId: cur.id, type: enabledChange ? 'agent.enabled' : 'agent.disabled', message: `Agent “${next.name}” ${enabledChange ? 'enabled' : 'disabled'}` })
    } else if (sets.length > 0) {
      this.events.record({ projectId: cur.project_id, agentId: cur.id, type: 'agent.updated', message: `Agent “${next.name}” updated${roleChange ? ` (role: ${next.roleLabel})` : ''}` })
    }
    return next
  }

  /** Copies everything except identity; the copy is named “<name> (copy)”, “(copy 2)”, … in the same scope. */
  duplicate(id: string): Agent {
    const src = this.row(id)
    const base = `${src.name} (copy)`.slice(0, MAX_NAME)
    const name = this.uniqueName(base, src.project_id)
    const newId = randomUUID()
    const t = this.now()
    this.db.run(
      `INSERT INTO agents (id, project_id, name, role, kind, connection_id, model, system_prompt, permissions_json,
                           temperature, max_tokens, max_cost_usd, enabled, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId,
      src.project_id,
      name,
      src.role,
      src.kind,
      src.connection_id,
      src.model,
      src.system_prompt,
      src.permissions_json,
      src.temperature,
      src.max_tokens,
      src.max_cost_usd,
      src.enabled,
      src.enabled === 1 ? 'idle' : 'disabled',
      t,
      t
    )
    this.events.record({ projectId: src.project_id, agentId: newId, type: 'agent.duplicated', message: `Agent “${src.name}” duplicated as “${name}”` })
    return this.get(newId)!
  }

  remove(id: string): void {
    const cur = this.row(id)
    if (cur.status === 'working') throw new Error('This agent is working right now. Stop the run before deleting it.')
    this.db.run(`DELETE FROM agents WHERE id = ?`, cur.id)
    // The event keeps no agent_id: the row it would point at is gone.
    this.events.record({ projectId: cur.project_id, type: 'agent.removed', message: `Agent “${cur.name}” deleted` })
  }

  /** One agent per template role, skipping roles the scope already has (matched by role, so renamed agents count). */
  createTeam(projectId: string | null): Agent[] {
    this.assertProject(projectId)
    const have = new Set(this.db.all<{ role: string }>(`SELECT role FROM agents WHERE project_id IS ?`, projectId).map((r) => r.role))
    const created: Agent[] = []
    this.db.transaction(() => {
      for (const tpl of AGENT_TEMPLATES) {
        if (have.has(tpl.key)) continue
        created.push(this.create({ templateKey: tpl.key, projectId, name: this.uniqueName(tpl.label, projectId) }))
      }
    })
    return created
  }
}

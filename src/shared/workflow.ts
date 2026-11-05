import { ASSET_KINDS, type Agent, type AssetKind } from './ipc'

/**
 * The workflow graph: what the editor draws, what is saved in `workflows.graph_json` and what the engine runs.
 * Everything here is pure (no Electron, no DOM) so the editor, the main process and the tests share one definition.
 *
 * Semantics in one paragraph: a node runs when every edge into it has been decided (taken or not taken) and at
 * least one was taken. A node with several outputs (review, test, condition, approval, loop) takes exactly one of
 * them. A loop repeats the part of the graph between its "body" output and its "again" input.
 */

export const WORKFLOW_LIMITS = {
  nodes: 60,
  edges: 150,
  name: 80,
  label: 80,
  text: 6000,
  command: 500,
  maxLoopIterations: 20,
  maxDebateParticipants: 5,
  maxDebateRounds: 3
} as const

export type WorkflowNodeType = 'agent' | 'image' | 'review' | 'test' | 'condition' | 'loop' | 'approval' | 'debate'
export const NODE_TYPES: WorkflowNodeType[] = ['agent', 'image', 'review', 'test', 'condition', 'loop', 'approval', 'debate']

/** Who does the work: a specific agent, or whoever on the team has the role (resolved when the node runs). */
export interface AgentRef {
  agentId: string | null
  role: string | null
}

export interface NodeConfigs {
  agent: { agent: AgentRef; instruction: string }
  image: { agentId: string | null; prompt: string; kind: AssetKind; size: string; transparent: boolean }
  review: { agent: AgentRef; criteria: string }
  test: { command: string; cwd: string; timeoutSec: number }
  condition: { mode: 'contains' | 'regex' | 'ai'; value: string; agent: AgentRef }
  loop: { maxIterations: number; until: string }
  approval: { message: string }
  debate: { question: string; participants: AgentRef[]; rounds: number; moderator: AgentRef; saveToMemory: boolean }
}

export type WorkflowNode = { [T in WorkflowNodeType]: { id: string; type: T; label: string; position: { x: number; y: number }; config: NodeConfigs[T] } }[WorkflowNodeType]

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  /** null = the node's only output. */
  sourceHandle: string | null
  /** null = 'in'. Only loops have a second input, 'again'. */
  targetHandle: string | null
}

export interface WorkflowGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface Workflow {
  id: string
  projectId: string | null
  name: string
  graph: WorkflowGraph
  version: number
  createdAt: number
  updatedAt: number
}

export interface WorkflowSummary {
  id: string
  projectId: string | null
  name: string
  nodeCount: number
  version: number
  updatedAt: number
}

export type NodeStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped' | 'blocked'

export interface NodeRunState {
  nodeId: string
  status: NodeStatus
  /** What the node produced (the text the next nodes receive). */
  output: string | null
  /** Which output was taken, e.g. "approved". */
  handle: string | null
  error: string | null
  /** A short remark for the editor, e.g. "Iteration 2 of 3" or why a loop stopped. */
  note: string | null
  /** How many times the node has run in this run (loops run their body repeatedly). */
  runs: number
  taskId: string | null
  startedAt: number | null
  finishedAt: number | null
}

export interface WorkflowIssue {
  severity: 'error' | 'warning'
  nodeId: string | null
  message: string
}

// ------------------------------------------------------------------ node catalogue

export interface OutputHandle {
  id: string
  label: string
}

export interface NodeSpec {
  label: string
  summary: string
  outputs: OutputHandle[]
}

export const NODE_SPECS: Record<WorkflowNodeType, NodeSpec> = {
  agent: { label: 'Agent', summary: 'An agent does a piece of work (with its tools) and reports back.', outputs: [{ id: 'out', label: 'result' }] },
  image: { label: 'Image', summary: 'The image model makes a picture and saves it in the project.', outputs: [{ id: 'out', label: 'result' }] },
  review: {
    label: 'Review',
    summary: 'A reviewer inspects the incoming work and either approves it or asks for changes.',
    outputs: [
      { id: 'approved', label: 'approved' },
      { id: 'changes', label: 'changes' }
    ]
  },
  test: {
    label: 'Test',
    summary: 'Runs a command in the project folder. Exit code 0 passes.',
    outputs: [
      { id: 'pass', label: 'pass' },
      { id: 'fail', label: 'fail' }
    ]
  },
  condition: {
    label: 'Condition',
    summary: 'Branches on the incoming text: contains a phrase, matches a pattern, or an agent answers yes/no.',
    outputs: [
      { id: 'true', label: 'yes' },
      { id: 'false', label: 'no' }
    ]
  },
  loop: {
    label: 'Loop',
    summary: 'Repeats the steps between “body” and “again” until they stop sending work back, a phrase appears, or the limit is reached.',
    outputs: [
      { id: 'body', label: 'body' },
      { id: 'done', label: 'done' }
    ]
  },
  approval: {
    label: 'Human approval',
    summary: 'Pauses this branch until you approve or reject it.',
    outputs: [
      { id: 'approved', label: 'approved' },
      { id: 'rejected', label: 'rejected' }
    ]
  },
  debate: {
    label: 'Debate',
    summary: 'Several agents answer the same question, critique each other, and a moderator records the decision.',
    outputs: [{ id: 'out', label: 'decision' }]
  }
}

const noAgent = (): AgentRef => ({ agentId: null, role: null })

export function defaultConfig<T extends WorkflowNodeType>(type: T): NodeConfigs[T] {
  const configs: NodeConfigs = {
    agent: { agent: noAgent(), instruction: '' },
    image: { agentId: null, prompt: '{{input}}', kind: 'sprite', size: '1024x1024', transparent: false },
    review: { agent: { agentId: null, role: 'code_reviewer' }, criteria: 'Check correctness, readability and that the work matches the goal.' },
    test: { command: 'npm test', cwd: '', timeoutSec: 120 },
    condition: { mode: 'contains', value: '', agent: noAgent() },
    loop: { maxIterations: 3, until: '' },
    approval: { message: 'Continue with the next step?' },
    debate: { question: '', participants: [noAgent(), noAgent()], rounds: 1, moderator: { agentId: null, role: 'project_manager' }, saveToMemory: true }
  }
  return configs[type]
}

export function newNode<T extends WorkflowNodeType>(type: T, id: string, position: { x: number; y: number }): Extract<WorkflowNode, { type: T }> {
  return { id, type, label: NODE_SPECS[type].label, position, config: defaultConfig(type) } as unknown as Extract<WorkflowNode, { type: T }>
}

/** The output an edge leaves from. */
export function sourceHandleOf(edge: WorkflowEdge, type: WorkflowNodeType): string | null {
  if (edge.sourceHandle) return edge.sourceHandle
  const outs = NODE_SPECS[type].outputs
  return outs.length === 1 ? outs[0].id : null
}

export const targetHandleOf = (edge: WorkflowEdge): 'in' | 'again' => (edge.targetHandle === 'again' ? 'again' : 'in')

// ------------------------------------------------------------------ sanitising untrusted JSON

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function text(v: unknown, max: number, fallback = ''): string {
  return typeof v === 'string' ? v.slice(0, max) : fallback
}
function num(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}
function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function ref(v: unknown): AgentRef {
  const o = obj(v)
  const agentId = typeof o.agentId === 'string' && o.agentId ? o.agentId.slice(0, 64) : null
  const role = typeof o.role === 'string' && o.role ? o.role.slice(0, 64) : null
  return { agentId, role: agentId ? null : role }
}

function sanitizeConfig(type: WorkflowNodeType, raw: unknown): NodeConfigs[WorkflowNodeType] {
  const c = obj(raw)
  const d = defaultConfig(type) as unknown
  switch (type) {
    case 'agent':
      return { agent: ref(c.agent), instruction: text(c.instruction, WORKFLOW_LIMITS.text) }
    case 'image': {
      const kind = ASSET_KINDS.some((k) => k.value === c.kind) ? (c.kind as AssetKind) : 'sprite'
      return { agentId: typeof c.agentId === 'string' && c.agentId ? c.agentId.slice(0, 64) : null, prompt: text(c.prompt, 4000), kind, size: text(c.size, 20), transparent: c.transparent === true }
    }
    case 'review':
      return { agent: ref(c.agent), criteria: text(c.criteria, WORKFLOW_LIMITS.text) }
    case 'test':
      return { command: text(c.command, WORKFLOW_LIMITS.command), cwd: text(c.cwd, 200), timeoutSec: num(c.timeoutSec, 1, 900, (d as NodeConfigs['test']).timeoutSec) }
    case 'condition':
      return { mode: c.mode === 'regex' || c.mode === 'ai' ? c.mode : 'contains', value: text(c.value, 1000), agent: ref(c.agent) }
    case 'loop':
      return { maxIterations: num(c.maxIterations, 1, WORKFLOW_LIMITS.maxLoopIterations, 3), until: text(c.until, 200) }
    case 'approval':
      return { message: text(c.message, 1000) }
    case 'debate': {
      const parts = Array.isArray(c.participants) ? c.participants.slice(0, WORKFLOW_LIMITS.maxDebateParticipants).map(ref) : []
      return {
        question: text(c.question, WORKFLOW_LIMITS.text),
        participants: parts,
        rounds: num(c.rounds, 0, WORKFLOW_LIMITS.maxDebateRounds, 1),
        moderator: ref(c.moderator),
        saveToMemory: c.saveToMemory !== false
      }
    }
  }
}

/**
 * Turns whatever the renderer (or a file) sent into a well-formed graph, or throws with a message. It only
 * guarantees the shape; whether the graph is runnable is `checkGraph`'s job, so unfinished drafts can be saved.
 */
export function sanitizeGraph(raw: unknown): WorkflowGraph {
  const g = obj(raw)
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error('The workflow must have a list of nodes and a list of edges.')
  if (g.nodes.length > WORKFLOW_LIMITS.nodes) throw new Error(`A workflow can have at most ${WORKFLOW_LIMITS.nodes} nodes.`)
  if (g.edges.length > WORKFLOW_LIMITS.edges) throw new Error(`A workflow can have at most ${WORKFLOW_LIMITS.edges} connections.`)
  const ids = new Set<string>()
  const nodes: WorkflowNode[] = g.nodes.map((n, i) => {
    const o = obj(n)
    const type = o.type as WorkflowNodeType
    if (!NODE_TYPES.includes(type)) throw new Error(`Node ${i + 1} has an unknown type.`)
    const id = typeof o.id === 'string' ? o.id : ''
    if (!ID_RE.test(id)) throw new Error(`Node ${i + 1} has an invalid id.`)
    if (ids.has(id)) throw new Error(`Two nodes share the id "${id}".`)
    ids.add(id)
    const pos = obj(o.position)
    const x = typeof pos.x === 'number' && Number.isFinite(pos.x) ? Math.round(Math.max(-100_000, Math.min(100_000, pos.x))) : 0
    const y = typeof pos.y === 'number' && Number.isFinite(pos.y) ? Math.round(Math.max(-100_000, Math.min(100_000, pos.y))) : 0
    const label = text(o.label, WORKFLOW_LIMITS.label).trim() || NODE_SPECS[type].label
    return { id, type, label, position: { x, y }, config: sanitizeConfig(type, o.config) } as WorkflowNode
  })
  const edgeIds = new Set<string>()
  const edges: WorkflowEdge[] = g.edges.map((e, i) => {
    const o = obj(e)
    const id = typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : `e${i + 1}`
    if (edgeIds.has(id)) throw new Error(`Two connections share the id "${id}".`)
    edgeIds.add(id)
    if (typeof o.source !== 'string' || typeof o.target !== 'string') throw new Error(`Connection ${i + 1} is missing an end.`)
    return {
      id,
      source: o.source,
      target: o.target,
      sourceHandle: typeof o.sourceHandle === 'string' && o.sourceHandle ? o.sourceHandle.slice(0, 20) : null,
      targetHandle: typeof o.targetHandle === 'string' && o.targetHandle ? o.targetHandle.slice(0, 20) : null
    }
  })
  return { nodes, edges }
}

// ------------------------------------------------------------------ structure analysis

export interface LoopRegion {
  loopId: string
  /** Nodes that run again on every iteration. */
  nodes: Set<string>
}

function adjacency(graph: WorkflowGraph): { out: Map<string, WorkflowEdge[]>; inc: Map<string, WorkflowEdge[]> } {
  const out = new Map<string, WorkflowEdge[]>()
  const inc = new Map<string, WorkflowEdge[]>()
  for (const n of graph.nodes) (out.set(n.id, []), inc.set(n.id, []))
  for (const e of graph.edges) {
    out.get(e.source)?.push(e)
    inc.get(e.target)?.push(e)
  }
  return { out, inc }
}

/** The steps a loop repeats: reachable from its body and able to reach its "again" input. */
export function loopRegions(graph: WorkflowGraph): Map<string, LoopRegion> {
  const { out, inc } = adjacency(graph)
  const type = new Map(graph.nodes.map((n) => [n.id, n.type]))
  const regions = new Map<string, LoopRegion>()
  for (const loop of graph.nodes.filter((n) => n.type === 'loop')) {
    const forward = new Set<string>()
    const queue: string[] = []
    for (const e of out.get(loop.id) ?? []) {
      if (sourceHandleOf(e, 'loop') === 'body' && e.target !== loop.id) queue.push(e.target)
    }
    while (queue.length) {
      const id = queue.pop()!
      if (forward.has(id) || id === loop.id) continue
      forward.add(id)
      for (const e of out.get(id) ?? []) if (e.target !== loop.id) queue.push(e.target)
    }
    const back = new Set<string>()
    const bq = (inc.get(loop.id) ?? []).filter((e) => targetHandleOf(e) === 'again').map((e) => e.source)
    while (bq.length) {
      const id = bq.pop()!
      if (back.has(id) || id === loop.id) continue
      back.add(id)
      for (const e of inc.get(id) ?? []) bq.push(e.source)
    }
    const nodes = new Set([...forward].filter((id) => back.has(id) && type.has(id)))
    regions.set(loop.id, { loopId: loop.id, nodes })
  }
  return regions
}

/** Edges that leave a loop's repeated steps for the rest of the workflow. */
export function exitEdges(graph: WorkflowGraph, region: LoopRegion): WorkflowEdge[] {
  return graph.edges.filter((e) => region.nodes.has(e.source) && !region.nodes.has(e.target) && e.target !== region.loopId)
}

const REGEX_MAX = 300

export function validRegex(pattern: string): boolean {
  if (!pattern || pattern.length > REGEX_MAX) return false
  try {
    new RegExp(pattern, 'i')
    return true
  } catch {
    return false
  }
}

/** Everything that makes the graph impossible to run, plus things worth a second look. Needs no agents. */
export function checkGraph(graph: WorkflowGraph): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const err = (nodeId: string | null, message: string): void => void issues.push({ severity: 'error', nodeId, message })
  const warn = (nodeId: string | null, message: string): void => void issues.push({ severity: 'warning', nodeId, message })
  if (graph.nodes.length === 0) {
    err(null, 'The workflow is empty: add at least one step.')
    return issues
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const name = (n: WorkflowNode): string => `“${n.label}”`

  // ---- edges
  const seen = new Set<string>()
  const validEdges: WorkflowEdge[] = []
  for (const e of graph.edges) {
    const s = byId.get(e.source)
    const t = byId.get(e.target)
    if (!s || !t) {
      err(null, 'A connection points at a step that does not exist.')
      continue
    }
    if (e.source === e.target) {
      err(s.id, `${name(s)} is connected to itself.`)
      continue
    }
    const sh = sourceHandleOf(e, s.type)
    if (!sh || !NODE_SPECS[s.type].outputs.some((o) => o.id === sh)) {
      err(s.id, `A connection leaves ${name(s)} from an output it does not have.`)
      continue
    }
    if (e.targetHandle && e.targetHandle !== 'in' && e.targetHandle !== 'again') {
      err(t.id, `A connection enters ${name(t)} at an input it does not have.`)
      continue
    }
    if (targetHandleOf(e) === 'again' && t.type !== 'loop') {
      err(t.id, `Only a loop has an “again” input, but a connection enters ${name(t)} there.`)
      continue
    }
    const key = `${e.source}|${sh}|${e.target}|${targetHandleOf(e)}`
    if (seen.has(key)) {
      warn(s.id, `${name(s)} is connected to ${name(t)} twice.`)
      continue
    }
    seen.add(key)
    validEdges.push(e)
  }
  const g: WorkflowGraph = { nodes: graph.nodes, edges: validEdges }

  // ---- cycles (the "again" edges are the only ones allowed to go backwards)
  const forwardOnly = validEdges.filter((e) => targetHandleOf(e) !== 'again')
  const indeg = new Map(graph.nodes.map((n) => [n.id, 0]))
  for (const e of forwardOnly) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  let visited = 0
  while (queue.length) {
    const id = queue.pop()!
    visited++
    for (const e of forwardOnly) if (e.source === id && indeg.set(e.target, indeg.get(e.target)! - 1).get(e.target) === 0) queue.push(e.target)
  }
  if (visited < graph.nodes.length) {
    const stuck = graph.nodes.filter((n) => (indeg.get(n.id) ?? 0) > 0).map((n) => n.label)
    err(null, `The steps form a circle (${stuck.slice(0, 4).join(', ')}${stuck.length > 4 ? ', …' : ''}). To repeat steps, use a Loop and connect the end of the body to its “again” input.`)
  }

  // ---- loops
  const regions = loopRegions(g)
  const owner = new Map<string, string>()
  for (const loop of graph.nodes.filter((n) => n.type === 'loop')) {
    const region = regions.get(loop.id)!
    const bodyEdges = validEdges.filter((e) => e.source === loop.id && sourceHandleOf(e, 'loop') === 'body')
    const againEdges = validEdges.filter((e) => e.target === loop.id && targetHandleOf(e) === 'again')
    if (bodyEdges.length === 0) err(loop.id, `${name(loop)} has nothing connected to its “body” output.`)
    if (againEdges.length === 0) err(loop.id, `${name(loop)} has no “again” input: connect the last step of the body to it, or the loop would run only once.`)
    for (const e of bodyEdges) {
      if (!region.nodes.has(e.target)) err(loop.id, `${name(loop)}: the step “${byId.get(e.target)!.label}” starts the body but never leads back to the “again” input.`)
    }
    for (const e of againEdges) {
      if (!region.nodes.has(e.source)) err(loop.id, `${name(loop)}: “${byId.get(e.source)!.label}” is connected to “again” but is not part of the loop body.`)
    }
    for (const id of region.nodes) {
      const n = byId.get(id)!
      if (n.type === 'loop') err(loop.id, `Loops cannot be nested (${name(loop)} contains ${name(n)}).`)
      const other = owner.get(id)
      if (other && other !== loop.id) err(loop.id, `Loops cannot overlap: “${n.label}” belongs to two of them.`)
      owner.set(id, loop.id)
    }
    if (loop.type === 'loop' && loop.config.until && loop.config.until.length > 200) err(loop.id, `${name(loop)}: the stop phrase is too long.`)
  }

  // ---- per-node settings
  for (const n of graph.nodes) {
    switch (n.type) {
      case 'agent':
        if (!n.config.agent.agentId && !n.config.agent.role) err(n.id, `${name(n)}: choose which agent or role does this step.`)
        if (!n.config.instruction.trim()) err(n.id, `${name(n)}: write the instruction for this step.`)
        break
      case 'image':
        if (!n.config.prompt.trim()) err(n.id, `${name(n)}: write the picture prompt.`)
        if (n.config.size && !/^\d{2,4}x\d{2,4}$/i.test(n.config.size)) err(n.id, `${name(n)}: the size must look like 1024x1024.`)
        break
      case 'review':
        if (!n.config.agent.agentId && !n.config.agent.role) err(n.id, `${name(n)}: choose the reviewer.`)
        if (!validEdges.some((e) => e.source === n.id && sourceHandleOf(e, 'review') === 'changes')) warn(n.id, `${name(n)} has no “changes” connection: if the reviewer asks for changes, nothing will act on it.`)
        break
      case 'test':
        if (!n.config.command.trim()) err(n.id, `${name(n)}: enter the command to run.`)
        break
      case 'condition':
        if (n.config.mode === 'regex' && !validRegex(n.config.value)) err(n.id, `${name(n)}: the pattern is empty, too long or not a valid regular expression.`)
        if (n.config.mode !== 'regex' && !n.config.value.trim()) err(n.id, `${name(n)}: ${n.config.mode === 'ai' ? 'write the question the agent should answer' : 'enter the phrase to look for'}.`)
        if (n.config.mode === 'ai' && !n.config.agent.agentId && !n.config.agent.role) err(n.id, `${name(n)}: choose the agent that answers.`)
        break
      case 'approval':
        if (!n.config.message.trim()) err(n.id, `${name(n)}: write what you are being asked to approve.`)
        break
      case 'debate': {
        if (!n.config.question.trim()) err(n.id, `${name(n)}: write the question to debate.`)
        const p = n.config.participants
        if (p.length < 2) err(n.id, `${name(n)}: a debate needs at least two participants.`)
        if (p.some((x) => !x.agentId && !x.role)) err(n.id, `${name(n)}: every participant needs an agent or role.`)
        if (!n.config.moderator.agentId && !n.config.moderator.role) err(n.id, `${name(n)}: choose the moderator who writes the decision.`)
        break
      }
      case 'loop':
        break
    }
  }
  return issues
}

// ------------------------------------------------------------------ team readiness

type TeamAgent = Pick<Agent, 'id' | 'name' | 'role' | 'kind' | 'enabled' | 'issues' | 'projectId' | 'permissions'>

export const agentReady = (a: TeamAgent): boolean => a.enabled && a.issues.length === 0

/** Agents on the project's team that can do this kind of work right now. */
export function candidatesFor(team: TeamAgent[], ref: AgentRef, kind: 'chat' | 'image'): TeamAgent[] {
  const ready = team.filter((a) => a.kind === kind && agentReady(a))
  if (ref.agentId) return ready.filter((a) => a.id === ref.agentId)
  if (ref.role) return ready.filter((a) => a.role === ref.role)
  return []
}

/** Which agents the graph asks for, and whether the project's team can supply them. */
export function checkTeam(graph: WorkflowGraph, projectAgents: TeamAgent[]): WorkflowIssue[] {
  const issues: WorkflowIssue[] = []
  const team = projectAgents
  const need = (nodeId: string, label: string, ref: AgentRef, kind: 'chat' | 'image', what: string): void => {
    if (!ref.agentId && !ref.role) return // reported by checkGraph
    if (candidatesFor(team, ref, kind).length > 0) return
    const asked = ref.agentId ? team.find((a) => a.id === ref.agentId) : null
    let why: string
    if (ref.agentId) why = asked ? (asked.enabled ? `“${asked.name}” cannot run: ${asked.issues.join(' ')}` : `“${asked.name}” is disabled`) : 'that agent is not on this project’s team'
    else {
      const any = team.filter((a) => a.role === ref.role)
      why = any.length === 0 ? `the team has no agent with the role “${ref.role}”` : any[0].enabled ? `“${any[0].name}” cannot run: ${any[0].issues.join(' ') || 'it is not set up'}` : `“${any[0].name}” is disabled`
    }
    issues.push({ severity: 'error', nodeId, message: `“${label}”: ${what} is not available: ${why}.` })
  }
  for (const n of graph.nodes) {
    switch (n.type) {
      case 'agent':
        need(n.id, n.label, n.config.agent, n.config.agent.agentId && team.find((a) => a.id === n.config.agent.agentId)?.kind === 'image' ? 'image' : 'chat', 'the agent')
        break
      case 'review':
        need(n.id, n.label, n.config.agent, 'chat', 'the reviewer')
        break
      case 'condition':
        if (n.config.mode === 'ai') need(n.id, n.label, n.config.agent, 'chat', 'the agent')
        break
      case 'image': {
        const ready = team.filter((a) => a.kind === 'image' && agentReady(a) && a.permissions.generateImages)
        const ok = n.config.agentId ? ready.some((a) => a.id === n.config.agentId) : ready.length > 0
        if (!ok) issues.push({ severity: 'error', nodeId: n.id, message: `“${n.label}”: ${n.config.agentId ? 'the chosen image agent cannot generate pictures' : 'the team has no ready Image Generator agent'} (it needs a model and the “Generate images” permission).` })
        break
      }
      case 'debate': {
        const taken = new Set<string>()
        for (const [i, p] of n.config.participants.entries()) {
          need(n.id, n.label, p, 'chat', `participant ${i + 1}`)
          const pick = candidatesFor(team, p, 'chat').find((a) => !taken.has(a.id))
          if (pick) taken.add(pick.id)
          else if ((p.agentId || p.role) && candidatesFor(team, p, 'chat').length > 0) issues.push({ severity: 'error', nodeId: n.id, message: `“${n.label}”: participant ${i + 1} would be the same agent as another participant. A debate needs different agents.` })
        }
        need(n.id, n.label, n.config.moderator, 'chat', 'the moderator')
        break
      }
      default:
        break
    }
  }
  return issues
}

/** Debate cost in model calls: each participant answers once and then critiques `rounds` times, plus the moderator. */
export const debateCalls = (participants: number, rounds: number): number => participants * (1 + rounds) + 1

// ------------------------------------------------------------------ templates

export interface WorkflowTemplate {
  key: string
  name: string
  description: string
  graph: WorkflowGraph
}

const at = (x: number, y: number) => ({ x, y })

function game(): WorkflowGraph {
  const design = newNode('agent', 'design', at(0, 160))
  design.label = 'Game design'
  design.config = {
    agent: { agentId: null, role: 'game_designer' },
    instruction:
      'Write the game design document for: {{goal}}\nCover the core loop, mechanics, controls, win/lose conditions, progression, the list of required art assets and the first playable scope. Be concrete enough that a developer can build it without asking questions.'
  }
  const debate = newNode('debate', 'tech', at(300, 0))
  debate.label = 'Technology debate'
  debate.config = {
    question: 'Which engine or framework, and which project structure, should we use to build this game? Weigh build time, tooling, ease of testing, and the scope in the design document.',
    participants: [
      { agentId: null, role: 'technical_architect' },
      { agentId: null, role: 'game_developer' }
    ],
    rounds: 1,
    moderator: { agentId: null, role: 'project_manager' },
    saveToMemory: true
  }
  const artPrompt = newNode('agent', 'art-brief', at(300, 320))
  artPrompt.label = 'Art brief'
  artPrompt.config = {
    agent: { agentId: null, role: 'concept_artist' },
    instruction: 'From the design document, write ONE image prompt (at most 80 words) for the main character sprite: subject, art style, view, colours, plain background. Reply with the prompt text only.'
  }
  const art = newNode('image', 'art', at(600, 320))
  art.label = 'Character sprite'
  art.config = { agentId: null, prompt: '{{input}}', kind: 'sprite', size: '1024x1024', transparent: true }
  const loop = newNode('loop', 'loop', at(900, 160))
  loop.label = 'Build until it passes'
  loop.config = { maxIterations: 3, until: '' }
  const dev = newNode('agent', 'dev', at(1200, 0))
  dev.label = 'Implement'
  dev.config = {
    agent: { agentId: null, role: 'game_developer' },
    instruction:
      'Implement the game in the project folder following the design document and the technology decision. Use the sprite from the asset library if one exists (list_assets). If you received review or test feedback, fix every point. Report the files you wrote and how to run the game.'
  }
  const review = newNode('review', 'review', at(1500, 0))
  review.label = 'Code review'
  review.config = { agent: { agentId: null, role: 'code_reviewer' }, criteria: 'Check that the game follows the design document, that the code runs, and that obvious bugs and unsafe code are absent.' }
  const test = newNode('test', 'test', at(1500, 240))
  test.label = 'Run tests'
  test.config = { command: 'npm test', cwd: '', timeoutSec: 180 }
  const qa = newNode('agent', 'qa', at(1800, 160))
  qa.label = 'QA report'
  qa.config = {
    agent: { agentId: null, role: 'qa_tester' },
    instruction: 'Write the QA report for the build: what was verified, what the test run showed, known problems and what to do next. If the loop ended without passing tests, say so first.'
  }
  const gate = newNode('approval', 'gate', at(2100, 160))
  gate.label = 'Accept the build'
  gate.config = { message: 'Review the QA report. Accept this build?' }
  const e = (id: string, source: string, target: string, sourceHandle: string | null = null, targetHandle: string | null = null): WorkflowEdge => ({ id, source, target, sourceHandle, targetHandle })
  return {
    nodes: [design, debate, artPrompt, art, loop, dev, review, test, qa, gate],
    edges: [
      e('e1', 'design', 'tech'),
      e('e2', 'design', 'art-brief'),
      e('e3', 'art-brief', 'art'),
      e('e4', 'tech', 'loop'),
      e('e5', 'art', 'loop'),
      e('e6', 'loop', 'dev', 'body'),
      e('e7', 'dev', 'review'),
      e('e8', 'review', 'test', 'approved'),
      e('e9', 'review', 'loop', 'changes', 'again'),
      e('e10', 'test', 'loop', 'fail', 'again'),
      e('e11', 'test', 'qa', 'pass'),
      e('e12', 'loop', 'qa', 'done'),
      e('e13', 'qa', 'gate')
    ]
  }
}

function reviewLoop(): WorkflowGraph {
  const write = newNode('agent', 'write', at(300, 0))
  write.label = 'Write'
  write.config = { agent: { agentId: null, role: 'lead_developer' }, instruction: '{{goal}}\nDo the work in the project folder and report what you changed. If you received review feedback, fix every point.' }
  const loop = newNode('loop', 'loop', at(0, 0))
  loop.label = 'Revise'
  loop.config = { maxIterations: 3, until: '' }
  const review = newNode('review', 'review', at(600, 0))
  review.label = 'Review'
  const done = newNode('agent', 'summary', at(900, 0))
  done.label = 'Summary'
  done.config = { agent: { agentId: null, role: 'project_manager' }, instruction: 'Summarise what was built and the outcome of the review in a few lines.' }
  return {
    nodes: [loop, write, review, done],
    edges: [
      { id: 'e1', source: 'loop', target: 'write', sourceHandle: 'body', targetHandle: null },
      { id: 'e2', source: 'write', target: 'review', sourceHandle: null, targetHandle: null },
      { id: 'e3', source: 'review', target: 'loop', sourceHandle: 'changes', targetHandle: 'again' },
      { id: 'e4', source: 'review', target: 'summary', sourceHandle: 'approved', targetHandle: null },
      { id: 'e5', source: 'loop', target: 'summary', sourceHandle: 'done', targetHandle: null }
    ]
  }
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: 'game-pipeline',
    name: 'Game creation pipeline',
    description: 'Design, a technology debate, character art, an implement → review → test loop, a QA report and your approval.',
    graph: game()
  },
  {
    key: 'review-loop',
    name: 'Write and review',
    description: 'A developer writes, a reviewer approves or sends it back (up to 3 times), then the project manager summarises.',
    graph: reviewLoop()
  },
  {
    key: 'blank',
    name: 'Blank workflow',
    description: 'Start from one empty agent step.',
    graph: { nodes: [newNode('agent', 'start', at(0, 0))], edges: [] }
  }
]

/** `{{goal}}` and `{{input}}` in a node's text. */
export function fillTemplate(template: string, vars: { goal: string; input: string }): string {
  return template.replace(/\{\{\s*goal\s*\}\}/gi, () => vars.goal).replace(/\{\{\s*input\s*\}\}/gi, () => vars.input)
}

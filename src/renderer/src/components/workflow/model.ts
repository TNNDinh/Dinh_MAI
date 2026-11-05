import type { Edge, Node } from '@xyflow/react'
import {
  NODE_SPECS,
  sourceHandleOf,
  targetHandleOf,
  type AgentRef,
  type NodeRunState,
  type NodeStatus,
  type WorkflowEdge,
  type WorkflowGraph,
  type WorkflowNode
} from '../../../../shared/workflow'
import type { Agent, AgentTemplateInfo } from '../../../../shared/ipc'

/** What a canvas node carries besides its position: the real workflow node plus what the editor shows about it. */
export type StepData = {
  wf: WorkflowNode
  run: NodeRunState | null
  problem: 'error' | 'warning' | null
  summary: string
}
export type StepNode = Node<StepData, 'step'>
export type StepEdge = Edge<{ again: boolean }>

export function toFlow(graph: WorkflowGraph): { nodes: StepNode[]; edges: StepEdge[] } {
  const type = new Map(graph.nodes.map((n) => [n.id, n.type]))
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, type: 'step' as const, position: { ...n.position }, data: { wf: n, run: null, problem: null, summary: '' } })),
    edges: graph.edges.map((e) => {
      const t = type.get(e.source)
      return makeEdge(e.id, e.source, e.target, t ? sourceHandleOf(e, t) : e.sourceHandle, targetHandleOf(e))
    })
  }
}

export function makeEdge(id: string, source: string, target: string, sourceHandle: string | null, targetHandle: string | null): StepEdge {
  const again = targetHandle === 'again'
  return { id, source, target, sourceHandle, targetHandle: targetHandle ?? 'in', type: 'smoothstep', data: { again }, animated: again }
}

export function fromFlow(nodes: StepNode[], edges: StepEdge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => ({ ...n.data.wf, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } }) as WorkflowNode),
    edges: edges.map((e): WorkflowEdge => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null, targetHandle: e.targetHandle && e.targetHandle !== 'in' ? e.targetHandle : null }))
  }
}

export const newId = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 8)}`

/** A stable key for "did the graph change?": positions are included, so moving a node counts as an edit. */
export const graphKey = (g: WorkflowGraph): string => JSON.stringify(g)

// ------------------------------------------------------------------ describing nodes

export function describeRef(ref: AgentRef, agents: Agent[], templates: AgentTemplateInfo[]): string {
  if (ref.agentId) return agents.find((a) => a.id === ref.agentId)?.name ?? 'unknown agent'
  if (ref.role) return templates.find((t) => t.key === ref.role)?.label ?? ref.role
  return 'not chosen'
}

export function summarize(n: WorkflowNode, agents: Agent[], templates: AgentTemplateInfo[]): string {
  const ref = (r: AgentRef): string => describeRef(r, agents, templates)
  const clip = (s: string, max = 70): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)
  switch (n.type) {
    case 'agent':
      return `${ref(n.config.agent)}: ${clip(n.config.instruction || 'no instruction yet')}`
    case 'image':
      return clip(n.config.prompt || 'no prompt yet')
    case 'review':
      return `Reviewer: ${ref(n.config.agent)}`
    case 'test':
      return clip(n.config.command || 'no command yet')
    case 'condition':
      return n.config.mode === 'ai' ? `Asks ${ref(n.config.agent)}: ${clip(n.config.value)}` : `${n.config.mode === 'regex' ? 'Matches' : 'Contains'} ${clip(n.config.value || '…', 50)}`
    case 'loop':
      return `Up to ${n.config.maxIterations} round${n.config.maxIterations === 1 ? '' : 's'}${n.config.until ? `, or until “${clip(n.config.until, 30)}”` : ''}`
    case 'approval':
      return clip(n.config.message)
    case 'debate':
      return `${n.config.participants.length} agents, ${n.config.rounds} round${n.config.rounds === 1 ? '' : 's'}: ${clip(n.config.question || 'no question yet', 50)}`
  }
}

export const OUTPUT_LABEL = (n: WorkflowNode, id: string): string => NODE_SPECS[n.type].outputs.find((o) => o.id === id)?.label ?? id

// ------------------------------------------------------------------ run status look

export const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: 'Waiting',
  running: 'Running',
  waiting: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  blocked: 'Blocked'
}

/** Tailwind classes for the node's frame and its status chip. */
export const STATUS_FRAME: Record<NodeStatus, string> = {
  pending: 'border-line',
  running: 'border-info shadow-[0_0_0_1px_var(--color-info)] wf-running',
  waiting: 'border-warn shadow-[0_0_0_1px_var(--color-warn)]',
  done: 'border-ok/70',
  failed: 'border-err shadow-[0_0_0_1px_var(--color-err)]',
  skipped: 'border-line opacity-55',
  blocked: 'border-err/40 opacity-70'
}
export const STATUS_TEXT: Record<NodeStatus, string> = {
  pending: 'text-faint',
  running: 'text-info',
  waiting: 'text-warn',
  done: 'text-ok',
  failed: 'text-err',
  skipped: 'text-faint',
  blocked: 'text-err'
}

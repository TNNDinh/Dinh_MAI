import { newNode, type NodeConfigs, type WorkflowEdge, type WorkflowNode, type WorkflowNodeType } from '../../src/shared/workflow'

export function N<T extends WorkflowNodeType>(type: T, id: string, config: Partial<NodeConfigs[T]> = {}, label?: string): WorkflowNode {
  const n = newNode(type, id, { x: 0, y: 0 })
  Object.assign(n.config, config)
  if (label) n.label = label
  return n as WorkflowNode
}

export const E = (source: string, target: string, sourceHandle: string | null = null, targetHandle: string | null = null): WorkflowEdge => ({
  id: `${source}-${sourceHandle ?? 'o'}-${target}-${targetHandle ?? 'i'}`,
  source,
  target,
  sourceHandle,
  targetHandle
})

export const role = (r: string) => ({ agentId: null, role: r })

/** An agent step done by whoever has the lead_developer role; the instruction is "Do <id>". */
export const agentNode = (id: string, label = id, r = 'lead_developer'): WorkflowNode => N('agent', id, { agent: role(r), instruction: `Do ${id}` }, label)

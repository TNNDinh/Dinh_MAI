import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from './workflow'

/**
 * Pure editing helpers for the workflow editor: undo/redo history, copy-paste of steps and automatic layout.
 * They work on the saved graph shape (no UI types), so they are unit-tested without a browser.
 */

// ------------------------------------------------------------------ undo / redo

const keyOf = (g: WorkflowGraph): string => JSON.stringify(g)

/** Snapshots of the graph. `record` is called with the graph after every settled edit; undo and redo hand back the graph to show. */
export class GraphHistory {
  private undoStack: WorkflowGraph[] = []
  private redoStack: WorkflowGraph[] = []
  private present: WorkflowGraph | null = null
  private presentKey = ''

  constructor(private readonly limit = 100) {}

  /** Starts over from this graph (a workflow was opened). */
  reset(g: WorkflowGraph): void {
    this.undoStack = []
    this.redoStack = []
    this.present = structuredClone(g)
    this.presentKey = keyOf(g)
  }

  /** Remembers a new state. Returns false when nothing changed. A new edit forgets what could have been redone. */
  record(g: WorkflowGraph): boolean {
    const k = keyOf(g)
    if (this.present === null) {
      this.reset(g)
      return false
    }
    if (k === this.presentKey) return false
    this.undoStack.push(this.present)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
    this.present = structuredClone(g)
    this.presentKey = k
    return true
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undo(): WorkflowGraph | null {
    const prev = this.undoStack.pop()
    if (!prev || !this.present) return null
    this.redoStack.push(this.present)
    this.present = prev
    this.presentKey = keyOf(prev)
    return structuredClone(prev)
  }

  redo(): WorkflowGraph | null {
    const next = this.redoStack.pop()
    if (!next || !this.present) return null
    this.undoStack.push(this.present)
    this.present = next
    this.presentKey = keyOf(next)
    return structuredClone(next)
  }
}

// ------------------------------------------------------------------ copy / paste

/** Steps (and the connections between them) taken out of a graph. Connections to steps that were not copied are left behind. */
export interface Fragment {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export function copyFragment(graph: WorkflowGraph, ids: ReadonlySet<string>): Fragment | null {
  const nodes = graph.nodes.filter((n) => ids.has(n.id))
  if (nodes.length === 0) return null
  const kept = new Set(nodes.map((n) => n.id))
  return structuredClone({ nodes, edges: graph.edges.filter((e) => kept.has(e.source) && kept.has(e.target)) })
}

/** The fragment with fresh ids, moved by `offset`. Pass the ids already in use so a new id never collides. */
export function pasteFragment(
  fragment: Fragment,
  existing: ReadonlySet<string>,
  offset: { x: number; y: number },
  newId: (prefix: string) => string
): Fragment {
  const used = new Set(existing)
  const fresh = (prefix: string): string => {
    let id = newId(prefix)
    while (used.has(id)) id = newId(prefix)
    used.add(id)
    return id
  }
  const map = new Map<string, string>()
  const copy = structuredClone(fragment)
  const nodes = copy.nodes.map((n) => {
    const id = fresh(n.type)
    map.set(n.id, id)
    return { ...n, id, position: { x: Math.round(n.position.x + offset.x), y: Math.round(n.position.y + offset.y) } } as WorkflowNode
  })
  const edges = copy.edges.map((e) => ({ ...e, id: fresh('e'), source: map.get(e.source)!, target: map.get(e.target)! }))
  return { nodes, edges }
}

// ------------------------------------------------------------------ automatic layout

export interface LayoutOptions {
  columnWidth?: number
  rowHeight?: number
}

/**
 * Left-to-right layered layout: a step sits one column after the latest step that feeds it, and steps in the same column are
 * ordered to keep connections short. Connections into a loop's "again" input (and any other connection that would close a
 * cycle) are ignored for placement, so loops lay out as a straight line with the return arrow going back.
 * Returns new positions only; nothing else about the graph changes.
 */
export function autoLayout(graph: WorkflowGraph, opts: LayoutOptions = {}): Map<string, { x: number; y: number }> {
  const cw = opts.columnWidth ?? 330
  const rh = opts.rowHeight ?? 150
  const ids = graph.nodes.map((n) => n.id)
  const known = new Set(ids)
  const forward = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of graph.edges) {
    if (e.targetHandle === 'again' || !known.has(e.source) || !known.has(e.target) || e.source === e.target) continue
    forward.get(e.source)!.push(e.target)
  }

  // Drop connections that close a cycle (depth-first back edges), keeping the rest as a DAG.
  const state = new Map<string, 0 | 1 | 2>()
  const dag = new Map<string, string[]>(ids.map((id) => [id, []]))
  const visit = (start: string): void => {
    const stack: Array<{ id: string; i: number }> = [{ id: start, i: 0 }]
    state.set(start, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const outs = forward.get(top.id)!
      if (top.i >= outs.length) {
        state.set(top.id, 2)
        stack.pop()
        continue
      }
      const next = outs[top.i++]
      const s = state.get(next) ?? 0
      if (s === 1) continue // back edge
      dag.get(top.id)!.push(next)
      if (s === 0) {
        state.set(next, 1)
        stack.push({ id: next, i: 0 })
      }
    }
  }
  const hasIncoming = new Set<string>()
  for (const outs of forward.values()) for (const t of outs) hasIncoming.add(t)
  for (const id of ids.filter((i) => !hasIncoming.has(i))) if (!state.has(id)) visit(id)
  for (const id of ids) if (!state.has(id)) visit(id) // isolated cycles

  // Column = longest path from any start (processed in topological order).
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const outs of dag.values()) for (const t of outs) indeg.set(t, indeg.get(t)! + 1)
  const column = new Map<string, number>(ids.map((id) => [id, 0]))
  const queue = ids.filter((id) => indeg.get(id) === 0)
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (let q = 0; q < queue.length; q++) {
    const id = queue[q]
    for (const t of dag.get(id)!) {
      preds.get(t)!.push(id)
      column.set(t, Math.max(column.get(t)!, column.get(id)! + 1))
      indeg.set(t, indeg.get(t)! - 1)
      if (indeg.get(t) === 0) queue.push(t)
    }
  }

  const cols: string[][] = []
  for (const id of ids) (cols[column.get(id)!] ??= []).push(id)
  // Order within a column by the average row of the steps feeding it (a few sweeps), starting from the saved order.
  const row = new Map<string, number>()
  cols.forEach((c) => c?.forEach((id, i) => row.set(id, i)))
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const c of cols) {
      if (!c) continue
      const score = (id: string): number => {
        const p = preds.get(id)!
        return p.length ? p.reduce((s, x) => s + row.get(x)!, 0) / p.length : row.get(id)!
      }
      c.sort((a, b) => score(a) - score(b) || ids.indexOf(a) - ids.indexOf(b))
      c.forEach((id, i) => row.set(id, i))
    }
  }

  const out = new Map<string, { x: number; y: number }>()
  const tallest = Math.max(1, ...cols.map((c) => c?.length ?? 0))
  cols.forEach((c, x) => {
    if (!c) return
    const top = ((tallest - c.length) * rh) / 2 // centre shorter columns
    c.forEach((id, i) => out.set(id, { x: x * cw, y: Math.round(top + i * rh) }))
  })
  return out
}

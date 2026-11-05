import { NODE_SPECS, exitEdges, loopRegions, sourceHandleOf, targetHandleOf, type LoopRegion, type NodeRunState, type NodeStatus, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from '../../shared/workflow'

/**
 * Where a workflow run stands: which node is pending/running/done, which connections were taken, how far each
 * loop has got. Pure data and rules, no I/O: the engine asks it what may run next and tells it what happened.
 *
 * Rules:
 *  - A connection is "active" (taken), "dead" (not taken) or still "pending" (its source has not decided yet).
 *  - A node may run when every connection into it has been decided, at least one was taken and none of its
 *    sources failed. If none was taken it is skipped; if a source failed or was blocked, it is blocked.
 *  - A node with several outputs takes exactly one; the others die.
 *  - A loop fires its "body" output, waits until every step of the body has finished, then looks at its "again"
 *    inputs: none taken → leave through "done"; limit reached or stop phrase seen → leave through "done"; otherwise
 *    reset the body and go round again. Connections that leave the body for the rest of the workflow only count
 *    once the loop has left, using what the last round decided.
 */

export type EdgeState = 'pending' | 'active' | 'dead'

export interface LoopState {
  iterations: number
  /** Body fired and not yet judged. */
  awaiting: boolean
  /** What the loop received when it first fired. */
  input: string
  /** What the last round sent back through "again". */
  feedback: string
  exited: boolean
}

export interface FlowSnapshot {
  edges: Record<string, EdgeState>
  tentative: Record<string, EdgeState>
  loops: Record<string, LoopState>
}

const TERMINAL: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['done', 'failed', 'skipped', 'blocked'])
const BAD: ReadonlySet<NodeStatus> = new Set<NodeStatus>(['failed', 'blocked'])

export interface NodeInput {
  label: string
  text: string
}

/** One input as-is; several as titled sections. */
export function joinInputs(inputs: NodeInput[]): string {
  if (inputs.length === 0) return ''
  if (inputs.length === 1) return inputs[0].text
  return inputs.map((i) => `### ${i.label}\n${i.text}`).join('\n\n')
}

export class FlowState {
  readonly nodes = new Map<string, NodeRunState>()
  private readonly edges = new Map<string, EdgeState>()
  private readonly tentative = new Map<string, EdgeState>()
  private readonly loops = new Map<string, LoopState>()
  private readonly regions: Map<string, LoopRegion>
  private readonly byId = new Map<string, WorkflowNode>()
  private readonly incoming = new Map<string, WorkflowEdge[]>()
  private readonly outgoing = new Map<string, WorkflowEdge[]>()
  private readonly again = new Map<string, WorkflowEdge[]>()
  private readonly exitOf = new Map<string, string>()
  private readonly dirty = new Set<string>()

  constructor(
    readonly graph: WorkflowGraph,
    private readonly now: () => number = Date.now
  ) {
    for (const n of graph.nodes) {
      this.byId.set(n.id, n)
      this.incoming.set(n.id, [])
      this.outgoing.set(n.id, [])
      this.again.set(n.id, [])
      this.nodes.set(n.id, { nodeId: n.id, status: 'pending', output: null, handle: null, error: null, note: null, runs: 0, taskId: null, startedAt: null, finishedAt: null })
    }
    for (const e of graph.edges) {
      this.edges.set(e.id, 'pending')
      this.outgoing.get(e.source)?.push(e)
      if (targetHandleOf(e) === 'again') this.again.get(e.target)?.push(e)
      else this.incoming.get(e.target)?.push(e)
    }
    this.regions = loopRegions(graph)
    for (const [id, region] of this.regions) {
      this.loops.set(id, { iterations: 0, awaiting: false, input: '', feedback: '', exited: false })
      for (const e of exitEdges(graph, region)) this.exitOf.set(e.id, id)
    }
  }

  /** Rebuilds a state saved earlier. Nodes or connections that no longer exist in the graph are ignored. */
  static restore(graph: WorkflowGraph, nodes: NodeRunState[], snapshot: FlowSnapshot | null, now: () => number = Date.now): FlowState {
    const fs = new FlowState(graph, now)
    for (const n of nodes) if (fs.nodes.has(n.nodeId)) fs.nodes.set(n.nodeId, { ...n })
    if (snapshot) {
      for (const [id, s] of Object.entries(snapshot.edges ?? {})) if (fs.edges.has(id)) fs.edges.set(id, s)
      for (const [id, s] of Object.entries(snapshot.tentative ?? {})) if (fs.edges.has(id)) fs.tentative.set(id, s)
      for (const [id, l] of Object.entries(snapshot.loops ?? {})) if (fs.loops.has(id)) fs.loops.set(id, { ...l })
    }
    return fs
  }

  snapshot(): FlowSnapshot {
    return { edges: Object.fromEntries(this.edges), tentative: Object.fromEntries(this.tentative), loops: Object.fromEntries([...this.loops].map(([k, v]) => [k, { ...v }])) }
  }

  // ------------------------------------------------------------------ queries

  node(id: string): NodeRunState {
    return this.nodes.get(id)!
  }
  status(id: string): NodeStatus {
    return this.nodes.get(id)!.status
  }
  edgeState(id: string): EdgeState {
    return this.edges.get(id) ?? 'pending'
  }
  loop(id: string): LoopState | undefined {
    return this.loops.get(id)
  }
  region(id: string): LoopRegion | undefined {
    return this.regions.get(id)
  }
  maxIterations(loopId: string): number {
    const n = this.byId.get(loopId)
    return n?.type === 'loop' ? n.config.maxIterations : 1
  }

  /** Nodes whose changes have not been taken yet. */
  takeDirty(): NodeRunState[] {
    const out = [...this.dirty].map((id) => ({ ...this.nodes.get(id)! }))
    this.dirty.clear()
    return out
  }

  /** What the upstream steps produced, for the steps that feed this node. */
  inputs(nodeId: string): NodeInput[] {
    return (this.incoming.get(nodeId) ?? [])
      .filter((e) => this.edgeState(e.id) === 'active')
      .map((e) => ({ label: this.byId.get(e.source)!.label, text: this.nodes.get(e.source)!.output ?? '' }))
  }

  /** Nodes (never loops) that can start now. Call `settle()` first. */
  ready(): string[] {
    return this.graph.nodes.filter((n) => n.type !== 'loop' && this.status(n.id) === 'pending' && this.verdict(n.id).kind === 'ready').map((n) => n.id)
  }

  /** True when no step is running or waiting (a loop between rounds is "running" but does no work itself). */
  quiet(): boolean {
    return ![...this.nodes.values()].some((n) => (n.status === 'running' || n.status === 'waiting') && this.byId.get(n.nodeId)!.type !== 'loop')
  }

  pendingIds(): string[] {
    return [...this.nodes.values()].filter((n) => n.status === 'pending').map((n) => n.nodeId)
  }

  counts(): Record<NodeStatus, number> {
    const c: Record<NodeStatus, number> = { pending: 0, running: 0, waiting: 0, done: 0, failed: 0, skipped: 0, blocked: 0 }
    for (const n of this.nodes.values()) c[n.status]++
    return c
  }

  // ------------------------------------------------------------------ what the engine reports

  start(id: string): void {
    this.set(id, { status: 'running', error: null, handle: null, note: null, startedAt: this.now(), finishedAt: null })
  }

  wait(id: string, note: string | null = null): void {
    this.set(id, { status: 'waiting', note })
  }

  complete(id: string, r: { output: string; handle: string; taskId?: string | null; note?: string | null }): void {
    const n = this.byId.get(id)!
    if (!this.outputsOf(n).includes(r.handle)) throw new Error(`“${n.label}” has no “${r.handle}” output.`)
    const cur = this.node(id)
    this.set(id, { status: 'done', output: r.output, handle: r.handle, error: null, note: r.note ?? null, runs: cur.runs + 1, taskId: r.taskId ?? cur.taskId, finishedAt: this.now() })
    this.resolveOut(id, r.handle)
  }

  fail(id: string, error: string, taskId?: string | null): void {
    const cur = this.node(id)
    this.set(id, { status: 'failed', error, handle: null, runs: cur.runs + 1, taskId: taskId ?? cur.taskId, finishedAt: this.now() })
    this.resolveOut(id, null)
  }

  /** Marks everything still in flight as failed with `error` (the run was stopped or paused). */
  failInFlight(error: string): void {
    for (const n of this.nodes.values()) if ((n.status === 'running' || n.status === 'waiting') && this.byId.get(n.nodeId)!.type !== 'loop') this.fail(n.nodeId, error)
  }

  /** Marks everything that can never start as blocked (the graph went quiet with work left). */
  blockPending(reason: string): void {
    for (const id of this.pendingIds()) this.terminate(id, 'blocked', { error: reason })
  }

  /** Ends a node that did not produce anything: every connection out of it is dead. */
  private terminate(id: string, status: 'skipped' | 'blocked', patch: Partial<NodeRunState> = {}): void {
    this.set(id, { status, finishedAt: this.now(), ...patch })
    // A loop that never ran has no body to wait for: connections leaving its body are decided as their sources end.
    const ls = this.loops.get(id)
    if (ls) ls.exited = true
    this.resolveOut(id, null)
  }

  // ------------------------------------------------------------------ propagation

  /**
   * Decides what can be decided without running anything: skips branches that were not taken, blocks what sits
   * behind a failure, fires loops and judges finished loop rounds. Repeats until nothing changes.
   */
  settle(): void {
    for (let guard = 0; guard < 100_000; guard++) {
      let changed = false
      for (const n of this.graph.nodes) {
        const st = this.node(n.id)
        if (st.status === 'pending') {
          const v = this.verdict(n.id)
          if (v.kind === 'skip') {
            this.terminate(n.id, 'skipped')
            changed = true
          } else if (v.kind === 'block') {
            this.terminate(n.id, 'blocked', { error: v.reason })
            changed = true
          } else if (v.kind === 'ready' && n.type === 'loop') {
            this.startLoop(n.id)
            changed = true
          }
        } else if (n.type === 'loop' && st.status === 'running') {
          const ls = this.loops.get(n.id)!
          if (ls.awaiting && [...this.regions.get(n.id)!.nodes].every((id) => TERMINAL.has(this.status(id)))) {
            this.judge(n.id)
            changed = true
          }
        }
      }
      if (!changed) return
    }
    throw new Error('The workflow state did not settle (this is a bug).')
  }

  private verdict(id: string): { kind: 'wait' } | { kind: 'ready' } | { kind: 'skip' } | { kind: 'block'; reason: string } {
    const inc = this.incoming.get(id)!
    if (inc.length === 0) return { kind: 'ready' }
    if (inc.some((e) => this.edgeState(e.id) === 'pending')) return { kind: 'wait' }
    const bad = inc.find((e) => BAD.has(this.status(e.source)))
    if (bad) {
      const src = this.byId.get(bad.source)!
      return { kind: 'block', reason: `Not run: “${src.label}” ${this.status(bad.source) === 'failed' ? 'failed' : 'was blocked'}.` }
    }
    return inc.some((e) => this.edgeState(e.id) === 'active') ? { kind: 'ready' } : { kind: 'skip' }
  }

  private outputsOf(n: WorkflowNode): string[] {
    return NODE_SPECS[n.type].outputs.map((o) => o.id)
  }

  /** `handle` null: the node produced nothing, so every connection out of it is dead. */
  private resolveOut(id: string, handle: string | null): void {
    const n = this.byId.get(id)!
    for (const e of this.outgoing.get(id) ?? []) {
      const state: EdgeState = handle !== null && sourceHandleOf(e, n.type) === handle ? 'active' : 'dead'
      const loopId = this.exitOf.get(e.id)
      if (loopId && !this.loops.get(loopId)!.exited) this.tentative.set(e.id, state)
      else this.edges.set(e.id, state)
    }
  }

  // ------------------------------------------------------------------ loops

  private startLoop(id: string): void {
    const ls = this.loops.get(id)!
    ls.input = joinInputs(this.inputs(id))
    ls.feedback = ''
    this.set(id, { status: 'running', error: null, startedAt: this.now(), finishedAt: null })
    this.emitBody(id)
  }

  private emitBody(id: string): void {
    const ls = this.loops.get(id)!
    const region = this.regions.get(id)!
    for (const rid of region.nodes) this.set(rid, { status: 'pending', handle: null, error: null, note: null, startedAt: null, finishedAt: null })
    for (const e of this.graph.edges) {
      if (!region.nodes.has(e.source)) continue
      this.edges.set(e.id, 'pending')
      this.tentative.delete(e.id)
    }
    ls.iterations++
    ls.awaiting = true
    for (const e of this.outgoing.get(id) ?? []) if (sourceHandleOf(e, 'loop') === 'body') this.edges.set(e.id, 'active')
    const max = this.maxIterations(id)
    const text = ls.feedback ? `${ls.input}\n\n## Feedback from the previous round (round ${ls.iterations - 1} of ${max})\n${ls.feedback}` : ls.input
    this.set(id, { output: text, runs: ls.iterations, note: `Round ${ls.iterations} of ${max}` })
  }

  /** Every step of the body has finished: leave the loop or go round again. */
  private judge(id: string): void {
    const ls = this.loops.get(id)!
    const region = this.regions.get(id)!
    const bad = [...region.nodes].map((r) => this.node(r)).find((r) => BAD.has(r.status))
    if (bad) {
      ls.exited = true
      this.finalizeExits(id)
      this.set(id, { status: 'blocked', error: `The loop body did not finish: “${this.byId.get(bad.nodeId)!.label}” ${bad.status === 'failed' ? 'failed' : 'was blocked'}.`, finishedAt: this.now() })
      this.resolveOut(id, null)
      return
    }
    const back = (this.again.get(id) ?? []).filter((e) => this.edgeState(e.id) === 'active')
    ls.feedback = joinInputs(back.map((e) => ({ label: this.byId.get(e.source)!.label, text: this.nodes.get(e.source)!.output ?? '' })))
    const node = this.byId.get(id)!
    const until = node.type === 'loop' ? node.config.until.trim().toLowerCase() : ''
    const max = this.maxIterations(id)
    let reason: string | null = null
    if (back.length === 0) reason = 'Finished: nothing was sent back.'
    else if (until && ls.feedback.toLowerCase().includes(until)) reason = `Stopped: “${node.type === 'loop' ? node.config.until.trim() : ''}” appeared.`
    else if (ls.iterations >= max) reason = `Stopped: reached the limit of ${max} round${max === 1 ? '' : 's'} with work still sent back.`
    if (reason === null) return this.emitBody(id)
    ls.awaiting = false
    ls.exited = true
    this.finalizeExits(id)
    const output = ls.feedback ? `${ls.input}\n\n## Unresolved feedback after ${ls.iterations} round${ls.iterations === 1 ? '' : 's'}\n${ls.feedback}` : ls.input
    this.set(id, { status: 'done', handle: 'done', output, note: reason, finishedAt: this.now() })
    this.resolveOut(id, 'done')
  }

  /** The body is over: the connections that leave it now take the value the last round decided. */
  private finalizeExits(id: string): void {
    for (const e of exitEdges(this.graph, this.regions.get(id)!)) this.edges.set(e.id, this.tentative.get(e.id) ?? 'dead')
  }

  // ------------------------------------------------------------------ resume

  /**
   * Prepares a stopped, paused or failed run to continue: finished work stays finished, everything else (failed,
   * blocked, interrupted) is queued again, and a loop that was mid-round resumes that round.
   */
  prepareResume(): void {
    const keep = (id: string): boolean => this.status(id) === 'done' || this.status(id) === 'skipped'
    const midRound = new Set<string>()
    for (const [id, ls] of this.loops) if (this.status(id) !== 'done' && ls.awaiting) midRound.add(id)
    const resetNode = (id: string): void => this.set(id, { status: 'pending', error: null, handle: null, note: null, startedAt: null, finishedAt: null })
    for (const n of this.graph.nodes) {
      if (midRound.has(n.id)) continue
      if (!keep(n.id)) {
        resetNode(n.id)
        if (n.type === 'loop') this.loops.set(n.id, { iterations: 0, awaiting: false, input: '', feedback: '', exited: false })
      }
    }
    for (const id of midRound) {
      const ls = this.loops.get(id)!
      ls.exited = false
      this.set(id, { status: 'running', error: null, handle: null, finishedAt: null, note: `Round ${ls.iterations} of ${this.maxIterations(id)}` })
    }
    for (const e of this.graph.edges) {
      const src = e.source
      if (midRound.has(src)) {
        this.edges.set(e.id, sourceHandleOf(e, 'loop') === 'body' ? 'active' : 'pending')
      } else if (!keep(src)) {
        this.edges.set(e.id, 'pending')
        this.tentative.delete(e.id)
      }
    }
    // Connections that leave an unfinished loop's body wait for the loop again; what finished sources decided is kept.
    for (const [loopId, ls] of this.loops) {
      if (keep(loopId)) continue
      ls.exited = false
      for (const e of exitEdges(this.graph, this.regions.get(loopId)!)) {
        if (keep(e.source) && this.edges.get(e.id) !== 'pending') this.tentative.set(e.id, this.edges.get(e.id)!)
        this.edges.set(e.id, 'pending')
        if (!keep(e.source)) this.tentative.delete(e.id)
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  private set(id: string, patch: Partial<NodeRunState>): void {
    Object.assign(this.nodes.get(id)!, patch)
    this.dirty.add(id)
  }
}

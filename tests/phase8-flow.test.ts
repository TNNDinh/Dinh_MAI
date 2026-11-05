import { describe, expect, it } from 'vitest'
import { FlowState, joinInputs } from '../src/main/workflows/flow-state'
import { WorkflowService } from '../src/main/workflows/service'
import { E, N, agentNode, role } from './helpers/wf-builders'
import { Database } from '../src/main/db/database'
import { EventService } from '../src/main/services/events'
import {
  WORKFLOW_TEMPLATES,
  checkGraph,
  checkTeam,
  debateCalls,
  fillTemplate,
  sanitizeGraph,
  type WorkflowGraph
} from '../src/shared/workflow'

/** Runs a step to completion in the pure state. */
function finish(fs: FlowState, id: string, handle = 'out', output = `out:${id}`): void {
  fs.start(id)
  fs.complete(id, { output, handle })
}

const reviewLoop = (max = 3, until = ''): WorkflowGraph => ({
  nodes: [N('loop', 'loop', { maxIterations: max, until }, 'Revise'), agentNode('write', 'Write'), N('review', 'review', { agent: role('code_reviewer') }, 'Review'), agentNode('summary', 'Summary')],
  edges: [E('loop', 'write', 'body'), E('write', 'review'), E('review', 'loop', 'changes', 'again'), E('review', 'summary', 'approved'), E('loop', 'summary', 'done')]
})

// ------------------------------------------------------------------ shared module

describe('sanitizeGraph', () => {
  it('rejects malformed graphs', () => {
    expect(() => sanitizeGraph(null)).toThrow(/list of nodes/)
    expect(() => sanitizeGraph({ nodes: [{ id: 'a', type: 'wizard' }], edges: [] })).toThrow(/unknown type/)
    expect(() => sanitizeGraph({ nodes: [{ id: 'bad id!', type: 'agent' }], edges: [] })).toThrow(/invalid id/)
    expect(() => sanitizeGraph({ nodes: [{ id: 'a', type: 'agent' }, { id: 'a', type: 'agent' }], edges: [] })).toThrow(/share the id/)
    expect(() => sanitizeGraph({ nodes: [{ id: 'a', type: 'agent' }], edges: [{ id: 'e', source: 'a' }] })).toThrow(/missing an end/)
    expect(() => sanitizeGraph({ nodes: Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, type: 'agent' })), edges: [] })).toThrow(/at most 60/)
  })

  it('fills defaults and clamps values', () => {
    const g = sanitizeGraph({
      nodes: [
        { id: 'l', type: 'loop', position: { x: 1e9, y: 'x' }, config: { maxIterations: 99, until: 5 } },
        { id: 'd', type: 'debate', label: '   ', config: { rounds: 9, participants: Array.from({ length: 8 }, () => ({ agentId: 'a1', role: 'qa_tester' })), saveToMemory: false } }
      ],
      edges: [{ source: 'l', target: 'd' }]
    })
    const [l, d] = g.nodes
    expect(l.position).toEqual({ x: 100000, y: 0 })
    expect(l.config).toEqual({ maxIterations: 20, until: '' })
    expect(d.label).toBe('Debate')
    expect(d.type === 'debate' && d.config.rounds).toBe(3)
    expect(d.type === 'debate' && d.config.participants).toHaveLength(5)
    // An explicit agent wins over a role.
    expect(d.type === 'debate' && d.config.participants[0]).toEqual({ agentId: 'a1', role: null })
    expect(d.type === 'debate' && d.config.saveToMemory).toBe(false)
    expect(g.edges[0]).toEqual({ id: 'e1', source: 'l', target: 'd', sourceHandle: null, targetHandle: null })
  })
})

describe('checkGraph', () => {
  const errors = (g: WorkflowGraph) => checkGraph(g).filter((i) => i.severity === 'error').map((i) => i.message)

  it('says an empty workflow cannot run', () => {
    expect(errors({ nodes: [], edges: [] })[0]).toMatch(/empty/)
  })

  it('requires the settings of each node', () => {
    const g: WorkflowGraph = {
      nodes: [
        N('agent', 'a'),
        N('test', 't', { command: ' ' }),
        N('condition', 'c', { mode: 'regex', value: '(' }),
        N('condition', 'c2', { mode: 'ai', value: 'ok?' }),
        N('approval', 'p', { message: '' }),
        N('debate', 'd', { question: '', participants: [role('qa_tester')], moderator: { agentId: null, role: null } })
      ],
      edges: []
    }
    const text = errors(g).join('\n')
    expect(text).toMatch(/choose which agent or role/)
    expect(text).toMatch(/write the instruction/)
    expect(text).toMatch(/enter the command/)
    expect(text).toMatch(/not a valid regular expression/)
    expect(text).toMatch(/choose the agent that answers/)
    expect(text).toMatch(/what you are being asked to approve/)
    expect(text).toMatch(/at least two participants/)
    expect(text).toMatch(/choose the moderator/)
  })

  it('rejects bad connections', () => {
    const base = [agentNode('a'), agentNode('b')]
    expect(errors({ nodes: base, edges: [E('a', 'a')] }).join()).toMatch(/connected to itself/)
    expect(errors({ nodes: base, edges: [E('a', 'zzz')] }).join()).toMatch(/does not exist/)
    expect(errors({ nodes: base, edges: [E('a', 'b', 'approved')] }).join()).toMatch(/output it does not have/)
    expect(errors({ nodes: base, edges: [E('a', 'b', null, 'again')] }).join()).toMatch(/Only a loop has an “again” input/)
    expect(errors({ nodes: base, edges: [E('a', 'b', null, 'weird')] }).join()).toMatch(/input it does not have/)
  })

  it('warns about a duplicate connection and a review nobody listens to', () => {
    const g: WorkflowGraph = { nodes: [agentNode('a'), N('review', 'r', { agent: role('code_reviewer') })], edges: [E('a', 'r'), { ...E('a', 'r'), id: 'dup' }] }
    const issues = checkGraph(g)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(issues.map((i) => i.message).join('\n')).toMatch(/twice/)
    expect(issues.map((i) => i.message).join('\n')).toMatch(/no “changes” connection/)
  })

  it('finds circles that do not go through a loop', () => {
    expect(errors({ nodes: [agentNode('a'), agentNode('b')], edges: [E('a', 'b'), E('b', 'a')] }).join()).toMatch(/form a circle/)
  })

  it('checks loops', () => {
    const noAgain: WorkflowGraph = { nodes: [N('loop', 'l'), agentNode('a')], edges: [E('l', 'a', 'body')] }
    expect(errors(noAgain).join()).toMatch(/no “again” input/)
    const noBody: WorkflowGraph = { nodes: [N('loop', 'l'), agentNode('a')], edges: [E('a', 'l', null, 'again')] }
    expect(errors(noBody).join()).toMatch(/nothing connected to its “body”/)
    const outside: WorkflowGraph = { nodes: [N('loop', 'l'), agentNode('a'), agentNode('b')], edges: [E('l', 'a', 'body'), E('b', 'l', null, 'again')] }
    expect(errors(outside).join()).toMatch(/never leads back|not part of the loop body/)
    const nested: WorkflowGraph = {
      nodes: [N('loop', 'l1'), N('loop', 'l2'), agentNode('a')],
      edges: [E('l1', 'l2', 'body'), E('l2', 'a', 'body'), E('a', 'l2', null, 'again'), E('a', 'l1', null, 'again')]
    }
    expect(errors(nested).join()).toMatch(/cannot be nested/)
    expect(errors(reviewLoop())).toEqual([])
  })

  it('ships templates that are valid (except the blank starting point)', () => {
    for (const t of WORKFLOW_TEMPLATES.filter((x) => x.key !== 'blank')) expect(errors(t.graph), t.key).toEqual([])
    const blank = WORKFLOW_TEMPLATES.find((t) => t.key === 'blank')!
    expect(errors(blank.graph).length).toBeGreaterThan(0)
    // Every saved template survives sanitising unchanged.
    for (const t of WORKFLOW_TEMPLATES) expect(sanitizeGraph(JSON.parse(JSON.stringify(t.graph)))).toEqual(t.graph)
  })
})

describe('checkTeam', () => {
  type Team = Parameters<typeof checkTeam>[1]
  const ag = (id: string, r: string, extra: Record<string, unknown> = {}): Team[number] =>
    ({ id, name: id, role: r, kind: 'chat', enabled: true, issues: [], projectId: 'p1', permissions: { generateImages: false }, ...extra }) as unknown as Team[number]
  const msgs = (g: WorkflowGraph, team: Team) => checkTeam(g, team).map((i) => i.message).join('\n')

  it('reports a missing, disabled or unset-up agent', () => {
    const g: WorkflowGraph = { nodes: [agentNode('a')], edges: [] }
    expect(msgs(g, [])).toMatch(/no agent with the role “lead_developer”/)
    expect(msgs(g, [ag('x', 'lead_developer', { enabled: false })])).toMatch(/is disabled/)
    expect(msgs(g, [ag('x', 'lead_developer', { issues: ['Choose a model.'] })])).toMatch(/cannot run: Choose a model/)
    expect(msgs(g, [ag('x', 'lead_developer')])).toBe('')
  })

  it('needs a ready image agent that may generate pictures', () => {
    const g: WorkflowGraph = { nodes: [N('image', 'i', { prompt: 'a cat' })], edges: [] }
    expect(msgs(g, [])).toMatch(/no ready Image Generator/)
    expect(msgs(g, [ag('img', 'image_generator', { kind: 'image' })])).toMatch(/no ready Image Generator/)
    expect(msgs(g, [ag('img', 'image_generator', { kind: 'image', permissions: { generateImages: true } })])).toBe('')
  })

  it('needs different agents for a debate', () => {
    const g: WorkflowGraph = { nodes: [N('debate', 'd', { question: 'Q?', participants: [role('qa_tester'), role('qa_tester')], moderator: role('project_manager') })], edges: [] }
    expect(msgs(g, [ag('q1', 'qa_tester'), ag('pm', 'project_manager')])).toMatch(/same agent as another participant/)
    expect(msgs(g, [ag('q1', 'qa_tester'), ag('q2', 'qa_tester'), ag('pm', 'project_manager')])).toBe('')
  })
})

describe('small helpers', () => {
  it('fills {{goal}} and {{input}} literally', () => {
    expect(fillTemplate('Do {{goal}} with {{ input }} and $& {{goal}}', { goal: 'X $1', input: 'Y' })).toBe('Do X $1 with Y and $& X $1')
  })
  it('counts the model calls of a debate', () => {
    expect(debateCalls(2, 1)).toBe(5)
    expect(debateCalls(3, 0)).toBe(4)
    expect(debateCalls(5, 3)).toBe(21)
  })
  it('joins one input as is and several as titled sections', () => {
    expect(joinInputs([])).toBe('')
    expect(joinInputs([{ label: 'A', text: 'x' }])).toBe('x')
    expect(joinInputs([{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }])).toBe('### A\nx\n\n### B\ny')
  })
})

// ------------------------------------------------------------------ FlowState

describe('FlowState', () => {
  it('runs a chain in order and passes outputs along', () => {
    const fs = new FlowState({ nodes: [agentNode('a'), agentNode('b'), agentNode('c')], edges: [E('a', 'b'), E('b', 'c')] })
    fs.settle()
    expect(fs.ready()).toEqual(['a'])
    finish(fs, 'a')
    fs.settle()
    expect(fs.ready()).toEqual(['b'])
    expect(fs.inputs('b')).toEqual([{ label: 'a', text: 'out:a' }])
    finish(fs, 'b')
    fs.settle()
    finish(fs, 'c')
    fs.settle()
    expect(fs.counts().done).toBe(3)
    expect(fs.quiet()).toBe(true)
  })

  it('starts independent steps together and waits for all inputs of a merge', () => {
    const fs = new FlowState({ nodes: [agentNode('a'), agentNode('b'), agentNode('m')], edges: [E('a', 'm'), E('b', 'm')] })
    fs.settle()
    expect(fs.ready().sort()).toEqual(['a', 'b'])
    finish(fs, 'a')
    fs.settle()
    expect(fs.ready()).toEqual(['b'])
    finish(fs, 'b')
    fs.settle()
    expect(fs.ready()).toEqual(['m'])
    expect(fs.inputs('m')).toHaveLength(2)
  })

  it('takes one output of a branch and skips the other side, merging afterwards', () => {
    const g: WorkflowGraph = {
      nodes: [N('condition', 'c', { value: 'x' }), agentNode('yes'), agentNode('no'), agentNode('after')],
      edges: [E('c', 'yes', 'true'), E('c', 'no', 'false'), E('yes', 'after'), E('no', 'after')]
    }
    const fs = new FlowState(g)
    fs.settle()
    finish(fs, 'c', 'true')
    fs.settle()
    expect(fs.status('no')).toBe('skipped')
    expect(fs.ready()).toEqual(['yes'])
    finish(fs, 'yes')
    fs.settle()
    expect(fs.ready()).toEqual(['after'])
    expect(fs.inputs('after')).toEqual([{ label: 'yes', text: 'out:yes' }])
  })

  it('refuses an output the node does not have', () => {
    const fs = new FlowState({ nodes: [agentNode('a')], edges: [] })
    fs.start('a')
    expect(() => fs.complete('a', { output: '', handle: 'approved' })).toThrow(/no “approved” output/)
  })

  it('blocks what sits behind a failure and says why', () => {
    const fs = new FlowState({ nodes: [agentNode('a', 'Alpha'), agentNode('b'), agentNode('c')], edges: [E('a', 'b'), E('b', 'c')] })
    fs.settle()
    fs.start('a')
    fs.fail('a', 'boom')
    fs.settle()
    expect(fs.status('a')).toBe('failed')
    expect(fs.status('b')).toBe('blocked')
    expect(fs.node('b').error).toBe('Not run: “Alpha” failed.')
    expect(fs.status('c')).toBe('blocked')
    expect(fs.node('c').error).toMatch(/was blocked/)
  })

  it('blocks steps that can never start once the graph is quiet', () => {
    // m waits for a connection from a node that is itself waiting for m: only possible in a broken graph, so it is blocked, not hung.
    const fs = new FlowState({ nodes: [agentNode('a'), agentNode('b')], edges: [E('a', 'b'), E('b', 'a')] })
    fs.settle()
    expect(fs.ready()).toEqual([])
    fs.blockPending('never ready')
    expect(fs.counts().blocked).toBe(2)
  })

  describe('loops', () => {
    it('goes round again while work is sent back, then leaves through "done"', () => {
      const fs = new FlowState(reviewLoop(3))
      fs.settle()
      expect(fs.status('loop')).toBe('running')
      expect(fs.ready()).toEqual(['write'])
      expect(fs.node('loop').note).toBe('Round 1 of 3')
      finish(fs, 'write')
      fs.settle()
      finish(fs, 'review', 'changes', 'Add tests')
      fs.settle()
      // Round 2: the body is reset and the feedback travels with the loop's output.
      expect(fs.loop('loop')!.iterations).toBe(2)
      expect(fs.status('write')).toBe('pending')
      expect(fs.ready()).toEqual(['write'])
      expect(fs.inputs('write')[0].text).toContain('Feedback from the previous round (round 1 of 3)')
      expect(fs.inputs('write')[0].text).toContain('Add tests')
      finish(fs, 'write')
      fs.settle()
      finish(fs, 'review', 'approved', 'Good')
      fs.settle()
      expect(fs.status('loop')).toBe('done')
      expect(fs.node('loop').note).toBe('Finished: nothing was sent back.')
      expect(fs.node('loop').runs).toBe(2)
      expect(fs.ready()).toEqual(['summary'])
      expect(fs.inputs('summary').map((i) => i.label).sort()).toEqual(['Review', 'Revise'])
    })

    it('stops at the limit and carries the unresolved feedback out', () => {
      const fs = new FlowState(reviewLoop(2))
      fs.settle()
      for (let round = 1; round <= 2; round++) {
        finish(fs, 'write')
        fs.settle()
        finish(fs, 'review', 'changes', `Still wrong ${round}`)
        fs.settle()
      }
      expect(fs.status('loop')).toBe('done')
      expect(fs.loop('loop')!.iterations).toBe(2)
      expect(fs.node('loop').note).toMatch(/limit of 2 rounds/)
      expect(fs.node('loop').output).toContain('Unresolved feedback after 2 rounds')
      expect(fs.node('loop').output).toContain('Still wrong 2')
      // "approved" was never taken, so only the loop's "done" leads on.
      expect(fs.ready()).toEqual(['summary'])
      expect(fs.inputs('summary').map((i) => i.label)).toEqual(['Revise'])
    })

    it('stops when the phrase appears', () => {
      const fs = new FlowState(reviewLoop(5, 'lgtm'))
      fs.settle()
      finish(fs, 'write')
      fs.settle()
      finish(fs, 'review', 'changes', 'Nit: rename x. LGTM otherwise')
      fs.settle()
      expect(fs.status('loop')).toBe('done')
      expect(fs.loop('loop')!.iterations).toBe(1)
      expect(fs.node('loop').note).toMatch(/“lgtm” appeared/)
    })

    it('blocks the loop when a step in its body fails', () => {
      const fs = new FlowState(reviewLoop(3))
      fs.settle()
      fs.start('write')
      fs.fail('write', 'boom')
      fs.settle()
      expect(fs.status('review')).toBe('blocked')
      expect(fs.status('loop')).toBe('blocked')
      expect(fs.node('loop').error).toMatch(/loop body did not finish: “Write” failed/)
      expect(fs.status('summary')).toBe('blocked')
    })

    it('skips a loop that was never reached', () => {
      const g: WorkflowGraph = {
        nodes: [N('condition', 'c', { value: 'x' }), N('loop', 'loop'), agentNode('w'), N('review', 'r', { agent: role('code_reviewer') }), agentNode('end')],
        edges: [E('c', 'loop', 'true'), E('c', 'end', 'false'), E('loop', 'w', 'body'), E('w', 'r'), E('r', 'loop', 'changes', 'again')]
      }
      const fs = new FlowState(g)
      fs.settle()
      finish(fs, 'c', 'false')
      fs.settle()
      expect(fs.status('loop')).toBe('skipped')
      expect(fs.status('w')).toBe('skipped')
      expect(fs.status('r')).toBe('skipped')
      expect(fs.ready()).toEqual(['end'])
    })
  })

  describe('snapshot and resume', () => {
    it('restores a saved state and carries on', () => {
      const g: WorkflowGraph = { nodes: [agentNode('a'), agentNode('b')], edges: [E('a', 'b')] }
      const fs = new FlowState(g)
      fs.settle()
      finish(fs, 'a')
      const copy = FlowState.restore(g, [...fs.nodes.values()], JSON.parse(JSON.stringify(fs.snapshot())))
      copy.settle()
      expect(copy.ready()).toEqual(['b'])
      expect(copy.node('a').output).toBe('out:a')
    })

    it('ignores nodes and connections that no longer exist', () => {
      const g: WorkflowGraph = { nodes: [agentNode('a')], edges: [] }
      const fs = FlowState.restore(g, [{ ...new FlowState({ nodes: [agentNode('gone')], edges: [] }).node('gone') }], { edges: { ghost: 'active' }, tentative: {}, loops: { x: { iterations: 1, awaiting: true, input: '', feedback: '', exited: false } } })
      expect(fs.nodes.has('gone')).toBe(false)
      expect(fs.loop('x')).toBeUndefined()
    })

    it('queues failed and blocked steps again and keeps finished ones', () => {
      const g: WorkflowGraph = { nodes: [agentNode('a'), agentNode('b'), agentNode('c')], edges: [E('a', 'b'), E('b', 'c')] }
      const fs = new FlowState(g)
      fs.settle()
      finish(fs, 'a')
      fs.settle()
      fs.start('b')
      fs.fail('b', 'boom')
      fs.settle()
      expect(fs.status('c')).toBe('blocked')
      fs.prepareResume()
      expect([fs.status('a'), fs.status('b'), fs.status('c')]).toEqual(['done', 'pending', 'pending'])
      fs.settle()
      expect(fs.ready()).toEqual(['b'])
      expect(fs.node('b').runs).toBe(1)
    })

    it('puts a stopped loop back mid-round', () => {
      const g = reviewLoop(3)
      const live = new FlowState(g)
      live.settle()
      finish(live, 'write')
      live.settle()
      live.start('review')
      // The app stopped here: the review was in flight, the loop was between rounds.
      const saved = FlowState.restore(g, [...live.nodes.values()].map((n) => (n.nodeId === 'review' ? { ...n, status: 'failed' as const, error: 'Interrupted' } : { ...n })), JSON.parse(JSON.stringify(live.snapshot())))
      saved.prepareResume()
      expect(saved.status('loop')).toBe('running')
      expect(saved.loop('loop')!.iterations).toBe(1)
      expect(saved.status('write')).toBe('done')
      expect(saved.status('review')).toBe('pending')
      saved.settle()
      expect(saved.ready()).toEqual(['review'])
      finish(saved, 'review', 'approved', 'Good')
      saved.settle()
      expect(saved.status('loop')).toBe('done')
      expect(saved.ready()).toEqual(['summary'])
    })
  })
})

// ------------------------------------------------------------------ WorkflowService

describe('WorkflowService', () => {
  const setup = () => {
    const db = new Database(':memory:')
    db.migrate()
    db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p1', 'One', 'web', 'C:\\tmp\\p1', 1, 1)`)
    db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p2', 'Two', 'web', 'C:\\tmp\\p2', 1, 1)`)
    let t = 1000
    return { db, svc: new WorkflowService(db, new EventService(db), () => ++t) }
  }
  const graph: WorkflowGraph = { nodes: [agentNode('a')], edges: [] }

  it('saves, lists, loads, updates and deletes', () => {
    const { svc } = setup()
    const wf = svc.save({ projectId: 'p1', name: ' Mine ', graph })
    expect(wf).toMatchObject({ name: 'Mine', projectId: 'p1', version: 1 })
    expect(svc.get(wf.id)!.graph.nodes[0].id).toBe('a')
    const again = svc.save({ id: wf.id, projectId: 'p1', name: 'Mine v2', graph: { nodes: [agentNode('a'), agentNode('b')], edges: [E('a', 'b')] } })
    expect(again.version).toBe(2)
    expect(svc.list('p1')).toEqual([expect.objectContaining({ name: 'Mine v2', nodeCount: 2, version: 2 })])
    svc.remove(wf.id)
    expect(svc.get(wf.id)).toBeNull()
    svc.remove(wf.id) // deleting what is already gone is not an error
  })

  it('scopes workflows to a project; shared ones are visible everywhere', () => {
    const { svc } = setup()
    svc.save({ projectId: 'p1', name: 'Only one', graph })
    svc.save({ projectId: null, name: 'Everywhere', graph })
    expect(svc.list('p1').map((w) => w.name).sort()).toEqual(['Everywhere', 'Only one'])
    expect(svc.list('p2').map((w) => w.name)).toEqual(['Everywhere'])
    expect(svc.list(null).map((w) => w.name)).toEqual(['Everywhere'])
  })

  it('validates the name, the project and the graph', () => {
    const { svc } = setup()
    expect(() => svc.save({ projectId: 'p1', name: '  ', graph })).toThrow(/name/)
    expect(() => svc.save({ projectId: 'p1', name: 'x'.repeat(81), graph })).toThrow(/too long/)
    expect(() => svc.save({ projectId: 'nope', name: 'x', graph })).toThrow(/Project not found/)
    expect(() => svc.save({ projectId: 'p1', name: 'x', graph: { nodes: 'no' } as never })).toThrow(/list of nodes/)
    expect(() => svc.save({ id: 'missing', projectId: 'p1', name: 'x', graph })).toThrow(/not found/)
    svc.save({ projectId: 'p1', name: 'Same', graph })
    expect(() => svc.save({ projectId: 'p1', name: 'Same', graph })).toThrow(/already exists/)
    svc.save({ projectId: 'p2', name: 'Same', graph }) // another project may reuse the name
    svc.save({ projectId: null, name: 'Same', graph })
    expect(() => svc.save({ projectId: null, name: 'Same', graph })).toThrow(/already exists/)
  })

  it('saves an unfinished draft (it is checked when it runs)', () => {
    const { svc } = setup()
    expect(() => svc.save({ projectId: 'p1', name: 'Draft', graph: { nodes: [N('agent', 'a')], edges: [] } })).not.toThrow()
    expect(() => svc.save({ projectId: 'p1', name: 'Empty', graph: { nodes: [], edges: [] } })).not.toThrow()
  })

  it('refuses to delete a workflow while it is running, and keeps the history of runs when it is deleted', () => {
    const { db, svc } = setup()
    const wf = svc.save({ projectId: 'p1', name: 'W', graph })
    db.run(`INSERT INTO runs (id, project_id, workflow_id, goal, mode, status, created_at) VALUES ('r1', 'p1', ?, 'g', 'workflow', 'running', 1)`, wf.id)
    expect(() => svc.remove(wf.id)).toThrow(/in progress/)
    db.run(`UPDATE runs SET status = 'completed'`)
    svc.remove(wf.id)
    expect(db.get<{ workflow_id: string | null }>(`SELECT workflow_id FROM runs WHERE id = 'r1'`)!.workflow_id).toBeNull()
  })
})

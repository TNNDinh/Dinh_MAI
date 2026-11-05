import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CallFailedError } from '../src/main/orchestrator/gateway'
import { debateCalls, type WorkflowGraph } from '../src/shared/workflow'
import { E, N, agentNode, role } from './helpers/wf-builders'
import { makeFixture, promptOf, waitFor, type Fixture } from './helpers/wf-fixture'

let fx: Fixture
beforeEach(async () => {
  fx = await makeFixture()
})
afterEach(() => fx.dispose())

const chain = (...ids: string[]): WorkflowGraph => ({ nodes: ids.map((id) => agentNode(id, id.toUpperCase())), edges: ids.slice(1).map((id, i) => E(ids[i], id)) })
const gate = (): WorkflowGraph => ({
  nodes: [agentNode('a', 'Draft'), N('approval', 'gate', { message: 'Ship it?' }, 'Gate'), agentNode('yes', 'Ship'), agentNode('no', 'Rework')],
  edges: [E('a', 'gate'), E('gate', 'yes', 'approved'), E('gate', 'no', 'rejected')]
})
const startGate = async () => {
  fx.gw.handler = (s) => ({ text: `Output of ${s.taskTitle}` })
  const run = fx.engine.start({ workflowId: fx.save(gate()), goal: 'x' })
  await waitFor(() => fx.commands.approvals.list().length === 1)
  return run
}
const statuses = (state: { nodes: Array<{ nodeId: string; status: string }> }) => Object.fromEntries(state.nodes.map((n) => [n.nodeId, n.status]))

describe('human approval', () => {
  it('waits for the user and continues down the approved branch', async () => {
    const run = await startGate()
    const [req] = fx.commands.approvals.list()
    expect(req).toMatchObject({ kind: 'workflow', command: 'Ship it?', taskTitle: 'Gate', agentName: null })
    expect(req.detail).toContain('Output of Draft')
    expect(fx.node(fx.engine.getRunState(run.id), 'gate').status).toBe('waiting')
    expect(fx.orch.getRun(run.id)!.status).toBe('running')
    fx.commands.approvals.respond(req.id, true)
    await fx.engine.whenDone(run.id)
    const state = fx.engine.getRunState(run.id)
    expect(statuses(state)).toEqual({ a: 'done', gate: 'done', yes: 'done', no: 'skipped' })
    expect(fx.node(state, 'gate')).toMatchObject({ handle: 'approved', note: 'Approved by you' })
    expect(state.run.status).toBe('completed')
  })

  it('takes the rejected branch when the user says no', async () => {
    const run = await startGate()
    fx.commands.approvals.respond(fx.commands.approvals.list()[0].id, false)
    await fx.engine.whenDone(run.id)
    const state = fx.engine.getRunState(run.id)
    expect(statuses(state)).toEqual({ a: 'done', gate: 'done', yes: 'skipped', no: 'done' })
    expect(fx.node(state, 'gate').handle).toBe('rejected')
  })

  it('is cancelled by a stop, not treated as a rejection', async () => {
    const run = await startGate()
    const stopped = await fx.engine.stop(run.id)
    expect(stopped!.status).toBe('cancelled')
    expect(fx.commands.approvals.list()).toEqual([])
    const state = fx.engine.getRunState(run.id)
    expect(fx.node(state, 'gate')).toMatchObject({ status: 'failed', error: 'Stopped by the user.' })
    expect(fx.node(state, 'no').status).not.toBe('done')
    expect(fx.node(state, 'yes').status).not.toBe('done')
  })

  it('can be answered again after resuming a stopped run', async () => {
    const run = await startGate()
    await fx.engine.stop(run.id)
    fx.engine.resume({ id: run.id })
    await waitFor(() => fx.commands.approvals.list().length === 1)
    fx.commands.approvals.respond(fx.commands.approvals.list()[0].id, true)
    await fx.engine.whenDone(run.id)
    const state = fx.engine.getRunState(run.id)
    expect(state.run.status).toBe('completed')
    expect(fx.node(state, 'yes').status).toBe('done')
    // The draft was not written again.
    expect(fx.gw.forTask('Draft')).toHaveLength(1)
  })
})

describe('debate', () => {
  const debate = (extra: Record<string, unknown> = {}): WorkflowGraph => ({
    nodes: [
      N('debate', 'd', { question: 'Engine A or B?', participants: [role('technical_architect'), role('lead_developer')], rounds: 1, moderator: role('project_manager'), saveToMemory: true, ...extra } as never, 'Tech debate'),
      agentNode('after', 'After')
    ],
    edges: [E('d', 'after')]
  })

  it('makes every turn a real model call and records the moderator’s decision', async () => {
    fx.gw.handler = (s) => ({ text: `${s.role} speaks (call ${s.n})` })
    const { state, run } = await fx.go(debate())
    expect(run.status).toBe('completed')
    // 2 openings + 2 critiques + 1 decision.
    expect(fx.gw.forTask('Tech debate')).toHaveLength(debateCalls(2, 1))
    expect(fx.gw.seen.filter((s) => s.taskTitle === 'Tech debate').map((s) => s.role)).toEqual(expect.arrayContaining(['technical_architect', 'lead_developer', 'project_manager']))
    const last = fx.gw.forTask('Tech debate').at(-1)!
    expect(last.role).toBe('project_manager')
    // The critique round shows each participant the others' positions.
    const critique = fx.gw.forTask('Tech debate').filter((s) => promptOf(s).includes('Critique them'))
    expect(critique).toHaveLength(2)
    expect(promptOf(critique[0])).toMatch(/speaks \(call/)
    const d = fx.node(state, 'd')
    expect(d.output).toBe(`project_manager speaks (call 5)`)
    expect(d.note).toMatch(/2 agents · 1 critique round · 5 calls · saved to project memory/)
    // The decision is saved in project memory, written by the moderator.
    const mem = fx.db.all<{ kind: string; title: string; content: string; author: string }>(`SELECT * FROM memory_entries WHERE project_id = 'p1'`)
    expect(mem).toHaveLength(1)
    expect(mem[0].kind).toBe('decision')
    expect(mem[0].title).toContain('Engine A or B?')
    expect(mem[0].content).toContain('project_manager speaks (call 5)')
    expect(mem[0].author).toBe(fx.agents.list().find((a) => a.role === 'project_manager')!.id)
    // And the decision flows to the next step.
    expect(promptOf(fx.gw.forTask('After')[0])).toContain('project_manager speaks (call 5)')
    expect(fx.agents.list().every((a) => a.status !== 'working')).toBe(true)
  })

  it('can skip the critique rounds and the memory entry', async () => {
    fx.gw.handler = (s) => ({ text: `${s.role} says so` })
    const { run } = await fx.go(debate({ rounds: 0, saveToMemory: false }))
    expect(run.status).toBe('completed')
    expect(fx.gw.forTask('Tech debate')).toHaveLength(debateCalls(2, 0))
    expect(fx.db.all(`SELECT 1 FROM memory_entries`)).toHaveLength(0)
  })

  it('lets the moderator also take part', async () => {
    fx.gw.handler = (s) => ({ text: `${s.role} says so` })
    const { run } = await fx.go(debate({ rounds: 0, participants: [role('lead_developer'), role('project_manager')] }))
    expect(run.status).toBe('completed')
    expect(fx.gw.forTask('Tech debate')).toHaveLength(3)
  })

  it('refuses to start when two participants would be the same agent', async () => {
    const id = fx.save(debate({ participants: [role('technical_architect'), role('technical_architect')] }))
    expect(() => fx.engine.start({ workflowId: id, goal: 'x' })).toThrow(/same agent as another participant/)
    expect(fx.gw.seen).toHaveLength(0)
  })

  it('fails the step (and nothing is saved) when a participant gives no answer', async () => {
    fx.gw.handler = (s) => ({ text: s.role === 'lead_developer' ? '   ' : 'a position' })
    const { state, run } = await fx.go(debate())
    expect(run.status).toBe('failed')
    expect(fx.node(state, 'd').error).toMatch(/empty answer in the debate/)
    expect(fx.node(state, 'after').status).toBe('blocked')
    expect(fx.db.all(`SELECT 1 FROM memory_entries`)).toHaveLength(0)
    expect(fx.agents.list().every((a) => a.status !== 'working')).toBe(true)
  })
})

describe('budget', () => {
  it('pauses when the budget is reached and continues after the budget is raised, without redoing finished steps', async () => {
    const id = fx.save(chain('a', 'b', 'c'))
    const run = fx.engine.start({ workflowId: id, goal: 'x', budgetUsd: 0.015, concurrency: 1 })
    await fx.engine.whenDone(run.id)
    let state = fx.engine.getRunState(run.id)
    expect(state.run.status).toBe('paused')
    expect(state.run.error).toMatch(/Raise the budget and resume/)
    expect(statuses(state)).toEqual({ a: 'done', b: 'done', c: 'failed' })
    expect(fx.node(state, 'c').error).toMatch(/^Paused:/)
    expect(() => fx.engine.resume({ id: run.id })).toThrow(/already spent/)
    fx.engine.resume({ id: run.id, budgetUsd: 1 })
    await fx.engine.whenDone(run.id)
    state = fx.engine.getRunState(run.id)
    expect(state.run.status).toBe('completed')
    expect(statuses(state)).toEqual({ a: 'done', b: 'done', c: 'done' })
    expect(fx.gw.forTask('A')).toHaveLength(1)
    expect(fx.gw.forTask('B')).toHaveLength(1)
    expect(state.run.budgetUsd).toBe(1)
  })

  it('rejects a bad budget or concurrency before anything is created', () => {
    const id = fx.save(chain('a'))
    expect(() => fx.engine.start({ workflowId: id, goal: 'x', budgetUsd: 0 })).toThrow(/positive amount/)
    expect(() => fx.engine.start({ workflowId: id, goal: 'x', budgetUsd: Number.NaN })).toThrow(/positive amount/)
    expect(() => fx.engine.start({ workflowId: id, goal: 'x', concurrency: 9 })).toThrow(/Concurrency/)
    expect(fx.db.all(`SELECT 1 FROM runs`)).toHaveLength(0)
  })
})

describe('stop, resume and recovery', () => {
  it('stops a running step, then resumes without redoing what finished', async () => {
    let hold = true
    fx.gw.handler = async (s) => {
      if (hold && s.taskTitle === 'B') await new Promise<void>((r) => s.req.signal.addEventListener('abort', () => r()))
      return { text: `Output of ${s.taskTitle}` }
    }
    const run = fx.engine.start({ workflowId: fx.save(chain('a', 'b', 'c')), goal: 'x' })
    await waitFor(() => fx.gw.forTask('B').length === 1)
    const stopped = await fx.engine.stop(run.id)
    expect(stopped!.status).toBe('cancelled')
    let state = fx.engine.getRunState(run.id)
    // Nothing after the interrupted step was judged: it simply did not run.
    expect(statuses(state)).toEqual({ a: 'done', b: 'failed', c: 'pending' })
    expect(fx.node(state, 'b').error).toBe('Stopped by the user.')
    expect(fx.tasks.list({ projectId: 'p1' }).find((t) => t.title === 'B')).toMatchObject({ status: 'failed', error: 'Stopped by the user.' })
    expect(fx.agents.list().every((a) => a.status !== 'working')).toBe(true)

    hold = false
    fx.engine.resume({ id: run.id })
    await fx.engine.whenDone(run.id)
    state = fx.engine.getRunState(run.id)
    expect(state.run.status).toBe('completed')
    expect(statuses(state)).toEqual({ a: 'done', b: 'done', c: 'done' })
    expect(fx.gw.forTask('A')).toHaveLength(1)
    expect(fx.node(state, 'a').runs).toBe(1)
    expect(fx.tasks.list({ projectId: 'p1' }).filter((t) => t.title === 'B').map((t) => t.status).sort()).toEqual(['done', 'failed'])
    expect(fx.engine.isActive()).toBe(false)
  })

  it('stopAll stops every workflow run and reports how many', async () => {
    fx.gw.handler = async (s) => {
      await new Promise<void>((r) => s.req.signal.addEventListener('abort', () => r()))
      return { text: 'late' }
    }
    const run = fx.engine.start({ workflowId: fx.save(chain('a')), goal: 'x' })
    await waitFor(() => fx.gw.seen.length === 1)
    expect(await fx.engine.stopAll()).toBe(1)
    expect(fx.orch.getRun(run.id)!.status).toBe('cancelled')
    expect(await fx.engine.stopAll()).toBe(0)
  })

  it('shows a failed step, blocks what follows, and retries just those on resume', async () => {
    let failB = true
    fx.gw.handler = (s) => {
      if (failB && s.taskTitle === 'B') throw new CallFailedError('provider said no', 'bad_request', false)
      return { text: `Output of ${s.taskTitle}` }
    }
    const { id, state, run } = await fx.go(chain('a', 'b', 'c'))
    expect(run.status).toBe('failed')
    expect(run.error).toBe('2 of 3 steps did not finish (1 failed, 1 blocked).')
    expect(statuses(state)).toEqual({ a: 'done', b: 'failed', c: 'blocked' })
    expect(fx.node(state, 'b').error).toMatch(/provider said no/)
    expect(fx.node(state, 'c').error).toBe('Not run: “B” failed.')
    failB = false
    fx.engine.resume({ id })
    await fx.engine.whenDone(id)
    const after = fx.engine.getRunState(id)
    expect(after.run.status).toBe('completed')
    expect(statuses(after)).toEqual({ a: 'done', b: 'done', c: 'done' })
    expect(fx.gw.forTask('A')).toHaveLength(1)
  })

  it('refuses to resume a run that is running, completed or unknown, and to resume a workflow run as a planned run', async () => {
    const { id } = await fx.go(chain('a'))
    expect(() => fx.engine.resume({ id })).toThrow(/already completed/)
    expect(() => fx.engine.resume({ id: 'nope' })).toThrow(/Run not found/)
    fx.db.run(`UPDATE runs SET status = 'failed' WHERE id = ?`, id)
    expect(() => fx.orch.resume({ id })).toThrow(/executes a workflow/)
  })

  it('marks steps that were in flight when the app closed as interrupted', async () => {
    const { id } = await fx.go(chain('a', 'b'))
    fx.db.run(`UPDATE run_node_states SET status = 'running', finished_at = NULL WHERE run_id = ? AND node_id = 'b'`, id)
    fx.db.run(`UPDATE runs SET status = 'paused' WHERE id = ?`, id)
    expect(fx.engine.recover()).toBe(1)
    const state = fx.engine.getRunState(id)
    expect(fx.node(state, 'b')).toMatchObject({ status: 'failed' })
    expect(fx.node(state, 'b').error).toMatch(/Interrupted/)
    expect(fx.node(state, 'a').status).toBe('done')
    // …and the paused run can be continued: only the interrupted step runs again.
    fx.engine.resume({ id })
    await fx.engine.whenDone(id)
    expect(fx.engine.getRunState(id).run.status).toBe('completed')
    expect(fx.gw.forTask('A')).toHaveLength(1)
    expect(fx.gw.forTask('B')).toHaveLength(2)
  })

  it('leaves the steps of a live run alone when recovering', async () => {
    fx.gw.handler = async (s) => {
      await new Promise<void>((r) => s.req.signal.addEventListener('abort', () => r()))
      return { text: 'late' }
    }
    const run = fx.engine.start({ workflowId: fx.save(chain('a')), goal: 'x' })
    await waitFor(() => fx.gw.seen.length === 1)
    expect(fx.engine.recover()).toBe(0)
    await fx.engine.stop(run.id)
  })
})

describe('refusing to start', () => {
  it('says what is missing from the team', async () => {
    const bare = await makeFixture(['project_manager'])
    try {
      const id = bare.save(chain('a'))
      expect(() => bare.engine.start({ workflowId: id, goal: 'x' })).toThrow(/This workflow cannot run yet:\n- .*no agent with the role “lead_developer”/)
      expect(bare.db.all(`SELECT 1 FROM runs`)).toHaveLength(0)
      expect(bare.gw.seen).toHaveLength(0)
    } finally {
      bare.dispose()
    }
  })

  it('refuses an unfinished or empty workflow', () => {
    const draft = fx.save({ nodes: [N('agent', 'a')], edges: [] })
    expect(() => fx.engine.start({ workflowId: draft, goal: 'x' })).toThrow(/choose which agent or role/)
    const empty = fx.save({ nodes: [], edges: [] })
    expect(() => fx.engine.start({ workflowId: empty, goal: 'x' })).toThrow(/empty/)
  })

  it('refuses a second run in the same project', async () => {
    fx.gw.handler = async (s) => {
      await new Promise<void>((r) => s.req.signal.addEventListener('abort', () => r()))
      return { text: 'late' }
    }
    const id = fx.save(chain('a'))
    const run = fx.engine.start({ workflowId: id, goal: 'x' })
    expect(() => fx.engine.start({ workflowId: id, goal: 'again' })).toThrow(/already has a run in progress/)
    expect(() => fx.orch.start({ projectId: 'p1', goal: 'planned' })).toThrow(/already has a run in progress/)
    await fx.engine.stop(run.id)
  })

  it('needs a goal, and a project for a shared workflow', async () => {
    const id = fx.save(chain('a'))
    expect(() => fx.engine.start({ workflowId: id, goal: '   ' })).toThrow(/Describe the goal/)
    // With no goal given, the project's own goal is used.
    const r = fx.engine.start({ workflowId: id })
    await fx.engine.whenDone(r.id)
    expect(fx.orch.getRun(r.id)!.goal).toBe('Ship the thing')

    const shared = fx.wfs.save({ projectId: null, name: 'Shared', graph: chain('a') })
    expect(() => fx.engine.start({ workflowId: shared.id, goal: 'x' })).toThrow(/choose the project/)
    const r2 = fx.engine.start({ workflowId: shared.id, goal: 'x', projectId: 'p1' })
    await fx.engine.whenDone(r2.id)
    expect(fx.orch.getRun(r2.id)).toMatchObject({ projectId: 'p1', status: 'completed' })
    expect(() => fx.engine.start({ workflowId: 'nope', goal: 'x' })).toThrow(/Workflow not found/)
    fx.db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p2', 'Other', 'web', ?, 1, 1)`, `${fx.root}-other`)
    expect(() => fx.engine.start({ workflowId: id, goal: 'x', projectId: 'p2' })).toThrow(/belongs to another project/)
  })
})

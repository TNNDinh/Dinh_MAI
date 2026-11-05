import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkflowGraph } from '../src/shared/workflow'
import { E, N, agentNode, role } from './helpers/wf-builders'
import { decision, isDecision, makeFixture, promptOf, verdict, waitFor, type Fixture } from './helpers/wf-fixture'

let fx: Fixture
beforeEach(async () => {
  fx = await makeFixture()
})
afterEach(() => fx.dispose())

const reviewLoop = (max = 3): WorkflowGraph => ({
  nodes: [
    N('loop', 'loop', { maxIterations: max }, 'Revise'),
    agentNode('write', 'Write'),
    N('review', 'review', { agent: role('code_reviewer') }, 'Review'),
    agentNode('summary', 'Summary', 'project_manager')
  ],
  edges: [E('loop', 'write', 'body'), E('write', 'review'), E('review', 'loop', 'changes', 'again'), E('review', 'summary', 'approved'), E('loop', 'summary', 'done')]
})
const chain = (...ids: string[]): WorkflowGraph => ({ nodes: ids.map((id) => agentNode(id, id.toUpperCase())), edges: ids.slice(1).map((id, i) => E(ids[i], id)) })

describe('a linear workflow', () => {
  it('runs each step with a real task, passes results along and records everything', async () => {
    fx.gw.handler = (s) => ({ text: `Output of ${s.taskTitle}` })
    const { id, state, run } = await fx.go(chain('a', 'b'))
    expect(run.status).toBe('completed')
    expect(run.workflowId).toEqual(expect.any(String))
    expect(state.nodes.map((n) => n.status)).toEqual(['done', 'done'])
    expect(fx.node(state, 'a')).toMatchObject({ output: 'Output of A', handle: 'out', runs: 1 })
    // The second step was shown what the first produced, and its instruction was filled with the goal.
    expect(promptOf(fx.gw.forTask('B')[0])).toContain('Output of A')
    expect(fx.tasks.list({ projectId: 'p1' }).map((t) => [t.title, t.status])).toEqual(expect.arrayContaining([['A', 'done'], ['B', 'done']]))
    expect(run.spentUsd).toBeCloseTo(0.02)
    const types = fx.events.recent({ runId: id } as never).map((e) => e.type)
    expect(types.filter((t) => t === 'workflow.step.started')).toHaveLength(2)
    expect(types).toContain('run.completed')
    // Workflow steps are plain steps: they cannot re-plan the run.
    expect(fx.gw.seen.every((s) => !s.req.tools?.some((t) => t.name === 'create_task'))).toBe(true)
    // After the run nobody is left "working".
    expect(fx.agents.list().every((a) => a.status !== 'working')).toBe(true)
  })

  it('puts the goal into {{goal}}', async () => {
    const g: WorkflowGraph = { nodes: [N('agent', 'a', { agent: role('lead_developer'), instruction: 'Build: {{goal}}' }, 'A')], edges: [] }
    await fx.go(g, { goal: 'a tiny game' })
    expect(fx.tasks.list({ projectId: 'p1' }).find((t) => t.title === 'A')!.description).toBe('Build: a tiny game')
  })

  it('lists runs of a workflow, newest first, and reports a run that does not exist', async () => {
    const wfId = fx.save(chain('a'))
    const one = fx.engine.start({ workflowId: wfId, goal: 'one' })
    await fx.engine.whenDone(one.id)
    const two = fx.engine.start({ workflowId: wfId, goal: 'two' })
    await fx.engine.whenDone(two.id)
    expect(fx.engine.listRuns(wfId).map((r) => r.goal)).toEqual(['two', 'one'])
    expect(fx.engine.isWorkflowRun(one.id)).toBe(true)
    expect(fx.engine.isWorkflowRun('nope')).toBe(false)
    expect(() => fx.engine.getRunState('nope')).toThrow(/Run not found/)
  })
})

describe('review loops', () => {
  it('sends work back with the reviewer’s feedback until it is approved', async () => {
    let reviews = 0
    fx.gw.handler = (s) => {
      if (s.taskTitle === 'Review') return ++reviews === 1 ? verdict('changes', 'Add tests') : verdict('approved', 'Looks good')
      return { text: `Result of ${s.taskTitle} #${s.n}` }
    }
    const { state, run } = await fx.go(reviewLoop())
    expect(run.status).toBe('completed')
    const writes = fx.gw.forTask('Write')
    expect(writes).toHaveLength(2)
    expect(promptOf(writes[0])).not.toContain('Add tests')
    expect(promptOf(writes[1])).toContain('Add tests')
    // On the second round the author also sees its own earlier result.
    expect(promptOf(writes[1])).toContain('Your previous result for this step')
    expect(fx.node(state, 'loop')).toMatchObject({ status: 'done', handle: 'done', runs: 2, note: 'Finished: nothing was sent back.' })
    expect(fx.node(state, 'review')).toMatchObject({ handle: 'approved', note: 'Approved' })
    expect(fx.node(state, 'summary').status).toBe('done')
    expect(fx.tasks.list({ projectId: 'p1' })).toHaveLength(5)
  })

  it('stops at the round limit and still runs what follows', async () => {
    fx.gw.handler = (s) => (s.taskTitle === 'Review' ? verdict('changes', 'Still broken') : { text: `Result of ${s.taskTitle}` })
    const { state, run } = await fx.go(reviewLoop(2))
    expect(run.status).toBe('completed')
    expect(fx.gw.forTask('Write')).toHaveLength(2)
    expect(fx.gw.forTask('Review')).toHaveLength(2)
    expect(fx.node(state, 'loop').note).toMatch(/limit of 2 rounds/)
    expect(fx.node(state, 'summary').status).toBe('done')
    expect(promptOf(fx.gw.forTask('Summary')[0])).toContain('Unresolved feedback after 2 rounds')
  })

  it('fails a review that gives no verdict', async () => {
    fx.gw.handler = (s) => ({ text: s.taskTitle === 'Review' ? 'Looks fine to me' : 'done' })
    const { state, run } = await fx.go(reviewLoop())
    expect(run.status).toBe('failed')
    expect(fx.node(state, 'review')).toMatchObject({ status: 'failed' })
    expect(fx.node(state, 'review').error).toMatch(/verdict/i)
    expect(fx.node(state, 'loop').status).toBe('blocked')
    expect(fx.node(state, 'summary').status).toBe('blocked')
  })

  it('refuses a verdict without feedback when changes are requested', async () => {
    let n = 0
    fx.gw.handler = (s) => {
      if (s.taskTitle !== 'Review') return { text: 'written' }
      return ++n === 1 ? { tools: [{ name: 'submit_verdict', args: { verdict: 'changes', feedback: '' } }] } : verdict('approved', 'ok')
    }
    const { run } = await fx.go(reviewLoop())
    expect(run.status).toBe('completed')
    // The tool refused the empty feedback and the reviewer was asked again.
    expect(fx.gw.forTask('Review').length).toBeGreaterThanOrEqual(2)
  })
})

describe('test steps', () => {
  const branch = (command: string): WorkflowGraph => ({
    nodes: [N('test', 't', { command, timeoutSec: 60 }, 'Run tests'), agentNode('ok', 'Passed'), agentNode('bad', 'Failed')],
    edges: [E('t', 'ok', 'pass'), E('t', 'bad', 'fail')]
  })

  it('takes the "pass" output when the command exits with 0', async () => {
    const { state, run } = await fx.go(branch('node pass.js'))
    expect(run.status).toBe('completed')
    expect(fx.node(state, 't')).toMatchObject({ status: 'done', handle: 'pass', note: 'Passed' })
    expect(fx.node(state, 't').output).toContain('Exit code 0')
    expect(fx.node(state, 't').output).toContain('all tests passed')
    expect(fx.node(state, 'ok').status).toBe('done')
    expect(fx.node(state, 'bad').status).toBe('skipped')
    // The step that follows was given the test output.
    expect(promptOf(fx.gw.forTask('Passed')[0])).toContain('all tests passed')
  })

  it('takes the "fail" output on a non-zero exit code', async () => {
    const { state, run } = await fx.go(branch('node fail.js'))
    expect(run.status).toBe('completed')
    expect(fx.node(state, 't')).toMatchObject({ status: 'done', handle: 'fail' })
    expect(fx.node(state, 't').output).toContain('Exit code 1')
    expect(fx.node(state, 't').output).toContain('1 test failed')
    expect(fx.node(state, 'ok').status).toBe('skipped')
    expect(fx.node(state, 'bad').status).toBe('done')
  })

  it('fails the step when the command is refused (nothing is pretended to have passed)', async () => {
    const id = fx.save(branch('curl http://example.com'))
    const run = fx.engine.start({ workflowId: id, goal: 'x' })
    // An unusual command waits for the user; refuse it. (If the policy blocks it outright, there is nothing to answer.)
    while (fx.engine.isActive(run.id)) {
      for (const p of fx.commands.approvals.list()) fx.commands.approvals.respond(p.id, false)
      await new Promise((r) => setTimeout(r, 5))
    }
    const state = fx.engine.getRunState(run.id)
    expect(state.run.status).toBe('failed')
    expect(fx.node(state, 't').status).toBe('failed')
    expect(fx.node(state, 't').error).toMatch(/The command was not run/)
    expect(fx.node(state, 'ok').status).toBe('blocked')
    expect(fx.node(state, 'bad').status).toBe('blocked')
  })
})

describe('condition steps', () => {
  const cond = (config: Record<string, unknown>): WorkflowGraph => ({
    nodes: [agentNode('a', 'Source'), N('condition', 'c', config as never, 'Check'), agentNode('yes', 'Yes'), agentNode('no', 'No')],
    edges: [E('a', 'c'), E('c', 'yes', 'true'), E('c', 'no', 'false')]
  })
  const statuses = (state: { nodes: Array<{ nodeId: string; status: string }> }) => Object.fromEntries(state.nodes.map((n) => [n.nodeId, n.status]))

  it('branches on a phrase (case-insensitive)', async () => {
    fx.gw.handler = () => ({ text: 'ALL GOOD here' })
    const { state } = await fx.go(cond({ mode: 'contains', value: 'good' }))
    expect(statuses(state)).toEqual({ a: 'done', c: 'done', yes: 'done', no: 'skipped' })
    expect(fx.node(state, 'c').handle).toBe('true')
    // The condition passes its input through.
    expect(promptOf(fx.gw.forTask('Yes')[0])).toContain('ALL GOOD here')
  })

  it('branches on a regular expression', async () => {
    fx.gw.handler = () => ({ text: 'all good here' })
    const { state } = await fx.go(cond({ mode: 'regex', value: '^all\\s+bad' }))
    expect(statuses(state)).toEqual({ a: 'done', c: 'done', yes: 'skipped', no: 'done' })
  })

  it('asks an agent a yes/no question and takes its answer through a tool', async () => {
    fx.gw.handler = (s) => (isDecision(s) ? decision(true, 'It builds.') : { text: 'work done' })
    const { state } = await fx.go(cond({ mode: 'ai', value: 'Does it build?', agent: role('qa_tester') }))
    expect(statuses(state)).toEqual({ a: 'done', c: 'done', yes: 'done', no: 'skipped' })
    expect(fx.node(state, 'c').note).toBe('It builds.')
    const call = fx.gw.seen.find(isDecision)!
    expect(call.role).toBe('qa_tester')
    expect(promptOf(call)).toContain('Does it build?')
    expect(promptOf(call)).toContain('work done')
  })

  it('fails when the agent never answers through the tool', async () => {
    fx.gw.handler = (s) => ({ text: isDecision(s) ? 'Probably yes' : 'work done' })
    const { state, run } = await fx.go(cond({ mode: 'ai', value: 'Does it build?', agent: role('qa_tester') }))
    expect(run.status).toBe('failed')
    expect(fx.node(state, 'c').error).toMatch(/did not answer the question/)
    expect(fx.gw.seen.filter(isDecision)).toHaveLength(2)
    expect(statuses(state)).toMatchObject({ yes: 'blocked', no: 'blocked' })
  })
})

describe('agents are used one step at a time', () => {
  const fan = (a: string, b: string): WorkflowGraph => ({
    nodes: [agentNode('root', 'Root'), agentNode('x', 'X', a), agentNode('y', 'Y', b)],
    edges: [E('root', 'x'), E('root', 'y')]
  })

  it('lets one agent do only one step of a run at a time', async () => {
    let active = 0
    let most = 0
    fx.gw.handler = async () => {
      active++
      most = Math.max(most, active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      return { text: 'ok' }
    }
    const { state, run } = await fx.go(fan('lead_developer', 'lead_developer'))
    expect(run.status).toBe('completed')
    expect(state.nodes.every((n) => n.status === 'done')).toBe(true)
    expect(most).toBe(1)
  })

  it('runs steps of different agents in parallel', async () => {
    let active = 0
    fx.gw.handler = async (s) => {
      if (s.taskTitle === 'Root') return { text: 'ok' }
      active++
      await waitFor(() => active === 2)
      return { text: 'ok' }
    }
    const { run } = await fx.go(fan('lead_developer', 'qa_tester'))
    expect(run.status).toBe('completed')
  })

  it('respects the concurrency limit', async () => {
    let active = 0
    let most = 0
    fx.gw.handler = async () => {
      active++
      most = Math.max(most, active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      return { text: 'ok' }
    }
    const { run } = await fx.go(fan('lead_developer', 'qa_tester'), { concurrency: 1 })
    expect(run.status).toBe('completed')
    expect(most).toBe(1)
  })
})

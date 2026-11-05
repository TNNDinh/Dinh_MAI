import '@xyflow/react/dist/style.css'
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, ReactFlowProvider, applyEdgeChanges, applyNodeChanges, useReactFlow, type Connection, type EdgeChange, type NodeChange } from '@xyflow/react'
import { ChevronDown, ChevronUp, Play, Plus, Save, Trash2, TriangleAlert, Workflow as WorkflowIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Run, WorkflowRunState } from '../../../shared/ipc'
import { checkGraph, checkTeam, newNode, sourceHandleOf, type Workflow, type WorkflowNode, type WorkflowNodeType, type WorkflowSummary } from '../../../shared/workflow'
import { errMsg } from '../components/connections/StatusBadge'
import { Inspector } from '../components/workflow/Inspector'
import { NewDialog, type NewChoice } from '../components/workflow/NewDialog'
import { DRAG_TYPE, Palette } from '../components/workflow/Palette'
import { RunDialog } from '../components/workflow/RunDialog'
import { RunPanel } from '../components/workflow/RunPanel'
import { StepNodeView } from '../components/workflow/StepNodeView'
import { fromFlow, graphKey, makeEdge, newId, summarize, toFlow, type StepEdge, type StepNode } from '../components/workflow/model'
import { Badge, Button, EmptyState, Input, Select, cx } from '../components/ui'
import { useWorkspaceProject } from '../lib/use-workspace-project'
import { useStudio } from '../store'

const NODE_TYPES_MAP = { step: StepNodeView }

/** What is open in the editor besides the drawing itself. */
interface Open {
  id: string | null
  projectId: string | null
  name: string
  /** Bumped on every load so the canvas re-fits its view. */
  loadId: number
}

/** The "nothing changed" marker for a stored workflow, computed the same way as the live key (through the canvas representation). */
function savedKeyOf(wf: Workflow): string {
  const f = toFlow(wf.graph)
  return `${wf.name}|${wf.projectId}|${graphKey(fromFlow(f.nodes, f.edges))}`
}

export function WorkflowPage() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  )
}

function Editor() {
  const projects = useStudio((s) => s.projects)
  const agents = useStudio((s) => s.agents)
  const templates = useStudio((s) => s.agentTemplates)
  const setWorkspaceProject = useStudio((s) => s.setWorkspaceProject)
  const project = useWorkspaceProject()
  const flow = useReactFlow<StepNode, StepEdge>()
  const wrapper = useRef<HTMLDivElement>(null)

  const [list, setList] = useState<WorkflowSummary[]>([])
  const [open, setOpen] = useState<Open | null>(null)
  const [nodes, setNodes] = useState<StepNode[]>([])
  const [edges, setEdges] = useState<StepEdge[]>([])
  const [savedKey, setSavedKey] = useState('')
  const [notice, setNotice] = useState<{ tone: 'err' | 'ok'; text: string } | null>(null)
  const [dialog, setDialog] = useState<'new' | 'run' | null>(null)
  const [bottom, setBottom] = useState<'run' | 'problems' | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [runState, setRunState] = useState<WorkflowRunState | null>(null)
  const [busy, setBusy] = useState(false)
  const openRef = useRef<Open | null>(null)
  openRef.current = open

  const projectId = project?.id ?? null
  const team = useMemo(() => agents.filter((a) => a.projectId === projectId), [agents, projectId])
  const graph = useMemo(() => fromFlow(nodes, edges), [nodes, edges])
  const key = useMemo(() => (open ? `${open.name}|${open.projectId}|${graphKey(graph)}` : ''), [open, graph])
  const dirty = open !== null && key !== savedKey
  const issues = useMemo(() => (open ? [...checkGraph(graph), ...checkTeam(graph, team)] : []), [open, graph, team])
  const errors = issues.filter((i) => i.severity === 'error')
  const selectedId = nodes.find((n) => n.selected)?.id ?? null
  const selected = selectedId ? (graph.nodes.find((n) => n.id === selectedId) ?? null) : null

  // ---- loading

  const reloadList = useCallback(async (): Promise<WorkflowSummary[]> => {
    if (!projectId) return []
    const l = await window.api.invoke('workflows:list', projectId)
    setList(l)
    return l
  }, [projectId])

  const show = useCallback((wf: Workflow): void => {
    const f = toFlow(wf.graph)
    setNodes(f.nodes)
    setEdges(f.edges)
    setOpen((o) => ({ id: wf.id, projectId: wf.projectId, name: wf.name, loadId: (o?.loadId ?? 0) + 1 }))
    setSavedKey(savedKeyOf(wf))
    setRunId(null)
    setRunState(null)
    setRuns([])
  }, [])

  const openById = useCallback(
    async (id: string): Promise<void> => {
      try {
        const wf = await window.api.invoke('workflows:get', id)
        if (wf) show(wf)
        else setNotice({ tone: 'err', text: 'That workflow no longer exists.' })
      } catch (e) {
        setNotice({ tone: 'err', text: errMsg(e) })
      }
    },
    [show]
  )

  // Opening the page (or switching project): list what is available and open the first one.
  useEffect(() => {
    setOpen((o) => (o && o.projectId !== null && o.projectId !== projectId ? null : o))
    void reloadList().then(
      (l) => {
        if (!openRef.current && l[0]) void openById(l[0].id)
      },
      (e) => setNotice({ tone: 'err', text: errMsg(e) })
    )
  }, [projectId, reloadList, openById])

  // ---- runs

  const loadRun = useCallback(async (id: string): Promise<void> => {
    try {
      setRunState(await window.api.invoke('workflows:runState', id))
    } catch {
      setRunState(null)
    }
  }, [])

  const loadRuns = useCallback(
    async (workflowId: string, pick?: string): Promise<void> => {
      const l = (await window.api.invoke('workflows:runs', workflowId)).sort((a, b) => b.createdAt - a.createdAt)
      setRuns(l)
      const id = pick ?? l[0]?.id ?? null
      setRunId((cur) => pick ?? cur ?? id)
      if (id) await loadRun(pick ?? id)
    },
    [loadRun]
  )

  const openId = open?.id ?? null
  useEffect(() => {
    if (openId) void loadRuns(openId).catch(() => undefined)
  }, [openId, loadRuns])

  // Steps start and finish while you watch: every event of the watched run refreshes it (batched).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!runId || !openId) return
    const off = window.api.onActivity((e) => {
      if (e.runId !== runId) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void Promise.all([loadRun(runId), loadRuns(openId, runId)]).catch(() => undefined), 200)
    })
    return () => {
      off()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [runId, openId, loadRun, loadRuns])

  // The canvas changes size when the bottom panel opens or closes: keep the whole graph in view.
  useEffect(() => {
    const t = setTimeout(() => void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 150 }), 60)
    return () => clearTimeout(t)
  }, [bottom, flow])

  const pickRun = (id: string): void => {
    setRunId(id)
    void loadRun(id)
  }

  // ---- editing

  const touch = (): void => setNotice(null)
  const onNodesChange = useCallback((changes: NodeChange<StepNode>[]) => {
    if (changes.some((c) => c.type === 'remove')) {
      const gone = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
      setEdges((es) => es.filter((e) => !gone.has(e.source) && !gone.has(e.target)))
    }
    setNodes((ns) => applyNodeChanges(changes, ns))
  }, [])
  const onEdgesChange = useCallback((changes: EdgeChange<StepEdge>[]) => setEdges((es) => applyEdgeChanges(changes, es)), [])

  const isValidConnection = useCallback(
    (c: Connection | StepEdge): boolean => {
      if (c.source === c.target) return false
      const s = nodes.find((n) => n.id === c.source)
      if (!s) return false
      const sh = c.sourceHandle ?? sourceHandleOf({ id: '', source: c.source, target: c.target, sourceHandle: null, targetHandle: null }, s.data.wf.type)
      const th = c.targetHandle ?? 'in'
      return !edges.some((e) => e.source === c.source && e.sourceHandle === sh && e.target === c.target && (e.targetHandle ?? 'in') === th)
    },
    [nodes, edges]
  )

  const onConnect = useCallback(
    (c: Connection) => {
      touch()
      setEdges((es) => [...es, makeEdge(newId('e'), c.source, c.target, c.sourceHandle, c.targetHandle)])
    },
    []
  )

  const addNode = (type: WorkflowNodeType, at?: { x: number; y: number }): void => {
    touch()
    const box = wrapper.current?.getBoundingClientRect()
    const pos = at ?? (box ? flow.screenToFlowPosition({ x: box.left + box.width / 2 - 125, y: box.top + box.height / 2 - 40 }) : { x: 0, y: 0 })
    // Several clicks on the palette must not stack nodes exactly on top of each other.
    const offset = (nodes.length % 6) * 24
    const n = newNode(type, newId(type), { x: Math.round(pos.x + (at ? 0 : offset)), y: Math.round(pos.y + (at ? 0 : offset)) })
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { id: n.id, type: 'step' as const, position: n.position, selected: true, data: { wf: n as WorkflowNode, run: null, problem: null, summary: '' } }])
  }

  const onDrop = (e: React.DragEvent): void => {
    const type = e.dataTransfer.getData(DRAG_TYPE) as WorkflowNodeType
    if (!type) return
    e.preventDefault()
    addNode(type, flow.screenToFlowPosition({ x: e.clientX - 125, y: e.clientY - 20 }))
  }

  const updateNode = (next: WorkflowNode): void => {
    touch()
    setNodes((ns) => ns.map((n) => (n.id === next.id ? { ...n, data: { ...n.data, wf: next } } : n)))
  }
  const deleteNode = (id: string): void => {
    touch()
    setNodes((ns) => ns.filter((n) => n.id !== id))
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id))
  }
  const select = (id: string): void => setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })))

  // ---- saving, creating, deleting

  const save = async (): Promise<Workflow | null> => {
    if (!open) return null
    setBusy(true)
    try {
      const wf = await window.api.invoke('workflows:save', { id: open.id ?? undefined, projectId: open.projectId, name: open.name.trim() || 'Untitled workflow', graph })
      setOpen({ ...open, id: wf.id, name: wf.name })
      setSavedKey(savedKeyOf(wf))
      setNotice({ tone: 'ok', text: `Saved “${wf.name}”.` })
      await reloadList()
      return wf
    } catch (e) {
      setNotice({ tone: 'err', text: errMsg(e) })
      return null
    } finally {
      setBusy(false)
    }
  }

  const create = (c: NewChoice): void => {
    const g = structuredClone(c.template.graph)
    const f = toFlow(g)
    setNodes(f.nodes)
    setEdges(f.edges)
    setOpen((o) => ({ id: null, projectId: c.projectId, name: c.name, loadId: (o?.loadId ?? 0) + 1 }))
    setSavedKey('')
    setRunId(null)
    setRunState(null)
    setRuns([])
    setDialog(null)
    setNotice(null)
  }

  const remove = async (): Promise<void> => {
    if (!open) return
    if (open.id && !window.confirm(`Delete “${open.name}”? Its past runs stay in the history.`)) return
    try {
      if (open.id) await window.api.invoke('workflows:remove', open.id)
      setOpen(null)
      setNodes([])
      setEdges([])
      const l = await reloadList()
      if (l[0]) await openById(l[0].id)
    } catch (e) {
      setNotice({ tone: 'err', text: errMsg(e) })
    }
  }

  const choose = (id: string): void => {
    if (dirty && !window.confirm('Discard the changes you have not saved?')) return
    void openById(id)
  }

  const startRun = async (): Promise<void> => {
    if (errors.length > 0) {
      setBottom('problems')
      return setNotice({ tone: 'err', text: `Fix ${errors.length} problem${errors.length === 1 ? '' : 's'} first: a workflow with problems cannot run.` })
    }
    if (dirty || !open?.id) {
      if (!(await save())) return
    }
    setDialog('run')
  }

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      setNotice({ tone: 'err', text: errMsg(e) })
    } finally {
      setBusy(false)
    }
  }
  const stop = (): Promise<void> => act(async () => void (runId && (await window.api.invoke('runs:stop', runId))))
  const resume = (budgetUsd?: number | null): Promise<void> => act(async () => void (runId && (await window.api.invoke('runs:resume', { id: runId, ...(budgetUsd !== undefined ? { budgetUsd } : {}) }))))

  // ---- what the canvas shows

  const states = useMemo(() => {
    if (!runState || !open?.id || runState.run.workflowId !== open.id) return null
    return new Map(runState.nodes.map((n) => [n.nodeId, n]))
  }, [runState, open?.id])
  const problems = useMemo(() => {
    const m = new Map<string, 'error' | 'warning'>()
    for (const i of issues) if (i.nodeId && m.get(i.nodeId) !== 'error') m.set(i.nodeId, i.severity)
    return m
  }, [issues])
  const shownNodes = useMemo(
    () => nodes.map((n) => ({ ...n, data: { wf: n.data.wf, run: states?.get(n.id) ?? null, problem: problems.get(n.id) ?? null, summary: summarize(n.data.wf, agents, templates) } })),
    [nodes, states, problems, agents, templates]
  )
  const shownEdges = useMemo(() => edges.map((e) => (e.data?.again ? { ...e, style: { stroke: 'var(--color-warn)', strokeDasharray: '6 4' } } : e)), [edges])

  const live = runState?.run.status === 'running' && states !== null

  if (!project) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold">Workflow Editor</h1>
        <EmptyState icon={<WorkflowIcon size={28} />} title="No project yet">
          Create a project first: workflows run in a project, with its team of agents.
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-wf-page>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <WorkflowIcon size={16} className="text-accent" />
        <h1 className="mr-2 text-sm font-semibold">Workflow Editor</h1>
        <Select value={project.id} onChange={(e) => setWorkspaceProject(e.target.value)} aria-label="Project" className="w-44!">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select value={open?.id ?? ''} onChange={(e) => choose(e.target.value)} aria-label="Workflow" className="w-56!" data-wf-select>
          {open && !open.id && <option value="">{open.name} (not saved)</option>}
          {!open && <option value="">{list.length === 0 ? 'No workflows yet' : 'Choose a workflow…'}</option>}
          {list.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.projectId === null ? ' · shared' : ''}
            </option>
          ))}
        </Select>
        <Button size="sm" onClick={() => setDialog('new')} data-wf-action="new">
          <Plus size={13} /> New
        </Button>
        {open && (
          <>
            <Input value={open.name} onChange={(e) => setOpen({ ...open, name: e.target.value })} aria-label="Workflow name" className="w-52!" data-wf-name />
            <Badge tone={open.projectId === null ? 'info' : 'neutral'}>{open.projectId === null ? 'Shared' : 'This project'}</Badge>
            {dirty && <span className="text-[11px] text-warn" data-wf-dirty>Unsaved changes</span>}
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" onClick={() => setBottom(bottom === 'problems' ? null : 'problems')} data-wf-action="problems" title="Problems found in the graph and the team">
                <TriangleAlert size={13} className={errors.length ? 'text-err' : issues.length ? 'text-warn' : 'text-faint'} /> {issues.length}
              </Button>
              <Button size="sm" onClick={() => void save()} disabled={busy || !dirty} data-wf-action="save">
                <Save size={13} /> Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void remove()} aria-label="Delete workflow" data-wf-action="delete">
                <Trash2 size={13} />
              </Button>
              <Button size="sm" variant="primary" onClick={() => void startRun()} disabled={busy || live} data-wf-action="run">
                <Play size={13} /> Run
              </Button>
            </div>
          </>
        )}
      </div>
      {notice && (
        <div className={cx('border-b px-4 py-1.5 text-xs whitespace-pre-wrap', notice.tone === 'err' ? 'border-err/30 bg-err/10 text-err' : 'border-ok/30 bg-ok/10 text-ok')} data-wf-notice={notice.tone}>
          {notice.text}
        </div>
      )}
      {!open ? (
        <EmptyState
          icon={<WorkflowIcon size={28} />}
          title="No workflow open"
          action={
            <Button variant="primary" onClick={() => setDialog('new')} data-wf-action="new-empty">
              <Plus size={14} /> New workflow
            </Button>
          }
        >
          A workflow is a graph of steps — agents, reviews, tests, loops, debates and your approval — that the team carries out in order. Start from a template or a blank step.
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <Palette onAdd={(t) => addNode(t)} disabled={false} />
            <div ref={wrapper} className="relative min-w-0 flex-1" data-wf-canvas onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
              <ReactFlow<StepNode, StepEdge>
                key={open.loadId}
                nodes={shownNodes}
                edges={shownEdges}
                nodeTypes={NODE_TYPES_MAP}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                isValidConnection={isValidConnection}
                colorMode="dark"
                fitView
                fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
                minZoom={0.2}
                deleteKeyCode={['Delete', 'Backspace']}
                proOptions={{ hideAttribution: true }}
                onPaneClick={() => touch()}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#2a3040" />
                <Controls showInteractive={false} />
                <MiniMap pannable zoomable style={{ width: 120, height: 80 }} className="!bg-panel" maskColor="rgb(10 12 16 / 0.7)" nodeColor="#2a3040" />
              </ReactFlow>
            </div>
            {selected && <Inspector key={selected.id} node={selected} team={team} templates={templates} issues={issues.filter((i) => i.nodeId === selected.id)} onChange={updateNode} onDelete={() => deleteNode(selected.id)} onClose={() => setNodes((ns) => ns.map((n) => ({ ...n, selected: false })))} readOnly={false} />}
          </div>
          <div className="border-t border-line bg-panel">
            <div className="flex items-center gap-1 px-3 pt-1">
              {(['run', 'problems'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  data-wf-tab={t}
                  onClick={() => setBottom(bottom === t ? null : t)}
                  className={cx('rounded px-2.5 py-1 text-xs', bottom === t ? 'bg-hover text-fg' : 'text-muted hover:text-fg')}
                >
                  {t === 'run' ? 'Run' : `Problems (${issues.length})`}
                </button>
              ))}
              <button type="button" onClick={() => setBottom(bottom ? null : 'run')} className="ml-auto rounded p-1 text-muted hover:bg-hover hover:text-fg" aria-label={bottom ? 'Hide the panel' : 'Show the panel'}>
                {bottom ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>
            </div>
            {bottom === 'run' && (
              <div className="h-[220px]">
                <RunPanel runs={runs} state={states ? runState : null} nodes={graph.nodes} selectedId={selectedId} onPickRun={pickRun} onSelectNode={select} onStop={() => void stop()} onResume={(b) => void resume(b)} busy={busy} />
              </div>
            )}
            {bottom === 'problems' && (
              <ul className="h-[220px] space-y-1 overflow-y-auto p-3" data-wf-problems>
                {issues.length === 0 && <li className="text-xs text-ok">No problems: this workflow can run.</li>}
                {issues.map((i, k) => (
                  <li key={k}>
                    <button
                      type="button"
                      disabled={!i.nodeId}
                      onClick={() => i.nodeId && select(i.nodeId)}
                      className={cx('w-full rounded border px-2 py-1 text-left text-xs', i.severity === 'error' ? 'border-err/30 bg-err/10 text-err' : 'border-warn/30 bg-warn/10 text-warn')}
                    >
                      {i.message}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {dialog === 'new' && <NewDialog project={project} onClose={() => setDialog(null)} onCreate={create} />}
      {dialog === 'run' && open?.id && (
        <RunDialog
          workflowId={open.id}
          shared={open.projectId === null}
          projects={projects}
          project={project}
          onClose={() => setDialog(null)}
          onStarted={(run) => {
            setDialog(null)
            setBottom('run')
            setRuns((r) => [run, ...r.filter((x) => x.id !== run.id)])
            setRunId(run.id)
            void loadRun(run.id)
          }}
        />
      )}
    </div>
  )
}

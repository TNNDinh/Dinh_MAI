import { OctagonX, Play } from 'lucide-react'
import { useState } from 'react'
import type { Run, RunStatus, WorkflowRunState } from '../../../../shared/ipc'
import type { WorkflowNode } from '../../../../shared/workflow'
import { fmtUsd, timeAgo } from '../../lib/format'
import { Badge, Button, Input, Select, cx } from '../ui'
import { STATUS_LABEL, STATUS_TEXT } from './model'

const RUN_TONE: Record<RunStatus, 'neutral' | 'accent' | 'ok' | 'warn' | 'err' | 'info'> = {
  pending: 'neutral',
  running: 'info',
  paused: 'warn',
  completed: 'ok',
  failed: 'err',
  cancelled: 'neutral'
}

export interface RunPanelProps {
  runs: Run[]
  state: WorkflowRunState | null
  nodes: WorkflowNode[]
  selectedId: string | null
  onPickRun: (id: string) => void
  onSelectNode: (id: string) => void
  onStop: () => void
  onResume: (budgetUsd?: number | null) => void
  busy: boolean
}

/** The run being watched: its state, the way each step went, and what the selected step produced. */
export function RunPanel({ runs, state, nodes, selectedId, onPickRun, onSelectNode, onStop, onResume, busy }: RunPanelProps) {
  const [budget, setBudget] = useState('')
  const run = state?.run ?? null
  const byId = new Map((state?.nodes ?? []).map((n) => [n.nodeId, n]))
  const sel = selectedId ? (byId.get(selectedId) ?? null) : null
  const selNode = nodes.find((n) => n.id === selectedId) ?? null
  const active = run?.status === 'running'
  const canResume = run && (run.status === 'paused' || run.status === 'failed' || run.status === 'cancelled')
  return (
    <div className="flex h-full min-h-0 flex-col" data-wf-run-panel>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <Select value={run?.id ?? ''} onChange={(e) => onPickRun(e.target.value)} aria-label="Run history" className="w-64!" data-wf-run-select>
          {runs.length === 0 && <option value="">No runs yet</option>}
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.status} · {timeAgo(r.createdAt)} · {r.goal.slice(0, 40) || 'no goal'}
            </option>
          ))}
        </Select>
        {run && (
          <>
            <span data-wf-run-status={run.status}>
              <Badge tone={RUN_TONE[run.status]}>{run.status}</Badge>
            </span>
            <span className="text-xs text-muted" data-wf-run-spent>
              {fmtUsd(run.spentUsd)}
              {run.unpricedCalls > 0 ? '+' : ''}
              {run.budgetUsd != null ? ` of ${fmtUsd(run.budgetUsd)}` : ''}
            </span>
            {run.iteration > 0 && <span className="text-xs text-faint">{run.iteration} rework round{run.iteration === 1 ? '' : 's'}</span>}
            {run.error && (
              <span className="min-w-0 flex-1 truncate text-xs text-err" title={run.error} data-wf-run-error>
                {run.error}
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          {canResume && run.status === 'paused' && <Input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="New budget $ (optional)" className="w-44!" aria-label="New budget" />}
          {canResume && (
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onResume(budget.trim() === '' ? undefined : Number(budget))} data-wf-action="resume">
              <Play size={13} /> Resume
            </Button>
          )}
          {active && (
            <Button size="sm" variant="danger" disabled={busy} onClick={onStop} data-wf-action="stop">
              <OctagonX size={13} /> Stop
            </Button>
          )}
        </div>
      </div>
      {!state ? (
        <p className="p-4 text-xs text-faint">Run the workflow to watch it here. Every step lights up as it starts, finishes or needs you.</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,320px)_1fr]">
          <ul className="min-h-0 overflow-y-auto border-r border-line py-1" data-wf-run-nodes>
            {nodes.map((n) => {
              const s = byId.get(n.id)
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onSelectNode(n.id)}
                    data-wf-run-node={n.id}
                    className={cx('flex w-full items-center gap-2 px-4 py-1 text-left text-xs hover:bg-hover', n.id === selectedId && 'bg-hover')}
                  >
                    <span className="min-w-0 flex-1 truncate">{n.label}</span>
                    <span className={cx('shrink-0 text-[11px]', s ? STATUS_TEXT[s.status] : 'text-faint')}>{s ? STATUS_LABEL[s.status] : '—'}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="min-h-0 overflow-y-auto p-4 text-xs" data-selectable data-wf-output>
            {!selNode ? (
              <p className="text-faint">Select a step to see what it produced.</p>
            ) : !sel ? (
              <p className="text-faint">“{selNode.label}” is not part of this run (the graph was edited after it started).</p>
            ) : (
              <>
                <div className="mb-1 font-medium">{selNode.label}</div>
                {sel.error && <p className="mb-2 rounded border border-err/30 bg-err/10 p-2 text-err">{sel.error}</p>}
                {sel.note && <p className="mb-2 text-faint">{sel.note}</p>}
                {sel.output ? <pre className="font-mono text-[12px] break-words whitespace-pre-wrap text-muted">{sel.output}</pre> : !sel.error && <p className="text-faint">Nothing produced yet.</p>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

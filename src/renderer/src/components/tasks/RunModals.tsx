import { AlertTriangle, Play } from 'lucide-react'
import { useState } from 'react'
import type { Project, Run } from '../../../../shared/ipc'
import { useStudio } from '../../store'
import { fmtUsd } from '../../lib/format'
import { Button, Field, Input, Modal, Textarea } from '../ui'
import { errMsg } from '../connections/StatusBadge'

/** Parses an optional positive number. '' = null (no limit); anything else invalid = undefined. */
function parseBudget(raw: string): number | null | undefined {
  const t = raw.trim().replace(',', '.')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function StartRunModal({ project, onClose, onStarted }: { project: Project; onClose: () => void; onStarted: (run: Run) => void }) {
  const agents = useStudio((s) => s.agents)
  const refresh = useStudio((s) => s.refresh)
  const team = agents.filter((a) => a.projectId === project.id && a.enabled)
  const pms = team.filter((a) => a.role === 'project_manager')
  const readyPm = pms.find((a) => a.issues.length === 0)
  const runnable = team.filter((a) => a.kind === 'chat' && a.issues.length === 0)
  const stuck = team.filter((a) => a.issues.length > 0)

  const [goal, setGoal] = useState(project.goal)
  const [budget, setBudget] = useState(project.budgetUsd === null ? '' : String(project.budgetUsd))
  const [iterations, setIterations] = useState(String(project.maxIterations))
  const [concurrency, setConcurrency] = useState('3')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    const budgetUsd = parseBudget(budget)
    const maxIterations = Number(iterations)
    const conc = Number(concurrency)
    if (!goal.trim()) return setError('Describe what the team should build.')
    if (budgetUsd === undefined) return setError('Budget must be a positive amount, or empty for no limit.')
    if (!Number.isInteger(maxIterations) || maxIterations < 0 || maxIterations > 50) return setError('Review rounds must be a whole number from 0 to 50.')
    if (!Number.isInteger(conc) || conc < 1 || conc > 8) return setError('Parallel tasks must be a whole number from 1 to 8.')
    setBusy(true)
    setError(null)
    try {
      const run = await window.api.invoke('runs:start', { projectId: project.id, goal: goal.trim(), budgetUsd, maxIterations, concurrency: conc })
      await refresh()
      onStarted(run)
    } catch (e) {
      setError(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`Start a run · ${project.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void start()} disabled={busy || !readyPm} data-action="confirm-start-run">
            <Play size={13} /> {busy ? 'Starting…' : 'Start run'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!readyPm && (
          <div role="alert" className="flex gap-2 rounded-md border border-warn/30 bg-warn/10 p-3 text-xs text-warn" data-testid="run-not-ready">
            <AlertTriangle size={14} className="mt-px shrink-0" />
            <span>
              {pms.length === 0
                ? 'This project has no enabled Project Manager. Add one on the AI Agents page (“Add the full team”).'
                : `The Project Manager cannot run yet: ${pms[0].issues.join('; ').replace(/\.$/, '')}.`}
            </span>
          </div>
        )}
        <Field label="Goal" hint="The Project Manager turns this into a task graph for the team.">
          <Textarea rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="Run goal" autoFocus />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Budget (USD)" hint="Empty = no limit">
            <Input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="no limit" aria-label="Run budget" />
          </Field>
          <Field label="Review rounds" hint="Times work may be sent back">
            <Input value={iterations} onChange={(e) => setIterations(e.target.value)} inputMode="numeric" aria-label="Review rounds" />
          </Field>
          <Field label="Parallel tasks" hint="1–8 at once">
            <Input value={concurrency} onChange={(e) => setConcurrency(e.target.value)} inputMode="numeric" aria-label="Parallel tasks" />
          </Field>
        </div>
        <p className="text-[11px] leading-relaxed text-faint">
          {runnable.length} agent{runnable.length === 1 ? '' : 's'} ready
          {stuck.length > 0 && ` · ${stuck.length} need setup (${stuck.map((a) => a.name).join(', ')}) and will fail any task given to them`}. The budget is checked before every model call, so a call already in flight can finish slightly over it. Models without a price can’t be counted against it.
        </p>
        {error && (
          <p role="alert" className="text-xs text-err">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

export function ResumeModal({ run, onClose, onResumed }: { run: Run; onClose: () => void; onResumed: () => void }) {
  const refresh = useStudio((s) => s.refresh)
  const needsBudget = run.budgetUsd !== null && run.spentUsd >= run.budgetUsd
  const [budget, setBudget] = useState(needsBudget ? String(Math.ceil((run.spentUsd + 1) * 100) / 100) : run.budgetUsd === null ? '' : String(run.budgetUsd))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function resume() {
    const budgetUsd = parseBudget(budget)
    if (budgetUsd === undefined) return setError('Budget must be a positive amount, or empty for no limit.')
    setBusy(true)
    setError(null)
    try {
      await window.api.invoke('runs:resume', { id: run.id, budgetUsd })
      await refresh()
      onResumed()
    } catch (e) {
      setError(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Resume run"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void resume()} disabled={busy} data-action="confirm-resume-run">
            <Play size={13} /> {busy ? 'Resuming…' : 'Resume'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-muted">
          Finished tasks are kept. Failed and blocked tasks are retried, and the plan is not made again.
          {needsBudget && ` The run has spent ${fmtUsd(run.spentUsd)} of its ${fmtUsd(run.budgetUsd!)} budget, so raise it to continue.`}
        </p>
        <Field label="Budget (USD)" hint="Empty = no limit">
          <Input value={budget} onChange={(e) => setBudget(e.target.value)} inputMode="decimal" placeholder="no limit" aria-label="Resume budget" autoFocus />
        </Field>
        {error && (
          <p role="alert" className="text-xs text-err">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

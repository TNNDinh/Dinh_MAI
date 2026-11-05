import { useState } from 'react'
import type { Project, Run, StartWorkflowInput } from '../../../../shared/ipc'
import { Button, Field, Input, Modal, Select, Textarea } from '../ui'
import { errMsg } from '../connections/StatusBadge'

/** Asks for what `{{goal}}` means, the spending limit and how many steps may run at once, then starts the run. */
export function RunDialog({ workflowId, shared, projects, project, onClose, onStarted }: { workflowId: string; shared: boolean; projects: Project[]; project: Project; onClose: () => void; onStarted: (run: Run) => void }) {
  const [projectId, setProjectId] = useState(project.id)
  const chosen = projects.find((p) => p.id === projectId) ?? project
  const [goal, setGoal] = useState<string | null>(null)
  const [budget, setBudget] = useState('')
  const [concurrency, setConcurrency] = useState('3')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (): Promise<void> => {
    const b = budget.trim() === '' ? null : Number(budget)
    if (b !== null && (!Number.isFinite(b) || b <= 0)) return setError('The budget must be a positive number of dollars, or empty for no limit.')
    setBusy(true)
    setError(null)
    try {
      const input: StartWorkflowInput = { workflowId, projectId, goal: (goal ?? chosen.goal).trim() || undefined, budgetUsd: b, concurrency: Number(concurrency) || 3 }
      onStarted(await window.api.invoke('workflows:run', input))
    } catch (e) {
      setError(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Run workflow"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void start()} data-wf-action="confirm-run">
            {busy ? 'Starting…' : 'Run'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {shared && (
          <Field label="Project to run in" hint="This workflow is shared by every project; its team and folder come from the project you pick.">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Goal" hint="What {{goal}} stands for in the steps’ text. Defaults to the project’s goal.">
          <Textarea rows={4} value={goal ?? chosen.goal} onChange={(e) => setGoal(e.target.value)} data-wf-field="run-goal" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Budget in dollars" hint="Empty = no limit. The run pauses when it is reached.">
            <Input value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="e.g. 2.50" data-wf-field="run-budget" />
          </Field>
          <Field label="Steps at once" hint="1–8">
            <Input type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
          </Field>
        </div>
        <p className="text-[11.5px] leading-relaxed text-faint">The agents in this workflow call real models and are billed to your connections. Commands still need your approval unless the project’s policy allows them.</p>
        {error && (
          <p className="rounded border border-err/30 bg-err/10 p-2 text-xs whitespace-pre-wrap text-err" data-wf-run-refused>
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

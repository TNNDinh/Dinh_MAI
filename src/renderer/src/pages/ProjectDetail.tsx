import { ArrowLeft, ExternalLink, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { PROJECT_TYPES, type Project, type ProjectStatus, type ProjectType } from '../../../shared/ipc'
import { useStudio } from '../store'
import { Badge, Button, Card, CardHeader, Field, Input, Modal, PageHeader, ProgressBar, Select, Textarea } from '../components/ui'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function ProjectDetail({ project }: { project: Project }) {
  const { openProject, refresh } = useStudio()
  const [name, setName] = useState(project.name)
  const [goal, setGoal] = useState(project.goal)
  const [type, setType] = useState<ProjectType>(project.type)
  const [status, setStatus] = useState<ProjectStatus>(project.status)
  const [budget, setBudget] = useState(project.budgetUsd === null ? '' : String(project.budgetUsd))
  const [maxIter, setMaxIter] = useState(String(project.maxIterations))
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const dirty =
    name !== project.name ||
    goal !== project.goal ||
    type !== project.type ||
    status !== project.status ||
    budget !== (project.budgetUsd === null ? '' : String(project.budgetUsd)) ||
    maxIter !== String(project.maxIterations)

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const budgetNum = budget.trim() === '' ? null : Number(budget)
      if (budgetNum !== null && (!Number.isFinite(budgetNum) || budgetNum < 0)) throw new Error('Budget must be a positive number or empty.')
      await window.api.invoke('projects:update', {
        id: project.id,
        name: name.trim(),
        goal: goal.trim(),
        type,
        status,
        budgetUsd: budgetNum,
        maxIterations: Number(maxIter) || project.maxIterations
      })
      await refresh()
      setSaved(true)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    try {
      await window.api.invoke('projects:remove', project.id)
      await refresh()
      openProject(null)
    } catch (e) {
      setConfirmRemove(false)
      setError(errMsg(e))
    }
  }

  return (
    <div className="page-enter mx-auto max-w-4xl p-6">
      <button onClick={() => openProject(null)} className="mb-3 flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft size={13} /> All projects
      </button>
      <PageHeader
        title={project.name}
        subtitle={<span data-selectable>{project.rootPath}</span>}
        action={
          <Button onClick={() => void window.api.invoke('projects:reveal', project.id).catch((e) => setError(errMsg(e)))}>
            <ExternalLink size={14} /> Show in Explorer
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader title="Settings" />
          <div className="space-y-4 p-4">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Goal">
              <Textarea rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">
                <Select value={type} onChange={(e) => setType(e.target.value as ProjectType)}>
                  {PROJECT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Status">
                <Select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
                  <option value="active">Active</option>
                  <option value="completed">Completed</option>
                  <option value="archived">Archived</option>
                </Select>
              </Field>
              <Field label="Budget (USD)" hint="Empty = no limit">
                <Input type="number" min="0" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} />
              </Field>
              <Field label="Max iterations">
                <Input type="number" min="1" max="50" value={maxIter} onChange={(e) => setMaxIter(e.target.value)} />
              </Field>
            </div>
            {error && (
              <div role="alert" className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs text-err">
                {error}
              </div>
            )}
            <div className="flex items-center justify-end gap-3">
              {saved && !dirty && <span className="text-xs text-ok">Saved</span>}
              <Button variant="primary" onClick={save} disabled={busy || !dirty || !name.trim()}>
                {busy ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Progress" />
            <div className="space-y-2 p-4">
              <ProgressBar value={project.progress} />
              <div className="flex items-center justify-between text-xs text-muted">
                <span>{Math.round(project.progress * 100)}% complete</span>
                <Badge tone={project.status === 'active' ? 'accent' : 'neutral'}>{project.status}</Badge>
              </div>
              <p className="pt-1 text-[11px] text-faint">Progress is the share of finished tasks on the project’s task board.</p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Danger zone" />
            <div className="space-y-2 p-4">
              <p className="text-xs text-muted">Remove this project from the studio. Your files on disk are not touched.</p>
              <Button variant="danger" size="sm" onClick={() => setConfirmRemove(true)}>
                <Trash2 size={13} /> Remove from studio
              </Button>
            </div>
          </Card>
        </div>
      </div>

      {confirmRemove && (
        <Modal
          title="Remove project?"
          onClose={() => setConfirmRemove(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={remove}>
                Remove
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-muted">
            <span className="font-medium text-fg">{project.name}</span> and its task, run and usage history will be removed from the studio.
            <br />
            <span className="text-ok">No files are deleted from</span> <span className="font-mono text-xs text-fg">{project.rootPath}</span>.
          </p>
        </Modal>
      )}
    </div>
  )
}

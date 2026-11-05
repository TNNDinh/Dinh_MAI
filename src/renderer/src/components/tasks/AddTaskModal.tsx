import { useState } from 'react'
import type { Project, Task } from '../../../../shared/ipc'
import { useStudio } from '../../store'
import { Button, Field, Input, Modal, Select, Textarea } from '../ui'
import { errMsg } from '../connections/StatusBadge'
import { PRIORITY_LABEL } from './meta'

export function AddTaskModal({ project, onClose, onCreated }: { project: Project; onClose: () => void; onCreated: (t: Task) => void }) {
  const { agents, tasks, agentTemplates, refresh } = useStudio()
  const team = agents.filter((a) => a.projectId === project.id)
  const existing = tasks.filter((t) => t.projectId === project.id)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [owner, setOwner] = useState('') // '' | 'role:<key>' | 'agent:<id>'
  const [priority, setPriority] = useState('2')
  const [deps, setDeps] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const roles = [...new Set(team.map((a) => a.role))]
  const roleLabel = (key: string) => agentTemplates.find((t) => t.key === key)?.label ?? key

  async function create() {
    if (!title.trim()) return setError('Give the task a title.')
    setBusy(true)
    setError(null)
    try {
      const task = await window.api.invoke('tasks:create', {
        projectId: project.id,
        title: title.trim(),
        description,
        role: owner.startsWith('role:') ? owner.slice(5) : null,
        assignedAgentId: owner.startsWith('agent:') ? owner.slice(6) : null,
        priority: Number(priority),
        dependsOn: deps
      })
      await refresh()
      onCreated(task)
    } catch (e) {
      setError(errMsg(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Add task"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void create()} disabled={busy} data-action="confirm-add-task">
            {busy ? 'Adding…' : 'Add task'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task title" autoFocus maxLength={200} />
        </Field>
        <Field label="Description" hint="What “done” looks like. The agent sees exactly this.">
          <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Task description" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assign to" hint="A role is resolved to a free agent when the task is scheduled.">
            <Select value={owner} onChange={(e) => setOwner(e.target.value)} aria-label="Assign to">
              <option value="">Nobody yet</option>
              {roles.length > 0 && (
                <optgroup label="Any agent with role">
                  {roles.map((r) => (
                    <option key={r} value={`role:${r}`}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </optgroup>
              )}
              {team.length > 0 && (
                <optgroup label="Specific agent">
                  {team.map((a) => (
                    <option key={a.id} value={`agent:${a.id}`}>
                      {a.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
              {[1, 2, 3].map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {existing.length > 0 && (
          <fieldset>
            <legend className="mb-1 text-xs font-medium text-muted">Waits for</legend>
            <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border border-line bg-bg p-2">
              {existing.map((t) => (
                <li key={t.id}>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={deps.includes(t.id)}
                      onChange={(e) => setDeps((d) => (e.target.checked ? [...d, t.id] : d.filter((x) => x !== t.id)))}
                    />
                    <span className="truncate">{t.title}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <p className="text-[11px] text-faint">Tasks with an owner are picked up by the next run in this project; tasks with nobody assigned stay on the board.</p>
        {error && (
          <p role="alert" className="text-xs text-err">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

import { Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Task, TaskDetail, TaskLogEntry, UpdateTaskInput } from '../../../../shared/ipc'
import { useStudio } from '../../store'
import { fmtTime, fmtTokens, fmtUsd } from '../../lib/format'
import { Button, Select, cx } from '../ui'
import { errMsg } from '../connections/StatusBadge'
import { PRIORITY_LABEL, TaskStatusBadge } from './meta'

const LOG_STYLE: Record<TaskLogEntry['role'], string> = {
  system: 'border-warn/30 bg-warn/5',
  user: 'border-line bg-bg',
  assistant: 'border-accent/30 bg-accent-soft',
  tool: 'border-line bg-elev'
}
const LOG_LABEL: Record<TaskLogEntry['role'], string> = { system: 'System', user: 'Prompt', assistant: 'Agent', tool: 'Tool' }

function LogEntry({ e }: { e: TaskLogEntry }) {
  const [open, setOpen] = useState(false)
  const long = e.content.length > 400
  const text = long && !open ? `${e.content.slice(0, 400)}…` : e.content
  return (
    <li className={cx('rounded-md border px-2.5 py-2', LOG_STYLE[e.role])} data-log-role={e.role}>
      <div className="mb-1 flex justify-between text-[10px] text-faint">
        <span className="font-medium tracking-wide uppercase">
          {LOG_LABEL[e.role]}
          {e.agentName && e.role !== 'tool' ? ` · ${e.agentName}` : ''}
        </span>
        <span>{fmtTime(e.createdAt)}</span>
      </div>
      <pre className="font-sans text-[12px] leading-relaxed break-words whitespace-pre-wrap text-fg" data-selectable>
        {text}
      </pre>
      {long && (
        <button onClick={() => setOpen(!open)} className="mt-1 text-[11px] text-accent hover:underline">
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </li>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-faint uppercase">{title}</h4>
      {children}
    </section>
  )
}

export function TaskDrawer({ task, onClose }: { task: Task; onClose: () => void }) {
  const { agents, tasks, agentTemplates, refresh, setSelectedTask } = useStudio()
  const latestEvent = useStudio((s) => s.events[0]?.id)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Reload the log when the task changes, and while it runs whenever new activity arrives.
  const live = task.status === 'in_progress'
  useEffect(() => {
    let cancelled = false
    void window.api.invoke('tasks:get', task.id).then(
      (d) => !cancelled && setDetail(d),
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [task.id, task.updatedAt, task.status, live ? latestEvent : null])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('[role="dialog"]') && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const team = agents.filter((a) => a.projectId === task.projectId && a.kind === 'chat')
  const roleLabel = (key: string | null) => (key ? (agentTemplates.find((t) => t.key === key)?.label ?? key) : null)
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const dependents = tasks.filter((t) => t.dependsOn.includes(task.id))
  const locked = task.status === 'in_progress'

  async function act(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await refresh()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const update = (patch: Omit<UpdateTaskInput, 'id'>) =>
    act(() => window.api.invoke('tasks:update', { id: task.id, ...patch }))

  const owner = task.assignedAgentId ? `agent:${task.assignedAgentId}` : task.role ? `role:${task.role}` : ''
  const roles = [...new Set(team.map((a) => a.role))]

  return (
    <aside
      aria-label="Task details"
      data-testid="task-drawer"
      className="page-enter fixed top-9 right-0 bottom-6 z-40 flex w-[460px] max-w-[92vw] flex-col border-l border-line bg-panel shadow-2xl"
    >
      <div className="flex shrink-0 items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm leading-snug font-semibold break-words" data-selectable>
            {task.title}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <TaskStatusBadge status={task.status} />
            <span>{PRIORITY_LABEL[task.priority] ?? task.priority} priority</span>
            {task.attempts > 0 && <span>· attempt {task.attempts}</span>}
          </div>
        </div>
        <button onClick={onClose} aria-label="Close task details" className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
          <X size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {task.error && (
          <div role="alert" className="rounded-md border border-err/30 bg-err/10 p-2.5 text-xs break-words text-err" data-selectable>
            {task.error}
          </div>
        )}

        {task.description && (
          <Section title="Description">
            <p className="text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-fg" data-selectable>
              {task.description}
            </p>
          </Section>
        )}

        <Section title="Assignment">
          <div className="grid grid-cols-2 gap-2">
            <Select
              aria-label="Assignee"
              value={owner}
              disabled={locked || busy}
              onChange={(e) => {
                const v = e.target.value
                void update({ role: v.startsWith('role:') ? v.slice(5) : null, assignedAgentId: v.startsWith('agent:') ? v.slice(6) : null })
              }}
            >
              <option value="">Nobody</option>
              <optgroup label="Any agent with role">
                {roles.map((r) => (
                  <option key={r} value={`role:${r}`}>
                    {roleLabel(r)}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Specific agent">
                {team.map((a) => (
                  <option key={a.id} value={`agent:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
            </Select>
            <Select aria-label="Priority" value={task.priority} disabled={locked || busy} onChange={(e) => void update({ priority: Number(e.target.value) })}>
              {[1, 2, 3].map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]} priority
                </option>
              ))}
            </Select>
          </div>
          <p className="mt-1.5 text-[11px] text-faint">
            {task.assignedAgentName ? `Last worked on by ${task.assignedAgentName}.` : task.role ? `Will go to a free ${roleLabel(task.role)}.` : 'Not assigned: a run will not pick this task up.'}
          </p>
        </Section>

        <Section title="Usage">
          <dl className="grid grid-cols-3 gap-2 text-xs">
            {[
              ['Input', fmtTokens(task.inputTokens)],
              ['Output', fmtTokens(task.outputTokens)],
              ['Cost', fmtUsd(task.costUsd)]
            ].map(([l, v]) => (
              <div key={l} className="rounded-md border border-line bg-bg px-2.5 py-1.5">
                <dt className="text-[10px] text-faint">{l}</dt>
                <dd className="tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </Section>

        {(task.dependsOn.length > 0 || dependents.length > 0) && (
          <Section title="Dependencies">
            <ul className="space-y-1 text-xs">
              {task.dependsOn.map((id) => {
                const d = byId.get(id)
                return (
                  <li key={id} className="flex items-center gap-2">
                    <span className="text-faint">waits for</span>
                    {d ? (
                      <button onClick={() => setSelectedTask(d.id)} className="min-w-0 truncate text-accent hover:underline">
                        {d.title}
                      </button>
                    ) : (
                      <span className="text-faint">(removed)</span>
                    )}
                    {d && <TaskStatusBadge status={d.status} />}
                  </li>
                )
              })}
              {dependents.map((d) => (
                <li key={d.id} className="flex items-center gap-2">
                  <span className="text-faint">blocks</span>
                  <button onClick={() => setSelectedTask(d.id)} className="min-w-0 truncate text-accent hover:underline">
                    {d.title}
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {task.resultSummary && (
          <Section title="Result">
            <p className="max-h-72 overflow-y-auto rounded-md border border-line bg-bg p-2.5 text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-fg" data-selectable data-testid="task-result">
              {task.resultSummary}
            </p>
          </Section>
        )}

        <Section title={`Agent log${detail ? ` (${detail.log.length})` : ''}`}>
          {!detail ? (
            <p className="text-xs text-faint">Loading…</p>
          ) : detail.log.length === 0 ? (
            <p className="text-xs text-faint">Nothing yet. The conversation with the model appears here once an agent works on this task.</p>
          ) : (
            <ul className="space-y-1.5" data-testid="task-log">
              {detail.log.map((e) => (
                <LogEntry key={e.id} e={e} />
              ))}
            </ul>
          )}
        </Section>

        {error && (
          <p role="alert" className="text-xs text-err">
            {error}
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
        {task.status !== 'todo' && (
          <Button size="sm" disabled={locked || busy} onClick={() => void update({ status: 'todo' })} title="Run it again on the next run">
            Back to to-do
          </Button>
        )}
        {task.status !== 'done' && (
          <Button size="sm" disabled={locked || busy} onClick={() => void update({ status: 'done' })} title="Mark as finished without running it">
            Mark done
          </Button>
        )}
        {task.status !== 'blocked' && task.status !== 'done' && (
          <Button size="sm" disabled={locked || busy} onClick={() => void update({ status: 'blocked' })}>
            Block
          </Button>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="danger"
          disabled={locked || busy}
          title={locked ? 'Stop the run before deleting a running task' : 'Delete this task'}
          onClick={() => void act(async () => {
            await window.api.invoke('tasks:remove', task.id)
            onClose()
          })}
        >
          <Trash2 size={12} /> Delete
        </Button>
      </div>
    </aside>
  )
}

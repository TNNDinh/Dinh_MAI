import { AlertTriangle, Bot, Plus, Users } from 'lucide-react'
import { useState } from 'react'
import { useStudio } from '../store'
import { Button, Card, EmptyState, PageHeader, Select, cx } from '../components/ui'
import { AgentDetail } from '../components/agents/AgentDetail'
import { NewAgentModal } from '../components/agents/NewAgentModal'
import { errMsg } from '../components/connections/StatusBadge'

const DOT = { ready: 'bg-ok', setup: 'bg-warn', off: 'bg-faint/50' } as const

/** '' = everything, 'library' = global agents, otherwise a project id. */
type Scope = string

export function Agents() {
  const { agents, projects, selectedAgentId, setSelectedAgent, refresh } = useStudio()
  const [scope, setScope] = useState<Scope>('')
  const [adding, setAdding] = useState(false)
  const [teamMsg, setTeamMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const visible = agents.filter((a) => (scope === '' ? true : scope === 'library' ? a.projectId === null : a.projectId === scope))
  const selected = visible.find((a) => a.id === selectedAgentId) ?? visible[0] ?? null
  const projectName = (id: string | null) => (id ? (projects.find((p) => p.id === id)?.name ?? 'Project') : 'Library')

  async function addTeam() {
    setTeamMsg(null)
    try {
      const created = await window.api.invoke('agents:createTeam', scope === 'library' ? null : scope)
      await refresh()
      setTeamMsg({ ok: true, text: created.length === 0 ? 'Every role is already there.' : `Added ${created.length} agent${created.length === 1 ? '' : 's'}.` })
      if (created[0]) setSelectedAgent(created[0].id)
    } catch (e) {
      setTeamMsg({ ok: false, text: errMsg(e) })
    }
  }

  // Group the list by scope so a project's team reads as a team.
  const groups = [...new Set(visible.map((a) => a.projectId))].map((pid) => ({ pid, items: visible.filter((a) => a.projectId === pid) }))

  return (
    <div className="page-enter mx-auto max-w-6xl p-6">
      <PageHeader
        title="AI Agents"
        subtitle="Specialised agents that make up your AI team. Each one has a role, a model, limits and permissions."
        action={
          <Button variant="primary" onClick={() => setAdding(true)} data-action="new-agent">
            <Plus size={14} /> New agent
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={scope} onChange={(e) => (setScope(e.target.value), setTeamMsg(null))} aria-label="Show agents from" className="w-64">
          <option value="">All agents ({agents.length})</option>
          <option value="library">Library</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              Project: {p.name}
            </option>
          ))}
        </Select>
        {scope !== '' && (
          <Button onClick={() => void addTeam()} data-action="add-team" title="Adds the 12 built-in roles that are missing from this scope">
            <Users size={14} /> Add the full team
          </Button>
        )}
        {teamMsg && (
          <span role="status" className={cx('text-xs', teamMsg.ok ? 'text-ok' : 'text-err')}>
            {teamMsg.text}
          </span>
        )}
      </div>

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Bot size={22} />}
            title={agents.length === 0 ? 'No agents yet' : 'No agents in this view'}
            action={
              <div className="flex gap-2">
                <Button variant="primary" onClick={() => setAdding(true)}>
                  <Plus size={14} /> New agent
                </Button>
                {scope !== '' && (
                  <Button onClick={() => void addTeam()}>
                    <Users size={14} /> Add the full team
                  </Button>
                )}
              </div>
            }
          >
            Start from one of 12 role templates (Project Manager, Lead Developer, Game Designer, Code Reviewer, QA Tester…) or write your own. Agents work when you start a run from the Task Manager.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[280px_1fr]">
          <div className="space-y-3" aria-label="Agents">
            {groups.map(({ pid, items }) => (
              <section key={pid ?? 'library'}>
                {scope === '' && <h3 className="mb-1 px-1 text-[11px] font-semibold tracking-wide text-faint uppercase">{projectName(pid)}</h3>}
                <ul className="space-y-1.5">
                  {items.map((a) => {
                    const state = !a.enabled ? 'off' : a.issues.length ? 'setup' : 'ready'
                    return (
                      <li key={a.id}>
                        <button
                          data-agent={a.name}
                          aria-current={selected?.id === a.id}
                          onClick={() => setSelectedAgent(a.id)}
                          className={cx(
                            'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                            selected?.id === a.id ? 'border-accent/50 bg-accent-soft' : 'border-line bg-panel hover:bg-hover',
                            !a.enabled && 'opacity-60'
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span className={cx('size-2 shrink-0 rounded-full', DOT[state])} />
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.name}</span>
                            {state === 'setup' && <AlertTriangle size={12} className="shrink-0 text-warn" aria-label="Needs setup" />}
                          </div>
                          <div className="mt-0.5 truncate pl-4 text-[11px] text-faint">
                            {a.roleLabel} · {a.model ?? 'no model'}
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
          {selected && (
            <AgentDetail
              key={selected.id}
              agent={selected}
              onRemoved={() => setSelectedAgent(null)}
              onDuplicated={(copy) => {
                setScope((s) => (s !== '' && s !== (copy.projectId ?? 'library') ? '' : s))
                setSelectedAgent(copy.id)
              }}
            />
          )}
        </div>
      )}

      {adding && (
        <NewAgentModal
          defaultScope={scope && scope !== 'library' ? scope : ''}
          onClose={() => setAdding(false)}
          onCreated={(a) => {
            setScope((s) => (s !== '' && s !== (a.projectId ?? 'library') ? '' : s))
            setSelectedAgent(a.id)
            setAdding(false)
          }}
        />
      )}
    </div>
  )
}

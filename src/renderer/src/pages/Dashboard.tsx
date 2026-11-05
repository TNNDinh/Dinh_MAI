import { Activity, AlertTriangle, Bot, CheckCircle2, Coins, FolderKanban, ListChecks, PlugZap, Zap } from 'lucide-react'
import { useStudio } from '../store'
import { fmtInt, fmtTokens, fmtUsd } from '../lib/format'
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, ProgressBar, StatCard } from '../components/ui'
import { EventRow } from '../components/RightPanel'

export function Dashboard() {
  const { stats, events, loadError, openProject } = useStudio()

  if (loadError) {
    return (
      <div className="p-6">
        <Card className="border-err/40 p-4 text-sm text-err">Failed to load dashboard: {loadError}</Card>
      </div>
    )
  }
  if (!stats) return <div className="p-6 text-xs text-faint">Loading…</div>

  const { usage } = stats
  const unpriced = usage.total.unpricedCalls
  const costLabel = unpriced > 0 && usage.today.costUsd === 0 && usage.today.callCount > 0 ? 'unknown' : fmtUsd(usage.today.costUsd)

  return (
    <div className="page-enter mx-auto max-w-6xl p-6">
      <PageHeader title="Dashboard" subtitle="Live overview of projects, agents, tasks and API spend." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active projects" value={stats.projects.active} sub={`${stats.projects.completed} completed`} icon={<FolderKanban size={15} />} />
        <StatCard label="Agents working" value={stats.agents.working} sub={`${stats.agents.total} configured`} icon={<Bot size={15} />} />
        <StatCard label="Pending tasks" value={stats.tasks.pending} sub={`${stats.tasks.inProgress} in progress · ${stats.tasks.done} done`} icon={<ListChecks size={15} />} />
        <StatCard
          label="Failed tasks"
          value={stats.tasks.failed}
          tone={stats.tasks.failed > 0 ? 'err' : undefined}
          sub={stats.tasks.failed > 0 ? 'Needs attention' : 'None'}
          icon={<AlertTriangle size={15} />}
        />
        <StatCard label="Tokens today" value={fmtTokens(usage.today.inputTokens + usage.today.outputTokens)} sub={`${fmtInt(usage.today.callCount)} API calls`} icon={<Zap size={15} />} />
        <StatCard label="Tokens all time" value={fmtTokens(usage.total.inputTokens + usage.total.outputTokens)} sub={`${fmtInt(usage.total.callCount)} API calls`} icon={<Activity size={15} />} />
        <StatCard
          label="Cost today"
          value={costLabel}
          sub={unpriced > 0 ? `${unpriced} unpriced call(s) — lower bound` : `${fmtUsd(usage.total.costUsd)} all time`}
          icon={<Coins size={15} />}
        />
        <StatCard
          label="Connections"
          value={stats.connections.total}
          tone={stats.connections.error > 0 ? 'err' : stats.connections.ok > 0 ? 'ok' : undefined}
          sub={stats.connections.total === 0 ? 'None configured yet' : `${stats.connections.ok} ok · ${stats.connections.error} failing`}
          icon={<PlugZap size={15} />}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader title="Project progress" />
          {stats.projectProgress.length === 0 ? (
            <EmptyState
              icon={<FolderKanban size={22} />}
              title="No projects yet"
              action={
                <Button variant="primary" onClick={() => openProject(null)}>
                  Create a project
                </Button>
              }
            >
              A project points the AI team at a folder on disk. Agents are sandboxed to that folder.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {stats.projectProgress.map((p) => (
                <li key={p.id}>
                  <button className="block w-full px-4 py-3 text-left hover:bg-hover/60" onClick={() => openProject(p.id)}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-[13px] font-medium">{p.name}</span>
                      <span className="flex items-center gap-2">
                        {p.status === 'completed' && <CheckCircle2 size={13} className="text-ok" />}
                        <Badge>{p.type}</Badge>
                      </span>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <ProgressBar value={p.progress} className="flex-1" />
                      <span className="w-20 text-right text-[11px] text-faint tabular-nums">
                        {p.tasksTotal === 0 ? 'no tasks' : `${p.tasksDone}/${p.tasksTotal} tasks`}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="Recent activity" action={<span className="text-[11px] text-faint">live</span>} />
          {events.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="max-h-[420px] overflow-y-auto py-1">
              {events.slice(0, 20).map((e) => (
                <EventRow key={e.id} e={e} />
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

import { Activity, Coins, ListChecks, MessagesSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useStudio, type RightTab } from '../store'
import { fmtInt, fmtTime, fmtTokens, fmtUsd } from '../lib/format'
import { EmptyState, cx } from './ui'
import { TASK_STATUS_DOT, TASK_STATUS_LABEL } from './tasks/meta'
import type { ActivityEvent, EventLevel, ModelUsageRow, UsageTotals } from '../../../shared/ipc'

const TABS: Array<{ id: RightTab; label: string; icon: typeof Activity }> = [
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'chat', label: 'Chat', icon: MessagesSquare },
  { id: 'tasks', label: 'Tasks', icon: ListChecks },
  { id: 'usage', label: 'Usage', icon: Coins }
]

export const LEVEL_COLOR: Record<EventLevel, string> = {
  debug: 'bg-faint',
  info: 'bg-info',
  warn: 'bg-warn',
  error: 'bg-err'
}

export function EventRow({ e, showTime = true }: { e: ActivityEvent; showTime?: boolean }) {
  return (
    <li className="flex gap-2 px-3 py-1.5 hover:bg-hover/60">
      <span className={cx('mt-1.5 size-1.5 shrink-0 rounded-full', LEVEL_COLOR[e.level])} />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] leading-snug break-words text-fg" data-selectable>
          {e.message}
        </div>
        <div className="mt-0.5 flex gap-2 text-[10px] text-faint">
          <span className="font-mono">{e.type}</span>
          {showTime && <span>{fmtTime(e.createdAt)}</span>}
        </div>
      </div>
    </li>
  )
}

function UsageBlock({ title, u }: { title: string; u: UsageTotals }) {
  return (
    <div className="rounded-lg border border-line bg-panel p-3">
      <div className="mb-2 text-xs font-medium text-muted">{title}</div>
      <dl className="grid grid-cols-2 gap-y-2 text-xs">
        <dt className="text-faint">API calls</dt>
        <dd className="text-right tabular-nums">{fmtInt(u.callCount)}</dd>
        <dt className="text-faint">Input tokens</dt>
        <dd className="text-right tabular-nums">{fmtTokens(u.inputTokens)}</dd>
        <dt className="text-faint">Output tokens</dt>
        <dd className="text-right tabular-nums">{fmtTokens(u.outputTokens)}</dd>
        <dt className="text-faint">Est. cost</dt>
        <dd className="text-right tabular-nums">{u.unpricedCalls > 0 && u.costUsd > 0 ? '≥ ' : ''}{u.unpricedCalls > 0 && u.costUsd === 0 && u.callCount > 0 ? 'unknown' : fmtUsd(u.costUsd)}</dd>
      </dl>
      {u.unpricedCalls > 0 && <p className="mt-2 text-[11px] text-warn">{u.unpricedCalls} call(s) have no price set, so cost is a lower bound.</p>}
    </div>
  )
}

function ModelUsageList({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<ModelUsageRow[] | null>(null)
  useEffect(() => {
    void window.api.invoke('usage:byModel').then(setRows, () => setRows([]))
  }, [refreshKey])

  if (!rows || rows.length === 0) return null
  return (
    <div className="rounded-lg border border-line bg-panel">
      <div className="border-b border-line px-3 py-2 text-xs font-medium text-muted">By model</div>
      <ul className="divide-y divide-line/60" data-usage-by-model>
        {rows.map((r) => (
          <li key={`${r.connectionId}:${r.model}`} className="px-3 py-2 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-[11.5px]" title={r.model}>
                {r.model}
              </span>
              <span className="shrink-0 tabular-nums">
                {r.unpricedCalls > 0 ? (r.costUsd > 0 ? `≥ ${fmtUsd(r.costUsd)}` : 'cost unknown') : fmtUsd(r.costUsd)}
              </span>
            </div>
            <div className="mt-0.5 flex justify-between gap-2 text-[11px] text-faint">
              <span className="truncate">{r.connectionName}</span>
              <span className="shrink-0 tabular-nums">
                {fmtInt(r.calls)} call{r.calls === 1 ? '' : 's'} · {fmtTokens(r.inputTokens)} in · {fmtTokens(r.outputTokens)} out
                {r.failedCalls > 0 ? ` · ${r.failedCalls} failed` : ''}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function RightPanel() {
  const { rightTab, setRightTab, events, stats, tasks, openTask, setPage } = useStudio()
  const ORDER = { in_progress: 0, review: 1, testing: 1, todo: 2, blocked: 3, failed: 4, done: 5 } as const
  const shown = [...tasks].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt).slice(0, 15)

  return (
    <aside className="flex h-full flex-col bg-panel" aria-label="Agent activity">
      <div role="tablist" className="flex h-9 shrink-0 border-b border-line">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            data-testid={`right-tab-${id}`}
            role="tab"
            aria-selected={rightTab === id}
            onClick={() => setRightTab(id)}
            className={cx(
              'flex flex-1 items-center justify-center gap-1.5 border-b-2 text-xs transition-colors',
              rightTab === id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
            )}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rightTab === 'activity' &&
          (events.length === 0 ? (
            <EmptyState icon={<Activity size={20} />} title="No activity yet">
              Agent actions such as “Writing PlayerController.cs” or “Generating player sprite…” will stream here live.
            </EmptyState>
          ) : (
            <ul className="py-1">
              {events.map((e) => (
                <EventRow key={e.id} e={e} />
              ))}
            </ul>
          ))}

        {rightTab === 'chat' && (
          <EmptyState
            icon={<MessagesSquare size={20} />}
            title="Agent conversations"
            action={
              <button onClick={() => setPage('tasks')} className="text-xs text-accent hover:underline">
                Open the Task Manager
              </button>
            }
          >
            Every task keeps its own log of the prompts, replies and tool calls between an agent and its model: open a task to read it. A shared team chat room is not built yet.
          </EmptyState>
        )}

        {rightTab === 'tasks' && (
          <div className="space-y-3 p-3">
            <div className="grid grid-cols-2 gap-2">
              {[
                ['Pending', stats?.tasks.pending ?? 0],
                ['In progress', stats?.tasks.inProgress ?? 0],
                ['Done', stats?.tasks.done ?? 0],
                ['Failed', stats?.tasks.failed ?? 0]
              ].map(([l, v]) => (
                <div key={l} className="rounded-lg border border-line bg-panel p-3">
                  <div className="text-[11px] text-faint">{l}</div>
                  <div className="text-lg font-semibold tabular-nums">{v}</div>
                </div>
              ))}
            </div>
            {shown.length === 0 ? (
              <p className="text-xs text-faint">No tasks yet. Start a run from the Task Manager and the Project Manager will fill the board.</p>
            ) : (
              <ul className="space-y-1" data-testid="right-task-list">
                {shown.map((t) => (
                  <li key={t.id}>
                    <button onClick={() => openTask(t)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover" title={TASK_STATUS_LABEL[t.status]}>
                      <span className={cx('size-2 shrink-0 rounded-full', TASK_STATUS_DOT[t.status], t.status === 'in_progress' && 'animate-pulse')} />
                      <span className="min-w-0 flex-1 truncate text-xs">{t.title}</span>
                      <span className="shrink-0 text-[10px] text-faint">{TASK_STATUS_LABEL[t.status]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {rightTab === 'usage' && (
          <div className="space-y-3 p-3">
            {stats ? (
              <>
                <UsageBlock title="Today" u={stats.usage.today} />
                <UsageBlock title="All time" u={stats.usage.total} />
                <ModelUsageList refreshKey={stats.usage.total.callCount} />
              </>
            ) : (
              <p className="text-xs text-faint">Loading…</p>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

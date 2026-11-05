import { useState } from 'react'
import { useStudio, type BottomTab } from '../store'
import { fmtTime } from '../lib/format'
import { EmptyState, cx } from './ui'
import { LEVEL_COLOR } from './RightPanel'
import { Terminal } from './Terminal'
import { AutomationToolbar, BuildOutputView, ProblemsView, TestResultsView, useProblemCount } from './AutomationPanel'
import type { EventLevel } from '../../../shared/ipc'

const TABS: Array<{ id: BottomTab; label: string }> = [
  { id: 'logs', label: 'Logs' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'build', label: 'Build Output' },
  { id: 'problems', label: 'Problems' },
  { id: 'tests', label: 'Test Results' }
]

const LEVELS: EventLevel[] = ['debug', 'info', 'warn', 'error']

export function BottomPanel() {
  const { bottomTab, setBottomTab, events } = useStudio()
  const [min, setMin] = useState<EventLevel>('info')
  const problems = useProblemCount()
  const shown = events.filter((e) => LEVELS.indexOf(e.level) >= LEVELS.indexOf(min))

  return (
    <section className="flex h-full flex-col bg-panel" aria-label="Output panel">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-line pr-2">
        <div role="tablist" className="flex h-full">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={bottomTab === t.id}
              onClick={() => setBottomTab(t.id)}
              className={cx(
                'h-full border-b-2 px-3 text-xs transition-colors',
                bottomTab === t.id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
              )}
            >
              {t.label}
              {t.id === 'problems' && problems > 0 && (
                <span className="ml-1 rounded bg-err/20 px-1 text-[10px] text-err" data-problem-count>
                  {problems}
                </span>
              )}
            </button>
          ))}
        </div>
        {(bottomTab === 'build' || bottomTab === 'problems' || bottomTab === 'tests') && <AutomationToolbar />}
        {bottomTab === 'logs' && (
          <label className="flex items-center gap-1.5 text-[11px] text-faint">
            Level
            <select
              value={min}
              onChange={(e) => setMin(e.target.value as EventLevel)}
              className="rounded border border-line bg-bg px-1.5 py-0.5 text-[11px] text-fg focus:outline-none"
            >
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}+
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className={cx('min-h-0 flex-1 font-mono text-[11.5px]', bottomTab === 'terminal' ? 'overflow-hidden' : 'overflow-y-auto')}>
        {bottomTab === 'terminal' ? (
          <Terminal />
        ) : bottomTab === 'logs' ? (
          shown.length === 0 ? (
            <EmptyState title="No log entries" />
          ) : (
            <ul className="py-1">
              {shown.map((e) => (
                <li key={e.id} className="flex items-baseline gap-2 px-3 py-0.5 hover:bg-hover/60" data-selectable>
                  <span className="text-faint">{fmtTime(e.createdAt)}</span>
                  <span className={cx('size-1.5 shrink-0 self-center rounded-full', LEVEL_COLOR[e.level])} />
                  <span className="shrink-0 text-faint">{e.type}</span>
                  <span className="min-w-0 break-words text-fg">{e.message}</span>
                </li>
              ))}
            </ul>
          )
        ) : bottomTab === 'build' ? (
          <BuildOutputView />
        ) : bottomTab === 'problems' ? (
          <ProblemsView />
        ) : (
          <TestResultsView />
        )}
      </div>
    </section>
  )
}

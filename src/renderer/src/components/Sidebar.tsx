import { Bot, Code2, FolderKanban, Images, LayoutDashboard, ListChecks, PlugZap, Settings, Workflow, type LucideIcon } from 'lucide-react'
import { cx } from './ui'
import { useStudio, type Page } from '../store'
import { isOpenTask } from './tasks/meta'

interface NavItem {
  page: Page
  label: string
  icon: LucideIcon
  /** Phase in which the page becomes functional; undefined = available now. */
  phase?: number
}

const NAV: NavItem[] = [
  { page: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { page: 'projects', label: 'Projects', icon: FolderKanban },
  { page: 'workspace', label: 'Workspace', icon: Code2 },
  { page: 'agents', label: 'AI Agents', icon: Bot },
  { page: 'connections', label: 'Model Connections', icon: PlugZap },
  { page: 'workflow', label: 'Workflow Editor', icon: Workflow },
  { page: 'assets', label: 'Asset Library', icon: Images },
  { page: 'tasks', label: 'Task Manager', icon: ListChecks },
  { page: 'settings', label: 'Settings', icon: Settings }
]

export function Sidebar() {
  const { page, setPage, openProject, stats, agents, tasks, runs } = useStudio()
  const openTasks = tasks.filter(isOpenTask).length
  const running = runs.some((r) => r.status === 'running' || r.status === 'pending')

  return (
    <nav aria-label="Main" className="flex h-full flex-col bg-panel py-2">
      <ul className="flex flex-col gap-0.5 px-2">
        {NAV.map(({ page: p, label, icon: Icon, phase }) => {
          const active = page === p
          return (
            <li key={p}>
              <button
                data-nav={p}
                aria-current={active ? 'page' : undefined}
                onClick={() => (p === 'projects' ? openProject(null) : setPage(p))}
                className={cx(
                  'group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors',
                  active ? 'bg-accent-soft text-fg' : 'text-muted hover:bg-hover hover:text-fg'
                )}
              >
                <Icon size={16} className={active ? 'text-accent' : 'text-faint group-hover:text-muted'} />
                <span className="flex-1 truncate">{label}</span>
                {phase && <span className="rounded bg-elev px-1 text-[10px] text-faint" title={`Arrives in Phase ${phase}`}>P{phase}</span>}
                {p === 'projects' && stats && stats.projects.total > 0 && <span className="text-[11px] text-faint tabular-nums">{stats.projects.total}</span>}
                {p === 'agents' && agents.length > 0 && <span className="text-[11px] text-faint tabular-nums">{agents.length}</span>}
                {p === 'tasks' && (running || openTasks > 0) && (
                  <span className={cx('flex items-center gap-1 text-[11px] tabular-nums', running ? 'text-info' : 'text-faint')} title={running ? 'A run is in progress' : 'Open tasks'}>
                    {running && <span className="size-1.5 animate-pulse rounded-full bg-info" />}
                    {openTasks}
                  </span>
                )}
                {p === 'connections' && stats && stats.connections.total > 0 && <span className="text-[11px] text-faint tabular-nums">{stats.connections.total}</span>}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

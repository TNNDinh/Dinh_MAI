import { create } from 'zustand'
import type { ActivityEvent, Agent, AgentTemplateInfo, AppInfo, Connection, DashboardStats, PendingApproval, ProviderCatalogItem, Project, Run, Task } from '../../shared/ipc'

export type Page = 'dashboard' | 'projects' | 'workspace' | 'agents' | 'connections' | 'workflow' | 'assets' | 'tasks' | 'settings'
export type RightTab = 'activity' | 'chat' | 'tasks' | 'usage'
export type BottomTab = 'logs' | 'terminal' | 'build' | 'problems' | 'tests'

const MAX_EVENTS = 300
import { applyTerminalEvent, type TerminalEntry } from './lib/terminal-reducer'
export { applyTerminalEvent, type TerminalEntry }

interface StudioState {
  page: Page
  selectedProjectId: string | null
  rightTab: RightTab
  bottomTab: BottomTab
  info: AppInfo | null
  projects: Project[]
  connections: Connection[]
  catalog: ProviderCatalogItem[]
  selectedConnectionId: string | null
  agents: Agent[]
  agentTemplates: AgentTemplateInfo[]
  selectedAgentId: string | null
  runs: Run[]
  tasks: Task[]
  /** Project shown on the Task Manager page. */
  taskProjectId: string | null
  selectedTaskId: string | null
  stats: DashboardStats | null
  events: ActivityEvent[]
  loadError: string | null
  /** Project shown in the Workspace page and the terminal. */
  workspaceProjectId: string | null
  terminal: TerminalEntry[]
  approvals: PendingApproval[]
  /** The user chose “decide later”: show a status-bar chip instead of the dialog until something new arrives. */
  approvalsMinimized: boolean

  setApprovalsMinimized: (v: boolean) => void
  setWorkspaceProject: (id: string | null) => void
  clearTerminal: (projectId: string) => void
  setPage: (p: Page) => void
  setSelectedConnection: (id: string | null) => void
  setSelectedAgent: (id: string | null) => void
  setTaskProject: (id: string | null) => void
  setSelectedTask: (id: string | null) => void
  /** Jump to the Task Manager with one task open. */
  openTask: (task: Task) => void
  openProject: (id: string | null) => void
  setRightTab: (t: RightTab) => void
  setBottomTab: (t: BottomTab) => void
  refresh: () => Promise<void>
  init: () => () => void
}

export const useStudio = create<StudioState>((set, get) => ({
  page: 'dashboard',
  selectedProjectId: null,
  rightTab: 'activity',
  bottomTab: 'logs',
  info: null,
  projects: [],
  connections: [],
  catalog: [],
  selectedConnectionId: null,
  agents: [],
  agentTemplates: [],
  selectedAgentId: null,
  runs: [],
  tasks: [],
  taskProjectId: null,
  selectedTaskId: null,
  stats: null,
  events: [],
  loadError: null,
  workspaceProjectId: null,
  terminal: [],
  approvals: [],
  approvalsMinimized: false,

  setApprovalsMinimized: (approvalsMinimized) => set({ approvalsMinimized }),
  setWorkspaceProject: (workspaceProjectId) => set({ workspaceProjectId }),
  clearTerminal: (projectId) => set((s) => ({ terminal: s.terminal.filter((t) => t.projectId !== projectId || t.outcome === null) })),
  setPage: (page) => set({ page }),
  setSelectedConnection: (selectedConnectionId) => set({ selectedConnectionId }),
  setSelectedAgent: (selectedAgentId) => set({ selectedAgentId }),
  setTaskProject: (taskProjectId) => set({ taskProjectId, selectedTaskId: null }),
  setSelectedTask: (selectedTaskId) => set({ selectedTaskId }),
  openTask: (task) => set({ page: 'tasks', taskProjectId: task.projectId, selectedTaskId: task.id }),
  openProject: (id) => set({ selectedProjectId: id, page: 'projects' }),
  setRightTab: (rightTab) => set({ rightTab }),
  setBottomTab: (bottomTab) => set({ bottomTab }),

  async refresh() {
    try {
      const [projects, stats, connections, agents, runs, tasks] = await Promise.all([
        window.api.invoke('projects:list'),
        window.api.invoke('dashboard:stats'),
        window.api.invoke('connections:list'),
        window.api.invoke('agents:list'),
        window.api.invoke('runs:list'),
        window.api.invoke('tasks:list')
      ])
      const sel = get().selectedProjectId
      const wp = get().workspaceProjectId
      const selAgent = get().selectedAgentId
      const selTask = get().selectedTaskId
      set({
        projects,
        stats,
        connections,
        agents,
        runs,
        tasks,
        loadError: null,
        ...(wp && !projects.some((p) => p.id === wp) ? { workspaceProjectId: null } : {}),
        ...(sel && !projects.some((p) => p.id === sel) ? { selectedProjectId: null } : {}),
        ...(selAgent && !agents.some((a) => a.id === selAgent) ? { selectedAgentId: null } : {}),
        ...(selTask && !tasks.some((t) => t.id === selTask) ? { selectedTaskId: null } : {})
      })
    } catch (e) {
      set({ loadError: e instanceof Error ? e.message : String(e) })
    }
  },

  init() {
    let timer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefresh = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void get().refresh(), 200) // coalesce bursts of events
    }

    void window.api.invoke('app:info').then((info) => set({ info }), () => undefined)
    void window.api.invoke('connections:catalog').then((catalog) => set({ catalog }), () => undefined)
    void window.api.invoke('agents:templates').then((agentTemplates) => set({ agentTemplates }), () => undefined)
    void window.api.invoke('events:recent', { limit: MAX_EVENTS }).then((events) => set({ events }), () => undefined)
    void get().refresh()

    const off = window.api.onActivity((e) => {
      set((s) => ({ events: [e, ...s.events.filter((x) => x.id !== e.id)].slice(0, MAX_EVENTS) }))
      scheduleRefresh()
    })
    void window.api.invoke('approvals:list').then((approvals) => set({ approvals }), () => undefined)
    const offTerm = window.api.onTerminalEvent((e) => set((s) => ({ terminal: applyTerminalEvent(s.terminal, e) })))
    const offApprovals = window.api.onApprovalsChanged((approvals) =>
      set((s) => ({ approvals, approvalsMinimized: approvals.length === 0 ? false : approvals.some((a) => !s.approvals.some((x) => x.id === a.id)) ? false : s.approvalsMinimized }))
    )
    return () => {
      clearTimeout(timer)
      off()
      offTerm()
      offApprovals()
    }
  }
}))

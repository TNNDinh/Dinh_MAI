import type { AppInfo, ChatStreamEvent, IpcChannel, IpcContract } from '../../shared/ipc'
import type { AgentService } from '../services/agents'
import type { ChatService } from '../services/chat'
import type { AssetService } from '../assets/service'
import type { ConnectionService } from '../services/connections'
import type { DashboardService } from '../services/dashboard'
import type { EventService } from '../services/events'
import type { Orchestrator } from '../orchestrator/orchestrator'
import type { ProjectService } from '../services/projects'
import type { TaskService } from '../services/tasks'
import { describePolicy } from '../security/command-policy'
import type { CommandService } from '../workspace/commands'
import type { WorkspaceService } from '../workspace/workspace'
import type { WorkflowEngine } from '../workflows/engine'
import type { WorkflowService } from '../workflows/service'
import { randomUUID } from 'node:crypto'

/** Things only the Electron host can do; injected so handlers stay testable. */
export interface HostBridge {
  appInfo(): AppInfo
  pickFolder(): Promise<string | null>
  revealInFolder(path: string): void
  /** Push a streamed chat event to the UI. */
  emitChat(event: ChatStreamEvent): void
}

export interface HandlerDeps {
  projects: ProjectService
  dashboard: DashboardService
  events: EventService
  connections: ConnectionService
  chat: ChatService
  agents: AgentService
  tasks: TaskService
  orchestrator: Orchestrator
  workspace: WorkspaceService
  commands: CommandService
  assets: AssetService
  workflows: WorkflowService
  workflowEngine: WorkflowEngine
  host: HostBridge
}

export type Handlers = {
  [K in IpcChannel]: (...args: Parameters<IpcContract[K]>) => ReturnType<IpcContract[K]> | Promise<ReturnType<IpcContract[K]>>
}

export function createHandlers({ projects, dashboard, events, connections, chat, agents, tasks, orchestrator, workspace, commands, assets, workflows, workflowEngine, host }: HandlerDeps): Handlers {
  return {
    'runs:start': (input) => orchestrator.start(input),
    'runs:list': (projectId) => orchestrator.listRuns(projectId === null || projectId === undefined ? undefined : String(projectId)),
    'runs:stop': (id) => (workflowEngine.isWorkflowRun(String(id)) ? workflowEngine.stop(String(id)) : orchestrator.stop(String(id))),
    'runs:resume': (input) => (workflowEngine.isWorkflowRun(String(input?.id ?? '')) ? workflowEngine.resume(input) : orchestrator.resume(input)),
    'runs:stopAll': async () => {
      // Workflow runs are aborted first (synchronously), so a step waiting for approval sees "stopped", not "rejected".
      const flows = workflowEngine.stopAll()
      // Abort in-flight model calls so the runs unwind immediately.
      chat.cancelAll()
      assets.cancelAll()
      // Also kill every running command and deny every command waiting for approval.
      commands.killAll()
      const [planned, drawn] = await Promise.all([orchestrator.stopAll(), flows])
      return planned + drawn
    },
    'workflows:list': (projectId) => workflows.list(projectId === null || projectId === undefined ? null : String(projectId)),
    'workflows:get': (id) => workflows.get(String(id)),
    'workflows:save': (input) => workflows.save(input),
    'workflows:remove': (id) => workflows.remove(String(id)),
    'workflows:run': (input) => workflowEngine.start(input),
    'workflows:runs': (workflowId) => workflowEngine.listRuns(String(workflowId)),
    'workflows:runState': (runId) => workflowEngine.getRunState(String(runId)),
    'fs:list': (i) => workspace.list(String(i.projectId), i.path === undefined ? '' : String(i.path), i.includeIgnored === true),
    'fs:read': (i) => workspace.read(String(i.projectId), String(i.path)),
    'fs:write': (i) =>
      workspace.write({ projectId: String(i.projectId), path: String(i.path), content: typeof i.content === 'string' ? i.content : '', expectedHash: i.expectedHash === undefined ? undefined : i.expectedHash === null ? null : String(i.expectedHash) }),
    'fs:create': (i) => workspace.create(String(i.projectId), String(i.path), i.kind === 'dir' ? 'dir' : 'file'),
    'fs:rename': (i) => workspace.rename(String(i.projectId), String(i.from), String(i.to)),
    'fs:remove': (i) => workspace.remove(String(i.projectId), String(i.path)),
    'fs:search': (i) => workspace.search(String(i.projectId), String(i.query ?? ''), { regex: i.regex === true, path: i.path === undefined ? undefined : String(i.path) }),
    'index:run': (id) => workspace.indexRun(String(id)),
    'index:status': (id) => workspace.indexStatus(String(id)),
    'index:find': (i) => workspace.indexFind(String(i.projectId), String(i.query ?? ''), typeof i.limit === 'number' ? i.limit : undefined),
    'locks:list': (id) => workspace.lockList(String(id)),
    'locks:release': (i) => workspace.locks.release(String(i.projectId), String(i.path)),
    'term:run': (i) => {
      const project = workspace.project(String(i.projectId))
      const command = typeof i.command === 'string' ? i.command : ''
      if (!command.trim()) throw new Error('Type a command to run.')
      const id = randomUUID()
      // The result reaches the UI as terminal events; a refusal is already reported there, so the rejection is swallowed.
      void commands
        .run({ projectId: project.id, projectName: project.name, sandbox: workspace.sandbox(project.id), command, cwd: i.cwd === undefined ? undefined : String(i.cwd), origin: 'user' }, id)
        .catch(() => undefined)
      return id
    },
    'term:kill': (id) => commands.kill(String(id)),
    'term:history': (id) => commands.history(String(id)),
    'assets:list': (i) => assets.list(String(i.projectId), i.kind ?? null),
    'assets:preview': (i) => assets.preview(String(i.id), typeof i.max === 'number' ? i.max : undefined),
    'assets:imageModels': () => assets.imageModels(),
    'assets:generate': (i) =>
      assets.generate({
        requestId: String(i.requestId ?? ''),
        projectId: String(i.projectId),
        connectionId: String(i.connectionId),
        model: String(i.model ?? ''),
        prompt: String(i.prompt ?? ''),
        kind: i.kind,
        name: i.name === undefined ? undefined : String(i.name),
        size: i.size === undefined ? undefined : String(i.size),
        count: Number(i.count),
        transparent: i.transparent === true,
        referenceAssetId: i.referenceAssetId ? String(i.referenceAssetId) : undefined
      }),
    'assets:cancel': (id) => assets.cancel(String(id)),
    'assets:process': (i) => assets.process({ id: String(i.id), operation: i.operation, replace: i.replace === true }),
    'assets:remove': (i) => assets.remove(String(i.id), i.deleteFile === true),
    'assets:reveal': (id) => host.revealInFolder(assets.absolutePath(String(id))),
    'images:setPrice': (i) => connections.setImagePrice(String(i.connectionId), String(i.model ?? ''), i.priceUsd === null || i.priceUsd === undefined ? null : Number(i.priceUsd)),
    'term:policy': () => describePolicy(),
    'approvals:list': () => commands.approvals.list(),
    'approvals:respond': (i) => commands.approvals.respond(String(i.id), i.allow === true),
    'tasks:list': (filter) => tasks.list(filter ?? {}),
    'tasks:get': (id) => tasks.detail(String(id)),
    'tasks:create': (input) => tasks.create(input),
    'tasks:update': (input) => tasks.update(input),
    'tasks:remove': (id) => tasks.remove(String(id)),
    'agents:templates': () => agents.templates(),
    'agents:list': () => agents.list(),
    'agents:create': (input) => agents.create(input),
    'agents:update': (input) => agents.update(input),
    'agents:duplicate': (id) => agents.duplicate(String(id)),
    'agents:remove': (id) => agents.remove(String(id)),
    'agents:createTeam': (projectId) => agents.createTeam(projectId === null || projectId === undefined ? null : String(projectId)),
    'connections:catalog': () => connections.catalog(),
    'connections:list': () => connections.list(),
    'connections:create': (input) => connections.create(input),
    'connections:update': (input) => connections.update(input),
    'connections:remove': (id) => connections.remove(String(id)),
    'connections:test': (id) => connections.test(String(id)),
    'models:list': (id) => connections.listModels(String(id)),
    'models:discover': (id) => connections.discoverModels(String(id)),
    'models:setPricing': (input) => connections.setPricing(input),
    'chat:start': (input) => chat.start(input, (e) => host.emitChat(e)),
    'chat:cancel': (id) => chat.cancel(String(id)),
    'usage:byModel': () => chat.usageByModel(),
    'app:info': () => host.appInfo(),
    'projects:list': () => projects.list(),
    'projects:get': (id) => projects.get(String(id)),
    'projects:create': (input) => projects.create(input),
    'projects:update': (input) => projects.update(input),
    'projects:remove': (id) => projects.remove(String(id)),
    'projects:pickFolder': () => host.pickFolder(),
    'projects:inspectFolder': (path) => projects.inspectFolder(String(path)),
    'projects:reveal': (id) => {
      const p = projects.get(String(id))
      if (!p) throw new Error('Project not found.')
      host.revealInFolder(p.rootPath)
    },
    'dashboard:stats': () => dashboard.stats(),
    'events:recent': (query) => events.recent(query ?? {})
  }
}

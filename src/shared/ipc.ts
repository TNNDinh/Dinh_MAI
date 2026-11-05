/**
 * The single source of truth for main <-> renderer communication.
 * Adding a channel: add it to `IpcContract`, add it to `IPC_CHANNELS` (the
 * compiler enforces both), then implement the handler in main/ipc/handlers.ts.
 */

import type { NodeRunState, Workflow, WorkflowGraph, WorkflowSummary } from './workflow'

// ------------------------------------------------------------------ domain types

export type ProjectType =
  | 'unity'
  | 'unreal'
  | 'godot'
  | 'web'
  | 'react'
  | 'nextjs'
  | 'python'
  | 'csharp'
  | 'cpp'
  | 'other'

export const PROJECT_TYPES: ReadonlyArray<{ value: ProjectType; label: string }> = [
  { value: 'unity', label: 'Unity' },
  { value: 'unreal', label: 'Unreal Engine' },
  { value: 'godot', label: 'Godot' },
  { value: 'web', label: 'HTML / CSS / JavaScript' },
  { value: 'react', label: 'React' },
  { value: 'nextjs', label: 'Next.js' },
  { value: 'python', label: 'Python' },
  { value: 'csharp', label: 'C#' },
  { value: 'cpp', label: 'C++' },
  { value: 'other', label: 'Other' }
]

export type ProjectStatus = 'active' | 'completed' | 'archived'

export interface Project {
  id: string
  name: string
  type: ProjectType
  rootPath: string
  goal: string
  status: ProjectStatus
  /** 0..1 */
  progress: number
  budgetUsd: number | null
  maxIterations: number
  createdAt: number
  updatedAt: number
}

export interface CreateProjectInput {
  name: string
  /** Omit to auto-detect from the folder contents. */
  type?: ProjectType
  /** Omit to create a new folder under the default projects directory. */
  rootPath?: string
  goal?: string
  budgetUsd?: number | null
  maxIterations?: number
}

export interface UpdateProjectInput {
  id: string
  name?: string
  type?: ProjectType
  goal?: string
  status?: ProjectStatus
  budgetUsd?: number | null
  maxIterations?: number
}

export interface FolderInspection {
  exists: boolean
  isEmpty: boolean
  isGitRepo: boolean
  detectedType: ProjectType
  alreadyRegistered: boolean
}

export type EventLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ActivityEvent {
  id: number
  projectId: string | null
  runId: string | null
  agentId: string | null
  level: EventLevel
  type: string
  message: string
  createdAt: number
}

export interface UsageTotals {
  callCount: number
  inputTokens: number
  outputTokens: number
  /** Sum over calls with a known price only. */
  costUsd: number
  /** Calls whose price is unknown, so costUsd is a lower bound when > 0. */
  unpricedCalls: number
}

export interface ProjectProgress {
  id: string
  name: string
  type: ProjectType
  status: ProjectStatus
  progress: number
  tasksDone: number
  tasksTotal: number
}

export interface DashboardStats {
  projects: { active: number; completed: number; total: number }
  agents: { total: number; working: number }
  tasks: { pending: number; inProgress: number; failed: number; done: number }
  connections: { total: number; ok: number; error: number }
  usage: { total: UsageTotals; today: UsageTotals }
  projectProgress: ProjectProgress[]
}

export interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
  platform: string
  userDataPath: string
  defaultProjectsRoot: string
  dbVersion: number
  /** True when OS-level encryption (Windows DPAPI) is available for API keys. */
  encryptionAvailable: boolean
}

export interface RecentEventsQuery {
  limit?: number
  projectId?: string
  minLevel?: EventLevel
}

// ------------------------------------------------------------------ connections (Phase 3)

export type ProviderKind = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'deepseek' | 'groq' | 'ollama' | 'custom'

/** Static description of a provider, used to render the "Add connection" form. */
export interface ProviderCatalogItem {
  kind: ProviderKind
  label: string
  defaultBaseUrl: string
  requiresApiKey: boolean
  /** The user must supply the base URL (custom endpoints). */
  customBaseUrl: boolean
  /** Runs on this machine: no per-token cost. */
  local: boolean
  /** The provider has an image-generation API this app can call. */
  imageGeneration: boolean
  docsUrl?: string
}

export type ConnectionState = 'unknown' | 'ok' | 'error'

/** A configured provider connection. The API key itself NEVER crosses IPC; only whether one is stored. */
export interface Connection {
  id: string
  kind: ProviderKind
  name: string
  baseUrl: string
  hasKey: boolean
  enabled: boolean
  status: ConnectionState
  lastError: string | null
  lastCheckedAt: number | null
  modelCount: number
  createdAt: number
}

export interface CreateConnectionInput {
  kind: ProviderKind
  name: string
  /** Omit to use the provider's default. */
  baseUrl?: string
  /** Sent once to the main process, encrypted with Windows DPAPI, never returned. */
  apiKey?: string
  enabled?: boolean
}

export interface UpdateConnectionInput {
  id: string
  name?: string
  baseUrl?: string
  enabled?: boolean
  /** Replace the stored key. Omit to keep the current one. */
  apiKey?: string
  clearKey?: boolean
}

export interface ConnectionTestResult {
  ok: boolean
  latencyMs: number
  modelCount?: number
  errorKind?: string
  error?: string
  connection: Connection
}

export type ModelKindId = 'chat' | 'image' | 'embedding' | 'other'

export interface ModelPricingEntry {
  inputPerMTok: number
  outputPerMTok: number
  /** `provider` = reported by the provider's API; `user` = entered by you and never overwritten. */
  source: 'user' | 'provider'
}

export interface ModelEntry {
  connectionId: string
  model: string
  displayName: string | null
  kind: ModelKindId
  contextWindow: number | null
  pricing: ModelPricingEntry | null
  /** Price of one generated picture (USD), entered by the user; null = unknown. Only meaningful for image models. */
  imagePriceUsd: number | null
}

export interface SetPricingInput {
  connectionId: string
  model: string
  /** null removes the price (cost becomes "unknown" again). */
  pricing: { inputPerMTok: number; outputPerMTok: number } | null
}

export interface ChatStartInput {
  connectionId: string
  model: string
  system?: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxTokens?: number
  temperature?: number
  /** When set, the call is attributed to this agent (and its project) in usage and the activity feed. */
  agentId?: string
}

export type ChatStreamEvent = { requestId: string } & (
  | { type: 'text'; delta: string }
  | {
      type: 'done'
      model: string
      inputTokens: number
      outputTokens: number
      /** null = no price known for this model. */
      costUsd: number | null
      latencyMs: number
      stopReason: string
    }
  | { type: 'error'; message: string; kind: string; retryable: boolean }
  | { type: 'cancelled' }
)

export interface ModelUsageRow {
  connectionId: string | null
  connectionName: string
  model: string
  calls: number
  inputTokens: number
  outputTokens: number
  /** Sum over priced calls only. */
  costUsd: number
  unpricedCalls: number
  failedCalls: number
}

// ------------------------------------------------------------------ agents (Phase 4)

export type AgentKind = 'chat' | 'image'
export type AgentStatus = 'idle' | 'working' | 'waiting' | 'error' | 'disabled'
/** none = cannot run commands; ask = every command needs approval; allowlist = safe commands auto-run. */
export type CommandPolicy = 'none' | 'ask' | 'allowlist'
export type ModelStrength = 'coding' | 'design' | 'review' | 'vision' | 'long_context' | 'cheap' | 'image_generation'

export interface AgentPermissions {
  readFiles: boolean
  writeFiles: boolean
  runCommands: CommandPolicy
  generateImages: boolean
  internet: boolean
  manageTasks: boolean
  gitCommit: boolean
}

export interface AgentTemplateInfo {
  key: string
  label: string
  kind: AgentKind
  description: string
  systemPrompt: string
  permissions: AgentPermissions
  temperature: number | null
  wants: ModelStrength[]
}

export interface Agent {
  id: string
  /** null = global library agent; otherwise belongs to that project's team. */
  projectId: string | null
  name: string
  /** Template key the agent was created from, or `custom`. */
  role: string
  roleLabel: string
  kind: AgentKind
  connectionId: string | null
  connectionName: string | null
  model: string | null
  systemPrompt: string
  permissions: AgentPermissions
  temperature: number | null
  maxTokens: number | null
  /** Per-run spend cap. Stored now; enforced by the orchestrator from Phase 5. */
  maxCostUsd: number | null
  enabled: boolean
  status: AgentStatus
  /** Why this agent can't run yet (no model, connection down, …). Empty = ready. */
  issues: string[]
  createdAt: number
  updatedAt: number
}

export interface CreateAgentInput {
  /** Start from a template; omit for a custom agent (then `name` and `systemPrompt` are required). */
  templateKey?: string
  projectId?: string | null
  name?: string
  kind?: AgentKind
  connectionId?: string | null
  model?: string | null
  systemPrompt?: string
  permissions?: Partial<AgentPermissions>
  temperature?: number | null
  maxTokens?: number | null
  maxCostUsd?: number | null
  enabled?: boolean
}

export interface UpdateAgentInput {
  id: string
  name?: string
  connectionId?: string | null
  model?: string | null
  systemPrompt?: string
  permissions?: Partial<AgentPermissions>
  temperature?: number | null
  maxTokens?: number | null
  maxCostUsd?: number | null
  enabled?: boolean
}

// ------------------------------------------------------------------ runs & tasks (Phase 5)

export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'testing' | 'done' | 'failed' | 'blocked'
export const TASK_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'review', 'testing', 'done', 'failed', 'blocked']

export interface Run {
  id: string
  projectId: string
  /** Set when the run executes a saved workflow graph instead of a Project Manager plan. */
  workflowId: string | null
  goal: string
  status: RunStatus
  /** Rework rounds used so far (reviewer/QA sending work back). */
  iteration: number
  maxIterations: number
  budgetUsd: number | null
  /** Sum of priced calls. A lower bound when `unpricedCalls` > 0. */
  spentUsd: number
  unpricedCalls: number
  concurrency: number
  error: string | null
  startedAt: number | null
  finishedAt: number | null
  createdAt: number
  taskCounts: Record<TaskStatus, number>
}

export interface Task {
  id: string
  projectId: string
  runId: string | null
  title: string
  description: string
  /** Role (template key) the Project Manager asked for; the agent is resolved from it when the task is scheduled. */
  role: string | null
  assignedAgentId: string | null
  assignedAgentName: string | null
  status: TaskStatus
  /** 1 high .. 3 low */
  priority: number
  attempts: number
  dependsOn: string[]
  resultSummary: string | null
  error: string | null
  inputTokens: number
  outputTokens: number
  costUsd: number
  createdAt: number
  updatedAt: number
}

export interface TaskLogEntry {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  agentId: string | null
  agentName: string | null
  content: string
  createdAt: number
}

export interface TaskDetail extends Task {
  log: TaskLogEntry[]
}

export interface StartRunInput {
  projectId: string
  /** Defaults to the project's own goal. */
  goal?: string
  /** Defaults to the project's budget. null = unlimited. */
  budgetUsd?: number | null
  /** Defaults to the project's iteration limit. */
  maxIterations?: number
  /** How many tasks may run at the same time (1–8, default 3). */
  concurrency?: number
}

export interface ResumeRunInput {
  id: string
  /** Raise (or set) the budget when the run stopped because it ran out. */
  budgetUsd?: number | null
}

export interface SaveWorkflowInput {
  /** Omit to create. */
  id?: string
  projectId: string | null
  name: string
  graph: WorkflowGraph
}

export interface StartWorkflowInput {
  workflowId: string
  /** The project to run in. Required for a shared workflow; a project's own workflow always runs in that project. */
  projectId?: string
  /** What `{{goal}}` stands for. Defaults to the project's goal. */
  goal?: string
  budgetUsd?: number | null
  /** How many steps may run at the same time (1–8, default 3). */
  concurrency?: number
}

export interface WorkflowRunState {
  run: Run
  nodes: NodeRunState[]
}

export interface CreateTaskInput {
  projectId: string
  title: string
  description?: string
  role?: string | null
  assignedAgentId?: string | null
  priority?: number
  dependsOn?: string[]
}

export interface UpdateTaskInput {
  id: string
  title?: string
  description?: string
  role?: string | null
  assignedAgentId?: string | null
  priority?: number
  /** Manual moves only: todo, blocked or done. The orchestrator owns in_progress/failed. */
  status?: 'todo' | 'blocked' | 'done'
}

export interface TaskFilter {
  projectId?: string
  runId?: string
}

// ------------------------------------------------------------------ workspace, terminal, approvals (Phase 6)

export interface FileEntry {
  name: string
  /** Project-relative, forward slashes. */
  path: string
  type: 'dir' | 'file'
  size: number
  mtimeMs: number
  /** A generated or huge folder (node_modules, dist, ...): shown dimmed, excluded from search and the index. */
  ignored: boolean
}

export interface DirListing {
  entries: FileEntry[]
  truncated: boolean
}

export interface FileContent {
  path: string
  content: string
  size: number
  mtimeMs: number
  /** Send back as `expectedHash` when saving, so a change made by an agent in the meantime is detected. */
  hash: string
  language: string
  lines: number
  /** Set when an agent currently holds the write lock: saving will be refused until the task ends. */
  lockedBy: string | null
}

export interface WriteFileInput {
  projectId: string
  path: string
  content: string
  /** Hash from `fs:read`. `null` = the file must not exist yet. Omit to overwrite without checking. */
  expectedHash?: string | null
}

export interface WriteFileResult {
  path: string
  size: number
  hash: string
  created: boolean
}

export interface SearchHit {
  path: string
  line: number
  text: string
}

export interface SearchResult {
  hits: SearchHit[]
  truncated: boolean
  scanned: number
}

export interface FileLockInfo {
  path: string
  agentId: string
  agentName: string | null
  taskId: string | null
  taskTitle: string | null
  acquiredAt: number
  expiresAt: number
}

export interface IndexSummary {
  files: number
  indexedAt: number | null
  /** Files read in this pass (the rest were unchanged). */
  updated: number
  removed: number
  truncated: boolean
}

export interface ContextMatch {
  path: string
  language: string | null
  summary: string | null
  symbols: string[]
  imports: string[]
  score: number
}

export type CommandOrigin = 'user' | 'agent'
export type CommandOutcome = 'exited' | 'timeout' | 'cancelled' | 'denied' | 'blocked' | 'error'

export interface RunCommandInput {
  projectId: string
  command: string
  /** Project-relative folder to run in; default is the project root. */
  cwd?: string
}

/** Streamed to the terminal panel. */
export type TerminalEvent =
  | { type: 'start'; id: string; projectId: string; command: string; cwd: string; origin: CommandOrigin; agentName: string | null; note: string | null }
  | { type: 'output'; id: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'end'; id: string; outcome: CommandOutcome; exitCode: number | null; durationMs: number; message: string | null }

export interface PendingApproval {
  id: string
  projectId: string
  projectName: string
  agentId: string | null
  agentName: string | null
  taskTitle: string | null
  /** 'command' (default) asks to run `command`; 'workflow' is a Human-approval step: `command` holds the question and `detail` the work under review. */
  kind?: 'command' | 'workflow'
  command: string
  cwd: string
  /** Why the policy asked. */
  reason: string
  /** Workflow approvals: the text the step received, for the user to read before deciding. */
  detail?: string | null
  createdAt: number
  expiresAt: number
}

export interface CommandLogEntry {
  id: string
  projectId: string | null
  agentName: string | null
  origin: CommandOrigin
  command: string
  cwd: string
  decision: 'auto_allowed' | 'user_approved' | 'user_denied' | 'blocked'
  reason: string | null
  exitCode: number | null
  durationMs: number | null
  createdAt: number
}

export interface CommandPolicyInfo {
  safe: string[]
  blocked: string[]
}

// ------------------------------------------------------------------ contract

export interface IpcContract {
  /** Plans the goal with the project's Project Manager agent, then runs the team. Returns immediately; progress arrives as activity events. */
  'runs:start': (input: StartRunInput) => Run
  'runs:list': (projectId?: string) => Run[]
  /** Aborts the run, including in-flight model calls. Unfinished tasks go back to todo. */
  'runs:stop': (runId: string) => Run | null
  /** Continues a stopped/paused/failed run; failed and blocked tasks are retried. */
  'runs:resume': (input: ResumeRunInput) => Run
  /** Emergency stop: aborts every run and every in-flight model call. Returns how many runs were active. */
  'runs:stopAll': () => number
  /** Workflows are graphs of agent steps you draw; a project's own saved ones plus the ones shared by every project (projectId null). */
  'workflows:list': (projectId: string | null) => WorkflowSummary[]
  'workflows:get': (id: string) => Workflow | null
  /** Creates or replaces a workflow. Drafts with problems can be saved; they cannot be run. */
  'workflows:save': (input: SaveWorkflowInput) => Workflow
  'workflows:remove': (id: string) => void
  /** Checks the graph against the project's team, then runs it. Returns immediately; node states arrive as activity events. */
  'workflows:run': (input: StartWorkflowInput) => Run
  'workflows:runs': (workflowId: string) => Run[]
  'workflows:runState': (runId: string) => WorkflowRunState
  'tasks:list': (filter?: TaskFilter) => Task[]
  'tasks:get': (id: string) => TaskDetail | null
  'tasks:create': (input: CreateTaskInput) => Task
  'tasks:update': (input: UpdateTaskInput) => Task
  'tasks:remove': (id: string) => void
  'agents:templates': () => AgentTemplateInfo[]
  'agents:list': () => Agent[]
  'agents:create': (input: CreateAgentInput) => Agent
  'agents:update': (input: UpdateAgentInput) => Agent
  'agents:duplicate': (id: string) => Agent
  'agents:remove': (id: string) => void
  /** Adds every template role that isn't already present in that scope (null = library). Returns the new agents. */
  'agents:createTeam': (projectId: string | null) => Agent[]
  'connections:catalog': () => ProviderCatalogItem[]
  'connections:list': () => Connection[]
  'connections:create': (input: CreateConnectionInput) => Connection
  'connections:update': (input: UpdateConnectionInput) => Connection
  /** Deletes the connection, its cached models/prices and its encrypted key. */
  'connections:remove': (id: string) => void
  'connections:test': (id: string) => ConnectionTestResult
  'models:list': (connectionId: string) => ModelEntry[]
  /** Calls the provider's model-list endpoint and caches the result. */
  'models:discover': (connectionId: string) => ModelEntry[]
  'models:setPricing': (input: SetPricingInput) => void
  /** Starts a streamed completion; returns a request id. Progress arrives on `onChatEvent`. */
  'chat:start': (input: ChatStartInput) => string
  'chat:cancel': (requestId: string) => void
  'usage:byModel': () => ModelUsageRow[]
  'fs:list': (input: { projectId: string; path?: string; includeIgnored?: boolean }) => DirListing
  'fs:read': (input: { projectId: string; path: string }) => FileContent
  /** Saves a file as the user. Refused while an agent holds the file's lock, or if it changed on disk since `fs:read`. */
  'fs:write': (input: WriteFileInput) => WriteFileResult
  'fs:create': (input: { projectId: string; path: string; kind: 'file' | 'dir' }) => string
  'fs:rename': (input: { projectId: string; from: string; to: string }) => { from: string; to: string }
  /** Deletes a file or folder (recursively) inside the project. Cannot be undone. */
  'fs:remove': (input: { projectId: string; path: string }) => void
  'fs:search': (input: { projectId: string; query: string; regex?: boolean; path?: string }) => SearchResult
  /** Updates the project's file index (only files that changed are read again). */
  'index:run': (projectId: string) => IndexSummary
  'index:status': (projectId: string) => IndexSummary
  'index:find': (input: { projectId: string; query: string; limit?: number }) => ContextMatch[]
  'locks:list': (projectId: string) => FileLockInfo[]
  'locks:release': (input: { projectId: string; path: string }) => boolean
  /** Runs a command typed by the user in the project folder. Returns a command id; output streams on `onTerminalEvent`. */
  'term:run': (input: RunCommandInput) => string
  'term:kill': (commandId: string) => boolean
  'term:history': (projectId: string) => CommandLogEntry[]
  'assets:list': (input: { projectId: string; kind?: AssetKind | null }) => AssetItem[]
  /** A PNG data URL scaled to fit within `max` pixels (default 256), or null when the file cannot be shown. */
  'assets:preview': (input: { id: string; max?: number }) => string | null
  'assets:imageModels': () => ImageModelOption[]
  'assets:generate': (input: GenerateAssetInput) => GenerateAssetResult
  'assets:cancel': (requestId: string) => boolean
  'assets:process': (input: ProcessAssetInput) => AssetItem
  'assets:remove': (input: { id: string; deleteFile: boolean }) => void
  'assets:reveal': (id: string) => void
  /** Price of one picture for an image model (USD). null clears it. */
  'images:setPrice': (input: { connectionId: string; model: string; priceUsd: number | null }) => void
  'term:policy': () => CommandPolicyInfo
  'approvals:list': () => PendingApproval[]
  'approvals:respond': (input: { id: string; allow: boolean }) => boolean
  'app:info': () => AppInfo
  'projects:list': () => Project[]
  'projects:get': (id: string) => Project | null
  'projects:create': (input: CreateProjectInput) => Project
  'projects:update': (input: UpdateProjectInput) => Project
  /** Unregisters the project from the studio. Never deletes files on disk. */
  'projects:remove': (id: string) => void
  'projects:pickFolder': () => string | null
  'projects:inspectFolder': (path: string) => FolderInspection
  'projects:reveal': (id: string) => void
  'dashboard:stats': () => DashboardStats
  'events:recent': (query?: RecentEventsQuery) => ActivityEvent[]
}

export type IpcChannel = keyof IpcContract

/** Runtime allow-list; typed so a channel cannot be forgotten. */
export const IPC_CHANNELS: Record<IpcChannel, true> = {
  'runs:start': true,
  'runs:list': true,
  'runs:stop': true,
  'runs:resume': true,
  'runs:stopAll': true,
  'workflows:list': true,
  'workflows:get': true,
  'workflows:save': true,
  'workflows:remove': true,
  'workflows:run': true,
  'workflows:runs': true,
  'workflows:runState': true,
  'tasks:list': true,
  'tasks:get': true,
  'tasks:create': true,
  'tasks:update': true,
  'tasks:remove': true,
  'agents:templates': true,
  'agents:list': true,
  'agents:create': true,
  'agents:update': true,
  'agents:duplicate': true,
  'agents:remove': true,
  'agents:createTeam': true,
  'connections:catalog': true,
  'connections:list': true,
  'connections:create': true,
  'connections:update': true,
  'connections:remove': true,
  'connections:test': true,
  'models:list': true,
  'models:discover': true,
  'models:setPricing': true,
  'chat:start': true,
  'chat:cancel': true,
  'usage:byModel': true,
  'fs:list': true,
  'fs:read': true,
  'fs:write': true,
  'fs:create': true,
  'fs:rename': true,
  'fs:remove': true,
  'fs:search': true,
  'index:run': true,
  'index:status': true,
  'index:find': true,
  'locks:list': true,
  'locks:release': true,
  'term:run': true,
  'term:kill': true,
  'term:history': true,
  'assets:list': true,
  'assets:preview': true,
  'assets:imageModels': true,
  'assets:generate': true,
  'assets:cancel': true,
  'assets:process': true,
  'assets:remove': true,
  'assets:reveal': true,
  'images:setPrice': true,
  'term:policy': true,
  'approvals:list': true,
  'approvals:respond': true,
  'app:info': true,
  'projects:list': true,
  'projects:get': true,
  'projects:create': true,
  'projects:update': true,
  'projects:remove': true,
  'projects:pickFolder': true,
  'projects:inspectFolder': true,
  'projects:reveal': true,
  'dashboard:stats': true,
  'events:recent': true
}

/** Main -> renderer push channel. */
export const ACTIVITY_CHANNEL = 'activity:new'
export const CHAT_CHANNEL = 'chat:event'
export const TERMINAL_CHANNEL = 'terminal:event'
/** Pushes the full list of commands waiting for the user's approval whenever it changes. */
export const APPROVAL_CHANNEL = 'approvals:changed'
/** A file was changed by an agent or the user. */
export const FS_CHANNEL = 'fs:changed'

// ------------------------------------------------------------------ assets (Phase 7)

export type AssetKind = 'sprite' | 'texture' | 'background' | 'ui' | 'icon' | 'concept' | 'other'

export const ASSET_KINDS: ReadonlyArray<{ value: AssetKind; label: string; hint: string }> = [
  { value: 'sprite', label: 'Sprite', hint: 'A character or object, usually with a transparent background' },
  { value: 'texture', label: 'Texture', hint: 'A surface that should tile or wrap a model' },
  { value: 'background', label: 'Background', hint: 'A full scene or backdrop' },
  { value: 'ui', label: 'UI element', hint: 'A button, panel, frame or HUD piece' },
  { value: 'icon', label: 'Icon', hint: 'A small symbol, usually square' },
  { value: 'concept', label: 'Concept art', hint: 'A reference picture for the team' },
  { value: 'other', label: 'Other', hint: 'Anything else' }
]

export interface AssetItem {
  id: string
  projectId: string
  taskId: string | null
  kind: AssetKind
  name: string
  /** Project-relative path of the file. */
  path: string
  prompt: string | null
  connectionId: string | null
  connectionName: string | null
  model: string | null
  width: number | null
  height: number | null
  transparent: boolean
  parentId: string | null
  /** 'generated' came straight from an image model; 'processed' was derived from another asset by an editing step. */
  origin: 'generated' | 'processed'
  bytes: number
  /** What was done to derive it, e.g. "Resized to 64×64". */
  note: string | null
  /** False when the file is no longer on disk (deleted outside the app). */
  exists: boolean
  createdAt: number
}

export interface ImageModelOption {
  connectionId: string
  connectionName: string
  providerKind: ProviderKind
  model: string
  /** True when the provider reported this as an image model; false when the user can still try it (unlisted or custom servers). */
  listedAsImage: boolean
  priceUsd: number | null
  supportsEdit: boolean
  sizes: string[] | null
}

export interface GenerateAssetInput {
  /** Identifies the request so it can be cancelled with `assets:cancel`. */
  requestId: string
  projectId: string
  connectionId: string
  model: string
  prompt: string
  kind: AssetKind
  /** Used for the file name; derived from the prompt when empty. */
  name?: string
  /** e.g. "1024x1024". Models pick the nearest size they support. */
  size?: string
  count: number
  transparent: boolean
  /** Edit or vary this asset instead of starting from scratch (the model must support edits). */
  referenceAssetId?: string
}

export interface GenerateAssetResult {
  assets: AssetItem[]
  /** null = unknown: no price was entered for this model. */
  costUsd: number | null
  /** Things worth knowing, e.g. that transparency was applied by the app rather than the model. */
  notes: string[]
}

export type AssetOperation =
  | { type: 'resize'; width: number; height: number; fit: 'contain' | 'cover' | 'stretch'; pixelArt?: boolean }
  | { type: 'trim'; padding?: number }
  | { type: 'removeBackground'; tolerance?: number }

export interface ProcessAssetInput {
  id: string
  operation: AssetOperation
  /** Replace the file instead of saving a new asset next to it. The original is kept by default. */
  replace?: boolean
}

export interface FsChange {
  projectId: string
  path: string
  kind: 'write' | 'remove' | 'rename'
  by: 'user' | 'agent'
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: { message: string } }

/** What `window.api` looks like in the renderer. */
export interface StudioApi {
  invoke<K extends IpcChannel>(channel: K, ...args: Parameters<IpcContract[K]>): Promise<Awaited<ReturnType<IpcContract[K]>>>
  /** Subscribe to live activity events. Returns an unsubscribe function. */
  onActivity(cb: (event: ActivityEvent) => void): () => void
  /** Subscribe to streamed chat progress for requests started with `chat:start`. */
  onChatEvent(cb: (event: ChatStreamEvent) => void): () => void
  /** Output of commands run in the project (by the user or by agents). */
  onTerminalEvent(cb: (event: TerminalEvent) => void): () => void
  onApprovalsChanged(cb: (pending: PendingApproval[]) => void): () => void
  onFsChange(cb: (change: FsChange) => void): () => void
}

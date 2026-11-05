import type { Agent, DirListing, FileContent, FileLockInfo, FsChange, IndexSummary, ContextMatch, SearchResult, WriteFileInput, WriteFileResult } from '../../shared/ipc'
import type { Database } from '../db/database'
import type { EventService } from '../services/events'
import { ContextIndexer } from './indexer'
import { TaskJournal, type RollbackResult } from './journal'
import { FileLockedError, FileLocks } from './locks'
import { Sandbox, WorkspaceError, isSecretPath, normalizeRel } from './sandbox'
import { FolderWatcher } from './watcher'

interface ProjectRow {
  id: string
  name: string
  root_path: string
}

/** The agent (and task) on whose behalf a file operation runs. */
export interface Actor {
  agent: Agent
  runId: string
  taskId: string
}

/**
 * Project-aware file access: finds the project's folder, enforces locks, keeps the index fresh and tells the UI
 * what changed. The user and agents go through the same sandbox; the differences are the lock check (the user
 * cannot overwrite a file an agent is editing) and that agents may not read credential files.
 */
const OWN_WINDOW_MS = 2500

export class WorkspaceService {
  private readonly sandboxes = new Map<string, Sandbox>()
  private readonly changeListeners = new Set<(c: FsChange) => void>()

  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    readonly locks: FileLocks,
    readonly indexer: ContextIndexer
  ) {}

  onChange(cb: (c: FsChange) => void): () => void {
    this.changeListeners.add(cb)
    return () => this.changeListeners.delete(cb)
  }

  private emit(c: FsChange): void {
    if (c.by !== 'external') this.noteOwn(c.projectId, c.path)
    for (const l of this.changeListeners) l(c)
  }

  // ------------------------------------------------------------------ changes made by other programs

  private watcher: { projectId: string; w: FolderWatcher } | null = null
  /** Paths this app changed a moment ago: the folder watcher sees those too and must not report them as foreign edits. */
  private readonly own = new Map<string, number>()

  private noteOwn(projectId: string, path: string): void {
    const now = Date.now()
    if (this.own.size > 500) for (const [k, t] of this.own) if (now - t > OWN_WINDOW_MS) this.own.delete(k)
    this.own.set(`${projectId}:${path.toLowerCase()}`, now)
  }

  private isOwn(projectId: string, path: string): boolean {
    const now = Date.now()
    const parts = path.toLowerCase().split('/')
    // The path itself, or a folder above it that this app just changed (deleted, renamed, restored).
    for (let i = parts.length; i > 0; i--) {
      const t = this.own.get(`${projectId}:${parts.slice(0, i).join('/')}`)
      if (t !== undefined && now - t <= OWN_WINDOW_MS) return true
    }
    return false
  }

  /**
   * Watches one project folder so the file tree, editors and Source Control notice edits made outside the app. Only one
   * project is watched at a time (the one on screen); null stops. Returns false when the folder cannot be watched.
   */
  watchProject(projectId: string | null): boolean {
    if (this.watcher && this.watcher.projectId === projectId && this.watcher.w.running) return true
    this.stopWatching()
    if (!projectId) return true
    let root: string
    try {
      root = this.sandbox(projectId).root
    } catch {
      return false
    }
    const w = new FolderWatcher(root, (path, exists) => {
      if (this.isOwn(projectId, path)) return
      this.emit({ projectId, path, kind: exists ? 'write' : 'remove', by: 'external' })
    })
    if (!w.start()) return false
    this.watcher = { projectId, w }
    return true
  }

  stopWatching(): void {
    this.watcher?.w.stop()
    this.watcher = null
  }

  /** Lets other services that write into a project folder (the asset pipeline) refresh the file tree. */
  notify(c: FsChange): void {
    this.emit(c)
  }

  // ------------------------------------------------------------------ undo journal for agent tasks (Auto Recovery)

  private readonly journals = new Map<string, TaskJournal>()

  /** From now on, the agent write/delete tools remember what each file looked like before this task changed it. */
  beginJournal(taskId: string): void {
    this.journals.set(taskId, new TaskJournal())
  }

  /** Forgets the journal (the task is finished or was rolled back). */
  endJournal(taskId: string): void {
    this.journals.delete(taskId)
  }

  /** Undoes what the task changed through the write/delete tools and tells the UI which files changed. */
  async rollbackJournal(projectId: string, taskId: string): Promise<RollbackResult> {
    const j = this.journals.get(taskId)
    if (!j) return { restored: [], removed: [], skipped: [] }
    const r = await j.rollback(this.sandbox(projectId))
    for (const path of [...r.restored, ...r.removed]) this.emit({ projectId, path, kind: r.removed.includes(path) ? 'remove' : 'write', by: 'agent' })
    return r
  }

  project(projectId: string): { id: string; name: string; rootPath: string } {
    const row = this.db.get<ProjectRow>(`SELECT id, name, root_path FROM projects WHERE id = ?`, projectId)
    if (!row) throw new WorkspaceError('Project not found.', 'not_found')
    return { id: row.id, name: row.name, rootPath: row.root_path }
  }

  /** One Sandbox per project; re-created if the project's folder changed. */
  sandbox(projectId: string): Sandbox {
    const p = this.project(projectId)
    const cached = this.sandboxes.get(projectId)
    if (cached && cached.root === this.tryReal(p.rootPath)) return cached
    const sb = new Sandbox(p.rootPath)
    this.sandboxes.set(projectId, sb)
    return sb
  }

  private tryReal(path: string): string | null {
    try {
      return new Sandbox(path).root
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------------ the user

  async list(projectId: string, path = '', includeIgnored = false): Promise<DirListing> {
    return this.sandbox(projectId).list(path, { includeIgnored })
  }

  async read(projectId: string, path: string): Promise<FileContent> {
    const sb = this.sandbox(projectId)
    const f = await sb.read(path)
    const lock = this.locks.heldByOther(projectId, f.path)
    return { ...f, lockedBy: lock ? (lock.agentName ?? 'an agent') : null }
  }

  async write(input: WriteFileInput): Promise<WriteFileResult> {
    const sb = this.sandbox(input.projectId)
    const { rel } = sb.resolve(input.path)
    const lock = this.locks.heldByOther(input.projectId, rel)
    if (lock) throw new WorkspaceError(`“${rel}” is being edited by ${lock.agentName ?? 'an agent'}${lock.taskTitle ? ` (task “${lock.taskTitle}”)` : ''}. Wait for the task to finish, or release the lock first.`, 'locked')
    const r = await sb.write(rel, input.content, { expectedHash: input.expectedHash })
    this.events.record({ projectId: input.projectId, level: 'debug', type: 'file.saved', message: `You saved ${r.path} (${r.size} bytes)` })
    this.emit({ projectId: input.projectId, path: r.path, kind: 'write', by: 'user' })
    return r
  }

  async create(projectId: string, path: string, kind: 'file' | 'dir'): Promise<string> {
    const sb = this.sandbox(projectId)
    if (kind === 'dir') {
      const p = await sb.mkdir(path)
      this.emit({ projectId, path: p, kind: 'write', by: 'user' })
      return p
    }
    const r = await sb.write(path, '', { expectedHash: null })
    this.emit({ projectId, path: r.path, kind: 'write', by: 'user' })
    return r.path
  }

  async rename(projectId: string, from: string, to: string): Promise<{ from: string; to: string }> {
    const sb = this.sandbox(projectId)
    const a = sb.resolve(from)
    const lock = this.locks.heldByOther(projectId, a.rel)
    if (lock) throw new WorkspaceError(`“${a.rel}” is being edited by ${lock.agentName ?? 'an agent'}.`, 'locked')
    const r = await sb.rename(from, to)
    this.noteOwn(projectId, r.to)
    this.emit({ projectId, path: r.from, kind: 'rename', by: 'user' })
    return r
  }

  async remove(projectId: string, path: string): Promise<void> {
    const sb = this.sandbox(projectId)
    const { rel } = sb.resolve(path)
    const lock = this.locks.list(projectId).find((l) => l.path === rel.toLowerCase() || l.path === rel || l.path.startsWith(`${rel.toLowerCase()}/`))
    if (lock) throw new WorkspaceError(`“${rel}” is being edited by ${lock.agentName ?? 'an agent'}.`, 'locked')
    const r = await sb.remove(rel)
    this.events.record({ projectId, level: 'info', type: 'file.deleted', message: `You deleted ${r.path}${r.wasDir ? ' (folder)' : ''}` })
    this.emit({ projectId, path: r.path, kind: 'remove', by: 'user' })
  }

  async search(projectId: string, query: string, opts: { regex?: boolean; path?: string } = {}): Promise<SearchResult> {
    return this.sandbox(projectId).search(query, { regex: opts.regex, path: opts.path, maxResults: 200 })
  }

  lockList(projectId: string): FileLockInfo[] {
    return this.locks.list(projectId).map((l) => ({ path: l.path, agentId: l.agentId, agentName: l.agentName, taskId: l.taskId, taskTitle: l.taskTitle, acquiredAt: l.acquiredAt, expiresAt: l.expiresAt }))
  }

  async indexRun(projectId: string): Promise<IndexSummary> {
    return this.indexer.index(projectId, this.sandbox(projectId))
  }

  indexStatus(projectId: string): IndexSummary {
    this.project(projectId)
    return this.indexer.status(projectId)
  }

  async indexFind(projectId: string, query: string, limit?: number): Promise<ContextMatch[]> {
    await this.indexRun(projectId)
    return this.indexer.find(projectId, query, limit)
  }

  // ------------------------------------------------------------------ agents

  private assertReadable(rel: string, actor: Actor): void {
    if (!actor.agent.permissions.readFiles) throw new WorkspaceError('You are not allowed to read files.', 'denied')
    if (isSecretPath(rel)) throw new WorkspaceError(`“${rel}” may hold credentials, so agents cannot read it. Ask the user to provide the values you need in a safe way.`, 'denied')
  }

  async agentList(projectId: string, path: string, includeIgnored: boolean, actor: Actor): Promise<DirListing> {
    if (!actor.agent.permissions.readFiles) throw new WorkspaceError('You are not allowed to read files.', 'denied')
    const r = await this.sandbox(projectId).list(path, { includeIgnored })
    return { ...r, entries: r.entries.filter((e) => e.type === 'dir' || !isSecretPath(e.path)) }
  }

  async agentTree(projectId: string, path: string, actor: Actor, max: number): Promise<{ files: Array<{ path: string; size: number }>; truncated: boolean }> {
    if (!actor.agent.permissions.readFiles) throw new WorkspaceError('You are not allowed to read files.', 'denied')
    const r = await this.sandbox(projectId).walk(path, { max, includeBinary: true })
    return { files: r.files.filter((f) => !isSecretPath(f.path)).map((f) => ({ path: f.path, size: f.size })), truncated: r.truncated }
  }

  async agentRead(projectId: string, path: string, actor: Actor, maxBytes: number): Promise<FileContent> {
    const rel = normalizeRel(path)
    this.assertReadable(rel, actor)
    const f = await this.sandbox(projectId).read(rel, { maxBytes })
    return { ...f, lockedBy: null }
  }

  /** Takes the file's lock for the agent's task, then writes. `expectedHash` guards read-modify-write edits. */
  async agentWrite(projectId: string, path: string, content: string, actor: Actor, expectedHash?: string | null): Promise<WriteFileResult> {
    if (!actor.agent.permissions.writeFiles) throw new WorkspaceError('You are not allowed to write files.', 'denied')
    const sb = this.sandbox(projectId)
    const { rel } = sb.resolve(path)
    if (isSecretPath(rel)) throw new WorkspaceError(`“${rel}” may hold credentials, so agents cannot write it.`, 'denied')
    this.locks.acquire(projectId, rel, actor.agent.id, actor.taskId)
    const journal = this.journals.get(actor.taskId)
    await journal?.capture(sb, rel)
    const r = await sb.write(rel, content, { expectedHash })
    await journal?.settle(sb, rel, false)
    this.events.record({ projectId, runId: actor.runId, agentId: actor.agent.id, type: 'file.written', message: `${actor.agent.name} ${r.created ? 'created' : 'wrote'} ${r.path} (${r.size} bytes)` })
    this.emit({ projectId, path: r.path, kind: 'write', by: 'agent' })
    return r
  }

  async agentRemove(projectId: string, path: string, actor: Actor): Promise<string> {
    if (!actor.agent.permissions.writeFiles) throw new WorkspaceError('You are not allowed to delete files.', 'denied')
    const sb = this.sandbox(projectId)
    const { rel } = sb.resolve(path)
    this.locks.acquire(projectId, rel, actor.agent.id, actor.taskId)
    const journal = this.journals.get(actor.taskId)
    await journal?.capture(sb, rel)
    const r = await sb.remove(rel, { filesOnly: true })
    await journal?.settle(sb, rel, true)
    this.events.record({ projectId, runId: actor.runId, agentId: actor.agent.id, level: 'warn', type: 'file.deleted', message: `${actor.agent.name} deleted ${r.path}` })
    this.emit({ projectId, path: r.path, kind: 'remove', by: 'agent' })
    return r.path
  }

  async agentSearch(projectId: string, query: string, opts: { regex?: boolean; path?: string }, actor: Actor): Promise<SearchResult> {
    if (!actor.agent.permissions.readFiles) throw new WorkspaceError('You are not allowed to read files.', 'denied')
    return this.sandbox(projectId).search(query, { regex: opts.regex, path: opts.path, maxResults: 60, skip: isSecretPath })
  }

  async agentFindContext(projectId: string, query: string, actor: Actor): Promise<ContextMatch[]> {
    if (!actor.agent.permissions.readFiles) throw new WorkspaceError('You are not allowed to read files.', 'denied')
    return this.indexFind(projectId, query, 12)
  }
}

export { FileLockedError }

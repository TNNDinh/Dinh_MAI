import type { Agent, DirListing, FileContent, FileLockInfo, FsChange, IndexSummary, ContextMatch, SearchResult, WriteFileInput, WriteFileResult } from '../../shared/ipc'
import type { Database } from '../db/database'
import type { EventService } from '../services/events'
import { ContextIndexer } from './indexer'
import { FileLockedError, FileLocks } from './locks'
import { Sandbox, WorkspaceError, isSecretPath, normalizeRel } from './sandbox'

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
    for (const l of this.changeListeners) l(c)
  }

  /** Lets other services that write into a project folder (the asset pipeline) refresh the file tree. */
  notify(c: FsChange): void {
    this.emit(c)
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
    const r = await sb.write(rel, content, { expectedHash })
    this.events.record({ projectId, runId: actor.runId, agentId: actor.agent.id, type: 'file.written', message: `${actor.agent.name} ${r.created ? 'created' : 'wrote'} ${r.path} (${r.size} bytes)` })
    this.emit({ projectId, path: r.path, kind: 'write', by: 'agent' })
    return r
  }

  async agentRemove(projectId: string, path: string, actor: Actor): Promise<string> {
    if (!actor.agent.permissions.writeFiles) throw new WorkspaceError('You are not allowed to delete files.', 'denied')
    const sb = this.sandbox(projectId)
    const { rel } = sb.resolve(path)
    this.locks.acquire(projectId, rel, actor.agent.id, actor.taskId)
    const r = await sb.remove(rel, { filesOnly: true })
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

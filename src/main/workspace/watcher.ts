import { existsSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { IGNORED_DIRS } from './sandbox'

const TEMP_WRITE = /^\..+\.[0-9a-f]{8}\.tmp$/

export interface FolderWatcherOptions {
  /** Changes to one path within this time are reported once (editors and tools write in several steps). */
  debounceMs?: number
  /** Distinct paths reported per burst, so a tool that rewrites thousands of files cannot flood the UI. */
  maxPending?: number
}

/**
 * Reports changes made to a project folder by programs outside the app (an editor, git, a build, the user's own terminal).
 * It uses the operating system's recursive watch (Windows and macOS: native; Linux: Node's emulation), skips `.git` and
 * the folders the file tree hides (node_modules, dist, …), and never keeps the process alive.
 */
export class FolderWatcher {
  private watcher: FSWatcher | null = null
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly debounceMs: number
  private readonly maxPending: number

  constructor(
    readonly root: string,
    private readonly onChange: (rel: string, exists: boolean) => void,
    opts: FolderWatcherOptions = {}
  ) {
    this.debounceMs = opts.debounceMs ?? 150
    this.maxPending = opts.maxPending ?? 200
  }

  get running(): boolean {
    return this.watcher !== null
  }

  /** Returns false (and watches nothing) when the platform or folder cannot be watched; the app then simply has no live refresh. */
  start(): boolean {
    if (this.watcher) return true
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, (_event, name) => {
        if (name) this.touch(String(name))
      })
      this.watcher.on('error', () => this.stop())
      return true
    } catch {
      this.watcher = null
      return false
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    for (const t of this.pending.values()) clearTimeout(t)
    this.pending.clear()
  }

  private touch(name: string): void {
    const rel = name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!rel || this.hidden(rel)) return
    const key = rel.toLowerCase()
    const existing = this.pending.get(key)
    if (existing) clearTimeout(existing)
    else if (this.pending.size >= this.maxPending) return
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key)
        if (!this.watcher) return
        this.onChange(rel, existsSync(join(this.root, rel)))
      }, this.debounceMs)
    )
  }

  private hidden(rel: string): boolean {
    const parts = rel.split('/')
    // The sandbox writes files through a temporary ".<name>.<8 hex>.tmp" sibling and renames it; that is never a real edit.
    if (TEMP_WRITE.test(parts[parts.length - 1])) return true
    for (const part of parts) {
      if (part.toLowerCase() === '.git' || IGNORED_DIRS.has(part)) return true
    }
    return false
  }
}

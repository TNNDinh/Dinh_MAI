import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import type { Sandbox } from './sandbox'

/** A file bigger than this is not copied into the journal (it cannot be rolled back; the task report says so). */
export const JOURNAL_FILE_LIMIT = 2 * 1024 * 1024
/** All files of one task together. */
export const JOURNAL_TOTAL_LIMIT = 20 * 1024 * 1024

export interface RollbackResult {
  /** Files put back to what they were before the task. */
  restored: string[]
  /** Files the task created, now deleted. */
  removed: string[]
  /** Files that could not be rolled back (too large to keep a copy of, or changed on disk by something else since). */
  skipped: string[]
}

interface Entry {
  /** The bytes the file had when the task first touched it; null = it did not exist. */
  before: Buffer | null
  /** Too large to copy: left as the task wrote it. */
  tooLarge: boolean
  /** What the task last wrote (to detect that something else changed the file afterwards); null = the task deleted it. */
  after: Buffer | null | undefined
}

/**
 * Remembers what files looked like before one agent task changed them, so a failed task can be undone exactly: the agent's write and delete tools
 * record the original content the first time the task touches a file. It is held in memory only and lives as long as the task does.
 * It knows nothing about changes made by commands the agent ran (npm install, a build): those are outside what it can undo.
 */
export class TaskJournal {
  private readonly entries = new Map<string, Entry>()
  private bytes = 0

  get size(): number {
    return this.entries.size
  }

  /** Call right before the task changes `rel` (after it holds the file's lock). Only the first call per file records anything. */
  async capture(sandbox: Sandbox, rel: string): Promise<void> {
    if (this.entries.has(rel)) return
    const full = sandbox.resolve(rel).full
    let before: Buffer | null = null
    let tooLarge = false
    try {
      const st = await fsp.stat(full)
      if (!st.isFile() || st.size > JOURNAL_FILE_LIMIT || this.bytes + st.size > JOURNAL_TOTAL_LIMIT) tooLarge = true
      else {
        before = await fsp.readFile(full)
        this.bytes += before.length
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') tooLarge = true // unreadable: do not pretend it can be restored
    }
    this.entries.set(rel, { before, tooLarge, after: undefined })
  }

  /** Call after the task wrote `content` to `rel`, or deleted it (null). */
  async settle(sandbox: Sandbox, rel: string, deleted: boolean): Promise<void> {
    const e = this.entries.get(rel)
    if (!e) return
    if (deleted) e.after = null
    else {
      try {
        e.after = await fsp.readFile(sandbox.resolve(rel).full)
      } catch {
        e.after = undefined
      }
    }
  }

  /**
   * Puts every touched file back. A file that something else changed after the task's last write is left alone (and reported), so a rollback never
   * destroys work that is not the task's.
   */
  async rollback(sandbox: Sandbox): Promise<RollbackResult> {
    const out: RollbackResult = { restored: [], removed: [], skipped: [] }
    for (const [rel, e] of this.entries) {
      if (e.tooLarge) {
        out.skipped.push(rel)
        continue
      }
      let full: string
      try {
        full = sandbox.resolve(rel).full
      } catch {
        out.skipped.push(rel)
        continue
      }
      let now: Buffer | null = null
      try {
        now = await fsp.readFile(full)
      } catch {
        now = null
      }
      if (e.after !== undefined && !same(now, e.after)) {
        out.skipped.push(rel)
        continue
      }
      try {
        if (e.before === null) {
          if (now !== null) {
            await fsp.rm(full)
            out.removed.push(rel)
          }
        } else if (!same(now, e.before)) {
          await fsp.mkdir(dirname(full), { recursive: true })
          await fsp.writeFile(full, e.before)
          out.restored.push(rel)
        }
      } catch {
        out.skipped.push(rel)
      }
    }
    this.entries.clear()
    this.bytes = 0
    return out
  }
}

const same = (a: Buffer | null, b: Buffer | null): boolean => (a === null || b === null ? a === b : a.equals(b))

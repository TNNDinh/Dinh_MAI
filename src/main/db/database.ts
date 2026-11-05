import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { MIGRATIONS, type Migration } from './migrations'

/*
 * node:sqlite ships with Node >= 22.5 and Electron >= 37, so there is no native
 * module to rebuild per Electron ABI. `process.getBuiltinModule` is used instead
 * of a static import so bundlers never try to resolve "node:sqlite".
 */
const { DatabaseSync: SqliteDatabase } = process.getBuiltinModule('node:sqlite')

export type SqlValue = string | number | bigint | null | Uint8Array

export class Database {
  private readonly db: DatabaseSync
  private readonly cache = new Map<string, StatementSync>()
  private txDepth = 0

  constructor(path: string) {
    this.db = new SqliteDatabase(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  }

  /** Apply pending migrations in order; each runs in its own transaction. Returns the new version. */
  migrate(migrations: Migration[] = MIGRATIONS): number {
    let current = this.userVersion()
    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (m.version <= current) continue
      this.transaction(() => {
        this.db.exec(m.sql)
        this.db.exec(`PRAGMA user_version = ${m.version}`)
      })
      current = m.version
    }
    return current
  }

  userVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    return row.user_version
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint } {
    const r = this.stmt(sql).run(...params)
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...params) as T[]
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  /** Run `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.txDepth++
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    } finally {
      this.txDepth--
    }
  }

  close(): void {
    this.cache.clear()
    this.db.close()
  }
}

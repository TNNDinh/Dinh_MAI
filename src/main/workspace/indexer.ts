import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { ContextMatch, IndexSummary } from '../../shared/ipc'
import { languageFor } from '../../shared/language'
import type { Database } from '../db/database'
import { isSecretPath, sha1, type Sandbox } from './sandbox'

const MAX_INDEXED_BYTES = 400_000
const MAX_SYMBOLS = 60
const MAX_IMPORTS = 30

interface Extracted {
  symbols: string[]
  imports: string[]
  summary: string | null
}

const uniq = (xs: string[], max: number): string[] => [...new Set(xs)].slice(0, max)

function matches(text: string, re: RegExp, group = 1): string[] {
  const out: string[] = []
  for (const m of text.matchAll(re)) if (m[group]) out.push(m[group])
  return out
}

/** Regex-based, language-aware extraction. Heuristic by design: no parser, no model call. */
export function extract(path: string, text: string): Extracted {
  const lang = languageFor(path)
  let symbols: string[] = []
  let imports: string[] = []
  switch (lang) {
    case 'typescript':
    case 'javascript':
      symbols = matches(text, /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)
      symbols.push(...matches(text, /^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm), ...matches(text, /^\s*class\s+([A-Za-z_$][\w$]*)/gm))
      imports = [...matches(text, /\bfrom\s+['"]([^'"]+)['"]/g), ...matches(text, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g), ...matches(text, /^\s*import\s+['"]([^'"]+)['"]/gm)]
      break
    case 'python':
      symbols = matches(text, /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm)
      imports = [...matches(text, /^\s*import\s+([\w.]+)/gm), ...matches(text, /^\s*from\s+([\w.]+)\s+import/gm)]
      break
    case 'csharp':
      symbols = matches(text, /\b(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/g)
      imports = matches(text, /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm)
      break
    case 'go':
      symbols = [...matches(text, /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm), ...matches(text, /^type\s+([A-Za-z_]\w*)/gm)]
      imports = matches(text, /^\s*(?:import\s+)?"([^"]+)"\s*$/gm)
      break
    case 'rust':
      symbols = matches(text, /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\s+([A-Za-z_]\w*)/gm)
      imports = matches(text, /^\s*use\s+([\w:]+)/gm)
      break
    case 'java':
    case 'kotlin':
      symbols = matches(text, /\b(?:class|interface|enum|object|fun)\s+([A-Za-z_]\w*)/g)
      imports = matches(text, /^\s*import\s+([\w.]+)/gm)
      break
    case 'cpp':
    case 'c':
      symbols = matches(text, /\b(?:class|struct|enum)\s+([A-Za-z_]\w*)/g)
      imports = matches(text, /^\s*#include\s+[<"]([^>"]+)[>"]/gm)
      break
    case 'gdscript':
      symbols = matches(text, /^\s*(?:class_name|class|func|signal)\s+([A-Za-z_]\w*)/gm)
      break
    case 'lua':
      symbols = matches(text, /^\s*(?:local\s+)?function\s+([\w.:]+)/gm)
      break
    case 'markdown':
      symbols = matches(text, /^#{1,3}\s+(.+?)\s*$/gm)
      break
    case 'html':
      imports = [...matches(text, /<script[^>]+src=["']([^"']+)["']/gi), ...matches(text, /<link[^>]+href=["']([^"']+)["']/gi)]
      break
    default:
      break
  }
  return { symbols: uniq(symbols, MAX_SYMBOLS), imports: uniq(imports, MAX_IMPORTS), summary: summarize(lang, text) }
}

/** First doc comment, heading or leading comment line (<= 200 chars). */
function summarize(lang: string, text: string): string | null {
  const head = text.slice(0, 1500)
  const clean = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 200)
  if (lang === 'markdown') {
    const h = head.match(/^#\s+(.+)$/m)
    return h ? clean(h[1]) : null
  }
  const block = head.match(/^\s*(?:#!.*\n)?\s*\/\*+\s*([\s\S]*?)\*\//)
  if (block) {
    const t = clean(block[1].replace(/^\s*\*\s?/gm, ' '))
    if (t) return t
  }
  const lines = head.split('\n').slice(0, 12)
  const comment: string[] = []
  for (const l of lines) {
    const m = l.match(/^\s*(?:\/\/+|#(?!!)|--|;)\s?(.*)$/)
    if (m) comment.push(m[1])
    else if (comment.length || l.trim()) break
  }
  if (comment.length) return clean(comment.join(' ')) || null
  const py = head.match(/^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/)
  return py ? clean(py[1]) || null : null
}

interface IndexRow {
  path: string
  content_hash: string
  size: number
  language: string | null
  summary: string | null
  symbols_json: string
  imports_json: string
  indexed_at: number
  mtime_ms: number
}

const tokens = (q: string): string[] => [...new Set(q.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2))]

/**
 * Keeps a per-project table of what each file is and exports, so an agent can ask "where is the player movement
 * code?" without reading the whole repository. Extraction and ranking are deterministic heuristics, not a model.
 */
export class ContextIndexer {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now
  ) {}

  status(projectId: string): IndexSummary {
    const r = this.db.get<{ n: number; at: number | null }>(`SELECT COUNT(*) AS n, MAX(indexed_at) AS at FROM file_index WHERE project_id = ?`, projectId)
    return { files: r?.n ?? 0, indexedAt: r?.at ?? null, updated: 0, removed: 0, truncated: false }
  }

  /** Re-reads only the files whose size or modification time changed, and forgets deleted files. */
  async index(projectId: string, sandbox: Sandbox): Promise<IndexSummary> {
    const { files, truncated } = await sandbox.walk('', { maxFileBytes: MAX_INDEXED_BYTES })
    const known = new Map(this.db.all<IndexRow>(`SELECT * FROM file_index WHERE project_id = ?`, projectId).map((r) => [r.path, r]))
    const t = this.now()
    let updated = 0
    const rows: Array<[string, IndexRow]> = []
    for (const f of files) {
      if (isSecretPath(f.path)) continue
      const prev = known.get(f.path)
      if (prev && prev.size === f.size && prev.mtime_ms === Math.floor(f.mtimeMs)) continue
      let buf: Buffer
      try {
        buf = await fsp.readFile(join(sandbox.root, ...f.path.split('/')))
      } catch {
        continue
      }
      if (buf.subarray(0, 4000).includes(0)) continue
      const hash = sha1(buf)
      if (prev && prev.content_hash === hash) {
        rows.push([f.path, { ...prev, mtime_ms: Math.floor(f.mtimeMs) }])
        continue
      }
      const x = extract(f.path, buf.toString('utf8'))
      updated++
      rows.push([f.path, { path: f.path, content_hash: hash, size: f.size, language: languageFor(f.path), summary: x.summary, symbols_json: JSON.stringify(x.symbols), imports_json: JSON.stringify(x.imports), indexed_at: t, mtime_ms: Math.floor(f.mtimeMs) }])
    }
    const present = new Set(files.map((f) => f.path))
    const gone = [...known.keys()].filter((p) => !present.has(p) || isSecretPath(p))
    this.db.transaction(() => {
      for (const [, r] of rows) {
        this.db.run(
          `INSERT INTO file_index (project_id, path, content_hash, size, language, summary, symbols_json, imports_json, indexed_at, mtime_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, path) DO UPDATE SET content_hash = excluded.content_hash, size = excluded.size, language = excluded.language, summary = excluded.summary,
             symbols_json = excluded.symbols_json, imports_json = excluded.imports_json, indexed_at = excluded.indexed_at, mtime_ms = excluded.mtime_ms`,
          projectId, r.path, r.content_hash, r.size, r.language, r.summary, r.symbols_json, r.imports_json, r.indexed_at, r.mtime_ms
        )
      }
      for (const p of gone) this.db.run(`DELETE FROM file_index WHERE project_id = ? AND path = ?`, projectId, p)
    })
    const s = this.status(projectId)
    return { ...s, indexedAt: s.indexedAt ?? t, updated, removed: gone.length, truncated }
  }

  /** Ranks indexed files for a free-text question. Matches in the file name and exported symbols count most. */
  find(projectId: string, query: string, limit = 12): ContextMatch[] {
    const qs = tokens(query)
    if (qs.length === 0) return []
    const rows = this.db.all<IndexRow>(`SELECT * FROM file_index WHERE project_id = ?`, projectId)
    const out: ContextMatch[] = []
    for (const r of rows) {
      const path = r.path.toLowerCase()
      const symbols: string[] = JSON.parse(r.symbols_json)
      const imports: string[] = JSON.parse(r.imports_json)
      const symLower = symbols.map((s) => s.toLowerCase())
      const summary = (r.summary ?? '').toLowerCase()
      let score = 0
      for (const q of qs) {
        const base = path.split('/').pop() ?? path
        if (base.includes(q)) score += 5
        else if (path.includes(q)) score += 3
        if (symLower.some((s) => s === q)) score += 6
        else if (symLower.some((s) => s.includes(q))) score += 4
        if (summary.includes(q)) score += 2
        if (imports.some((i) => i.toLowerCase().includes(q))) score += 1
      }
      if (score > 0) out.push({ path: r.path, language: r.language, summary: r.summary, symbols: symbols.slice(0, 12), imports: imports.slice(0, 8), score })
    }
    return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, Math.min(Math.max(limit, 1), 50))
  }
}

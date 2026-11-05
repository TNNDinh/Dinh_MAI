import { Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { SearchHit } from '../../../../shared/ipc'
import { Input } from '../ui'

/** Text search across the project (literal by default, regular expression on request). */
export function SearchPanel({ projectId, onOpen }: { projectId: string; onOpen: (path: string, line: number) => void }) {
  const [query, setQuery] = useState('')
  const [regex, setRegex] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ query: string; hits: SearchHit[]; truncated: boolean; scanned: number } | null>(null)

  const run = async (): Promise<void> => {
    const q = query.trim()
    if (!q) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.invoke('fs:search', { projectId, query: q, regex })
      setResult({ query: q, ...r })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const grouped = useMemo(() => {
    const m = new Map<string, SearchHit[]>()
    for (const h of result?.hits ?? []) m.set(h.path, [...(m.get(h.path) ?? []), h])
    return [...m.entries()]
  }, [result])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        className="space-y-1.5 border-b border-line p-2"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute top-2.5 left-2 text-faint" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search in project" aria-label="Search in project" className="pl-7" />
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-faint">
          <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} className="accent-[#7c6cff]" />
          Regular expression
        </label>
      </form>
      <div className="min-h-0 flex-1 overflow-y-auto text-[12px]">
        {busy && <p className="p-3 text-faint">Searching…</p>}
        {error && <p className="p-3 text-err">{error}</p>}
        {!busy && !error && result && (
          <>
            <p className="px-3 py-2 text-[11px] text-faint">
              {result.hits.length === 0 ? 'No matches' : `${result.hits.length}${result.truncated ? '+' : ''} matches in ${grouped.length} files`} · {result.scanned} files scanned
            </p>
            {grouped.map(([path, hits]) => (
              <div key={path}>
                <div className="truncate bg-elev/60 px-3 py-1 font-mono text-[11px] text-muted" title={path}>
                  {path}
                </div>
                {hits.map((h) => (
                  <button key={`${h.path}:${h.line}`} onClick={() => onOpen(h.path, h.line)} className="flex w-full gap-2 px-3 py-0.5 text-left hover:bg-hover" data-hit>
                    <span className="w-8 shrink-0 text-right text-faint tabular-nums">{h.line}</span>
                    <span className="truncate font-mono text-fg">{h.text.trim()}</span>
                  </button>
                ))}
              </div>
            ))}
            {result.truncated && <p className="p-3 text-[11px] text-warn">Showing the first matches only. Narrow the search.</p>}
          </>
        )}
        {!busy && !error && !result && <p className="p-3 text-faint">Search skips node_modules, dist and binary files.</p>}
      </div>
    </div>
  )
}

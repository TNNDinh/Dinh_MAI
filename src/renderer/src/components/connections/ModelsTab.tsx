import { CloudDownload, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Connection, ModelEntry } from '../../../../shared/ipc'
import { useStudio } from '../../store'
import { fmtTokens } from '../../lib/format'
import { Badge, Button, EmptyState, Input } from '../ui'
import { errMsg } from './StatusBadge'

const usd = (n: number): string => `$${Math.round(n * 100) / 100 === n ? n.toFixed(2) : String(Number(n.toFixed(4)))}`

function PriceCell({ m, local, onSaved }: { m: ModelEntry; local: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [inp, setInp] = useState('')
  const [out, setOut] = useState('')
  const [err, setErr] = useState<string | null>(null)

  function start() {
    setInp(m.pricing ? String(m.pricing.inputPerMTok) : '')
    setOut(m.pricing ? String(m.pricing.outputPerMTok) : '')
    setErr(null)
    setEditing(true)
  }

  async function save(clear: boolean) {
    try {
      const pricing = clear ? null : { inputPerMTok: Number(inp), outputPerMTok: Number(out) }
      if (pricing && (inp.trim() === '' || out.trim() === '' || !Number.isFinite(pricing.inputPerMTok) || !Number.isFinite(pricing.outputPerMTok))) {
        throw new Error('Enter both prices, or use Clear.')
      }
      await window.api.invoke('models:setPricing', { connectionId: m.connectionId, model: m.model, pricing })
      setEditing(false)
      onSaved()
    } catch (e) {
      setErr(errMsg(e))
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-1">
          <Input className="h-7 w-20 text-right" inputMode="decimal" placeholder="in" aria-label={`Input price for ${m.model}`} value={inp} onChange={(e) => setInp(e.target.value)} />
          <Input className="h-7 w-20 text-right" inputMode="decimal" placeholder="out" aria-label={`Output price for ${m.model}`} value={out} onChange={(e) => setOut(e.target.value)} />
          <Button size="sm" variant="primary" onClick={() => void save(false)}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          {m.pricing && (
            <Button size="sm" variant="ghost" onClick={() => void save(true)}>
              Clear
            </Button>
          )}
        </div>
        <span className="text-[10px] text-faint">USD per 1M tokens (input / output)</span>
        {err && <span className="text-[11px] text-err">{err}</span>}
      </div>
    )
  }

  return (
    <button onClick={start} className="group flex items-center gap-2 rounded px-1.5 py-0.5 text-right hover:bg-hover" title="Edit price">
      {m.pricing ? (
        <span className="tabular-nums">
          {usd(m.pricing.inputPerMTok)} / {usd(m.pricing.outputPerMTok)}
          <span className="ml-1.5 text-[10px] text-faint">{m.pricing.source === 'provider' ? 'from provider' : 'set by you'}</span>
        </span>
      ) : local ? (
        <span className="text-ok">free (local)</span>
      ) : (
        <span className="text-warn">not set</span>
      )}
      <span className="text-[10px] text-faint opacity-0 group-hover:opacity-100">edit</span>
    </button>
  )
}

export function ModelsTab({ connection }: { connection: Connection }) {
  const refresh = useStudio((s) => s.refresh)
  const local = useStudio((s) => s.catalog.find((c) => c.kind === connection.kind)?.local ?? false)
  const [models, setModels] = useState<ModelEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const load = useCallback(() => {
    void window.api.invoke('models:list', connection.id).then(setModels, (e) => setError(errMsg(e)))
  }, [connection.id])
  useEffect(load, [load])

  async function discover() {
    setBusy(true)
    setError(null)
    try {
      setModels(await window.api.invoke('models:discover', connection.id))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (models ?? []).filter((m) => !q || m.model.toLowerCase().includes(q) || (m.displayName ?? '').toLowerCase().includes(q))
  }, [models, filter])

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-line p-3">
        <div className="relative flex-1">
          <Search size={13} className="pointer-events-none absolute top-2.5 left-2.5 text-faint" />
          <Input className="pl-8" placeholder="Filter models…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter models" />
        </div>
        <Button variant="primary" onClick={() => void discover()} disabled={busy || !connection.enabled}>
          <CloudDownload size={14} /> {busy ? 'Fetching…' : models && models.length > 0 ? 'Refresh models' : 'Discover models'}
        </Button>
      </div>

      {error && (
        <p role="alert" className="m-3 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs break-words text-err" data-selectable>
          {error}
        </p>
      )}

      {models === null ? (
        <p className="p-4 text-xs text-faint">Loading…</p>
      ) : models.length === 0 ? (
        <EmptyState title="No models cached yet">Click “Discover models” to ask the provider which models your key can use.</EmptyState>
      ) : (
        <>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] text-faint">
                <th className="px-4 py-2 font-medium">Model</th>
                <th className="px-2 py-2 font-medium">Type</th>
                <th className="px-2 py-2 text-right font-medium">Context</th>
                <th className="px-4 py-2 text-right font-medium">Price · $/1M tokens (in / out)</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.model} className="border-b border-line/60 hover:bg-hover/40" data-model={m.model}>
                  <td className="max-w-[260px] truncate px-4 py-1.5 font-mono text-[11.5px]" title={m.displayName ? `${m.displayName} (${m.model})` : m.model} data-selectable>
                    {m.model}
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge tone={m.kind === 'chat' ? 'accent' : 'neutral'}>{m.kind}</Badge>
                  </td>
                  <td className="px-2 py-1.5 text-right text-muted tabular-nums">{m.contextWindow ? fmtTokens(m.contextWindow) : '—'}</td>
                  <td className="px-4 py-1 text-right">
                    <PriceCell m={m} local={local} onSaved={load} />
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-faint">
                    No models match “{filter}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="p-3 text-[11px] leading-relaxed text-faint">
            Prices are never guessed. A model without a price is shown as “not set”, and its calls count as unpriced in usage totals. Only OpenRouter publishes prices through its API; for other providers, enter them from the provider's pricing page.
          </p>
        </>
      )}
    </div>
  )
}

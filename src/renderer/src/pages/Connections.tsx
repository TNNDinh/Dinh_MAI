import { PlugZap, Plus, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { useStudio } from '../store'
import { Button, Card, EmptyState, PageHeader, cx } from '../components/ui'
import { AddConnectionModal } from '../components/connections/AddConnectionModal'
import { ConnectionDetail } from '../components/connections/ConnectionDetail'
import { ConnectionStatusBadge } from '../components/connections/StatusBadge'

const DOT: Record<string, string> = { ok: 'bg-ok', error: 'bg-err', unknown: 'bg-faint' }

export function Connections() {
  const { connections, selectedConnectionId, setSelectedConnection, info, catalog } = useStudio()
  const [adding, setAdding] = useState(false)
  const selected = connections.find((c) => c.id === selectedConnectionId) ?? connections[0] ?? null
  const label = (kind: string) => catalog.find((c) => c.kind === kind)?.label ?? kind

  return (
    <div className="page-enter mx-auto max-w-6xl p-6">
      <PageHeader
        title="Model Connections"
        subtitle="Connect AI providers. Keys are encrypted with Windows DPAPI and never leave the main process."
        action={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus size={14} /> Add connection
          </Button>
        }
      />

      {info && !info.encryptionAvailable && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-err/30 bg-err/10 p-3 text-xs text-err">
          <ShieldAlert size={14} className="mt-px shrink-0" />
          Windows encryption (DPAPI) is unavailable, so API keys can't be stored securely. Keyless providers such as a local Ollama still work.
        </div>
      )}

      {connections.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PlugZap size={22} />}
            title="No connections yet"
            action={
              <Button variant="primary" onClick={() => setAdding(true)}>
                <Plus size={14} /> Add your first connection
              </Button>
            }
          >
            Add Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek, Groq, a local Ollama, or any OpenAI-compatible endpoint. Nothing is called until you test or use a connection.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[260px_1fr]">
          <ul className="space-y-1.5" aria-label="Connections">
            {connections.map((c) => (
              <li key={c.id}>
                <button
                  data-connection={c.name}
                  aria-current={selected?.id === c.id}
                  onClick={() => setSelectedConnection(c.id)}
                  className={cx(
                    'w-full rounded-lg border px-3 py-2.5 text-left transition-colors',
                    selected?.id === c.id ? 'border-accent/50 bg-accent-soft' : 'border-line bg-panel hover:bg-hover'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className={cx('size-2 shrink-0 rounded-full', c.enabled ? DOT[c.status] : 'bg-faint/50')} />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{c.name}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 pl-4 text-[11px] text-faint">
                    <span className="truncate">{label(c.kind)}</span>
                    <ConnectionStatusBadge c={c} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {selected && <ConnectionDetail key={selected.id} connection={selected} onRemoved={() => setSelectedConnection(null)} />}
        </div>
      )}

      {adding && (
        <AddConnectionModal
          onClose={() => setAdding(false)}
          onCreated={(c) => {
            setSelectedConnection(c.id)
            setAdding(false)
          }}
        />
      )}
    </div>
  )
}

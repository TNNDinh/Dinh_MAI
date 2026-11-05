import { KeyRound, Lock, PlugZap, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Connection } from '../../../../shared/ipc'
import { useStudio } from '../../store'
import { timeAgo } from '../../lib/format'
import { Badge, Button, Card, Field, Input, cx } from '../ui'
import { ModelsTab } from './ModelsTab'
import { Playground } from './Playground'
import { ConnectionStatusBadge, errMsg } from './StatusBadge'

type Tab = 'models' | 'playground' | 'settings'

function SettingsTab({ connection, onRemoved }: { connection: Connection; onRemoved: () => void }) {
  const refresh = useStudio((s) => s.refresh)
  const entry = useStudio((s) => s.catalog.find((c) => c.kind === connection.kind))
  const encryptionAvailable = useStudio((s) => s.info?.encryptionAvailable ?? true)
  const [name, setName] = useState(connection.name)
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl)
  const [enabled, setEnabled] = useState(connection.enabled)
  const [newKey, setNewKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const dirty = name !== connection.name || baseUrl !== connection.baseUrl || enabled !== connection.enabled || newKey.trim() !== ''

  async function save(clearKey = false) {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await window.api.invoke('connections:update', {
        id: connection.id,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        enabled,
        apiKey: newKey.trim() || undefined,
        clearKey: clearKey || undefined
      })
      setNewKey('')
      await refresh()
      setSaved(true)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    try {
      await window.api.invoke('connections:remove', connection.id)
      await refresh()
      onRemoved()
    } catch (e) {
      setConfirmRemove(false)
      setError(errMsg(e))
    }
  }

  return (
    <div className="space-y-4 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={name}
            maxLength={60}
            onChange={(e) => {
              setName(e.target.value)
              setSaved(false)
            }}
            aria-label="Connection name"
          />
        </Field>
        <Field label="Base URL">
          <Input
            value={baseUrl}
            spellCheck={false}
            onChange={(e) => {
              setBaseUrl(e.target.value)
              setSaved(false)
            }}
            aria-label="Base URL"
          />
        </Field>
      </div>

      <Field
        label="API key"
        hint={
          connection.hasKey ? (
            <span className="flex items-center gap-1">
              <Lock size={11} /> A key is stored (encrypted with Windows DPAPI). It can't be viewed again; paste a new one to replace it.
            </span>
          ) : (
            'No key stored.'
          )
        }
      >
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={newKey}
          placeholder={connection.hasKey ? '•••••••• (unchanged)' : 'Paste a key'}
          disabled={!encryptionAvailable}
          onChange={(e) => {
            setNewKey(e.target.value)
            setSaved(false)
          }}
          aria-label="Replace API key"
        />
      </Field>

      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked)
            setSaved(false)
          }}
          className="size-3.5 accent-[var(--color-accent)]"
        />
        Enabled <span className="text-xs text-faint">(disabled connections can't be used by agents or the playground)</span>
      </label>

      {error && (
        <p role="alert" className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs break-words text-err" data-selectable>
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy || name.trim() === ''}>
          Save changes
        </Button>
        {connection.hasKey && !entry?.requiresApiKey && (
          <Button onClick={() => void save(true)} disabled={busy}>
            <KeyRound size={13} /> Remove key
          </Button>
        )}
        {saved && <span className="text-xs text-ok">Saved.</span>}
        {saved && <span className="text-xs text-faint">Test the connection again to confirm the changes.</span>}
      </div>

      <div className="border-t border-line pt-4">
        <h4 className="mb-1 text-xs font-semibold text-muted">Danger zone</h4>
        <p className="mb-2 text-xs text-faint">Removing a connection deletes its stored key, cached models and prices. Past usage records are kept.</p>
        {confirmRemove ? (
          <div className="flex items-center gap-2">
            <Button variant="danger" onClick={() => void remove()}>
              Yes, remove “{connection.name}”
            </Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirmRemove(true)}>
            <Trash2 size={13} /> Remove connection
          </Button>
        )}
      </div>
    </div>
  )
}

export function ConnectionDetail({ connection, onRemoved }: { connection: Connection; onRemoved: () => void }) {
  const refresh = useStudio((s) => s.refresh)
  const entry = useStudio((s) => s.catalog.find((c) => c.kind === connection.kind))
  const [tab, setTab] = useState<Tab>('models')
  const [testing, setTesting] = useState(false)
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null)

  async function test() {
    setTesting(true)
    setTestNote(null)
    try {
      const r = await window.api.invoke('connections:test', connection.id)
      setTestNote(
        r.ok
          ? { ok: true, text: `Connected in ${r.latencyMs} ms${r.modelCount !== undefined ? ` · ${r.modelCount} models available` : ''}` }
          : { ok: false, text: r.error ?? 'Connection failed' }
      )
    } catch (e) {
      setTestNote({ ok: false, text: errMsg(e) })
    } finally {
      setTesting(false)
      void refresh()
    }
  }

  const tabs: Array<[Tab, string]> = [
    ['models', `Models${connection.modelCount ? ` (${connection.modelCount})` : ''}`],
    ['playground', 'Playground'],
    ['settings', 'Settings']
  ]

  return (
    <Card>
      <div className="border-b border-line p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold">{connection.name}</h2>
              <ConnectionStatusBadge c={connection} />
              <Badge>{entry?.label ?? connection.kind}</Badge>
            </div>
            <p className="mt-0.5 truncate font-mono text-[11px] text-faint" data-selectable>
              {connection.baseUrl}
            </p>
          </div>
          <Button onClick={() => void test()} disabled={testing || !connection.enabled}>
            <PlugZap size={14} /> {testing ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
        {(testNote || (connection.status === 'error' && connection.lastError)) && (
          <p
            role="status"
            data-test-result={testNote ? (testNote.ok ? 'ok' : 'error') : 'error'}
            className={cx('mt-3 rounded-md border px-3 py-2 text-xs break-words', (testNote ? testNote.ok : false) ? 'border-ok/30 bg-ok/10 text-ok' : 'border-err/30 bg-err/10 text-err')}
            data-selectable
          >
            {testNote ? testNote.text : connection.lastError}
          </p>
        )}
        {!testNote && connection.status === 'ok' && connection.lastCheckedAt && (
          <p className="mt-2 text-[11px] text-faint">Last successful check {timeAgo(connection.lastCheckedAt)}.</p>
        )}
      </div>

      <div role="tablist" className="flex h-9 border-b border-line px-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            data-tab={id}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cx('border-b-2 px-3 text-xs transition-colors', tab === id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'models' && <ModelsTab connection={connection} />}
      {tab === 'playground' && <Playground connection={connection} />}
      {tab === 'settings' && <SettingsTab connection={connection} onRemoved={onRemoved} />}
    </Card>
  )
}

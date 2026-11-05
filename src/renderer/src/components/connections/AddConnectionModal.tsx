import { Lock } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Connection, ProviderCatalogItem, ProviderKind } from '../../../../shared/ipc'
import { useStudio } from '../../store'
import { Button, Field, Input, Modal, Select } from '../ui'
import { errMsg } from './StatusBadge'

export function AddConnectionModal({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Connection) => void }) {
  const encryptionAvailable = useStudio((s) => s.info?.encryptionAvailable ?? true)
  const refresh = useStudio((s) => s.refresh)
  const [catalog, setCatalog] = useState<ProviderCatalogItem[]>([])
  const [kind, setKind] = useState<ProviderKind>('openai')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'saving' | 'testing'>('idle')

  useEffect(() => {
    void window.api.invoke('connections:catalog').then(setCatalog, (e) => setError(errMsg(e)))
  }, [])

  const entry = useMemo(() => catalog.find((c) => c.kind === kind), [catalog, kind])

  // Re-seed the form from the catalog when (and only when) the provider changes.
  const nameEditedRef = useRef(false)
  nameEditedRef.current = nameEdited
  useEffect(() => {
    if (!entry) return
    setBaseUrl(entry.defaultBaseUrl)
    if (!nameEditedRef.current) setName(entry.label)
    setError(null)
  }, [entry])

  const needsKey = entry?.requiresApiKey ?? true
  const keyBlocked = !encryptionAvailable && apiKey.trim() !== ''
  const canSubmit = !!entry && name.trim() !== '' && baseUrl.trim() !== '' && (!needsKey || apiKey.trim() !== '') && !keyBlocked && phase === 'idle'

  async function submit() {
    if (!entry) return
    setError(null)
    setPhase('saving')
    try {
      const created = await window.api.invoke('connections:create', {
        kind,
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined
      })
      setApiKey('') // the key now lives only in the encrypted store
      setPhase('testing')
      // Check it straight away so the user learns about a wrong key or URL immediately.
      // A failed test is not a failed save: the connection exists and shows its error.
      const tested = await window.api.invoke('connections:test', created.id).then((r) => r.connection, () => created)
      await refresh()
      onCreated(tested)
    } catch (e) {
      setPhase('idle')
      setError(errMsg(e))
    }
  }

  return (
    <Modal
      title="Add model connection"
      onClose={phase === 'idle' ? onClose : () => undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={phase !== 'idle'}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canSubmit} onClick={() => void submit()}>
            {phase === 'saving' ? 'Saving…' : phase === 'testing' ? 'Testing connection…' : 'Add & test'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSubmit) void submit()
        }}
      >
        <Field label="Provider">
          <Select value={kind} onChange={(e) => setKind(e.target.value as ProviderKind)} aria-label="Provider">
            {catalog.map((c) => (
              <option key={c.kind} value={c.kind}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name" hint="Shown in the app, e.g. “Work OpenAI”.">
          <Input
            value={name}
            maxLength={60}
            onChange={(e) => {
              setName(e.target.value)
              setNameEdited(true)
              setError(null)
            }}
            aria-label="Connection name"
          />
        </Field>
        <Field
          label="Base URL"
          hint={entry?.customBaseUrl ? 'Any OpenAI-compatible endpoint, e.g. http://localhost:1234/v1 (LM Studio, vLLM, llama.cpp…).' : 'Change only for proxies or regional endpoints. Plain http:// is limited to local / private-network hosts.'}
        >
          <Input
            value={baseUrl}
            placeholder="https://…"
            spellCheck={false}
            onChange={(e) => {
              setBaseUrl(e.target.value)
              setError(null)
            }}
            aria-label="Base URL"
          />
        </Field>
        <Field label={needsKey ? 'API key' : 'API key (optional)'} hint={entry?.docsUrl ? `Create one in the provider's console — ${entry.docsUrl}` : undefined}>
          <Input
            type="password"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={needsKey ? 'Paste your key' : 'Leave empty if the server needs none'}
            onChange={(e) => {
              setApiKey(e.target.value)
              setError(null)
            }}
            aria-label="API key"
          />
        </Field>

        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-faint">
          <Lock size={12} className="mt-px shrink-0" />
          {encryptionAvailable
            ? 'The key is encrypted with Windows DPAPI in the main process and is never shown again or sent back to this window.'
            : 'Windows encryption (DPAPI) is unavailable on this machine, so API keys cannot be stored securely and saving a key is blocked.'}
        </p>
        {keyBlocked && <p className="text-xs text-err">Cannot store a key without OS encryption.</p>}
        {error && (
          <p role="alert" className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs break-words text-err" data-selectable>
            {error}
          </p>
        )}
        {/* lets Enter submit the form */}
        <button type="submit" hidden />
      </form>
    </Modal>
  )
}

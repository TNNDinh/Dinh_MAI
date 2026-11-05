import { Sparkles } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ASSET_KINDS, type AssetItem, type AssetKind, type GenerateAssetResult, type ImageModelOption, type Project } from '../../../../shared/ipc'
import { fmtUsd } from '../../lib/format'
import { useStudio } from '../../store'
import { Badge, Button, Field, Input, Modal, Select, Textarea } from '../ui'
import { errMsg } from '../connections/StatusBadge'

export interface GenerateSeed {
  prompt?: string
  kind?: AssetKind
  name?: string
  connectionId?: string | null
  model?: string | null
  transparent?: boolean
  size?: string
  /** Edit / vary this asset. */
  reference?: AssetItem | null
}

/**
 * Asks an image model for pictures. Every request is a real API call: the model list comes from the configured
 * connections, the price (if known) is the one the user entered, and the result is whatever the provider returned.
 */
export function GenerateModal({
  project,
  seed,
  onClose,
  onDone
}: {
  project: Project
  seed: GenerateSeed
  onClose: () => void
  onDone: (r: GenerateAssetResult) => void
}) {
  const [options, setOptions] = useState<ImageModelOption[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connectionId, setConnectionId] = useState(seed.connectionId ?? '')
  const [model, setModel] = useState(seed.model ?? '')
  const [prompt, setPrompt] = useState(seed.prompt ?? '')
  const [kind, setKind] = useState<AssetKind>(seed.kind ?? 'sprite')
  const [name, setName] = useState(seed.name ?? '')
  const [size, setSize] = useState(seed.size ?? '1024x1024')
  const [count, setCount] = useState('1')
  const [transparent, setTransparent] = useState(seed.transparent ?? false)
  const [price, setPrice] = useState('')
  const [priceMsg, setPriceMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<GenerateAssetResult | null>(null)
  const requestId = useRef<string | null>(null)
  const allConnections = useStudio((s) => s.connections)
  const catalog = useStudio((s) => s.catalog)

  async function loadOptions() {
    try {
      const list = await window.api.invoke('assets:imageModels')
      setOptions(list)
      return list
    } catch (e) {
      setLoadError(errMsg(e))
      setOptions([])
      return []
    }
  }

  // Every enabled connection whose provider has an image API can be used, even when no image model was discovered on it.
  const connections = useMemo(
    () => allConnections.filter((c) => c.enabled && catalog.find((p) => p.kind === c.kind)?.imageGeneration).map((c) => [c.id, c.name] as const),
    [allConnections, catalog]
  )

  useEffect(() => {
    void loadOptions()
  }, [])

  useEffect(() => {
    if (connections.length && !connections.some(([id]) => id === connectionId)) setConnectionId(connections[0][0])
  }, [connections, connectionId])

  const forConnection = useMemo(() => (options ?? []).filter((o) => o.connectionId === connectionId), [options, connectionId])
  const chosen = forConnection.find((o) => o.model === model.trim()) ?? null

  // Offer a sensible model whenever none is chosen.
  useEffect(() => {
    if (!connectionId || forConnection.length === 0 || model) return
    setModel((forConnection.find((o) => o.listedAsImage) ?? forConnection[0]).model)
  }, [connectionId, forConnection, model])

  useEffect(() => {
    setPriceMsg(null)
  }, [connectionId, model])
  useEffect(() => {
    setPrice(chosen?.priceUsd != null ? String(chosen.priceUsd) : '')
  }, [chosen?.connectionId, chosen?.model, chosen?.priceUsd])

  const refMissingEdit = !!seed.reference && !!chosen && !chosen.supportsEdit

  async function savePrice() {
    setPriceMsg(null)
    try {
      const v = price.trim() === '' ? null : Number(price)
      await window.api.invoke('images:setPrice', { connectionId, model: model.trim(), priceUsd: v })
      await loadOptions()
      setPriceMsg(v === null ? 'Price cleared.' : 'Price saved.')
    } catch (e) {
      setPriceMsg(errMsg(e))
    }
  }

  async function generate() {
    setBusy(true)
    setError(null)
    setResult(null)
    const id = crypto.randomUUID()
    requestId.current = id
    try {
      const r = await window.api.invoke('assets:generate', {
        requestId: id,
        projectId: project.id,
        connectionId,
        model: model.trim(),
        prompt,
        kind,
        name: name.trim() || undefined,
        size: size.trim() || undefined,
        count: Number(count),
        transparent,
        referenceAssetId: seed.reference?.id
      })
      setResult(r)
      onDone(r)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      requestId.current = null
      setBusy(false)
    }
  }

  const cancel = () => requestId.current && void window.api.invoke('assets:cancel', requestId.current)
  const noModels = connections.length === 0

  return (
    <Modal
      title={seed.reference ? `Vary “${seed.reference.name}”` : 'Generate pictures'}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          {busy ? (
            <Button variant="danger" onClick={cancel} data-action="cancel-generate">
              Cancel request
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose} data-action="close-generate">
              {result ? 'Close' : 'Cancel'}
            </Button>
          )}
          <Button variant="primary" onClick={() => void generate()} disabled={busy || !prompt.trim() || !connectionId || !model.trim()} data-action="run-generate">
            <Sparkles size={14} /> {busy ? 'Generating…' : 'Generate'}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-generate-form>
        {noModels && (
          <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn" data-selectable>
            {loadError ?? 'No connection with an image-generation API is ready. Add and enable a connection to OpenAI, Google Gemini or an OpenAI-compatible server on the Model Connections page.'}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Connection">
            <Select value={connectionId} onChange={(e) => (setConnectionId(e.target.value), setModel(''))} aria-label="Connection" disabled={busy || noModels}>
              {connections.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Image model" hint={chosen && !chosen.listedAsImage ? 'Not reported as an image model by the provider: it may fail.' : 'Pick one or type any model id the provider accepts.'}>
            <Input list="image-models" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Image model" className="font-mono" disabled={busy || noModels} />
            <datalist id="image-models">
              {forConnection.map((o) => (
                <option key={o.model} value={o.model} />
              ))}
            </datalist>
          </Field>
        </div>

        {model.trim() && connectionId && (
          <div className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-elev px-3 py-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Price per picture (USD)</span>
              <Input type="number" min="0" step="0.001" value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Price per picture" className="w-32" placeholder="unknown" />
            </label>
            <Button size="sm" onClick={() => void savePrice()} data-action="save-price">
              Save price
            </Button>
            <p className="min-w-0 flex-1 text-[11px] text-faint" data-price-message>
              {priceMsg ??
                'The app cannot read prices from providers. Enter the price from your provider’s pricing page so image spend counts against budgets; without it the cost is recorded as unknown.'}
            </p>
          </div>
        )}

        <Field label={seed.reference ? 'What to change or keep' : 'Prompt'} hint={`${prompt.length.toLocaleString()} / 4,000 characters`}>
          <Textarea rows={5} value={prompt} maxLength={4000} onChange={(e) => setPrompt(e.target.value)} aria-label="Prompt" disabled={busy} />
        </Field>

        {seed.reference && (
          <p className="text-[11px] text-faint">
            The picture “{seed.reference.name}” is sent to the model as the starting point.
            {refMissingEdit && <span className="ml-1 text-warn">This model has no edit API: the request will be refused. Choose a gpt-image model or an OpenAI-compatible server.</span>}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as AssetKind)} aria-label="Kind" disabled={busy}>
              {ASSET_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Size">
            <Input list="image-sizes" value={size} onChange={(e) => setSize(e.target.value)} aria-label="Size" disabled={busy} placeholder="1024x1024" />
            <datalist id="image-sizes">
              {(chosen?.sizes ?? ['1024x1024', '1536x1024', '1024x1536', '512x512']).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Field>
          <Field label="How many">
            <Input type="number" min="1" max="4" value={count} onChange={(e) => setCount(e.target.value)} aria-label="Count" disabled={busy} />
          </Field>
          <Field label="File name">
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" placeholder="from prompt" disabled={busy} />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} className="mt-0.5 size-3.5 accent-[var(--color-accent)]" disabled={busy} aria-label="Transparent background" />
          <span>
            Transparent background
            <span className="block text-[11px] text-faint">Models without native transparency draw on a plain background and the app then removes it; this works for flat backgrounds only.</span>
          </span>
        </label>
        <p className="text-[11px] text-faint">Models choose the nearest size they support; the real size of every picture is shown after it arrives.</p>

        {error && (
          <p role="alert" className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs break-words text-err" data-selectable data-generate-error>
            {error}
          </p>
        )}
        {result && (
          <div className="space-y-1 rounded-md border border-ok/30 bg-ok/10 px-3 py-2 text-xs" data-generate-result>
            <p className="text-ok">
              Saved {result.assets.length} picture{result.assets.length === 1 ? '' : 's'}: {result.assets.map((a) => `${a.path}${a.width ? ` (${a.width}×${a.height})` : ''}`).join(', ')}
            </p>
            <p className="text-muted">Cost: {result.costUsd === null ? 'unknown (no price entered for this model)' : fmtUsd(result.costUsd)}</p>
            {result.notes.map((n, i) => (
              <p key={i} className="text-muted">
                <Badge tone="info">note</Badge> {n}
              </p>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

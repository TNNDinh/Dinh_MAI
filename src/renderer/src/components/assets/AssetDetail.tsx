import { Copy, FolderOpen, Repeat, Scissors, Trash2, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { ASSET_KINDS, type AssetItem, type AssetOperation } from '../../../../shared/ipc'
import { fmtBytes, timeAgo } from '../../lib/format'
import { Badge, Button, Field, Input, Select, cx } from '../ui'
import { errMsg } from '../connections/StatusBadge'
import { AssetImage } from './AssetImage'

type OpType = AssetOperation['type']

/** Everything known about one picture, plus the editing steps that derive new pictures from it. */
export function AssetDetail({
  asset,
  parent,
  onChanged,
  onSelect,
  onVariation,
  onRegenerate
}: {
  asset: AssetItem
  parent: AssetItem | null
  /** Called after any change so the list is reloaded. `select` is the asset to show next. */
  onChanged: (select?: string | null) => void
  onSelect: (id: string) => void
  onVariation: (a: AssetItem) => void
  onRegenerate: (a: AssetItem) => void
}) {
  const [op, setOp] = useState<OpType>('resize')
  const [width, setWidth] = useState(String(asset.width ?? 64))
  const [height, setHeight] = useState(String(asset.height ?? 64))
  const [fit, setFit] = useState<'contain' | 'cover' | 'stretch'>('contain')
  const [pixelArt, setPixelArt] = useState(false)
  const [padding, setPadding] = useState('0')
  const [tolerance, setTolerance] = useState('24')
  const [replace, setReplace] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteFile, setDeleteFile] = useState(true)

  const kindLabel = ASSET_KINDS.find((k) => k.value === asset.kind)?.label ?? asset.kind

  async function process() {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const operation: AssetOperation =
        op === 'resize'
          ? { type: 'resize', width: Number(width), height: Number(height), fit, pixelArt }
          : op === 'trim'
            ? { type: 'trim', padding: Number(padding) }
            : { type: 'removeBackground', tolerance: Number(tolerance) }
      const out = await window.api.invoke('assets:process', { id: asset.id, operation, replace })
      setMessage(replace ? 'The picture was replaced.' : `Saved as ${out.path}.`)
      onChanged(out.id)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await window.api.invoke('assets:remove', { id: asset.id, deleteFile })
      onChanged(null)
    } catch (e) {
      setError(errMsg(e))
      setConfirmDelete(false)
    } finally {
      setBusy(false)
    }
  }

  async function reveal() {
    setError(null)
    try {
      await window.api.invoke('assets:reveal', asset.id)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-asset-detail={asset.name}>
      <div className="p-4">
        <AssetImage asset={asset} max={640} className="h-64 w-full rounded-md border border-line" />
        <div className="mt-3 flex items-start justify-between gap-2">
          <h2 className="min-w-0 text-sm font-semibold break-all" data-selectable>
            {asset.name}
          </h2>
          <div className="flex shrink-0 gap-1">
            <Badge tone="info">{kindLabel}</Badge>
            {asset.origin === 'processed' && <Badge>processed</Badge>}
          </div>
        </div>
        <dl className="mt-2 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-xs" data-selectable>
          <dt className="text-faint">Path</dt>
          <dd className="font-mono break-all">{asset.path}</dd>
          <dt className="text-faint">Size</dt>
          <dd>
            {asset.width ? `${asset.width}×${asset.height}` : 'unknown'} · {fmtBytes(asset.bytes)}
            {asset.transparent ? ' · transparent' : ''}
          </dd>
          <dt className="text-faint">Model</dt>
          <dd>{asset.model ? `${asset.model}${asset.connectionName ? ` (${asset.connectionName})` : ''}` : asset.origin === 'processed' ? 'derived by the app' : '—'}</dd>
          <dt className="text-faint">Created</dt>
          <dd>{timeAgo(asset.createdAt)}</dd>
          {asset.note && (
            <>
              <dt className="text-faint">Note</dt>
              <dd>{asset.note}</dd>
            </>
          )}
          {parent && (
            <>
              <dt className="text-faint">Derived from</dt>
              <dd>
                <button className="text-accent hover:underline" onClick={() => onSelect(parent.id)}>
                  {parent.name}
                </button>
              </dd>
            </>
          )}
        </dl>
        {asset.prompt && (
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-muted">Prompt</span>
              <button className="text-faint hover:text-fg" title="Copy prompt" aria-label="Copy prompt" onClick={() => void navigator.clipboard?.writeText(asset.prompt ?? '')}>
                <Copy size={12} />
              </button>
            </div>
            <p className="max-h-28 overflow-y-auto rounded-md border border-line bg-bg px-2.5 py-1.5 text-xs whitespace-pre-wrap" data-selectable>
              {asset.prompt}
            </p>
          </div>
        )}
        {!asset.exists && <p className="mt-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">The file was removed outside the app. You can still regenerate it from its prompt or remove this entry.</p>}

        <div className="mt-3 flex flex-wrap gap-2">
          {asset.origin === 'generated' && asset.connectionId && (
            <Button size="sm" onClick={() => onRegenerate(asset)} data-action="regenerate">
              <Repeat size={13} /> Regenerate
            </Button>
          )}
          {asset.exists && (
            <Button size="sm" onClick={() => onVariation(asset)} data-action="variation">
              <Wand2 size={13} /> Vary…
            </Button>
          )}
          <Button size="sm" onClick={() => void reveal()} disabled={!asset.exists} data-action="reveal">
            <FolderOpen size={13} /> Show in folder
          </Button>
        </div>
      </div>

      {asset.exists && (
        <div className="border-t border-line p-4" data-process-form>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted">
            <Scissors size={13} /> Edit
          </h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Operation">
              <Select value={op} onChange={(e) => setOp(e.target.value as OpType)} aria-label="Operation">
                <option value="resize">Resize</option>
                <option value="trim">Trim transparent border</option>
                <option value="removeBackground">Remove flat background</option>
              </Select>
            </Field>
            {op === 'resize' && (
              <Field label="Fit">
                <Select value={fit} onChange={(e) => setFit(e.target.value as typeof fit)} aria-label="Fit">
                  <option value="contain">Contain (keep proportions, pad)</option>
                  <option value="cover">Cover (keep proportions, crop)</option>
                  <option value="stretch">Stretch</option>
                </Select>
              </Field>
            )}
            {op === 'trim' && (
              <Field label="Padding (px)">
                <Input type="number" min="0" value={padding} onChange={(e) => setPadding(e.target.value)} aria-label="Padding" />
              </Field>
            )}
            {op === 'removeBackground' && (
              <Field label="Tolerance (0–255)" hint="How far a pixel may differ from the background colour.">
                <Input type="number" min="0" max="255" value={tolerance} onChange={(e) => setTolerance(e.target.value)} aria-label="Tolerance" />
              </Field>
            )}
          </div>
          {op === 'resize' && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Width">
                <Input type="number" min="1" value={width} onChange={(e) => setWidth(e.target.value)} aria-label="Width" />
              </Field>
              <Field label="Height">
                <Input type="number" min="1" value={height} onChange={(e) => setHeight(e.target.value)} aria-label="Height" />
              </Field>
              <label className="flex items-center gap-2 text-xs sm:col-span-2">
                <input type="checkbox" checked={pixelArt} onChange={(e) => setPixelArt(e.target.checked)} className="size-3.5 accent-[var(--color-accent)]" aria-label="Pixel art" />
                Pixel art (nearest-neighbour: keeps hard edges)
              </label>
            </div>
          )}
          <label className="mt-3 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="size-3.5 accent-[var(--color-accent)]" aria-label="Replace the original" />
            Replace the original (otherwise a new picture is saved next to it)
          </label>
          <p className="mt-1 text-[11px] text-faint">Results are saved as PNG.</p>
          <Button variant="primary" size="sm" className="mt-3" onClick={() => void process()} disabled={busy} data-action="apply-process">
            Apply
          </Button>
          {message && (
            <p className="mt-2 text-xs text-ok" data-process-message>
              {message}
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mx-4 mb-3 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs break-words text-err" data-selectable data-asset-error>
          {error}
        </p>
      )}

      <div className={cx('mt-auto border-t border-line p-4')}>
        {confirmDelete ? (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={deleteFile} onChange={(e) => setDeleteFile(e.target.checked)} className="size-3.5 accent-[var(--color-accent)]" aria-label="Also delete the file" />
              Also delete the file from the project folder
            </label>
            <div className="flex gap-2">
              <Button variant="danger" size="sm" onClick={() => void remove()} disabled={busy} data-action="confirm-delete-asset">
                {deleteFile ? 'Delete picture and file' : 'Remove from library'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                Keep
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} data-action="delete-asset">
            <Trash2 size={13} /> Delete…
          </Button>
        )}
      </div>
    </div>
  )
}

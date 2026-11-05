import { useEffect, useState } from 'react'
import { ASSET_KINDS, type AssetKind, type ImportAssetsResult, type Project, type UntrackedImage } from '../../../../shared/ipc'
import { fmtBytes } from '../../lib/format'
import { Button, Modal, Select } from '../ui'
import { errMsg } from '../connections/StatusBadge'

/** Lists picture files that are in the project folder but not in the library, and adds the chosen ones (no copy, no change to the files). */
export function ImportModal({ project, onClose, onDone }: { project: Project; onClose: () => void; onDone: (r: ImportAssetsResult) => void }) {
  const [files, setFiles] = useState<UntrackedImage[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [kind, setKind] = useState<AssetKind | ''>('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [skipped, setSkipped] = useState<ImportAssetsResult['skipped']>([])

  useEffect(() => {
    let live = true
    window.api.invoke('assets:scan', project.id).then(
      (r) => {
        if (!live) return
        setFiles(r.files)
        setTruncated(r.truncated)
        setPicked(new Set(r.files.map((f) => f.path)))
      },
      (e) => live && (setError(errMsg(e)), setFiles([]))
    )
    return () => {
      live = false
    }
  }, [project.id])

  const toggle = (path: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(path)) n.delete(path)
      else n.add(path)
      return n
    })

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await window.api.invoke('assets:import', { projectId: project.id, paths: [...picked].slice(0, 200), kind: kind || null })
      if (r.skipped.length === 0) {
        onDone(r)
        onClose()
      } else {
        setSkipped(r.skipped)
        onDone(r)
        setFiles((cur) => (cur ?? []).filter((f) => !r.imported.some((a) => a.path === f.path)))
        setPicked(new Set())
      }
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="Import existing pictures"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || picked.size === 0} data-action="import-confirm">
            {busy ? 'Importing…' : `Add ${picked.size} to the library`}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-import-modal>
        <p className="text-xs text-muted">
          Pictures already inside <span className="font-mono text-fg">{project.name}</span> (PNG, JPEG, WebP, GIF) that the library does not list. Importing only adds them to the list: the files are not copied, moved or changed.
        </p>
        {files === null ? (
          <p className="text-xs text-faint">Looking through the project folder…</p>
        ) : files.length === 0 ? (
          <p className="rounded-md border border-line bg-elev/40 px-3 py-4 text-center text-xs text-muted" data-import-empty>
            Nothing to import: every picture in the project is already in the library.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={picked.size === files.length}
                  onChange={(e) => setPicked(e.target.checked ? new Set(files.map((f) => f.path)) : new Set())}
                  aria-label="Select all"
                />
                {picked.size} of {files.length} selected
              </label>
              <Select value={kind} onChange={(e) => setKind(e.target.value as AssetKind | '')} aria-label="Kind for the imported pictures" className="w-48">
                <option value="">Guess the kind from the path</option>
                {ASSET_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </div>
            <ul className="max-h-64 divide-y divide-line/60 overflow-y-auto rounded-md border border-line" data-import-list>
              {files.map((f) => (
                <li key={f.path}>
                  <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-hover/50">
                    <input type="checkbox" checked={picked.has(f.path)} onChange={() => toggle(f.path)} data-import-file={f.path} />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={f.path}>
                      {f.path}
                    </span>
                    <span className="shrink-0 text-faint tabular-nums">{fmtBytes(f.bytes)}</span>
                  </label>
                </li>
              ))}
            </ul>
            {truncated && <p className="text-[11px] text-warn">Only the first {files.length} pictures are listed. Import these, then open this dialog again for the rest.</p>}
          </>
        )}
        {skipped.length > 0 && (
          <div role="alert" className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn" data-import-skipped>
            <p className="font-medium">Not imported:</p>
            <ul className="mt-1 space-y-0.5">
              {skipped.map((s) => (
                <li key={s.path} className="break-words">
                  <span className="font-mono">{s.path}</span>: {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs break-words text-err">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

import { ChevronDown, ChevronRight, ChevronsDownUp, File, FilePlus, Folder, FolderOpen, FolderPlus, Lock, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry, FileLockInfo, FsChange } from '../../../../shared/ipc'
import { Button, Input, Modal, cx } from '../ui'

interface DirState {
  entries: FileEntry[]
  truncated: boolean
  error: string | null
}

type Prompt = { kind: 'file' | 'dir'; parent: string } | { kind: 'rename'; entry: FileEntry } | { kind: 'delete'; entry: FileEntry }

const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function FileTree({
  projectId,
  locks,
  activePath,
  onOpen,
  guardRename,
  onRenamed,
  onDeleted
}: {
  projectId: string
  locks: FileLockInfo[]
  activePath: string | null
  onOpen: (path: string) => void
  /** Returns a reason to refuse renaming (for example unsaved edits in an open tab), or null. */
  guardRename: (path: string) => string | null
  onRenamed: (from: string, to: string) => void
  onDeleted: (path: string) => void
}) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']))
  const [selected, setSelected] = useState<FileEntry | null>(null)
  const [prompt, setPrompt] = useState<Prompt | null>(null)
  const [showIgnored, setShowIgnored] = useState(false)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const showIgnoredRef = useRef(showIgnored)
  showIgnoredRef.current = showIgnored

  const load = useCallback(
    async (path: string) => {
      try {
        const r = await window.api.invoke('fs:list', { projectId, path, includeIgnored: showIgnoredRef.current })
        setDirs((d) => ({ ...d, [path]: { entries: r.entries, truncated: r.truncated, error: null } }))
      } catch (e) {
        setDirs((d) => ({ ...d, [path]: { entries: [], truncated: false, error: msg(e) } }))
      }
    },
    [projectId]
  )

  const reloadAll = useCallback(() => {
    for (const p of expandedRef.current) void load(p)
  }, [load])

  // New project: start over.
  useEffect(() => {
    setDirs({})
    setExpanded(new Set(['']))
    setSelected(null)
    void load('')
  }, [projectId, load])

  useEffect(() => {
    reloadAll()
  }, [showIgnored, reloadAll])

  // Files changed by agents (or by us): refresh the folders that are on screen, coalescing bursts.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.api.onFsChange((c: FsChange) => {
      if (c.projectId !== projectId) return
      clearTimeout(timer)
      timer = setTimeout(reloadAll, 150)
    })
    return () => {
      clearTimeout(timer)
      off()
    }
  }, [projectId, reloadAll])

  const toggle = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        if (!dirs[path]) void load(path)
      }
      return next
    })
  }

  // Reveal the active file's folders so that "open from search" shows where the file lives.
  useEffect(() => {
    if (!activePath) return
    const parts = activePath.split('/').slice(0, -1)
    let acc = ''
    const need: string[] = []
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p
      if (!expandedRef.current.has(acc)) need.push(acc)
    }
    if (need.length === 0) return
    setExpanded((prev) => new Set([...prev, ...need]))
    for (const n of need) void load(n)
  }, [activePath, load])

  const lockedPaths = new Set(locks.map((l) => l.path.toLowerCase()))
  const lockedBy = (path: string): FileLockInfo | undefined => locks.find((l) => l.path.toLowerCase() === path.toLowerCase())
  const dirHasLock = (path: string): boolean => [...lockedPaths].some((l) => l.startsWith(`${path.toLowerCase()}/`))

  const targetDir = selected ? (selected.type === 'dir' ? selected.path : parentOf(selected.path)) : ''

  const renderDir = (path: string, depth: number): React.ReactNode => {
    const d = dirs[path]
    if (!d) return depth === 0 ? <li className="px-3 py-2 text-xs text-faint">Loading…</li> : null
    return (
      <>
        {d.error && (
          <li className="px-3 py-1 text-[11px] text-err" style={{ paddingLeft: 12 + depth * 12 }}>
            {d.error}
          </li>
        )}
        {d.entries.map((e) => {
          const isDir = e.type === 'dir'
          const open = isDir && expanded.has(e.path)
          const lock = !isDir ? lockedBy(e.path) : undefined
          const sel = selected?.path === e.path
          return (
            <li key={e.path}>
              <div
                role="treeitem"
                aria-selected={sel}
                aria-expanded={isDir ? open : undefined}
                data-path={e.path}
                onClick={() => {
                  setSelected(e)
                  if (isDir) toggle(e.path)
                  else onOpen(e.path)
                }}
                className={cx(
                  'flex h-[22px] cursor-pointer items-center gap-1 pr-2 text-[12.5px] select-none',
                  sel ? 'bg-accent-soft text-fg' : activePath === e.path ? 'bg-hover text-fg' : 'text-muted hover:bg-hover/70 hover:text-fg',
                  e.ignored && 'opacity-50'
                )}
                style={{ paddingLeft: 6 + depth * 12 }}
                title={lock ? `Being edited by ${lock.agentName ?? 'an agent'}${lock.taskTitle ? ` (${lock.taskTitle})` : ''}` : e.path}
              >
                {isDir ? open ? <ChevronDown size={13} className="shrink-0 text-faint" /> : <ChevronRight size={13} className="shrink-0 text-faint" /> : <span className="w-[13px] shrink-0" />}
                {isDir ? open ? <FolderOpen size={14} className="shrink-0 text-warn/80" /> : <Folder size={14} className="shrink-0 text-warn/80" /> : <File size={14} className="shrink-0 text-faint" />}
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {(lock || (isDir && !open && dirHasLock(e.path))) && <Lock size={11} className="shrink-0 text-warn" aria-label="locked by an agent" />}
              </div>
              {open && <ul role="group">{renderDir(e.path, depth + 1)}</ul>}
            </li>
          )
        })}
        {d.entries.length === 0 && !d.error && depth === 0 && <li className="px-3 py-3 text-xs text-faint">This folder is empty.</li>}
        {d.truncated && <li className="px-3 py-1 text-[11px] text-warn">Only the first entries are shown.</li>}
      </>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        <IconBtn label="New file" onClick={() => setPrompt({ kind: 'file', parent: targetDir })}>
          <FilePlus size={14} />
        </IconBtn>
        <IconBtn label="New folder" onClick={() => setPrompt({ kind: 'dir', parent: targetDir })}>
          <FolderPlus size={14} />
        </IconBtn>
        <IconBtn label="Rename (F2)" disabled={!selected} onClick={() => selected && setPrompt({ kind: 'rename', entry: selected })}>
          <Pencil size={13} />
        </IconBtn>
        <IconBtn label="Delete (Del)" disabled={!selected} onClick={() => selected && setPrompt({ kind: 'delete', entry: selected })}>
          <Trash2 size={13} />
        </IconBtn>
        <span className="flex-1" />
        <IconBtn label="Refresh" onClick={reloadAll}>
          <RefreshCw size={13} />
        </IconBtn>
        <IconBtn label="Collapse all" onClick={() => setExpanded(new Set(['']))}>
          <ChevronsDownUp size={14} />
        </IconBtn>
      </div>
      <ul
        role="tree"
        aria-label="Project files"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto py-1 focus:outline-none"
        onKeyDown={(e) => {
          if (!selected) return
          if (e.key === 'F2') setPrompt({ kind: 'rename', entry: selected })
          if (e.key === 'Delete') setPrompt({ kind: 'delete', entry: selected })
        }}
      >
        {renderDir('', 0)}
      </ul>
      <label className="flex shrink-0 items-center gap-1.5 border-t border-line px-2.5 py-1.5 text-[11px] text-faint">
        <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} className="accent-[#7c6cff]" />
        Show node_modules, dist and other generated folders
      </label>

      {prompt && prompt.kind !== 'delete' && (
        <NameDialog
          prompt={prompt}
          onClose={() => setPrompt(null)}
          onSubmit={async (name) => {
            if (prompt.kind === 'rename') {
              const to = parentOf(prompt.entry.path) ? `${parentOf(prompt.entry.path)}/${name}` : name
              const refuse = guardRename(prompt.entry.path)
              if (refuse) throw new Error(refuse)
              await window.api.invoke('fs:rename', { projectId, from: prompt.entry.path, to })
              onRenamed(prompt.entry.path, to)
              setSelected(null)
            } else {
              const path = prompt.parent ? `${prompt.parent}/${name}` : name
              await window.api.invoke('fs:create', { projectId, path, kind: prompt.kind })
              if (prompt.parent) setExpanded((p) => new Set([...p, prompt.parent]))
              if (prompt.kind === 'file') onOpen(path)
            }
            reloadAll()
            setPrompt(null)
          }}
        />
      )}
      {prompt?.kind === 'delete' && (
        <DeleteDialog
          entry={prompt.entry}
          onClose={() => setPrompt(null)}
          onConfirm={async () => {
            await window.api.invoke('fs:remove', { projectId, path: prompt.entry.path })
            onDeleted(prompt.entry.path)
            setSelected(null)
            reloadAll()
            setPrompt(null)
          }}
        />
      )}
    </div>
  )
}

function IconBtn({ label, children, ...rest }: { label: string; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} title={label} aria-label={label} className="rounded p-1.5 text-muted hover:bg-hover hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent">
      {children}
    </button>
  )
}

function NameDialog({ prompt, onClose, onSubmit }: { prompt: Exclude<Prompt, { kind: 'delete' }>; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(prompt.kind === 'rename' ? prompt.entry.name : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = prompt.kind === 'rename' ? `Rename “${prompt.entry.name}”` : prompt.kind === 'file' ? 'New file' : 'New folder'
  const where = prompt.kind === 'rename' ? null : prompt.parent || 'project root'

  const submit = async (): Promise<void> => {
    const n = name.trim()
    if (!n) return
    if (n.includes('/') && prompt.kind === 'rename') {
      setError('Enter a name, not a path. Use New file to create inside a folder.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSubmit(n)
    } catch (e) {
      setError(msg(e))
      setBusy(false)
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
            {prompt.kind === 'rename' ? 'Rename' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="space-y-2"
      >
        {where && <p className="text-xs text-muted">In: {where}</p>}
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={prompt.kind === 'dir' ? 'folder-name' : 'file-name.ts'} aria-label="Name" />
        {error && <p className="text-xs text-err">{error}</p>}
      </form>
    </Modal>
  )
}

function DeleteDialog({ entry, onClose, onConfirm }: { entry: FileEntry; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal
      title={`Delete ${entry.type === 'dir' ? 'folder' : 'file'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm()
              } catch (e) {
                setError(msg(e))
                setBusy(false)
              }
            }}
          >
            Delete permanently
          </Button>
        </>
      }
    >
      <p className="text-[13px]">
        Delete <span className="font-mono">{entry.path}</span>
        {entry.type === 'dir' ? ' and everything inside it' : ''}?
      </p>
      <p className="mt-2 text-xs text-muted">This removes it from disk; it does not go to the Recycle Bin and cannot be undone.</p>
      {error && <p className="mt-2 text-xs text-err">{error}</p>}
    </Modal>
  )
}

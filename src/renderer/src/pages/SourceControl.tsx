import { Archive, GitBranch, GitCommitHorizontal, History, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStudio } from '../store'
import { useWorkspaceProject } from '../lib/use-workspace-project'
import { timeAgo } from '../lib/format'
import { Badge, Button, EmptyState, Input, Select, Textarea, cx } from '../components/ui'
import type { Checkpoint, GitBranchInfo, GitCommitInfo, GitDiffResult, GitFileChange, GitStatus } from '../../../shared/ipc'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const LETTER_TONE: Record<string, string> = { M: 'text-warn', A: 'text-ok', D: 'text-err', R: 'text-info', C: 'text-info', U: 'text-err', '?': 'text-ok' }
const LETTER_TITLE: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', '?': 'New file (untracked)' }

function letter(f: GitFileChange): string {
  const l = f.worktree !== ' ' ? f.worktree : f.index
  return l === ' ' ? '·' : l
}

function DiffView({ diff }: { diff: GitDiffResult | null }) {
  if (!diff) return <p className="p-3 text-xs text-faint">Select a file to see what changed.</p>
  if (diff.note) return <p className="p-3 text-xs text-muted">{diff.note}</p>
  if (!diff.text.trim()) return <p className="p-3 text-xs text-faint">No textual changes.</p>
  return (
    <pre className="min-h-0 flex-1 overflow-auto p-0 font-mono text-[11.5px] leading-5" data-diff data-selectable>
      {diff.text.split('\n').map((line, i) => (
        <div
          key={i}
          className={cx(
            'px-3 whitespace-pre',
            line.startsWith('+') && !line.startsWith('+++') && 'bg-ok/10 text-ok',
            line.startsWith('-') && !line.startsWith('---') && 'bg-err/10 text-err',
            line.startsWith('@@') && 'text-info',
            /^(diff |index |--- |\+\+\+ )/.test(line) && 'text-faint'
          )}
        >
          {line || ' '}
        </div>
      ))}
      {diff.truncated && <div className="px-3 py-1 text-warn">… the diff was cut because it is very long</div>}
    </pre>
  )
}

/** Source control for the project folder: status, diffs, commits, branches, and checkpoints (restorable snapshots). No push, pull or remote access. */
export function SourceControl() {
  const projects = useStudio((s) => s.projects)
  const setWorkspaceProject = useStudio((s) => s.setWorkspaceProject)
  const project = useWorkspaceProject()
  const projectId = project?.id ?? null

  const [status, setStatus] = useState<GitStatus | null>(null)
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [log, setLog] = useState<GitCommitInfo[]>([])
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitDiffResult | null>(null)
  const [tab, setTab] = useState<'history' | 'checkpoints'>('checkpoints')
  const [label, setLabel] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const seq = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    if (!projectId) return
    const mine = ++seq.current
    try {
      const st = await window.api.invoke('git:status', projectId)
      const [br, lg, cps] = await Promise.all([
        st.isRepo ? window.api.invoke('git:branches', projectId) : Promise.resolve<GitBranchInfo[]>([]),
        st.isRepo && st.hasCommits ? window.api.invoke('git:log', { projectId, limit: 50 }) : Promise.resolve<GitCommitInfo[]>([]),
        window.api.invoke('checkpoints:list', projectId)
      ])
      if (mine !== seq.current) return
      setStatus(st)
      setBranches(br)
      setLog(lg)
      setCheckpoints(cps)
      // Forget selections of files that are no longer changed.
      setPicked((p) => new Set([...p].filter((x) => st.files.some((f) => f.path === x))))
      setError(null)
    } catch (e) {
      if (mine === seq.current) setError(errText(e))
    }
  }, [projectId])

  useEffect(() => {
    setStatus(null)
    setOpen(null)
    setDiff(null)
    setPicked(new Set())
    setNotice(null)
    void reload()
  }, [reload])

  // Files change while agents work: keep the list current (coalesced).
  useEffect(() => {
    if (!projectId) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.api.onFsChange((c) => {
      if (c.projectId !== projectId) return
      clearTimeout(timer)
      timer = setTimeout(() => void reload(), 600)
    })
    const off2 = window.api.onActivity((e) => {
      if (e.projectId === projectId && e.type.startsWith('checkpoint.')) void reload()
    })
    return () => {
      clearTimeout(timer)
      off()
      off2()
    }
  }, [projectId, reload])

  // Show the diff of the selected file (the staged side when that is all there is).
  useEffect(() => {
    if (!projectId || !open || !status) return setDiff(null)
    const f = status.files.find((x) => x.path === open)
    if (!f) return setDiff(null)
    let live = true
    void window.api.invoke('git:diff', { projectId, path: open, staged: f.worktree === ' ' && f.index !== ' ' && f.index !== '?' }).then(
      (d) => live && setDiff(d),
      (e) => live && setDiff({ path: open, text: '', truncated: false, note: errText(e) })
    )
    return () => {
      live = false
    }
  }, [projectId, open, status])

  const act = async (name: string, fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(name)
    setError(null)
    setNotice(null)
    try {
      await fn()
      if (ok) setNotice(ok)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(null)
      void reload()
    }
  }

  if (!project || !projectId) {
    return (
      <div className="page-enter p-6">
        <EmptyState icon={<GitBranch size={28} />} title="No project yet">
          Create a project first. Source control works on the project&apos;s folder.
        </EmptyState>
      </div>
    )
  }

  const files = status?.files ?? []
  const committable = files.filter((f) => !f.secret)
  const allPicked = committable.length > 0 && committable.every((f) => picked.has(f.path))

  return (
    <div className="page-enter flex h-full min-h-0 flex-col" data-page="source">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <Select value={project.id} onChange={(e) => setWorkspaceProject(e.target.value)} aria-label="Project" className="h-7 w-52 py-0 text-xs">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        {status?.isRepo && (
          <span className="flex items-center gap-1.5 text-xs text-muted" data-branch>
            <GitBranch size={13} /> {status.branch ?? (status.detached ? 'detached HEAD' : 'no commits yet')}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[11px] text-faint">Local only: this app never pushes or pulls</span>
        <Button size="sm" onClick={() => void reload()} aria-label="Refresh">
          <RefreshCw size={12} /> Refresh
        </Button>
      </header>

      {(error || notice) && (
        <div className={cx('shrink-0 border-b px-4 py-2 text-xs', error ? 'border-err/30 bg-err/10 text-err' : 'border-ok/30 bg-ok/10 text-ok')} role={error ? 'alert' : 'status'} data-git-message>
          {error ?? notice}
        </div>
      )}

      {!status ? (
        <p className="p-6 text-xs text-faint">Reading the repository…</p>
      ) : status.gitMissing ? (
        <EmptyState title="git is not installed">Install Git for Windows and make sure it is on the PATH. Checkpoints need it too.</EmptyState>
      ) : !status.isRepo ? (
        <div className="p-6">
          <EmptyState
            icon={<GitBranch size={28} />}
            title="This project folder is not a git repository"
            action={
              <Button variant="primary" disabled={busy !== null} onClick={() => void act('init', () => window.api.invoke('git:init', projectId), 'Repository created.')} data-git-init>
                Initialize repository
              </Button>
            }
          >
            A repository gives you history, branches and checkpoints. Nothing is sent anywhere.
          </EmptyState>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,34%)_1fr] gap-0">
          <section className="flex min-h-0 flex-col border-r border-line bg-panel" aria-label="Changes">
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-xs">
              <input
                type="checkbox"
                aria-label="Select all changed files"
                checked={allPicked}
                disabled={committable.length === 0}
                onChange={() => setPicked(allPicked ? new Set() : new Set(committable.map((f) => f.path)))}
              />
              <span className="font-medium">Changes</span>
              <Badge>{files.length}</Badge>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto py-1" data-git-files>
              {files.length === 0 && <li className="px-3 py-4 text-xs text-faint">Working tree clean.</li>}
              {files.map((f) => (
                <li key={f.path} className={cx('flex items-center gap-2 px-3 py-0.5 text-xs hover:bg-hover/60', open === f.path && 'bg-accent-soft')}>
                  <input
                    type="checkbox"
                    aria-label={`Include ${f.path}`}
                    disabled={f.secret}
                    checked={picked.has(f.path)}
                    onChange={() =>
                      setPicked((p) => {
                        const n = new Set(p)
                        if (n.has(f.path)) n.delete(f.path)
                        else n.add(f.path)
                        return n
                      })
                    }
                  />
                  <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(f.path)} data-git-file={f.path}>
                    <span className={cx('w-3 shrink-0 text-center font-mono', LETTER_TONE[letter(f)] ?? 'text-muted')} title={LETTER_TITLE[letter(f)] ?? ''}>
                      {letter(f)}
                    </span>
                    <span className="min-w-0 truncate" title={f.from ? `${f.from} → ${f.path}` : f.path}>
                      {f.path}
                    </span>
                    {f.secret && (
                      <Badge tone="warn" title="Credential-looking files are never committed, snapshotted or shown by this app">
                        never committed
                      </Badge>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <div className="shrink-0 space-y-2 border-t border-line p-3">
              <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" aria-label="Commit message" data-commit-message />
              <Button
                variant="primary"
                className="w-full"
                disabled={busy !== null || picked.size === 0 || !message.trim()}
                onClick={() =>
                  void act(
                    'commit',
                    async () => {
                      const r = await window.api.invoke('git:commit', { projectId, message, paths: [...picked] })
                      setMessage('')
                      setPicked(new Set())
                      setNotice(`Committed ${r.committed} file${r.committed === 1 ? '' : 's'} as ${r.short}.`)
                    },
                    undefined
                  )
                }
                data-commit
              >
                <GitCommitHorizontal size={14} /> Commit {picked.size > 0 ? `${picked.size} file${picked.size === 1 ? '' : 's'}` : ''}
              </Button>
              <div className="flex gap-2">
                <Select
                  value={status.branch ?? ''}
                  onChange={(e) => void act('switch', () => window.api.invoke('git:switch', { projectId, branch: e.target.value }), `Switched to ${e.target.value}.`)}
                  aria-label="Branch"
                  className="h-7 min-w-0 flex-1 py-0 text-xs"
                  disabled={busy !== null || branches.length === 0}
                >
                  {status.branch === null && <option value="">(none)</option>}
                  {branches.map((b) => (
                    <option key={b.name} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const name = newBranch.trim()
                  if (!name) return
                  void act('branch', () => window.api.invoke('git:switch', { projectId, branch: name, create: true }), `Created and switched to ${name}.`).then(() => setNewBranch(''))
                }}
              >
                <Input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} placeholder="New branch name" aria-label="New branch name" className="h-7 text-xs" />
                <Button size="sm" type="submit" disabled={busy !== null || !newBranch.trim()}>
                  Create
                </Button>
              </form>
            </div>
          </section>

          <section className="flex min-h-0 flex-col" aria-label="Details">
            <div className="flex min-h-0 flex-1 flex-col border-b border-line">
              <div className="flex h-8 shrink-0 items-center border-b border-line px-3 text-xs font-medium text-muted">{open ?? 'Diff'}</div>
              <DiffView diff={diff} />
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <div role="tablist" className="flex h-8 shrink-0 border-b border-line">
                {(
                  [
                    ['checkpoints', 'Checkpoints', Archive],
                    ['history', 'History', History]
                  ] as const
                ).map(([id, text, Icon]) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    onClick={() => setTab(id)}
                    className={cx('flex items-center gap-1.5 border-b-2 px-4 text-xs', tab === id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}
                  >
                    <Icon size={13} /> {text}
                  </button>
                ))}
              </div>
              {tab === 'history' ? (
                <ul className="min-h-0 flex-1 overflow-y-auto py-1" data-git-log>
                  {log.length === 0 && <li className="px-4 py-4 text-xs text-faint">No commits yet.</li>}
                  {log.map((c) => (
                    <li key={c.sha} className="flex items-baseline gap-3 px-4 py-1 text-xs hover:bg-hover/60">
                      <code className="shrink-0 text-accent">{c.short}</code>
                      <span className="min-w-0 flex-1 truncate" title={c.subject}>
                        {c.subject}
                      </span>
                      <span className="shrink-0 text-faint">{c.author}</span>
                      <span className="shrink-0 text-faint">{timeAgo(c.date)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <form
                    className="flex shrink-0 gap-2 border-b border-line p-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void act('checkpoint', () => window.api.invoke('checkpoints:create', { projectId, label: label.trim() || undefined }), 'Checkpoint saved.').then(() => setLabel(''))
                    }}
                  >
                    <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Checkpoint name (optional)" aria-label="Checkpoint name" className="h-7 text-xs" />
                    <Button size="sm" type="submit" disabled={busy !== null} data-checkpoint-create>
                      <Archive size={12} /> Save checkpoint
                    </Button>
                  </form>
                  <p className="shrink-0 px-4 py-2 text-[11px] leading-relaxed text-faint">
                    A checkpoint saves every project file (except credential files) without touching your branch, staging area or history. Restoring puts the files back and first saves a
                    safety checkpoint, so a restore can be undone.
                  </p>
                  <ul className="min-h-0 flex-1 overflow-y-auto" data-checkpoints>
                    {checkpoints.length === 0 && <li className="px-4 py-3 text-xs text-faint">No checkpoints yet.</li>}
                    {checkpoints.map((c) => (
                      <li key={c.id} className="flex items-center gap-3 border-t border-line/60 px-4 py-1.5 text-xs" data-checkpoint={c.kind}>
                        <Badge tone={c.kind === 'manual' ? 'accent' : c.kind === 'auto' ? 'info' : 'neutral'}>{c.kind}</Badge>
                        <span className="min-w-0 flex-1 truncate" title={c.label}>
                          {c.label}
                        </span>
                        <span className="shrink-0 text-faint">{c.fileCount} files</span>
                        <span className="shrink-0 text-faint">{timeAgo(c.createdAt)}</span>
                        {confirmId === c.id ? (
                          <>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={busy !== null}
                              onClick={() => {
                                setConfirmId(null)
                                void act('restore', async () => {
                                  const r = await window.api.invoke('checkpoints:restore', { id: c.id })
                                  setNotice(`Restored ${r.restored} file${r.restored === 1 ? '' : 's'} and removed ${r.removed}. Undo it from the “safety” checkpoint just above.`)
                                })
                              }}
                              data-checkpoint-confirm
                            >
                              Overwrite files
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmId(null)}>
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" disabled={busy !== null} onClick={() => setConfirmId(c.id)} title="Put the project files back to this snapshot" data-checkpoint-restore>
                              <RotateCcw size={11} /> Restore
                            </Button>
                            <Button size="sm" variant="ghost" aria-label="Delete checkpoint" disabled={busy !== null} onClick={() => void act('remove', () => window.api.invoke('checkpoints:remove', c.id))}>
                              <Trash2 size={12} />
                            </Button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

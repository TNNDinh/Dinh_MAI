import { DatabaseZap, FolderTree, Lock, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { useStudio } from '../store'
import { useEditors } from '../lib/editor-store'
import { useWorkspaceProject } from '../lib/use-workspace-project'
import { timeAgo } from '../lib/format'
import { loadLayout, saveLayout } from '../lib/layout-storage'
import { Badge, Button, EmptyState, Select, cx } from '../components/ui'
import { FileTree } from '../components/workspace/FileTree'
import { SearchPanel } from '../components/workspace/SearchPanel'
import { EditorPane } from '../components/workspace/EditorPane'
import type { FileLockInfo, IndexSummary } from '../../../shared/ipc'

const NO_LOCKS: FileLockInfo[] = []

/** Project files with a real code editor. Agents work in the same folder; the lock markers show who is editing what. */
export function Workspace() {
  const projects = useStudio((s) => s.projects)
  const setWorkspaceProject = useStudio((s) => s.setWorkspaceProject)
  const project = useWorkspaceProject()
  const projectId = project?.id ?? null
  const [side, setSide] = useState<'files' | 'search'>('files')
  const locks = useEditors((s) => (projectId ? s.locks[projectId] : undefined)) ?? NO_LOCKS
  const active = useEditors((s) => (projectId ? s.byProject[projectId]?.active : null)) ?? null
  const dirtyCount = useEditors((s) => (projectId ? (s.byProject[projectId]?.files.filter((f) => f.dirty).length ?? 0) : 0))
  const [index, setIndex] = useState<IndexSummary | null>(null)
  const [indexing, setIndexing] = useState(false)
  const [indexError, setIndexError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    void useEditors.getState().refreshLocks(projectId)
    const timer = setInterval(() => void useEditors.getState().refreshLocks(projectId), 2500)
    const off = window.api.onFsChange((c) => {
      useEditors.getState().handleFsChange(c)
      void useEditors.getState().refreshLocks(c.projectId)
    })
    setIndex(null)
    setIndexError(null)
    void window.api.invoke('index:status', projectId).then(setIndex, () => undefined)
    return () => {
      clearInterval(timer)
      off()
    }
  }, [projectId])

  if (!project || !projectId) {
    return (
      <div className="page-enter p-6">
        <EmptyState icon={<FolderTree size={28} />} title="No project yet">
          Create a project first. Its folder is what you browse and edit here, and what agents work in.
        </EmptyState>
      </div>
    )
  }

  const onIndex = async (): Promise<void> => {
    setIndexing(true)
    setIndexError(null)
    try {
      setIndex(await window.api.invoke('index:run', projectId))
    } catch (e) {
      setIndexError(e instanceof Error ? e.message : String(e))
    } finally {
      setIndexing(false)
    }
  }

  const ed = useEditors.getState()
  const under = (path: string, p: string): boolean => path === p || path.startsWith(`${p}/`)

  return (
    <div className="page-enter flex h-full min-h-0 flex-col" data-page="workspace">
      <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <Select value={project.id} onChange={(e) => setWorkspaceProject(e.target.value)} aria-label="Project" className="h-7 w-52 py-0 text-xs">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <span className="min-w-0 truncate font-mono text-[11px] text-faint" title={project.rootPath} data-selectable>
          {project.rootPath}
        </span>
        <span className="flex-1" />
        {locks.length > 0 && (
          <Badge tone="warn" title={locks.map((l) => `${l.path} — ${l.agentName ?? 'an agent'}`).join('\n')}>
            <Lock size={10} className="mr-1" />
            {locks.length} {locks.length === 1 ? 'file' : 'files'} locked by agents
          </Badge>
        )}
        {dirtyCount > 0 && (
          <Button size="sm" className="shrink-0 whitespace-nowrap" onClick={() => void ed.saveAll(projectId)}>
            Save all ({dirtyCount})
          </Button>
        )}
        <span className="shrink-0 text-[11px] whitespace-nowrap text-faint" title="The context index lets agents find relevant files by name, symbol and summary. It is built from the code itself, not by an AI." data-index-status>
          {indexError ? <span className="text-err">{indexError}</span> : index?.indexedAt ? `${index.files} files indexed ${timeAgo(index.indexedAt)}` : 'Not indexed'}
        </span>
        <Button size="sm" onClick={() => void onIndex()} disabled={indexing} title="Rebuild the context index used by agents">
          <DatabaseZap size={12} /> {indexing ? 'Indexing…' : 'Index'}
        </Button>
      </header>

      <Group orientation="horizontal" id="workspace-split" className="min-h-0 flex-1" defaultLayout={loadLayout('workspace-split')} onLayoutChanged={(l) => saveLayout('workspace-split', l)}>
        <Panel id="ws-side" defaultSize="24%" minSize="14%" maxSize="45%">
          <div className="flex h-full min-h-0 flex-col bg-panel">
            <div role="tablist" className="flex h-8 shrink-0 border-b border-line">
              {(
                [
                  ['files', 'Files', FolderTree],
                  ['search', 'Search', Search]
                ] as const
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={side === id}
                  onClick={() => setSide(id)}
                  className={cx('flex flex-1 items-center justify-center gap-1.5 border-b-2 text-xs', side === id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}
                >
                  <Icon size={13} /> {label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {side === 'files' ? (
                <FileTree
                  projectId={projectId}
                  locks={locks}
                  activePath={active}
                  onOpen={(p) => void ed.openFile(projectId, p)}
                  guardRename={(p) => {
                    const dirty = (useEditors.getState().byProject[projectId]?.files ?? []).find((f) => f.dirty && under(f.path, p))
                    return dirty ? `“${dirty.path}” has unsaved changes. Save or close it before renaming.` : null
                  }}
                  onRenamed={(from) => {
                    // A tab under the old name would point at nothing: close it (the file is still there under its new name).
                    for (const f of useEditors.getState().byProject[projectId]?.files ?? []) if (under(f.path, from)) useEditors.getState().closeFile(projectId, f.path, true)
                  }}
                  onDeleted={(p) => {
                    for (const f of useEditors.getState().byProject[projectId]?.files ?? []) if (under(f.path, p)) useEditors.getState().closeFile(projectId, f.path, true)
                  }}
                />
              ) : (
                <SearchPanel projectId={projectId} onOpen={(p, line) => void ed.openFile(projectId, p, line)} />
              )}
            </div>
          </div>
        </Panel>
        <Separator />
        <Panel id="ws-editor" minSize="30%">
          <EditorPane projectId={projectId} />
        </Panel>
      </Group>
    </div>
  )
}

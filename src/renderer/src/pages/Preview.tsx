import { AppWindow, Play, RefreshCw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useStudio } from '../store'
import { useWorkspaceProject } from '../lib/use-workspace-project'
import { Badge, Button, EmptyState, Select, cx } from '../components/ui'
import type { PreviewMode, PreviewOptions } from '../../../shared/ipc'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const TONE = { starting: 'info', running: 'ok', failed: 'err', stopped: 'neutral' } as const

/** Live preview of the project: its static files (built-in server) or its own dev server, shown in a sandboxed frame. Only this computer's addresses are ever loaded. */
export function Preview() {
  const projects = useStudio((s) => s.projects)
  const setWorkspaceProject = useStudio((s) => s.setWorkspaceProject)
  const applyPreview = useStudio((s) => s.applyPreview)
  const project = useWorkspaceProject()
  const projectId = project?.id ?? null
  const info = useStudio((s) => (projectId ? (s.previews[projectId] ?? null) : null))
  const [options, setOptions] = useState<PreviewOptions | null>(null)
  const [mode, setMode] = useState<PreviewMode>('static')
  const [folder, setFolder] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState(0)

  useEffect(() => {
    setOptions(null)
    setError(null)
    if (!projectId) return
    let live = true
    void window.api.invoke('preview:options', projectId).then(
      (o) => {
        if (!live) return
        setOptions(o)
        setFolder((f) => (o.staticFolders.includes(f) ? f : (o.staticFolders[0] ?? '')))
        setMode((m) => (m === 'static' && o.staticFolders.length === 0 && o.devCommand ? 'dev' : m))
      },
      (e) => live && setError(errText(e))
    )
    void window.api.invoke('preview:get', projectId).then(
      (i) => live && i && applyPreview(i),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [projectId, applyPreview])

  if (!project || !projectId) {
    return (
      <div className="page-enter p-6">
        <EmptyState icon={<AppWindow size={28} />} title="No project yet">
          Create a project first. The preview shows what is in its folder.
        </EmptyState>
      </div>
    )
  }

  const active = info && (info.status === 'starting' || info.status === 'running')
  const canStatic = (options?.staticFolders.length ?? 0) > 0
  const canDev = !!options?.devCommand
  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      applyPreview(await window.api.invoke('preview:start', { projectId, mode, folder: mode === 'static' ? folder : undefined }))
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const stop = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.api.invoke('preview:stop', projectId)
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-enter flex h-full min-h-0 flex-col" data-page="preview">
      <header className="flex min-h-10 shrink-0 flex-wrap items-center gap-3 border-b border-line bg-panel px-3 py-1">
        <Select value={project.id} onChange={(e) => setWorkspaceProject(e.target.value)} aria-label="Project" className="h-7 w-52 py-0 text-xs" disabled={!!active}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select value={mode} onChange={(e) => setMode(e.target.value as PreviewMode)} aria-label="Preview source" className="h-7 w-44 py-0 text-xs" disabled={!!active}>
          <option value="static" disabled={!canStatic}>
            Static files
          </option>
          <option value="dev" disabled={!canDev}>
            Dev server
          </option>
        </Select>
        {mode === 'static' ? (
          <Select value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder" className="h-7 w-44 py-0 text-xs" disabled={!!active || !canStatic}>
            {(options?.staticFolders ?? []).map((f) => (
              <option key={f} value={f}>
                {f || '(project folder)'}
              </option>
            ))}
          </Select>
        ) : (
          <code className="text-[11px] text-faint" data-selectable>
            {options?.devCommand ?? ''}
          </code>
        )}
        <span className="flex-1" />
        {info && <Badge tone={TONE[info.status]}>{info.status}</Badge>}
        {info?.url && (
          <code className="text-[11px] text-muted" data-selectable data-preview-url>
            {info.url}
          </code>
        )}
        {info?.status === 'running' && (
          <Button size="sm" onClick={() => setManual((n) => n + 1)} aria-label="Reload preview">
            <RefreshCw size={12} /> Reload
          </Button>
        )}
        {active ? (
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void stop()} data-preview-stop>
            <Square size={11} /> Stop
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={busy || (mode === 'static' ? !canStatic : !canDev)} onClick={() => void start()} data-preview-start>
            <Play size={11} /> Start preview
          </Button>
        )}
      </header>

      {(error || info?.message) && (
        <div className={cx('shrink-0 border-b px-4 py-2 text-xs', info?.status === 'failed' || error ? 'border-err/30 bg-err/10 text-err' : 'border-line text-muted')} role="alert" data-preview-message>
          {error ?? info?.message}
        </div>
      )}

      <div className="min-h-0 flex-1 bg-bg">
        {info?.status === 'running' && info.url ? (
          <iframe
            key={`${info.url}-${manual}`}
            src={info.url}
            title="Project preview"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
            className="h-full w-full border-0 bg-white"
            data-preview-frame
          />
        ) : info?.status === 'starting' ? (
          <div className="flex h-full flex-col">
            <p className="px-4 py-3 text-xs text-muted">Starting the dev server… the page appears when it prints its address and accepts connections.</p>
            <pre className="min-h-0 flex-1 overflow-auto px-4 font-mono text-[11px] whitespace-pre-wrap text-faint" data-selectable>
              {info.output}
            </pre>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            {info?.output ? (
              <pre className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-[11px] whitespace-pre-wrap text-faint" data-selectable>
                {info.output}
              </pre>
            ) : (
              <EmptyState icon={<AppWindow size={28} />} title="Nothing is being previewed">
                {options && !canStatic && !canDev
                  ? 'This project has no index.html and no dev/start script, so there is nothing to show yet. Ask the agents to build a page, then come back.'
                  : 'Choose static files (served by the built-in local server) or the project’s own dev server, then start the preview.'}
              </EmptyState>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

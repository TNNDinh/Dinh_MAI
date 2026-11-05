import { AlertTriangle, FileWarning, Lock, Save, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { monaco } from '../../lib/monaco'
import { modelUri, useEditors, viewStates, type OpenFile } from '../../lib/editor-store'
import { fmtBytes } from '../../lib/format'
import { Button, EmptyState, cx } from '../ui'

const OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  theme: 'studio-dark',
  automaticLayout: true,
  fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  fontSize: 13,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderWhitespace: 'selection',
  smoothScrolling: true,
  tabSize: 2,
  bracketPairColorization: { enabled: true },
  contextmenu: true,
  fixedOverflowWidgets: true
}

const EMPTY_FILES: OpenFile[] = []

/** Tabs, a Monaco editor and the banners that explain why a file cannot be saved or has changed under you. */
export function EditorPane({ projectId }: { projectId: string }) {
  const pe = useEditors((s) => s.byProject[projectId])
  const error = useEditors((s) => s.error)
  const { activate, closeFile, save, reload, setError, clearReveal } = useEditors.getState()
  const files = pe?.files ?? EMPTY_FILES
  const active = files.find((f) => f.path === pe?.active) ?? null
  const reveal = pe?.reveal ?? null

  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const current = useRef<{ projectId: string; path: string } | null>(null)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })

  // One editor for the lifetime of the pane.
  useEffect(() => {
    if (!host.current) return
    const ed = monaco.editor.create(host.current, { ...OPTIONS, model: null })
    editor.current = ed
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const c = current.current
      if (c) void useEditors.getState().save(c.projectId, c.path)
    })
    ed.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, col: e.position.column }))
    return () => {
      const c = current.current
      if (c) viewStates.set(`${c.projectId}\u0000${c.path}`, ed.saveViewState())
      ed.dispose()
      editor.current = null
      current.current = null
    }
  }, [])

  // Show the active file's model; remember where the previous one was scrolled to.
  useEffect(() => {
    const ed = editor.current
    if (!ed) return
    const prev = current.current
    if (prev && (prev.projectId !== projectId || prev.path !== active?.path)) viewStates.set(`${prev.projectId}\u0000${prev.path}`, ed.saveViewState())
    if (!active) {
      ed.setModel(null)
      current.current = null
      return
    }
    const model = monaco.editor.getModel(modelUri(projectId, active.path))
    if (!model) return
    if (ed.getModel() !== model) ed.setModel(model)
    current.current = { projectId, path: active.path }
    const vs = viewStates.get(`${projectId}\u0000${active.path}`)
    if (vs) ed.restoreViewState(vs)
    ed.focus()
  }, [projectId, active?.path, active])

  useEffect(() => {
    editor.current?.updateOptions({ readOnly: !!active?.lockedBy, readOnlyMessage: { value: `Being edited by ${active?.lockedBy ?? 'an agent'}. Wait for their task to finish.` } })
  }, [active?.lockedBy, active?.path])

  useEffect(() => {
    if (!reveal || reveal.path !== active?.path) return
    const ed = editor.current
    if (!ed) return
    ed.revealLineInCenter(reveal.line)
    ed.setPosition({ lineNumber: reveal.line, column: 1 })
    clearReveal(projectId)
  }, [reveal, active?.path, projectId, clearReveal])

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div role="tablist" aria-label="Open files" className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel">
        {files.map((f) => {
          const isActive = f.path === active?.path
          return (
            <div
              key={f.path}
              role="tab"
              aria-selected={isActive}
              data-tab={f.path}
              title={f.path}
              onClick={() => activate(projectId, f.path)}
              onAuxClick={(e) => e.button === 1 && closeFile(projectId, f.path)}
              className={cx('group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-line px-3 text-xs', isActive ? 'border-t-2 border-t-accent bg-bg text-fg' : 'border-t-2 border-t-transparent text-muted hover:text-fg')}
            >
              {f.lockedBy && <Lock size={10} className="text-warn" />}
              <span className={cx(f.missing && 'line-through')}>{f.path.split('/').pop()}</span>
              <button
                aria-label={`Close ${f.path}`}
                onClick={(e) => {
                  e.stopPropagation()
                  closeFile(projectId, f.path)
                }}
                className="flex size-4 items-center justify-center rounded hover:bg-hover"
              >
                {f.dirty ? <span className="size-2 rounded-full bg-fg group-hover:hidden" aria-label="unsaved changes" /> : null}
                <X size={12} className={cx(f.dirty ? 'hidden group-hover:block' : 'opacity-0 group-hover:opacity-100', isActive && !f.dirty && 'opacity-60')} />
              </button>
            </div>
          )
        })}
      </div>

      {active?.lockedBy && (
        <Banner tone="warn" icon={<Lock size={13} />}>
          {active.lockedBy} is editing this file, so it is read-only until their task ends. It reloads automatically when they finish.
          <Button
            size="sm"
            className="ml-auto"
            onClick={async () => {
              if (!window.confirm('Release the lock? The agent may still be working on this file, and its next write could overwrite your edits.')) return
              await window.api.invoke('locks:release', { projectId, path: active.path })
              await useEditors.getState().refreshLocks(projectId)
            }}
          >
            Release lock
          </Button>
        </Banner>
      )}
      {active?.conflict && (
        <Banner tone="err" icon={<AlertTriangle size={13} />}>
          This file changed on disk while you have unsaved edits.
          <span className="ml-auto flex gap-1.5">
            <Button size="sm" onClick={() => void reload(projectId, active.path)}>
              Discard mine, reload
            </Button>
            <Button size="sm" variant="danger" onClick={() => void save(projectId, active.path, true)}>
              Overwrite disk
            </Button>
          </span>
        </Banner>
      )}
      {active?.missing && (
        <Banner tone="warn" icon={<FileWarning size={13} />}>
          This file was deleted or renamed on disk. Saving will create it again.
        </Banner>
      )}
      {error && (
        <Banner tone="err" icon={<AlertTriangle size={13} />}>
          <span className="min-w-0 break-words">{error}</span>
          <button className="ml-auto shrink-0 text-muted hover:text-fg" aria-label="Dismiss" onClick={() => setError(null)}>
            <X size={13} />
          </button>
        </Banner>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0" data-editor-host />
        {!active && (
          <div className="absolute inset-0 flex items-center justify-center bg-bg">
            <EmptyState title="No file open">Pick a file in the tree, or search the project. Ctrl+S saves.</EmptyState>
          </div>
        )}
      </div>

      <div className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 text-[11px] text-faint">
        {active ? (
          <>
            <span className="font-mono">{active.path}</span>
            <span>{active.language}</span>
            <span>
              Ln {cursor.line}, Col {cursor.col}
            </span>
            <span>{fmtBytes(active.size)}</span>
            <span className="flex-1" />
            <span className={cx(active.saving ? 'text-info' : active.dirty ? 'text-warn' : 'text-ok')} data-save-state>
              {active.saving ? 'Saving…' : active.dirty ? 'Unsaved changes' : 'Saved'}
            </span>
            <Button size="sm" variant="ghost" disabled={!active.dirty || active.saving || !!active.lockedBy} onClick={() => void save(projectId, active.path)} title="Save (Ctrl+S)">
              <Save size={12} /> Save
            </Button>
          </>
        ) : (
          <span>Nothing open</span>
        )}
      </div>
    </div>
  )
}

function Banner({ tone, icon, children }: { tone: 'warn' | 'err'; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div role="alert" className={cx('flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-xs', tone === 'warn' ? 'border-warn/30 bg-warn/10 text-warn' : 'border-err/30 bg-err/10 text-err')}>
      <span className="shrink-0">{icon}</span>
      {children}
    </div>
  )
}

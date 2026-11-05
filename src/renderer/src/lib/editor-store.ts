import { create } from 'zustand'
import type { FileLockInfo, FsChange } from '../../../shared/ipc'
import { monaco } from './monaco'

/**
 * Open editor tabs live outside React so they survive switching pages: unsaved edits are never lost by navigating.
 * The text itself lives in a Monaco model (which also keeps undo history); this store tracks what was last saved.
 */
export interface OpenFile {
  path: string
  language: string
  /** Hash of the content on disk when it was opened or last saved; sent back with a save to detect outside changes. */
  hash: string
  savedContent: string
  size: number
  dirty: boolean
  /** Name of the agent holding the write lock, if any. */
  lockedBy: string | null
  /** The file changed on disk while there are unsaved edits, or a save found it had changed. */
  conflict: boolean
  /** Deleted or renamed on disk while open. */
  missing: boolean
  saving: boolean
}

interface ProjectEditors {
  files: OpenFile[]
  active: string | null
  /** Line to reveal after the next activation (from search results). */
  reveal: { path: string; line: number } | null
}

interface EditorState {
  byProject: Record<string, ProjectEditors>
  locks: Record<string, FileLockInfo[]>
  error: string | null

  setError: (e: string | null) => void
  openFile: (projectId: string, path: string, line?: number) => Promise<void>
  activate: (projectId: string, path: string) => void
  closeFile: (projectId: string, path: string, force?: boolean) => boolean
  save: (projectId: string, path: string, overwrite?: boolean) => Promise<boolean>
  saveAll: (projectId: string) => Promise<void>
  reload: (projectId: string, path: string) => Promise<void>
  refreshLocks: (projectId: string) => Promise<void>
  handleFsChange: (c: FsChange) => void
  clearReveal: (projectId: string) => void
}

const EMPTY: ProjectEditors = { files: [], active: null, reveal: null }
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const modelUri = (projectId: string, path: string): monaco.Uri => monaco.Uri.from({ scheme: 'studio', authority: projectId, path: `/${path}` })

/** Per-file cursor/scroll state, restored when a tab is re-activated. */
export const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>()
const subs = new Map<string, monaco.IDisposable>()
const key = (projectId: string, path: string): string => `${projectId}\u0000${path}`

export const useEditors = create<EditorState>((set, get) => {
  const patchFile = (projectId: string, path: string, patch: Partial<OpenFile>): void =>
    set((s) => {
      const pe = s.byProject[projectId]
      if (!pe) return s
      return { byProject: { ...s.byProject, [projectId]: { ...pe, files: pe.files.map((f) => (f.path === path ? { ...f, ...patch } : f)) } } }
    })
  const getFile = (projectId: string, path: string): OpenFile | undefined => get().byProject[projectId]?.files.find((f) => f.path === path)

  /** Puts the model's text in step with what was read from disk, without recording it as an edit. */
  const setModelText = (model: monaco.editor.ITextModel, text: string): void => {
    if (model.getValue() !== text) model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
  }

  function attach(projectId: string, path: string, model: monaco.editor.ITextModel): void {
    subs.get(key(projectId, path))?.dispose()
    subs.set(
      key(projectId, path),
      model.onDidChangeContent(() => {
        const f = getFile(projectId, path)
        if (!f) return
        const dirty = model.getValue() !== f.savedContent
        if (dirty !== f.dirty) patchFile(projectId, path, { dirty })
      })
    )
  }

  return {
    byProject: {},
    locks: {},
    error: null,

    setError: (error) => set({ error }),

    async openFile(projectId, path, line) {
      const existing = getFile(projectId, path)
      if (existing) {
        get().activate(projectId, path)
        if (line) set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...(s.byProject[projectId] ?? EMPTY), reveal: { path, line } } } }))
        return
      }
      try {
        const f = await window.api.invoke('fs:read', { projectId, path })
        const uri = modelUri(projectId, f.path)
        const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(f.content, f.language, uri)
        setModelText(model, f.content)
        const file: OpenFile = { path: f.path, language: f.language, hash: f.hash, savedContent: f.content, size: f.size, dirty: false, lockedBy: f.lockedBy, conflict: false, missing: false, saving: false }
        set((s) => {
          const pe = s.byProject[projectId] ?? EMPTY
          return { error: null, byProject: { ...s.byProject, [projectId]: { files: [...pe.files, file], active: f.path, reveal: line ? { path: f.path, line } : null } } }
        })
        attach(projectId, f.path, model)
      } catch (e) {
        set({ error: msg(e) })
      }
    },

    activate(projectId, path) {
      set((s) => ({ byProject: { ...s.byProject, [projectId]: { ...(s.byProject[projectId] ?? EMPTY), active: path } } }))
    },

    closeFile(projectId, path, force = false) {
      const f = getFile(projectId, path)
      if (!f) return true
      if (f.dirty && !force && !window.confirm(`“${path}” has unsaved changes. Close it and discard them?`)) return false
      subs.get(key(projectId, path))?.dispose()
      subs.delete(key(projectId, path))
      viewStates.delete(key(projectId, path))
      monaco.editor.getModel(modelUri(projectId, path))?.dispose()
      set((s) => {
        const pe = s.byProject[projectId]
        if (!pe) return s
        const idx = pe.files.findIndex((x) => x.path === path)
        const files = pe.files.filter((x) => x.path !== path)
        const active = pe.active === path ? (files[Math.min(idx, files.length - 1)]?.path ?? null) : pe.active
        return { byProject: { ...s.byProject, [projectId]: { ...pe, files, active } } }
      })
      return true
    },

    async save(projectId, path, overwrite = false) {
      const f = getFile(projectId, path)
      const model = monaco.editor.getModel(modelUri(projectId, path))
      if (!f || !model || f.saving) return false
      if (f.lockedBy) {
        set({ error: `“${path}” is being edited by ${f.lockedBy}. Saving is disabled until their task ends.` })
        return false
      }
      const content = model.getValue()
      patchFile(projectId, path, { saving: true })
      try {
        const r = await window.api.invoke('fs:write', { projectId, path, content, expectedHash: overwrite || f.missing ? undefined : f.hash })
        // The user may have kept typing while the save was in flight: only what was sent counts as saved.
        patchFile(projectId, path, { saving: false, hash: r.hash, savedContent: content, size: r.size, dirty: model.getValue() !== content, conflict: false, missing: false })
        set({ error: null })
        return true
      } catch (e) {
        const m = msg(e)
        patchFile(projectId, path, { saving: false, ...(/changed on disk/.test(m) ? { conflict: true } : {}) })
        set({ error: m })
        return false
      }
    },

    async saveAll(projectId) {
      for (const f of get().byProject[projectId]?.files ?? []) if (f.dirty) await get().save(projectId, f.path)
    },

    async reload(projectId, path) {
      try {
        const f = await window.api.invoke('fs:read', { projectId, path })
        const model = monaco.editor.getModel(modelUri(projectId, path))
        if (model) {
          model.setValue(f.content) // discards undo history on purpose: the text is replaced wholesale
        }
        patchFile(projectId, path, { hash: f.hash, savedContent: f.content, size: f.size, dirty: false, conflict: false, missing: false, lockedBy: f.lockedBy, language: f.language })
        set({ error: null })
      } catch (e) {
        set({ error: msg(e) })
      }
    },

    async refreshLocks(projectId) {
      try {
        const locks = await window.api.invoke('locks:list', projectId)
        const prev = get().locks[projectId]
        if (JSON.stringify(prev) !== JSON.stringify(locks)) set((s) => ({ locks: { ...s.locks, [projectId]: locks } }))
        for (const f of get().byProject[projectId]?.files ?? []) {
          const by = locks.find((l) => l.path.toLowerCase() === f.path.toLowerCase())?.agentName ?? (locks.some((l) => l.path.toLowerCase() === f.path.toLowerCase()) ? 'an agent' : null)
          if (by !== f.lockedBy) {
            patchFile(projectId, f.path, { lockedBy: by })
            // An agent just finished with this file: pick up its changes if there is nothing of ours to lose.
            if (by === null && !f.dirty) void get().reload(projectId, f.path)
          }
        }
      } catch {
        /* the next poll will try again */
      }
    },

    handleFsChange(c) {
      const pe = get().byProject[c.projectId]
      if (!pe) return
      const lc = c.path.toLowerCase()
      for (const f of pe.files) {
        const fl = f.path.toLowerCase()
        const affected = fl === lc || (c.kind !== 'write' && fl.startsWith(`${lc}/`))
        if (!affected) continue
        if (c.by === 'user' && c.kind === 'write') continue // our own save
        if (c.kind === 'write') {
          if (f.dirty) patchFile(c.projectId, f.path, { conflict: true })
          else void get().reload(c.projectId, f.path)
        } else {
          patchFile(c.projectId, f.path, { missing: true })
        }
      }
    },

    clearReveal(projectId) {
      set((s) => {
        const pe = s.byProject[projectId]
        return pe ? { byProject: { ...s.byProject, [projectId]: { ...pe, reveal: null } } } : s
      })
    }
  }
})

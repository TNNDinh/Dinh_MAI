import { useEffect } from 'react'
import { useStudio } from '../store'

/** The project the Workspace page and the terminal are pointed at: the chosen one, else the first. */
export function useWorkspaceProject() {
  const projects = useStudio((s) => s.projects)
  const id = useStudio((s) => s.workspaceProjectId)
  return projects.find((p) => p.id === id) ?? projects[0] ?? null
}

/** Keeps the app's folder watcher on the project on screen, so edits made by other programs show up live. */
export function useWatchWorkspaceFolder(): void {
  const id = useWorkspaceProject()?.id ?? null
  useEffect(() => {
    window.api.invoke('fs:watch', id).catch(() => undefined) // no live refresh is a degraded mode, not an error
  }, [id])
}

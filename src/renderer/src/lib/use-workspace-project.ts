import { useStudio } from '../store'

/** The project the Workspace page and the terminal are pointed at: the chosen one, else the first. */
export function useWorkspaceProject() {
  const projects = useStudio((s) => s.projects)
  const id = useStudio((s) => s.workspaceProjectId)
  return projects.find((p) => p.id === id) ?? projects[0] ?? null
}

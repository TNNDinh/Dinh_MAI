import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStudio } from '../store'
import type { AutomationKind, AutomationRun, AutomationTask } from '../../../shared/ipc'

const NO_RUNS: AutomationRun[] = []

/** The project's own build / test / lint / typecheck commands and the runs started from this app (live, from the main process). */
export function useAutomation(projectId: string | null) {
  const all = useStudio((s) => s.automation)
  const apply = useStudio((s) => s.applyAutomation)
  const [tasks, setTasks] = useState<AutomationTask[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setTasks([])
    setError(null)
    if (!projectId) return
    let live = true
    void window.api.invoke('automation:detect', projectId).then(
      (t) => live && setTasks(t),
      (e) => live && setError(e instanceof Error ? e.message : String(e))
    )
    void window.api.invoke('automation:list', projectId).then(
      (r) => live && apply(r),
      () => undefined
    )
    return () => {
      live = false
    }
  }, [projectId, apply])

  const runs = useMemo(() => (projectId ? all.filter((r) => r.projectId === projectId) : NO_RUNS), [all, projectId])

  const latest = useCallback((kind: AutomationKind): AutomationRun | null => runs.find((r) => r.kind === kind) ?? null, [runs])

  const run = useCallback(
    async (kind: AutomationKind): Promise<void> => {
      if (!projectId) return
      setError(null)
      try {
        apply([await window.api.invoke('automation:run', { projectId, kind })])
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [projectId, apply]
  )

  const cancel = useCallback(async (id: string): Promise<void> => {
    try {
      await window.api.invoke('automation:cancel', id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  return { tasks, runs, latest, run, cancel, error, clearError: () => setError(null) }
}

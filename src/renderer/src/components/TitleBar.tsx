import { OctagonX, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useStudio } from '../store'
import { cx } from './ui'

export function TitleBar() {
  const { projects, selectedProjectId, page, runs, refresh } = useStudio()
  const [stopping, setStopping] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const active = runs.filter((r) => r.status === 'running' || r.status === 'pending').length

  async function stopAll() {
    setStopping(true)
    try {
      const n = await window.api.invoke('runs:stopAll')
      setResult(`Stopped ${n} run${n === 1 ? '' : 's'}`)
      await refresh()
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e))
    } finally {
      setStopping(false)
      setTimeout(() => setResult(null), 4000)
    }
  }
  const project = page === 'projects' ? projects.find((p) => p.id === selectedProjectId) : undefined

  return (
    <header className="drag flex h-9 shrink-0 items-center justify-between border-b border-line bg-bg pl-3">
      <div className="flex items-center gap-2 text-xs">
        <Sparkles size={14} className="text-accent" />
        <span className="font-semibold">Multi-AI Development Studio</span>
        {project && (
          <>
            <span className="text-faint">/</span>
            <span className="text-muted">{project.name}</span>
          </>
        )}
      </div>

      {/* Right padding leaves room for the native Windows min/max/close overlay. */}
      <div className="no-drag flex items-center gap-2 pr-[150px]">
        {result && (
          <span role="status" className="text-[11px] text-muted" data-testid="stop-all-result">
            {result}
          </span>
        )}
        <button
          data-action="stop-all"
          disabled={active === 0 || stopping}
          onClick={() => void stopAll()}
          title={active === 0 ? 'Global STOP: aborts every running agent and in-flight model call. Nothing is running.' : `Global STOP: abort ${active} active run${active === 1 ? '' : 's'} and every in-flight model call`}
          className={cx(
            'flex h-6 items-center gap-1.5 rounded border px-2 text-[11px] font-semibold tracking-wide uppercase disabled:cursor-not-allowed',
            active > 0 ? 'border-err/60 bg-err/15 text-err hover:bg-err/25' : 'border-line text-faint'
          )}
        >
          <OctagonX size={12} /> Stop all
        </button>
      </div>
    </header>
  )
}

import { Ban, Bot, CircleCheck, CircleX, Clock, Loader2, ShieldOff, Square, Trash2, User } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommandLogEntry } from '../../../shared/ipc'
import { fmtDuration } from '../lib/format'
import { useStudio, type TerminalEntry } from '../store'
import { useWorkspaceProject } from '../lib/use-workspace-project'
import { Button, EmptyState, cx } from './ui'

function Status({ e }: { e: TerminalEntry }) {
  if (e.outcome === null) {
    return (
      <span className="flex items-center gap-1 text-info">
        <Loader2 size={11} className="animate-spin" /> running
      </span>
    )
  }
  switch (e.outcome) {
    case 'exited':
      return e.exitCode === 0 ? (
        <span className="flex items-center gap-1 text-ok">
          <CircleCheck size={11} /> exit 0
        </span>
      ) : (
        <span className="flex items-center gap-1 text-err">
          <CircleX size={11} /> exit {e.exitCode}
        </span>
      )
    case 'timeout':
      return (
        <span className="flex items-center gap-1 text-warn">
          <Clock size={11} /> timed out
        </span>
      )
    case 'cancelled':
      return (
        <span className="flex items-center gap-1 text-warn">
          <Square size={10} /> stopped
        </span>
      )
    case 'denied':
      return (
        <span className="flex items-center gap-1 text-warn">
          <Ban size={11} /> not approved
        </span>
      )
    case 'blocked':
      return (
        <span className="flex items-center gap-1 text-err">
          <ShieldOff size={11} /> blocked
        </span>
      )
    default:
      return (
        <span className="flex items-center gap-1 text-err">
          <CircleX size={11} /> error
        </span>
      )
  }
}

function Entry({ e }: { e: TerminalEntry }) {
  return (
    <div className="border-b border-line/50 px-3 py-1.5" data-terminal-entry={e.id}>
      <div className="flex items-center gap-2">
        <span className="text-accent">$</span>
        <span className="min-w-0 flex-1 break-all text-fg" data-selectable>
          {e.command}
        </span>
        <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-faint" title={e.origin === 'agent' ? `Started by ${e.agentName ?? 'an agent'}` : 'Started by you'}>
          {e.origin === 'agent' ? <Bot size={11} /> : <User size={11} />}
          {e.origin === 'agent' ? (e.agentName ?? 'agent') : 'you'}
        </span>
        {e.cwd && e.cwd !== '.' && <span className="shrink-0 text-[10.5px] text-faint">in {e.cwd}</span>}
        <span className="shrink-0 text-[10.5px]">
          <Status e={e} />
        </span>
        {e.durationMs !== null && <span className="shrink-0 text-[10.5px] text-faint">{fmtDuration(e.durationMs)}</span>}
        {e.outcome === null && (
          <Button size="sm" variant="danger" className="h-5 px-1.5 text-[10.5px]" onClick={() => void window.api.invoke('term:kill', e.id)}>
            Stop
          </Button>
        )}
      </div>
      {e.note && <div className="mt-0.5 pl-4 text-[11px] text-warn/90">{e.note}</div>}
      {e.chunks.length > 0 && (
        <pre className="mt-1 max-h-72 overflow-auto pl-4 leading-snug break-words whitespace-pre-wrap" data-selectable data-terminal-output>
          {e.chunks.map((c, i) => (
            <span key={i} className={c.stream === 'stderr' ? 'text-err/90' : 'text-fg/90'}>
              {c.text}
            </span>
          ))}
          {e.clipped && <span className="text-warn">{'\n'}[output cut: too long for this panel]</span>}
        </pre>
      )}
      {e.message && e.outcome !== null && e.outcome !== 'exited' && <div className="pl-4 text-[11px] text-muted">{e.message}</div>}
    </div>
  )
}

/**
 * A command runner, not an interactive shell: each line you enter runs once in the project folder with its output
 * streamed here. Commands agents run (after approval, where the policy requires it) show up in the same list.
 */
export function Terminal() {
  const project = useWorkspaceProject()
  const projects = useStudio((s) => s.projects)
  const setWorkspaceProject = useStudio((s) => s.setWorkspaceProject)
  const terminal = useStudio((s) => s.terminal)
  const clearTerminal = useStudio((s) => s.clearTerminal)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<CommandLogEntry[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const entries = useMemo(() => terminal.filter((t) => t.projectId === project?.id), [terminal, project?.id])
  const last = entries[entries.length - 1]
  const finished = entries.filter((e) => e.outcome !== null).length

  useEffect(() => {
    setHistory([])
    setCursor(null)
    if (project) void window.api.invoke('term:history', project.id).then(setHistory, () => undefined)
  }, [project?.id, finished])

  // Keep the newest output in view unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [entries.length, last?.chunks.length, last?.outcome])

  const recall = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const h of history) {
      if (h.origin === 'user' && !seen.has(h.command)) {
        seen.add(h.command)
        out.push(h.command)
      }
    }
    return out // newest first
  }, [history])

  if (!project) return <EmptyState title="No project">Create a project to run commands in its folder.</EmptyState>

  const run = async (): Promise<void> => {
    const command = input.trim()
    if (!command) return
    setError(null)
    setInput('')
    setCursor(null)
    stick.current = true
    try {
      await window.api.invoke('term:run', { projectId: project.id, command })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setInput(command)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-terminal>
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-line/60 px-3 font-sans text-[11px] text-faint">
        <select value={project.id} onChange={(e) => setWorkspaceProject(e.target.value)} aria-label="Terminal project" className="rounded border border-line bg-bg px-1.5 py-0.5 text-[11px] text-fg focus:outline-none">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="min-w-0 truncate font-mono" title={project.rootPath}>
          {project.rootPath}
        </span>
        <span className="flex-1" />
        <span title="Each command runs once in a fresh shell with its input closed. Programs that wait for typed input, and full-screen programs, will not work here.">Command runner, not an interactive shell</span>
        <button onClick={() => clearTerminal(project.id)} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg" title="Clear finished commands from this view">
          <Trash2 size={11} /> Clear
        </button>
      </div>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {entries.length === 0 ? (
          <div className="px-4 py-5 font-sans text-xs leading-relaxed text-faint">
            Run a command below, for example <span className="font-mono text-muted">npm test</span>. Commands that agents run appear here too. Dangerous commands are blocked, and agents must get your approval for anything not on the safe list.
          </div>
        ) : (
          entries.map((e) => <Entry key={e.id} e={e} />)
        )}
      </div>

      <form
        className="flex shrink-0 items-center gap-2 border-t border-line bg-bg px-3 py-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <span className="text-accent">$</span>
        <input
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setCursor(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && recall.length > 0) {
              e.preventDefault()
              const next = Math.min((cursor ?? -1) + 1, recall.length - 1)
              setCursor(next)
              setInput(recall[next])
            } else if (e.key === 'ArrowDown' && cursor !== null) {
              e.preventDefault()
              const next = cursor - 1
              setCursor(next < 0 ? null : next)
              setInput(next < 0 ? '' : recall[next])
            }
          }}
          placeholder={`Run a command in ${project.name}…`}
          aria-label="Command"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-fg placeholder:text-faint focus:outline-none"
          data-terminal-input
        />
        {error && (
          <span className={cx('max-w-[50%] truncate font-sans text-[11px] text-err')} title={error}>
            {error}
          </span>
        )}
        <Button size="sm" variant="primary" type="submit" disabled={!input.trim()}>
          Run
        </Button>
      </form>
    </div>
  )
}

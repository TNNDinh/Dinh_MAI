import { CheckCircle2, CircleSlash, Hammer, Loader2, Play, Square, TestTube2, XCircle } from 'lucide-react'
import { useWorkspaceProject } from '../lib/use-workspace-project'
import { useAutomation } from '../lib/use-automation'
import { useEditors } from '../lib/editor-store'
import { fmtDuration } from '../lib/format'
import { useStudio } from '../store'
import { Badge, Button, EmptyState, cx } from './ui'
import type { AutomationKind, AutomationRun, ProblemItem } from '../../../shared/ipc'

const KINDS: AutomationKind[] = ['build', 'test', 'lint', 'typecheck']
const KIND_LABEL: Record<AutomationKind, string> = { build: 'Build', test: 'Test', lint: 'Lint', typecheck: 'Typecheck' }

const STATUS_TONE = { running: 'info', passed: 'ok', failed: 'err', cancelled: 'warn', error: 'err' } as const

/** A path inside the project can be opened in the editor; anything else (absolute, outside) is shown as printed. */
const openable = (file: string | null): file is string => !!file && !/^([A-Za-z]:|[\\/]|\.\.)/.test(file)

/** Run buttons for the commands this project defines. Shown in the header of the output panel. */
export function AutomationToolbar() {
  const project = useWorkspaceProject()
  const { tasks, runs, run, cancel } = useAutomation(project?.id ?? null)
  if (!project) return null
  if (tasks.length === 0) return <span className="text-[11px] text-faint">No build, test or lint commands found in this project</span>
  return (
    <div className="flex items-center gap-1" data-automation-toolbar>
      {KINDS.filter((k) => tasks.some((t) => t.kind === k)).map((k) => {
        const task = tasks.find((t) => t.kind === k)!
        const running = runs.find((r) => r.kind === k && r.status === 'running')
        return running ? (
          <Button key={k} size="sm" variant="danger" className="h-6 px-2 text-[11px]" onClick={() => void cancel(running.id)} title={`Stop: ${task.command}`} data-run-kind={k}>
            <Square size={10} /> Stop {KIND_LABEL[k]}
          </Button>
        ) : (
          <Button key={k} size="sm" className="h-6 px-2 text-[11px]" onClick={() => void run(k)} title={`${task.command}\n(${task.source})`} data-run-kind={k}>
            <Play size={10} /> {KIND_LABEL[k]}
          </Button>
        )
      })}
    </div>
  )
}

function StatusLine({ run }: { run: AutomationRun }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-1.5 font-sans text-[11px]" data-run-status={run.status}>
      <Badge tone={STATUS_TONE[run.status]}>{run.status === 'running' ? 'running…' : run.status}</Badge>
      <span className="font-medium text-fg">{run.label}</span>
      <code className="text-faint" data-selectable>
        {run.command}
      </code>
      {run.exitCode !== null && <span className="text-faint">exit {run.exitCode}</span>}
      {run.durationMs !== null && <span className="text-faint">{fmtDuration(run.durationMs)}</span>}
      {run.message && <span className="text-warn">{run.message}</span>}
    </div>
  )
}

function useLatestRuns(projectId: string | null) {
  const a = useAutomation(projectId)
  const latestAny = a.runs[0] ?? null
  return { ...a, latestAny }
}

const NoProject = () => <EmptyState title="No project selected">Create a project and open it in the Workspace to build and test it.</EmptyState>

const NothingYet = ({ what }: { what: string }) => (
  <EmptyState icon={<Hammer size={22} />} title={`No ${what} yet`}>
    Use the buttons above to run one of this project&apos;s own commands. Output shown here is exactly what the command printed.
  </EmptyState>
)

export function BuildOutputView() {
  const project = useWorkspaceProject()
  const { latestAny } = useLatestRuns(project?.id ?? null)
  if (!project) return <NoProject />
  if (!latestAny) return <NothingYet what="build output" />
  return (
    <div className="flex min-h-full flex-col" data-build-output>
      <StatusLine run={latestAny} />
      <pre className="flex-1 px-3 py-2 break-words whitespace-pre-wrap text-fg" data-selectable>
        {latestAny.output || (latestAny.status === 'running' ? 'Waiting for output…' : '(the command printed nothing)')}
        {latestAny.truncated && '\n… (the middle of a very long output was cut)'}
      </pre>
    </div>
  )
}

export function ProblemsView() {
  const project = useWorkspaceProject()
  const setPage = useStudio((s) => s.setPage)
  const { latest, runs } = useLatestRuns(project?.id ?? null)
  if (!project) return <NoProject />
  // The newest run of each kind: an older build's errors are not shown once a newer build ran.
  const current = KINDS.map((k) => latest(k)).filter((r): r is AutomationRun => r !== null)
  if (runs.length === 0) return <NothingYet what="problems" />
  const items: Array<ProblemItem & { runId: string }> = current.flatMap((r) => r.problems.map((p) => ({ ...p, runId: r.id })))
  const open = (p: ProblemItem): void => {
    if (!openable(p.file)) return
    setPage('workspace')
    void useEditors.getState().openFile(project.id, p.file, p.line ?? undefined)
  }
  const failedWithout = current.filter((r) => r.status === 'failed' && r.problems.length === 0)
  return (
    <div data-problems>
      {items.length === 0 ? (
        <EmptyState icon={<CheckCircle2 size={22} />} title="No problems found in the latest output">
          Problems are read from what the build, lint and typecheck commands printed (tsc, ESLint, gcc/clang, rustc, Go, dotnet, Python).
        </EmptyState>
      ) : (
        <ul className="py-1">
          {items.map((p, i) => (
            <li key={`${p.runId}-${i}`}>
              <button
                onClick={() => open(p)}
                disabled={!openable(p.file)}
                className="flex w-full items-baseline gap-2 px-3 py-0.5 text-left hover:bg-hover/60 disabled:cursor-default"
                data-problem={p.severity}
              >
                {p.severity === 'error' ? <XCircle size={12} className="shrink-0 translate-y-0.5 text-err" /> : <CircleSlash size={12} className="shrink-0 translate-y-0.5 text-warn" />}
                <span className="min-w-0 break-words text-fg">{p.message}</span>
                {p.code && <span className="shrink-0 text-faint">{p.code}</span>}
                <span className="ml-auto shrink-0 text-faint">
                  {p.file ?? ''}
                  {p.line !== null ? `:${p.line}${p.column !== null ? `:${p.column}` : ''}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {failedWithout.length > 0 && (
        <p className="px-3 py-2 font-sans text-[11px] text-warn">
          {failedWithout.map((r) => r.label).join(', ')} failed, but its output has no error this panel understands. Open the Build Output tab to read it.
        </p>
      )}
    </div>
  )
}

export function TestResultsView() {
  const project = useWorkspaceProject()
  const { latest } = useLatestRuns(project?.id ?? null)
  if (!project) return <NoProject />
  const run = latest('test')
  if (!run) return <EmptyState icon={<TestTube2 size={22} />} title="No test run yet">Use the Test button above to run this project&apos;s tests.</EmptyState>
  const t = run.tests
  return (
    <div data-tests>
      <StatusLine run={run} />
      {t ? (
        <div className="px-3 py-2 font-sans text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-ok" data-tests-passed>
              {t.passed} passed
            </span>
            <span className={cx(t.failed > 0 ? 'text-err' : 'text-faint')} data-tests-failed>
              {t.failed} failed
            </span>
            {t.skipped > 0 && <span className="text-faint">{t.skipped} skipped</span>}
            <span className="text-faint">
              ({t.unit} · {t.runner})
            </span>
          </div>
          {t.failures.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {t.failures.map((f) => (
                <li key={f} className="flex items-baseline gap-1.5 text-err">
                  <XCircle size={11} className="shrink-0 translate-y-0.5" />
                  <span className="break-words" data-selectable>
                    {f}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        run.status !== 'running' && <p className="px-3 py-2 font-sans text-xs text-muted">No test summary was recognised in the output (supported: vitest, jest, node:test, pytest, cargo, dotnet, go). The raw output is below.</p>
      )}
      <pre className="px-3 py-2 break-words whitespace-pre-wrap text-muted" data-selectable>
        {run.status === 'running' && <Loader2 size={11} className="mr-1 inline animate-spin" />}
        {run.output}
      </pre>
    </div>
  )
}

/** How many problems the newest runs report, for the tab label. */
export function useProblemCount(): number {
  const project = useWorkspaceProject()
  const all = useStudio((s) => s.automation)
  return KINDS.reduce((n, k) => n + (all.find((r) => r.projectId === project?.id && r.kind === k)?.problems.length ?? 0), 0)
}

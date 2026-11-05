import { ShieldQuestion } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useStudio } from '../store'
import { Button, cx } from './ui'

/**
 * Shown whenever an agent wants to run a command the policy does not allow on its own. Nothing runs until the user
 * decides; "Deny" is the default focus so a stray Enter cannot approve anything.
 */
export function ApprovalDialog() {
  const approvals = useStudio((s) => s.approvals)
  const minimized = useStudio((s) => s.approvalsMinimized)
  const setMinimized = useStudio((s) => s.setApprovalsMinimized)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const current = approvals[0]

  useEffect(() => {
    if (!current) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [current])

  if (!current || minimized) return null

  const respond = async (allow: boolean): Promise<void> => {
    setBusy(true)
    try {
      await window.api.invoke('approvals:respond', { id: current.id, allow })
    } finally {
      setBusy(false)
    }
  }
  const left = Math.max(0, Math.ceil((current.expiresAt - now) / 1000))
  // A workflow's "Human approval" step is a question for the user, not a command.
  const isStep = current.kind === 'workflow'
  const leftText = left >= 3600 ? `${Math.floor(left / 3600)} h ${Math.floor((left % 3600) / 60)} min` : left >= 120 ? `${Math.floor(left / 60)} min` : `${left}s`

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/60 pt-[8vh] backdrop-blur-[2px]" data-approval-overlay>
      <div role="alertdialog" aria-modal="true" aria-labelledby="approval-title" className="page-enter flex max-h-[84vh] w-[640px] max-w-[94vw] flex-col rounded-xl border border-warn/40 bg-panel shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-line px-5 py-3">
          <ShieldQuestion size={18} className="text-warn" />
          <h2 id="approval-title" className="text-sm font-semibold">
            {isStep ? 'A workflow step needs your decision' : `${current.agentName ?? 'An agent'} wants to run a command`}
          </h2>
          {approvals.length > 1 && <span className="ml-auto rounded bg-elev px-1.5 text-[11px] text-muted">{approvals.length} waiting</span>}
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          <dl className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted">Project</dt>
            <dd data-selectable>{current.projectName}</dd>
            {current.taskTitle && (
              <>
                <dt className="text-muted">{isStep ? 'Step' : 'Task'}</dt>
                <dd data-selectable>{current.taskTitle}</dd>
              </>
            )}
            {!isStep && (
              <>
                <dt className="text-muted">Folder</dt>
                <dd className="font-mono" data-selectable>
                  {current.cwd}
                </dd>
                <dt className="text-muted">Why you are asked</dt>
                <dd data-selectable>{current.reason}</dd>
              </>
            )}
          </dl>
          {isStep ? (
            <p className="rounded-md border border-line bg-bg p-3 text-[13px] whitespace-pre-wrap text-fg" data-selectable data-approval-command>
              {current.command}
            </p>
          ) : (
            <pre className="max-h-48 overflow-auto rounded-md border border-line bg-bg p-3 font-mono text-[12.5px] break-all whitespace-pre-wrap text-fg" data-selectable data-approval-command>
              {current.command}
            </pre>
          )}
          {isStep && current.detail && (
            <details open>
              <summary className="cursor-pointer text-xs text-muted">What the earlier steps produced</summary>
              <pre className="mt-1.5 max-h-56 overflow-auto rounded-md border border-line bg-bg p-3 text-[12px] break-words whitespace-pre-wrap text-muted" data-selectable data-approval-detail>
                {current.detail}
              </pre>
            </details>
          )}
          <p className="text-[11px] leading-relaxed text-faint">
            {isStep
              ? 'Approving continues the workflow down the “approved” branch; rejecting takes the “rejected” branch. Nothing else is decided for you.'
              : 'If you allow it, it runs once with your Windows user’s permissions. This app limits what agents can ask for, but it is not an operating-system sandbox. Read the command before allowing it.'}
          </p>
        </div>
        <div className="flex items-center gap-2 border-t border-line px-5 py-3">
          <span className={cx('text-[11px]', left <= 30 ? 'text-warn' : 'text-faint')}>{isStep ? 'Rejected' : 'Denied'} automatically in {leftText}</span>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setMinimized(true)}>
            Decide later
          </Button>
          <Button autoFocus disabled={busy} onClick={() => void respond(false)} data-approval="deny">
            {isStep ? 'Reject' : 'Deny'}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void respond(true)} data-approval="allow">
            {isStep ? 'Approve' : 'Allow once'}
          </Button>
        </div>
      </div>
    </div>
  )
}

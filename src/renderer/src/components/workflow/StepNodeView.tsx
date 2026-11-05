import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Bot, ClipboardCheck, FlaskConical, GitBranch, Image as ImageIcon, MessagesSquare, Repeat, TriangleAlert, UserCheck, type LucideIcon } from 'lucide-react'
import { memo } from 'react'
import { NODE_SPECS, type WorkflowNodeType } from '../../../../shared/workflow'
import { cx } from '../ui'
import { STATUS_FRAME, STATUS_LABEL, STATUS_TEXT, type StepNode } from './model'

export const NODE_ICON: Record<WorkflowNodeType, LucideIcon> = {
  agent: Bot,
  image: ImageIcon,
  review: ClipboardCheck,
  test: FlaskConical,
  condition: GitBranch,
  loop: Repeat,
  approval: UserCheck,
  debate: MessagesSquare
}

/** The tint of each node type's icon, so a graph can be read at a glance. */
export const NODE_TINT: Record<WorkflowNodeType, string> = {
  agent: 'text-[#b4aaff]',
  image: 'text-[#f0abfc]',
  review: 'text-info',
  test: 'text-ok',
  condition: 'text-warn',
  loop: 'text-[#fb923c]',
  approval: 'text-[#f9a8d4]',
  debate: 'text-[#5eead4]'
}

const HANDLE = '!h-3 !w-3 !border-2 !border-panel !bg-muted hover:!bg-accent'

function StepNodeViewBase({ data, selected }: NodeProps<StepNode>) {
  const { wf, run, problem, summary } = data
  const spec = NODE_SPECS[wf.type]
  const Icon = NODE_ICON[wf.type]
  const outputs = spec.outputs
  const status = run?.status ?? null
  return (
    <div
      data-wf-node={wf.id}
      data-wf-type={wf.type}
      data-wf-status={status ?? undefined}
      className={cx(
        'w-[250px] rounded-lg border bg-panel text-left shadow-lg transition-colors',
        status ? STATUS_FRAME[status] : selected ? 'border-accent shadow-[0_0_0_1px_var(--color-accent)]' : 'border-line hover:border-faint',
        status && selected && 'outline outline-2 outline-offset-2 outline-accent/60'
      )}
    >
      <Handle id="in" type="target" position={Position.Left} className={HANDLE} />
      {wf.type === 'loop' && <Handle id="again" type="target" position={Position.Bottom} className={HANDLE} title="again: connect the end of the loop body here" />}
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Icon size={15} className={NODE_TINT[wf.type]} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{wf.label}</span>
        {problem && <TriangleAlert size={13} className={problem === 'error' ? 'text-err' : 'text-warn'} aria-label={problem === 'error' ? 'This step needs attention' : 'Worth a look'} />}
      </div>
      <div className="px-3 py-2">
        <div className="text-[10.5px] tracking-wide text-faint uppercase">{spec.label}</div>
        <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug break-words text-muted">{summary}</p>
        {run && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px]">
            <span className={cx('font-medium', STATUS_TEXT[run.status])}>{STATUS_LABEL[run.status]}</span>
            {run.runs > 1 && <span className="text-faint">· ran {run.runs}×</span>}
            {run.handle && <span className="text-faint">→ {spec.outputs.find((o) => o.id === run.handle)?.label ?? run.handle}</span>}
          </div>
        )}
        {run?.note && <p className="mt-0.5 text-[11px] break-words text-faint">{run.note}</p>}
      </div>
      {outputs.length === 1 ? (
        <Handle id={outputs[0].id} type="source" position={Position.Right} className={HANDLE} />
      ) : (
        <div className="border-t border-line py-1">
          {outputs.map((o) => (
            <div key={o.id} className="relative flex h-6 items-center justify-end pr-4 text-[11px] text-muted">
              {o.label}
              <Handle id={o.id} type="source" position={Position.Right} className={HANDLE} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const StepNodeView = memo(StepNodeViewBase)

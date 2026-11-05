import { NODE_SPECS, NODE_TYPES, type WorkflowNodeType } from '../../../../shared/workflow'
import { NODE_ICON, NODE_TINT } from './StepNodeView'

export const DRAG_TYPE = 'application/x-studio-workflow-node'

/** The kinds of step you can add: drag one onto the canvas, or click it to drop it in the middle. */
export function Palette({ onAdd, disabled }: { onAdd: (type: WorkflowNodeType) => void; disabled: boolean }) {
  return (
    <div className="flex w-[148px] shrink-0 flex-col gap-1.5 border-r border-line bg-panel p-2.5" data-wf-palette>
      <div className="px-1 pb-1 text-[10.5px] font-semibold tracking-wide text-faint uppercase">Add a step</div>
      {NODE_TYPES.map((t) => {
        const Icon = NODE_ICON[t]
        return (
          <button
            key={t}
            type="button"
            disabled={disabled}
            draggable={!disabled}
            title={`${NODE_SPECS[t].summary}\nDrag onto the canvas, or click to add.`}
            data-wf-palette-item={t}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, t)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onClick={() => onAdd(t)}
            className="flex cursor-grab items-center gap-2 rounded-md border border-line bg-elev px-2 py-1.5 text-left text-xs hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon size={14} className={NODE_TINT[t]} />
            {NODE_SPECS[t].label}
          </button>
        )
      })}
    </div>
  )
}

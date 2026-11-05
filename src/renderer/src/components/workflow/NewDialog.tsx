import { useState } from 'react'
import { WORKFLOW_TEMPLATES, WORKFLOW_LIMITS, type WorkflowTemplate } from '../../../../shared/workflow'
import type { Project } from '../../../../shared/ipc'
import { Button, Field, Input, Modal, Select, cx } from '../ui'

export interface NewChoice {
  template: WorkflowTemplate
  name: string
  /** null = shared by every project. */
  projectId: string | null
}

/** Start from a template (or a blank step). Templates use roles, so they run with whichever agents the project's team has. */
export function NewDialog({ project, onClose, onCreate }: { project: Project; onClose: () => void; onCreate: (c: NewChoice) => void }) {
  const [key, setKey] = useState(WORKFLOW_TEMPLATES[0].key)
  const template = WORKFLOW_TEMPLATES.find((t) => t.key === key) ?? WORKFLOW_TEMPLATES[0]
  const [name, setName] = useState<string | null>(null)
  const [scope, setScope] = useState<'project' | 'shared'>('project')
  const finalName = (name ?? template.name).trim()
  return (
    <Modal
      title="New workflow"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!finalName} onClick={() => onCreate({ template, name: finalName, projectId: scope === 'shared' ? null : project.id })} data-wf-action="create-workflow">
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5" role="radiogroup" aria-label="Template">
          {WORKFLOW_TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={t.key === key}
              data-wf-template={t.key}
              onClick={() => setKey(t.key)}
              className={cx('block w-full rounded-md border px-3 py-2 text-left hover:bg-hover', t.key === key ? 'border-accent bg-accent-soft' : 'border-line bg-elev')}
            >
              <div className="text-[13px] font-medium">{t.name}</div>
              <div className="mt-0.5 text-[11.5px] text-muted">{t.description}</div>
              <div className="mt-0.5 text-[11px] text-faint">{t.graph.nodes.length} step{t.graph.nodes.length === 1 ? '' : 's'}</div>
            </button>
          ))}
        </div>
        <Field label="Name">
          <Input value={name ?? template.name} maxLength={WORKFLOW_LIMITS.name} onChange={(e) => setName(e.target.value)} data-wf-field="new-name" />
        </Field>
        <Field label="Available in" hint="A shared workflow can run in any project, with that project’s team.">
          <Select value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'shared')}>
            <option value="project">Only “{project.name}”</option>
            <option value="shared">Every project</option>
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

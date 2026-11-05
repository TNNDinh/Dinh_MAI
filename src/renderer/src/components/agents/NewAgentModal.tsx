import { useState } from 'react'
import type { Agent } from '../../../../shared/ipc'
import { useStudio } from '../../store'
import { Button, Field, Input, Modal, Select, cx } from '../ui'
import { errMsg } from '../connections/StatusBadge'

const CUSTOM = '__custom__'

export function NewAgentModal({ defaultScope, onClose, onCreated }: { defaultScope: string; onClose: () => void; onCreated: (a: Agent) => void }) {
  const templates = useStudio((s) => s.agentTemplates)
  const projects = useStudio((s) => s.projects)
  const refresh = useStudio((s) => s.refresh)
  const [pick, setPick] = useState<string>(templates[0]?.key ?? CUSTOM)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [scope, setScope] = useState(defaultScope) // '' = library, otherwise a project id
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tpl = templates.find((t) => t.key === pick)
  const custom = pick === CUSTOM

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const agent = await window.api.invoke('agents:create', {
        templateKey: custom ? undefined : pick,
        projectId: scope || null,
        name: name.trim() || undefined,
        systemPrompt: custom ? prompt : undefined
      })
      await refresh()
      onCreated(agent)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New agent"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} disabled={busy || (custom && (!name.trim() || !prompt.trim()))} data-action="create-agent">
            {busy ? 'Creating…' : 'Create agent'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <span className="mb-1 block text-xs font-medium text-muted">Start from</span>
          <div className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto pr-1" role="listbox" aria-label="Template">
            {[...templates.map((t) => [t.key, t.label] as const), [CUSTOM, 'Custom (blank)'] as const].map(([key, label]) => (
              <button
                key={key}
                role="option"
                aria-selected={pick === key}
                data-template={key}
                onClick={() => setPick(key)}
                className={cx(
                  'rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors',
                  pick === key ? 'border-accent/60 bg-accent-soft' : 'border-line bg-bg hover:bg-hover'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 min-h-8 text-[11px] text-faint">
            {custom ? 'A blank agent with least-privilege permissions. Write its system prompt below.' : tpl?.description}
          </p>
        </div>

        <Field label="Name" hint={custom ? undefined : `Leave empty to use “${tpl?.label}”.`}>
          <Input value={name} maxLength={80} placeholder={custom ? 'e.g. Docs Writer' : tpl?.label} onChange={(e) => setName(e.target.value)} aria-label="Agent name" autoFocus />
        </Field>

        {custom && (
          <Field label="System prompt">
            <textarea
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              aria-label="System prompt"
              className="w-full resize-none rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-fg focus:border-accent focus:outline-none"
            />
          </Field>
        )}

        <Field label="Belongs to" hint="Library agents are reusable. Project agents form that project's team.">
          <Select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope">
            <option value="">Library (all projects)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                Project: {p.name}
              </option>
            ))}
          </Select>
        </Field>

        {error && (
          <p role="alert" className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs break-words text-err" data-selectable>
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

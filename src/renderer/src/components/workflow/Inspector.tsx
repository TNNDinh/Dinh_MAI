import { Plus, Trash2, X } from 'lucide-react'
import { ASSET_KINDS, type Agent, type AgentTemplateInfo } from '../../../../shared/ipc'
import { NODE_SPECS, WORKFLOW_LIMITS, debateCalls, type AgentRef, type NodeConfigs, type WorkflowIssue, type WorkflowNode } from '../../../../shared/workflow'
import { Badge, Button, Field, Input, Select, Textarea, cx } from '../ui'
import { NODE_ICON, NODE_TINT } from './StepNodeView'

/** One value for the <select>: "a:<agent id>" = that agent, "r:<role>" = whoever on the team has the role. */
const encode = (r: AgentRef): string => (r.agentId ? `a:${r.agentId}` : r.role ? `r:${r.role}` : '')
const decode = (v: string): AgentRef => (v.startsWith('a:') ? { agentId: v.slice(2), role: null } : v.startsWith('r:') ? { agentId: null, role: v.slice(2) } : { agentId: null, role: null })

function AgentPicker({ label, value, onChange, team, templates, hint }: { label: string; value: AgentRef; onChange: (r: AgentRef) => void; team: Agent[]; templates: AgentTemplateInfo[]; hint?: string }) {
  const chat = team.filter((a) => a.kind === 'chat')
  const roles = templates.filter((t) => t.kind === 'chat')
  const stale = value.agentId && !chat.some((a) => a.id === value.agentId)
  return (
    <Field label={label} hint={hint}>
      <Select value={encode(value)} onChange={(e) => onChange(decode(e.target.value))} data-wf-field={label}>
        <option value="">Choose…</option>
        <optgroup label="By role (whoever on the team has it)">
          {roles.map((t) => (
            <option key={t.key} value={`r:${t.key}`}>
              {t.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="A specific agent">
          {chat.map((a) => (
            <option key={a.id} value={`a:${a.id}`}>
              {a.name} ({a.roleLabel})
            </option>
          ))}
          {stale && <option value={`a:${value.agentId}`}>(agent not on this team)</option>}
        </optgroup>
      </Select>
    </Field>
  )
}

const intOr = (v: string, fallback: number): number => (v.trim() === '' || !Number.isFinite(Number(v)) ? fallback : Math.round(Number(v)))

export interface InspectorProps {
  node: WorkflowNode
  team: Agent[]
  templates: AgentTemplateInfo[]
  issues: WorkflowIssue[]
  onChange: (n: WorkflowNode) => void
  onDelete: () => void
  onClose: () => void
  readOnly: boolean
}

export function Inspector({ node, team, templates, issues, onChange, onDelete, onClose, readOnly }: InspectorProps) {
  const Icon = NODE_ICON[node.type]
  const spec = NODE_SPECS[node.type]
  // Edit one part of the config; the node's type never changes, so the cast only narrows what TypeScript cannot follow.
  const set = <T extends WorkflowNode['type']>(patch: Partial<NodeConfigs[T]>): void => onChange({ ...node, config: { ...node.config, ...patch } } as WorkflowNode)
  return (
    <aside className="flex w-[330px] shrink-0 flex-col border-l border-line bg-panel" data-wf-inspector={node.id}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Icon size={15} className={NODE_TINT[node.type]} />
        <h3 className="flex-1 text-[13px] font-semibold">{spec.label} step</h3>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-hover hover:text-fg" aria-label="Close the inspector">
          <X size={14} />
        </button>
      </div>
      <fieldset disabled={readOnly} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
        <p className="text-[11.5px] leading-relaxed text-muted">{spec.summary}</p>
        {issues.length > 0 && (
          <ul className="space-y-1" data-wf-node-issues>
            {issues.map((i, k) => (
              <li key={k} className={cx('rounded border px-2 py-1 text-[11.5px] leading-snug', i.severity === 'error' ? 'border-err/30 bg-err/10 text-err' : 'border-warn/30 bg-warn/10 text-warn')}>
                {i.message}
              </li>
            ))}
          </ul>
        )}
        <Field label="Name">
          <Input value={node.label} maxLength={WORKFLOW_LIMITS.label} onChange={(e) => onChange({ ...node, label: e.target.value })} data-wf-field="label" />
        </Field>
        <Config node={node} set={set} team={team} templates={templates} />
      </fieldset>
      <div className="border-t border-line p-3">
        <Button variant="danger" size="sm" onClick={onDelete} disabled={readOnly} data-wf-action="delete-node">
          <Trash2 size={13} /> Delete this step
        </Button>
      </div>
    </aside>
  )
}

type SetFn = <T extends WorkflowNode['type']>(patch: Partial<NodeConfigs[T]>) => void

function Config({ node, set, team, templates }: { node: WorkflowNode; set: SetFn; team: Agent[]; templates: AgentTemplateInfo[] }) {
  const hintVars = 'Use {{goal}} for the run’s goal and {{input}} for what the previous steps produced.'
  switch (node.type) {
    case 'agent':
      return (
        <>
          <AgentPicker label="Who does it" value={node.config.agent} onChange={(agent) => set<'agent'>({ agent })} team={team} templates={templates} />
          <Field label="Instruction" hint={`${hintVars} The previous steps’ results are always attached.`}>
            <Textarea rows={7} value={node.config.instruction} maxLength={WORKFLOW_LIMITS.text} onChange={(e) => set<'agent'>({ instruction: e.target.value })} data-wf-field="instruction" />
          </Field>
        </>
      )
    case 'image': {
      const imageAgents = team.filter((a) => a.kind === 'image')
      return (
        <>
          <Field label="Image agent" hint="Needs a model and the “Generate images” permission.">
            <Select value={node.config.agentId ?? ''} onChange={(e) => set<'image'>({ agentId: e.target.value || null })}>
              <option value="">Any ready image agent</option>
              {imageAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Prompt" hint="{{input}} is the text the previous step wrote, e.g. an art brief.">
            <Textarea rows={4} value={node.config.prompt} maxLength={4000} onChange={(e) => set<'image'>({ prompt: e.target.value })} data-wf-field="prompt" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Kind">
              <Select value={node.config.kind} onChange={(e) => set<'image'>({ kind: e.target.value as NodeConfigs['image']['kind'] })}>
                {ASSET_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Size">
              <Input value={node.config.size} placeholder="1024x1024" onChange={(e) => set<'image'>({ size: e.target.value })} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={node.config.transparent} onChange={(e) => set<'image'>({ transparent: e.target.checked })} /> Transparent background
          </label>
        </>
      )
    }
    case 'review':
      return (
        <>
          <AgentPicker label="Reviewer" value={node.config.agent} onChange={(agent) => set<'review'>({ agent })} team={team} templates={templates} />
          <Field label="What to check" hint="Connect “changes” back to the work (usually through a Loop’s “again” input) so the feedback is acted on.">
            <Textarea rows={5} value={node.config.criteria} maxLength={WORKFLOW_LIMITS.text} onChange={(e) => set<'review'>({ criteria: e.target.value })} data-wf-field="criteria" />
          </Field>
        </>
      )
    case 'test':
      return (
        <>
          <Field label="Command" hint="Runs in the project folder under the command policy. Exit code 0 = pass; anything the policy does not allow asks you first.">
            <Input className="font-mono" value={node.config.command} maxLength={WORKFLOW_LIMITS.command} onChange={(e) => set<'test'>({ command: e.target.value })} data-wf-field="command" />
          </Field>
          <Field label="Folder (inside the project, optional)">
            <Input className="font-mono" value={node.config.cwd} placeholder="project root" onChange={(e) => set<'test'>({ cwd: e.target.value })} />
          </Field>
          <Field label="Time limit (seconds)">
            <Input type="number" min={1} max={900} value={node.config.timeoutSec} onChange={(e) => set<'test'>({ timeoutSec: intOr(e.target.value, 120) })} />
          </Field>
        </>
      )
    case 'condition':
      return (
        <>
          <Field label="How to decide">
            <Select value={node.config.mode} onChange={(e) => set<'condition'>({ mode: e.target.value as NodeConfigs['condition']['mode'] })} data-wf-field="mode">
              <option value="contains">The text contains a phrase</option>
              <option value="regex">The text matches a pattern</option>
              <option value="ai">An agent answers yes or no</option>
            </Select>
          </Field>
          <Field label={node.config.mode === 'ai' ? 'Question for the agent' : node.config.mode === 'regex' ? 'Pattern (regular expression, any case)' : 'Phrase (any case)'}>
            {node.config.mode === 'ai' ? (
              <Textarea rows={3} value={node.config.value} onChange={(e) => set<'condition'>({ value: e.target.value })} data-wf-field="value" />
            ) : (
              <Input className="font-mono" value={node.config.value} onChange={(e) => set<'condition'>({ value: e.target.value })} data-wf-field="value" />
            )}
          </Field>
          {node.config.mode === 'ai' && <AgentPicker label="Who answers" value={node.config.agent} onChange={(agent) => set<'condition'>({ agent })} team={team} templates={templates} />}
        </>
      )
    case 'loop':
      return (
        <>
          <Field label="Most rounds" hint={`1–${WORKFLOW_LIMITS.maxLoopIterations}. The loop always stops here, even if the work is not finished.`}>
            <Input type="number" min={1} max={WORKFLOW_LIMITS.maxLoopIterations} value={node.config.maxIterations} onChange={(e) => set<'loop'>({ maxIterations: intOr(e.target.value, 3) })} data-wf-field="maxIterations" />
          </Field>
          <Field label="Stop early when the body’s result contains (optional)">
            <Input value={node.config.until} maxLength={200} onChange={(e) => set<'loop'>({ until: e.target.value })} data-wf-field="until" />
          </Field>
          <p className="text-[11.5px] leading-relaxed text-faint">
            Connect “body” to the first step to repeat, and the last step’s sending-back output (a review’s “changes”, a test’s “fail”) to the loop’s “again” input at the bottom. “done” continues after the loop.
          </p>
        </>
      )
    case 'approval':
      return (
        <Field label="What you are asked" hint="Shown in a dialog together with what the earlier steps produced. It is rejected automatically if nobody answers.">
          <Textarea rows={4} value={node.config.message} maxLength={1000} onChange={(e) => set<'approval'>({ message: e.target.value })} data-wf-field="message" />
        </Field>
      )
    case 'debate': {
      const d = node.config
      const setPart = (i: number, r: AgentRef): void => set<'debate'>({ participants: d.participants.map((p, k) => (k === i ? r : p)) })
      return (
        <>
          <Field label="Question" hint="Every participant answers it; then each critiques the others.">
            <Textarea rows={4} value={d.question} maxLength={WORKFLOW_LIMITS.text} onChange={(e) => set<'debate'>({ question: e.target.value })} data-wf-field="question" />
          </Field>
          {d.participants.map((p, i) => (
            <div key={i} className="flex items-end gap-1.5">
              <div className="min-w-0 flex-1">
                <AgentPicker label={`Participant ${i + 1}`} value={p} onChange={(r) => setPart(i, r)} team={team} templates={templates} />
              </div>
              <Button size="sm" variant="ghost" aria-label={`Remove participant ${i + 1}`} onClick={() => set<'debate'>({ participants: d.participants.filter((_, k) => k !== i) })} disabled={d.participants.length <= 2}>
                <X size={13} />
              </Button>
            </div>
          ))}
          {d.participants.length < WORKFLOW_LIMITS.maxDebateParticipants && (
            <Button size="sm" variant="ghost" onClick={() => set<'debate'>({ participants: [...d.participants, { agentId: null, role: null }] })} data-wf-action="add-participant">
              <Plus size={13} /> Add a participant
            </Button>
          )}
          <AgentPicker label="Moderator (writes the decision)" value={d.moderator} onChange={(moderator) => set<'debate'>({ moderator })} team={team} templates={templates} />
          <Field label="Critique rounds" hint={`0–${WORKFLOW_LIMITS.maxDebateRounds}`}>
            <Input type="number" min={0} max={WORKFLOW_LIMITS.maxDebateRounds} value={d.rounds} onChange={(e) => set<'debate'>({ rounds: intOr(e.target.value, 1) })} />
          </Field>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={d.saveToMemory} onChange={(e) => set<'debate'>({ saveToMemory: e.target.checked })} /> Save the decision to project memory
          </label>
          <Badge tone="info" title="Each participant answers once and critiques once per round; the moderator answers once.">
            ≈ {debateCalls(d.participants.length, d.rounds)} model calls
          </Badge>
        </>
      )
    }
  }
}

import { AlertTriangle, Copy, Power, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Agent, AgentPermissions, CommandPolicy, ModelEntry } from '../../../../shared/ipc'
import { useStudio } from '../../store'
import { Badge, Button, Card, Field, Input, Select, Textarea, cx } from '../ui'
import { Playground } from '../connections/Playground'
import { errMsg } from '../connections/StatusBadge'

type Tab = 'config' | 'test'

const TOGGLES: Array<[Exclude<keyof AgentPermissions, 'runCommands'>, string, string]> = [
  ['readFiles', 'Read project files', 'See the code and documents in the shared workspace.'],
  ['writeFiles', 'Write project files', 'Create and edit files inside the project folder.'],
  ['generateImages', 'Generate images', 'Call an image-generation model for sprites, textures and mockups.'],
  ['internet', 'Use the internet', 'Fetch web pages and documentation.'],
  ['manageTasks', 'Manage the task board', 'Create, assign and close tasks.'],
  ['gitCommit', 'Commit to git', 'Create commits and checkpoints in the project repository.']
]

const COMMAND_POLICIES: Array<[CommandPolicy, string]> = [
  ['none', 'Cannot run commands'],
  ['ask', 'Ask me before every command'],
  ['allowlist', 'Auto-run safe commands, ask for the rest']
]

interface Draft {
  name: string
  connectionId: string
  model: string
  systemPrompt: string
  temperature: string
  maxTokens: string
  maxCost: string
  permissions: AgentPermissions
}

const toDraft = (a: Agent): Draft => ({
  name: a.name,
  connectionId: a.connectionId ?? '',
  model: a.model ?? '',
  systemPrompt: a.systemPrompt,
  temperature: a.temperature === null ? '' : String(a.temperature),
  maxTokens: a.maxTokens === null ? '' : String(a.maxTokens),
  maxCost: a.maxCostUsd === null ? '' : String(a.maxCostUsd),
  permissions: a.permissions
})

/** '' means "not set"; anything else must parse, otherwise the server's own message is shown. */
const num = (s: string): number | null => (s.trim() === '' ? null : Number(s))

function ConfigTab({ agent, onRemoved }: { agent: Agent; onRemoved: () => void }) {
  const refresh = useStudio((s) => s.refresh)
  const allConnections = useStudio((s) => s.connections)
  const catalog = useStudio((s) => s.catalog)
  const isImage = agent.kind === 'image'
  const wantKind = isImage ? 'image' : 'chat'
  const connections = useMemo(
    () => (isImage ? allConnections.filter((c) => catalog.find((p) => p.kind === c.kind)?.imageGeneration) : allConnections),
    [allConnections, catalog, isImage]
  )
  const [draft, setDraft] = useState<Draft>(() => toDraft(agent))
  const [models, setModels] = useState<ModelEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const initial = useMemo(() => JSON.stringify(toDraft(agent)), [agent])
  const dirty = JSON.stringify(draft) !== initial

  useEffect(() => {
    if (!draft.connectionId) {
      setModels([])
      return
    }
    let live = true
    void window.api.invoke('models:list', draft.connectionId).then(
      (list) => live && setModels(list.filter((m) => m.kind === wantKind)),
      () => live && setModels([])
    )
    return () => {
      live = false
    }
  }, [draft.connectionId, wantKind])

  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }))
    setSaved(false)
  }
  const setPerm = (p: Partial<AgentPermissions>) => patch({ permissions: { ...draft.permissions, ...p } })

  async function save() {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await window.api.invoke('agents:update', {
        id: agent.id,
        name: draft.name,
        connectionId: draft.connectionId || null,
        model: draft.model.trim() || null,
        systemPrompt: draft.systemPrompt,
        temperature: num(draft.temperature),
        maxTokens: num(draft.maxTokens),
        maxCostUsd: num(draft.maxCost),
        permissions: draft.permissions
      })
      await refresh()
      setSaved(true)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    try {
      await window.api.invoke('agents:remove', agent.id)
      await refresh()
      onRemoved()
    } catch (e) {
      setConfirmRemove(false)
      setError(errMsg(e))
    }
  }

  const modelListed = models.some((m) => m.model === draft.model)

  return (
    <div className="space-y-5 p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={draft.name} maxLength={80} onChange={(e) => patch({ name: e.target.value })} aria-label="Agent name" />
        </Field>
        <Field label="Role" hint="Fixed when the agent is created. Duplicate it to start a variation.">
          <Input value={agent.roleLabel} disabled aria-label="Role" />
        </Field>
      </div>

      {isImage && (
        <p className="rounded-md border border-line bg-elev px-3 py-2 text-xs text-muted">
          This is an image agent. It calls an image-generation API (OpenAI, Gemini or an OpenAI-compatible server). Pictures are saved to the project’s asset
          folder and listed in the Asset Library. Anthropic, OpenRouter, DeepSeek, Groq and Ollama have no image API here.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Connection">
          <Select value={draft.connectionId} onChange={(e) => patch({ connectionId: e.target.value, model: '' })} aria-label="Connection">
            <option value="">— none —</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {!c.enabled ? ' (disabled)' : c.status === 'error' ? ' (error)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Model"
          hint={
            draft.connectionId && models.length === 0
              ? isImage
                ? 'No image models are listed for this connection: type an id such as gpt-image-1, dall-e-3 or imagen-4.0-generate-001.'
                : 'No models cached for this connection: type an id, or discover models on the Model Connections page.'
              : undefined
          }
        >
          {models.length > 0 ? (
            <Select value={draft.model} onChange={(e) => patch({ model: e.target.value })} aria-label="Model" className="font-mono">
              <option value="">— choose a model —</option>
              {draft.model && !modelListed && <option value={draft.model}>{draft.model} (not in list)</option>}
              {models.map((m) => (
                <option key={m.model} value={m.model}>
                  {m.model}
                </option>
              ))}
            </Select>
          ) : (
            <Input
              value={draft.model}
              disabled={!draft.connectionId}
              placeholder={draft.connectionId ? 'Model id' : 'Choose a connection first'}
              onChange={(e) => patch({ model: e.target.value })}
              aria-label="Model"
              className="font-mono"
            />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Temperature" hint="0–2. Empty = provider default.">
          <Input
            type="number"
            step="0.1"
            min="0"
            max="2"
            value={draft.temperature}
            onChange={(e) => patch({ temperature: e.target.value })}
            aria-label="Temperature"
          />
        </Field>
        <Field label="Max output tokens" hint="Empty = provider default.">
          <Input type="number" step="1" min="1" value={draft.maxTokens} onChange={(e) => patch({ maxTokens: e.target.value })} aria-label="Max output tokens" />
        </Field>
        <Field
          label="Cost limit per run (USD)"
          hint="Empty = no limit. Checked before every model call in a run; the task fails when the agent has spent this much."
        >
          <Input type="number" step="0.01" min="0" value={draft.maxCost} onChange={(e) => patch({ maxCost: e.target.value })} aria-label="Cost limit" />
        </Field>
      </div>

      <Field label="System prompt" hint={`${draft.systemPrompt.length.toLocaleString()} / 20,000 characters`}>
        <Textarea
          rows={9}
          value={draft.systemPrompt}
          onChange={(e) => patch({ systemPrompt: e.target.value })}
          aria-label="System prompt"
          className="font-mono text-[12px] leading-relaxed"
        />
      </Field>

      <fieldset>
        <legend className="mb-1 text-xs font-medium text-muted">Permissions</legend>
        <p className="mb-2 text-[11px] text-faint">
          Task-board and memory tools follow these permissions today. File and command access is enforced by the workspace sandbox, which arrives in Phase 6.
          Grant only what the role needs.
        </p>
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {TOGGLES.map(([key, label, hint]) => (
            <label key={key} className="flex items-start gap-2 text-[13px]" title={hint}>
              <input
                type="checkbox"
                checked={draft.permissions[key]}
                onChange={(e) => setPerm({ [key]: e.target.checked })}
                className="mt-0.5 size-3.5 accent-[var(--color-accent)]"
              />
              <span>
                {label}
                <span className="block text-[11px] text-faint">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        <Field label="Terminal commands">
          <Select
            value={draft.permissions.runCommands}
            onChange={(e) => setPerm({ runCommands: e.target.value as CommandPolicy })}
            aria-label="Terminal commands"
            className="mt-2 max-w-sm"
          >
            {COMMAND_POLICIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
      </fieldset>

      {error && (
        <p role="alert" className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs break-words text-err" data-selectable>
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || busy} data-action="save-agent">
          Save changes
        </Button>
        {dirty && !busy && (
          <Button variant="ghost" onClick={() => (setDraft(toDraft(agent)), setError(null))}>
            Discard
          </Button>
        )}
        {saved && <span className="text-xs text-ok">Saved.</span>}
      </div>

      <div className="border-t border-line pt-4">
        <h4 className="mb-1 text-xs font-semibold text-muted">Danger zone</h4>
        <p className="mb-2 text-xs text-faint">Deleting an agent keeps its past usage and activity records, but they will no longer be linked to it.</p>
        {confirmRemove ? (
          <div className="flex items-center gap-2">
            <Button variant="danger" onClick={() => void remove()}>
              Yes, delete “{agent.name}”
            </Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirmRemove(true)}>
            <Trash2 size={13} /> Delete agent
          </Button>
        )}
      </div>
    </div>
  )
}

export function AgentDetail({ agent, onRemoved, onDuplicated }: { agent: Agent; onRemoved: () => void; onDuplicated: (a: Agent) => void }) {
  const refresh = useStudio((s) => s.refresh)
  const projects = useStudio((s) => s.projects)
  const connection = useStudio((s) => s.connections.find((c) => c.id === agent.connectionId))
  const [tab, setTab] = useState<Tab>('config')
  const [error, setError] = useState<string | null>(null)

  const scope = agent.projectId ? (projects.find((p) => p.id === agent.projectId)?.name ?? 'Project') : 'Library'

  async function toggleEnabled() {
    setError(null)
    try {
      await window.api.invoke('agents:update', {
        id: agent.id,
        enabled: !agent.enabled
      })
      await refresh()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function duplicate() {
    setError(null)
    try {
      const copy = await window.api.invoke('agents:duplicate', agent.id)
      await refresh()
      onDuplicated(copy)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const canTest = agent.kind === 'chat' && agent.enabled && !!connection && !!agent.model

  return (
    <Card>
      <div className="border-b border-line p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[15px] font-semibold">{agent.name}</h2>
              <Badge tone={agent.enabled ? (agent.issues.length ? 'warn' : 'ok') : 'neutral'}>
                {agent.enabled ? (agent.issues.length ? 'Needs setup' : 'Ready') : 'Disabled'}
              </Badge>
              {agent.roleLabel !== agent.name && <Badge>{agent.roleLabel}</Badge>}
              <Badge title="Where this agent lives">{scope}</Badge>
            </div>
            <p className="mt-0.5 truncate font-mono text-[11px] text-faint">
              {agent.model ? `${agent.connectionName ?? '?'} · ${agent.model}` : 'No model assigned'}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button onClick={() => void toggleEnabled()} data-action="toggle-agent">
              <Power size={13} /> {agent.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button onClick={() => void duplicate()} data-action="duplicate-agent">
              <Copy size={13} /> Duplicate
            </Button>
          </div>
        </div>
        {agent.issues.length > 0 && (
          <ul className="mt-3 space-y-1 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn" data-agent-issues>
            {agent.issues.map((i) => (
              <li key={i} className="flex items-start gap-1.5">
                <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {i}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p role="alert" className="mt-3 rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs break-words text-err" data-selectable>
            {error}
          </p>
        )}
      </div>

      <div role="tablist" className="flex h-9 border-b border-line px-2">
        {(
          [
            ['config', 'Configuration'],
            ['test', 'Test']
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            data-tab={id}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cx('border-b-2 px-3 text-xs transition-colors', tab === id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'config' && <ConfigTab key={`${agent.id}:${agent.updatedAt}`} agent={agent} onRemoved={onRemoved} />}
      {tab === 'test' &&
        (canTest && connection ? (
          <Playground key={`${agent.id}:${agent.updatedAt}`} connection={connection} agent={agent} />
        ) : (
          <p className="p-6 text-center text-xs text-faint">
            {agent.kind === 'image'
              ? 'Image agents are tested from the Asset Library: open it and press Generate.'
              : !agent.enabled
                ? 'Enable the agent to test it.'
                : 'Choose a connection and a model on the Configuration tab (and save) to test this agent.'}
          </p>
        ))}
    </Card>
  )
}

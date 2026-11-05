import { Send, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, ChatStreamEvent, Connection, ModelEntry } from '../../../../shared/ipc'
import { fmtTokens } from '../../lib/format'
import { Badge, Button, Input, Textarea, cx } from '../ui'
import { errMsg } from './StatusBadge'

interface Stats {
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  latencyMs: number
  ttftMs: number | null
  stopReason: string
}

interface Turn {
  id: number
  user: string
  text: string
  status: 'streaming' | 'ok' | 'error' | 'cancelled'
  error?: string
  stats?: Stats
}

const costLabel = (c: number | null): string => (c === null ? 'unknown (no price set)' : c === 0 ? '$0.00' : c < 0.0001 ? '<$0.0001' : `$${c.toFixed(4)}`)

/**
 * Free-form chat against one connection. With `agent`, model / system prompt / limits are the agent's own
 * (read-only here) and the calls are billed to that agent: a real end-to-end test of its configuration.
 */
export function Playground({ connection, agent }: { connection: Connection; agent?: Agent }) {
  const [models, setModels] = useState<ModelEntry[]>([])
  const [model, setModel] = useState(agent?.model ?? '')
  const [system, setSystem] = useState(agent?.systemPrompt ?? '')
  const [draft, setDraft] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [sendError, setSendError] = useState<string | null>(null)

  const activeId = useRef<string | null>(null)
  const startedAt = useRef(0)
  const firstTokenAt = useRef<number | null>(null)
  const early = useRef<ChatStreamEvent[]>([]) // events that beat the `chat:start` reply
  const nextTurn = useRef(1)
  const scroller = useRef<HTMLDivElement>(null)

  const streaming = turns.some((t) => t.status === 'streaming')

  useEffect(() => {
    if (agent) return // the agent decides the model
    void window.api.invoke('models:list', connection.id).then((list) => {
      const chatModels = list.filter((m) => m.kind === 'chat')
      setModels(chatModels)
      setModel((cur) => cur || chatModels[0]?.model || '')
    }, () => undefined)
  }, [connection.id, agent])

  const apply = useCallback((e: ChatStreamEvent) => {
    setTurns((prev) => {
      const i = prev.length - 1
      if (i < 0 || prev[i].status !== 'streaming') return prev
      const t = prev[i]
      let next: Turn = t
      if (e.type === 'text') {
        if (firstTokenAt.current === null) firstTokenAt.current = performance.now()
        next = { ...t, text: t.text + e.delta }
      } else if (e.type === 'done') {
        next = {
          ...t,
          status: 'ok',
          stats: {
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            costUsd: e.costUsd,
            latencyMs: e.latencyMs,
            ttftMs: firstTokenAt.current === null ? null : Math.round(firstTokenAt.current - startedAt.current),
            stopReason: e.stopReason
          }
        }
      } else if (e.type === 'error') {
        next = { ...t, status: 'error', error: e.message }
      } else if (e.type === 'cancelled') {
        next = { ...t, status: 'cancelled' }
      }
      return [...prev.slice(0, i), next]
    })
    if (e.type !== 'text') activeId.current = null
  }, [])

  useEffect(() => {
    return window.api.onChatEvent((e) => {
      if (activeId.current === null) {
        early.current.push(e) // request id not known yet; replayed once chat:start returns
        return
      }
      if (e.requestId === activeId.current) apply(e)
    })
  }, [apply])

  // Leaving the tab must not leave a request running in the background.
  useEffect(
    () => () => {
      if (activeId.current) void window.api.invoke('chat:cancel', activeId.current).catch(() => undefined)
    },
    []
  )

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [turns])

  const history = useMemo(
    () => turns.filter((t) => t.status === 'ok').flatMap((t) => [{ role: 'user' as const, content: t.user }, { role: 'assistant' as const, content: t.text }]),
    [turns]
  )

  async function send() {
    const text = draft.trim()
    if (!text || streaming || !model.trim()) return
    setSendError(null)
    const id = nextTurn.current++
    setTurns((p) => [...p, { id, user: text, text: '', status: 'streaming' }])
    setDraft('')
    startedAt.current = performance.now()
    firstTokenAt.current = null
    early.current = []
    activeId.current = null
    try {
      const requestId = await window.api.invoke('chat:start', {
        connectionId: connection.id,
        model: model.trim(),
        system: system.trim() || undefined,
        messages: [...history, { role: 'user', content: text }],
        ...(agent ? { agentId: agent.id, temperature: agent.temperature ?? undefined, maxTokens: agent.maxTokens ?? undefined } : {})
      })
      activeId.current = requestId
      const buffered = early.current.filter((e) => e.requestId === requestId)
      early.current = []
      for (const e of buffered) apply(e)
    } catch (e) {
      // Rejected before streaming started (validation): undo the turn and give the text back.
      setTurns((p) => p.filter((t) => t.id !== id))
      setDraft(text)
      setSendError(errMsg(e))
    }
  }

  function stop() {
    if (activeId.current) void window.api.invoke('chat:cancel', activeId.current).catch(() => undefined)
  }

  return (
    <div className="flex h-[560px] flex-col">
      <div className="grid grid-cols-[1fr_auto] items-center gap-2 border-b border-line p-3">
        {agent ? (
          <p className="text-xs text-muted" data-agent-config>
            Testing <span className="text-fg">{agent.name}</span> with <span className="font-mono text-fg">{model}</span>
            {agent.temperature !== null && <> · temperature {agent.temperature}</>}
            {agent.maxTokens !== null && <> · max {agent.maxTokens} tokens</>} · its {system.length.toLocaleString()}-character system prompt. Calls are billed to this agent.
          </p>
        ) : models.length > 0 ? (
          <select
            aria-label="Model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="h-8 rounded-md border border-line bg-bg px-2 font-mono text-[12px] text-fg focus:border-accent focus:outline-none"
          >
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.model}
              </option>
            ))}
          </select>
        ) : (
          <Input aria-label="Model" placeholder="Model id (or discover models first)" value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" />
        )}
        <Button variant="ghost" size="sm" onClick={() => setTurns([])} disabled={streaming || turns.length === 0}>
          <Trash2 size={13} /> Clear
        </Button>
        {!agent && <Input aria-label="System prompt" className="col-span-2" placeholder="System prompt (optional)" value={system} onChange={(e) => setSystem(e.target.value)} />}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {turns.length === 0 && (
          <p className="pt-10 text-center text-xs text-faint">
            Send a real request to {connection.name}. Tokens, latency and cost are measured from the actual response.
          </p>
        )}
        {turns.map((t) => (
          <div key={t.id} className="space-y-2" data-turn-status={t.status}>
            <div className="ml-auto max-w-[85%] rounded-lg bg-accent-soft px-3 py-2 text-[13px] whitespace-pre-wrap" data-selectable>
              {t.user}
            </div>
            <div className="max-w-[92%] rounded-lg border border-line bg-panel px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap" data-selectable data-role="assistant">
              {t.text || (t.status === 'streaming' ? <span className="text-faint">Waiting for the first token…</span> : null)}
              {t.status === 'streaming' && t.text && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />}
              {t.status === 'cancelled' && <span className="mt-1 block text-[11px] text-warn">Stopped.</span>}
              {t.status === 'error' && (
                <span role="alert" className="mt-1 block text-xs text-err">
                  {t.error}
                </span>
              )}
            </div>
            {t.stats && (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]" data-stats>
                <Badge>{fmtTokens(t.stats.inputTokens)} in</Badge>
                <Badge>{fmtTokens(t.stats.outputTokens)} out</Badge>
                <Badge tone={t.stats.costUsd === null ? 'warn' : 'ok'} title={t.stats.costUsd === null ? 'Set a price for this model in the Models tab' : undefined}>
                  cost {costLabel(t.stats.costUsd)}
                </Badge>
                <Badge>{t.stats.latencyMs} ms total</Badge>
                {t.stats.ttftMs !== null && <Badge>{t.stats.ttftMs} ms to first token</Badge>}
                <Badge>{t.stats.stopReason}</Badge>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="border-t border-line p-3">
        {sendError && (
          <p role="alert" className="mb-2 text-xs text-err" data-selectable>
            {sendError}
          </p>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            aria-label="Message"
            className="flex-1"
            placeholder="Message… (Enter to send, Shift+Enter for a new line)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
          />
          {streaming ? (
            <Button variant="danger" onClick={stop} aria-label="Stop">
              <Square size={13} /> Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void send()} disabled={!draft.trim() || !model.trim()} aria-label="Send">
              <Send size={13} /> Send
            </Button>
          )}
        </div>
        <p className={cx('mt-1.5 text-[11px] text-faint')}>Conversation history stays in this window only; each call is logged to Usage.</p>
      </div>
    </div>
  )
}

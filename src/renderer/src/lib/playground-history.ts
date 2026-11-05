/** Playground conversations are kept per connection (or per agent) in this window's local storage, so they survive switching tabs and restarting. */

export interface SavedStats {
  inputTokens: number
  outputTokens: number
  costUsd: number | null
  latencyMs: number
  ttftMs: number | null
  stopReason: string
}

export interface SavedTurn {
  id: number
  user: string
  text: string
  status: 'ok' | 'error' | 'cancelled'
  error?: string
  stats?: SavedStats
}

export interface SavedPlayground {
  turns: SavedTurn[]
  /** Connection playground only: the model and system prompt the user had typed. */
  model?: string
  system?: string
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const MAX_TURNS = 40
export const MAX_TEXT = 40_000

const keyOf = (scope: string): string => `playground:${scope}`
const store = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const clip = (s: unknown): string => (typeof s === 'string' ? s.slice(0, MAX_TEXT) : '')

function cleanTurn(raw: unknown): SavedTurn | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const status = t.status
  if (status !== 'ok' && status !== 'error' && status !== 'cancelled') return null // an unfinished turn is never restored
  const id = num(t.id)
  if (id === null) return null
  const out: SavedTurn = { id, user: clip(t.user), text: clip(t.text), status }
  if (typeof t.error === 'string') out.error = t.error.slice(0, 2000)
  const s = t.stats
  if (s && typeof s === 'object') {
    const r = s as Record<string, unknown>
    out.stats = {
      inputTokens: num(r.inputTokens) ?? 0,
      outputTokens: num(r.outputTokens) ?? 0,
      costUsd: num(r.costUsd),
      latencyMs: num(r.latencyMs) ?? 0,
      ttftMs: num(r.ttftMs),
      stopReason: typeof r.stopReason === 'string' ? r.stopReason.slice(0, 40) : ''
    }
  }
  return out
}

/** Never throws: a missing, corrupt or hand-edited entry just means an empty conversation. */
export function loadPlayground(scope: string, from: Store | null = store()): SavedPlayground {
  try {
    const raw = from?.getItem(keyOf(scope))
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.turns)) return { turns: [] }
    const turns = parsed.turns.map(cleanTurn).filter((t): t is SavedTurn => t !== null).slice(-MAX_TURNS)
    return {
      turns,
      ...(typeof parsed.model === 'string' ? { model: parsed.model.slice(0, 200) } : {}),
      ...(typeof parsed.system === 'string' ? { system: parsed.system.slice(0, 20_000) } : {})
    }
  } catch {
    return { turns: [] }
  }
}

/** Saves only finished turns (the newest MAX_TURNS). An empty conversation removes the entry. */
export function savePlayground(scope: string, data: { turns: ReadonlyArray<{ status: string } & Omit<SavedTurn, 'status'>>; model?: string; system?: string }, to: Store | null = store()): void {
  try {
    if (!to) return
    const turns = data.turns.map(cleanTurn).filter((t): t is SavedTurn => t !== null).slice(-MAX_TURNS)
    if (turns.length === 0 && !data.model && !data.system) to.removeItem(keyOf(scope))
    else to.setItem(keyOf(scope), JSON.stringify({ turns, ...(data.model ? { model: data.model } : {}), ...(data.system ? { system: data.system } : {}) }))
  } catch {
    /* storage full or blocked: the conversation just is not remembered */
  }
}

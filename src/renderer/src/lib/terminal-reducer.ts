import type { CommandOrigin, CommandOutcome, TerminalEvent } from '../../../shared/ipc'

const MAX_TERMINAL_ENTRIES = 60
/** Characters of output kept per command in the panel (the main process keeps the head and tail of the rest). */
const MAX_ENTRY_CHARS = 200_000

/** One command shown in the terminal panel, built from streamed TerminalEvents. */
export interface TerminalEntry {
  id: string
  projectId: string
  command: string
  cwd: string
  origin: CommandOrigin
  agentName: string | null
  note: string | null
  startedAt: number
  /** null while running. */
  outcome: CommandOutcome | null
  exitCode: number | null
  durationMs: number | null
  message: string | null
  chunks: Array<{ stream: 'stdout' | 'stderr'; text: string }>
  chars: number
  clipped: boolean
}

/** Pure reducer so it can be reasoned about (and tested) without React. */
export function applyTerminalEvent(entries: TerminalEntry[], e: TerminalEvent, now = Date.now()): TerminalEntry[] {
  if (e.type === 'start') {
    const entry: TerminalEntry = { id: e.id, projectId: e.projectId, command: e.command, cwd: e.cwd, origin: e.origin, agentName: e.agentName, note: e.note, startedAt: now, outcome: null, exitCode: null, durationMs: null, message: null, chunks: [], chars: 0, clipped: false }
    return [...entries.filter((x) => x.id !== e.id), entry].slice(-MAX_TERMINAL_ENTRIES)
  }
  return entries.map((x) => {
    if (x.id !== e.id) return x
    if (e.type === 'output') {
      if (x.chars >= MAX_ENTRY_CHARS) return x.clipped ? x : { ...x, clipped: true }
      const room = MAX_ENTRY_CHARS - x.chars
      const text = e.text.length > room ? e.text.slice(0, room) : e.text
      const last = x.chunks[x.chunks.length - 1]
      const chunks = last && last.stream === e.stream ? [...x.chunks.slice(0, -1), { stream: e.stream, text: last.text + text }] : [...x.chunks, { stream: e.stream, text }]
      return { ...x, chunks, chars: x.chars + text.length, clipped: text.length < e.text.length }
    }
    return { ...x, outcome: e.outcome, exitCode: e.exitCode, durationMs: e.durationMs, message: e.message }
  })
}

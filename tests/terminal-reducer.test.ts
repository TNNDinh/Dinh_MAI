import { describe, expect, it } from 'vitest'
import { applyTerminalEvent, type TerminalEntry } from '../src/renderer/src/lib/terminal-reducer'
import type { TerminalEvent } from '../src/shared/ipc'

const start = (id: string, command = 'npm test'): TerminalEvent => ({ type: 'start', id, projectId: 'p1', command, cwd: '.', origin: 'user', agentName: null, note: null })
const out = (id: string, text: string, stream: 'stdout' | 'stderr' = 'stdout'): TerminalEvent => ({ type: 'output', id, stream, text })
const end = (id: string, exitCode = 0): TerminalEvent => ({ type: 'end', id, outcome: 'exited', exitCode, durationMs: 120, message: null })

const run = (events: TerminalEvent[], from: TerminalEntry[] = []): TerminalEntry[] => events.reduce((s, e) => applyTerminalEvent(s, e, 1000), from)

describe('terminal event reducer', () => {
  it('starts an entry as running, then fills in the outcome', () => {
    const running = run([start('a')])
    expect(running).toHaveLength(1)
    expect(running[0]).toMatchObject({ id: 'a', outcome: null, exitCode: null, startedAt: 1000 })
    const done = run([end('a', 2)], running)
    expect(done[0]).toMatchObject({ outcome: 'exited', exitCode: 2, durationMs: 120 })
  })

  it('merges consecutive output of the same stream and splits on a stream change', () => {
    const s = run([start('a'), out('a', 'one '), out('a', 'two'), out('a', 'oops', 'stderr'), out('a', 'three')])
    expect(s[0].chunks).toEqual([
      { stream: 'stdout', text: 'one two' },
      { stream: 'stderr', text: 'oops' },
      { stream: 'stdout', text: 'three' }
    ])
  })

  it('ignores output and end events for commands it never saw', () => {
    const s = run([start('a')])
    expect(run([out('zzz', 'x'), end('zzz')], s)).toEqual(s)
  })

  it('keeps entries independent', () => {
    const s = run([start('a'), start('b'), out('b', 'only b'), end('a')])
    expect(s.find((e) => e.id === 'a')?.chunks).toEqual([])
    expect(s.find((e) => e.id === 'b')?.chunks[0].text).toBe('only b')
    expect(s.find((e) => e.id === 'b')?.outcome).toBeNull()
  })

  it('does not duplicate an entry when the start event arrives twice', () => {
    expect(run([start('a'), start('a')])).toHaveLength(1)
  })

  it('stops growing at the character cap and marks the entry as clipped', () => {
    const big = 'x'.repeat(150_000)
    const s = run([start('a'), out('a', big), out('a', big), out('a', 'more')])
    expect(s[0].chars).toBe(200_000)
    expect(s[0].clipped).toBe(true)
    expect(s[0].chunks.map((c) => c.text.length).reduce((a, b) => a + b, 0)).toBe(200_000)
  })

  it('keeps only the most recent entries', () => {
    const s = run(Array.from({ length: 75 }, (_, i) => start(`c${i}`)))
    expect(s).toHaveLength(60)
    expect(s[0].id).toBe('c15')
    expect(s[59].id).toBe('c74')
  })

  it('does not mutate its input', () => {
    const before = run([start('a'), out('a', 'hi')])
    const snapshot = JSON.stringify(before)
    run([out('a', ' there'), end('a')], before)
    expect(JSON.stringify(before)).toBe(snapshot)
  })
})

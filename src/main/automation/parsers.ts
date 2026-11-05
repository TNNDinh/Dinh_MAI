import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ProblemItem, TestSummary } from '../../shared/ipc'

const MAX_PROBLEMS = 500
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

export const stripAnsi = (s: string): string => s.replace(ANSI, '')

/** Makes a path the tool printed relative to the project when it points inside it; otherwise leaves it as printed. */
export function relPath(p: string, root: string): string {
  const clean = p.trim().replace(/^["']|["']$/g, '')
  if (!clean) return clean
  try {
    const abs = isAbsolute(clean) ? clean : resolve(root, clean)
    const rel = relative(root, abs)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  } catch {
    /* keep as printed */
  }
  return clean.replace(/\\/g, '/')
}

const num = (s: string | undefined): number | null => (s === undefined || s === '' ? null : Number(s))

/**
 * Reads compiler, linter and runtime errors out of build output. It understands the formats of tsc, ESLint (stylish), gcc/clang/mypy, rustc,
 * Go, dotnet/MSBuild and Python tracebacks. Lines it does not recognise are ignored, so this never invents a problem: every item points at a line of the output.
 */
export function parseProblems(raw: string, root: string): ProblemItem[] {
  const lines = stripAnsi(raw).split(/\r?\n/)
  const out: ProblemItem[] = []
  const seen = new Set<string>()
  const add = (p: ProblemItem): void => {
    const key = `${p.file}|${p.line}|${p.column}|${p.code}|${p.message}`
    if (seen.has(key) || out.length >= MAX_PROBLEMS) return
    seen.add(key)
    out.push(p)
  }

  let eslintFile: string | null = null
  let pyFile: string | null = null
  let pyLine: number | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let m: RegExpMatchArray | null

    // tsc, dotnet and MSBuild:  path(12,5): error TS2322: message
    // (npm and yarn echo the script line as "> cmd" / "$ cmd": that echo is not a diagnostic even when the command text looks like one.)
    if ((m = line.match(/^\s*(?![>$]\s)(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Za-z]+\d+)\s*:\s*(.*?)(?:\s+\[[^\]]*\])?\s*$/))) {
      add({ severity: m[4] as 'error' | 'warning', file: relPath(m[1], root), line: Number(m[2]), column: Number(m[3]), code: m[5], message: m[6], tool: /^TS\d/.test(m[5]) ? 'tsc' : 'dotnet' })
      continue
    }
    // tsc --pretty false variant:  path:12:5 - error TS2322: message
    if ((m = line.match(/^\s*(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s*(.*)$/))) {
      add({ severity: m[4] as 'error' | 'warning', file: relPath(m[1], root), line: Number(m[2]), column: Number(m[3]), code: m[5], message: m[6], tool: 'tsc' })
      continue
    }
    // rustc:  error[E0425]: message   then   --> path:line:col
    if ((m = line.match(/^(error|warning)(?:\[(\w+)\])?:\s+(.*)$/)) && /^\s*-->\s+\S+:\d+:\d+/.test(lines[i + 1] ?? '')) {
      const loc = (lines[i + 1] ?? '').match(/-->\s+(.+?):(\d+):(\d+)/)
      if (loc && m[3] !== 'aborting due to previous error') {
        add({ severity: m[1] as 'error' | 'warning', file: relPath(loc[1], root), line: Number(loc[2]), column: Number(loc[3]), code: m[2] ?? null, message: m[3], tool: 'rustc' })
      }
      continue
    }
    // gcc, clang, mypy, eslint --format unix, javac:  path:12:5: error: message   (column optional)
    if ((m = line.match(/^\s*((?:[A-Za-z]:)?[^\s:(][^:(]*?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning)\b:?\s*(.*?)(?:\s+\[([\w.-]+)\])?\s*$/)) && !/^https?$/i.test(m[1])) {
      add({ severity: m[4] === 'warning' ? 'warning' : 'error', file: relPath(m[1], root), line: Number(m[2]), column: num(m[3]), code: m[6] ?? null, message: m[5], tool: 'gcc' })
      continue
    }
    // Go compiler:  ./main.go:12:3: message
    if ((m = line.match(/^\s*(\.{0,2}[\\/]?[^\s:]+\.go):(\d+):(\d+):\s+(.+)$/))) {
      add({ severity: 'error', file: relPath(m[1], root), line: Number(m[2]), column: Number(m[3]), code: null, message: m[4], tool: 'go' })
      continue
    }
    // ESLint stylish: a path on its own line, then "  12:5  error  message  rule" lines
    if (/^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/])\S.*\.[A-Za-z0-9]+$/.test(line.trim()) && !/^\s/.test(line)) {
      eslintFile = line.trim()
      continue
    }
    if (eslintFile && (m = line.match(/^\s+(\d+):(\d+)\s+(error|warning)\s+(.*?)(?:\s{2,}([@\w/.-]+))?\s*$/))) {
      add({ severity: m[3] as 'error' | 'warning', file: relPath(eslintFile, root), line: Number(m[1]), column: Number(m[2]), code: m[5] ?? null, message: m[4], tool: 'eslint' })
      continue
    }
    if (line.trim() === '') eslintFile = null

    // Python traceback: remember the innermost frame, report at the exception line
    if ((m = line.match(/^\s*File "(.+?)", line (\d+)/))) {
      pyFile = m[1]
      pyLine = Number(m[2])
      continue
    }
    if (pyFile && (m = line.match(/^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt)):\s*(.*)$/))) {
      add({ severity: 'error', file: relPath(pyFile, root), line: pyLine, column: null, code: m[1], message: m[2] || m[1], tool: 'python' })
      pyFile = null
      pyLine = null
    }
  }
  return out
}

const int = (s: string | undefined): number => (s ? parseInt(s, 10) : 0)

/**
 * Reads a test summary from vitest, jest, pytest, `node --test`, cargo, go and dotnet output. Returns null when the output has no recognisable
 * summary line: the UI then says so instead of guessing.
 */
export function parseTests(raw: string): TestSummary | null {
  const text = stripAnsi(raw)
  let m: RegExpMatchArray | null

  // vitest:  " Tests  2 failed | 17 passed | 1 skipped (20)"
  if ((m = text.match(/^\s*Tests\s+((?:\d+ (?:failed|passed|skipped|todo|pending)(?: \| )?)+)\s*\(\d+\)/m))) {
    const s = m[1]
    const failures = [...text.matchAll(/^\s*(?:FAIL|×)\s+(.+?)\s*$/gm)].map((x) => x[1]).filter((x) => !/^\d+ test/.test(x))
    return { passed: int(s.match(/(\d+) passed/)?.[1]), failed: int(s.match(/(\d+) failed/)?.[1]), skipped: int(s.match(/(\d+) (?:skipped|todo|pending)/)?.[1]), unit: 'tests', failures: uniq(failures), runner: 'vitest' }
  }
  // jest:  "Tests:       1 failed, 2 passed, 3 total"
  if ((m = text.match(/^\s*Tests:\s+(.+?)\s*$/m))) {
    const s = m[1]
    const failures = [...text.matchAll(/^\s*●\s+(.+?)\s*$/gm)].map((x) => x[1]).filter((x) => !/^Console/.test(x))
    return { passed: int(s.match(/(\d+) passed/)?.[1]), failed: int(s.match(/(\d+) failed/)?.[1]), skipped: int(s.match(/(\d+) (?:skipped|todo)/)?.[1]), unit: 'tests', failures: uniq(failures), runner: 'jest' }
  }
  // node --test: the TAP summary ("# pass 3") or the spec reporter's ("ℹ pass 3")
  if (/^[#ℹ] pass \d+/m.test(text) && /^[#ℹ] fail \d+/m.test(text)) {
    const failures = [...text.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)].map((x) => x[1])
    for (const x of text.matchAll(/^\s*✖ (.+?)\s+\([\d.]+m?s\)\s*$/gm)) failures.push(x[1])
    return {
      passed: int(text.match(/^[#ℹ] pass (\d+)/m)?.[1]),
      failed: int(text.match(/^[#ℹ] fail (\d+)/m)?.[1]),
      skipped: int(text.match(/^[#ℹ] skipped (\d+)/m)?.[1]),
      unit: 'tests',
      failures: uniq(failures),
      runner: 'node:test'
    }
  }
  // pytest:  "=== 2 failed, 5 passed, 1 skipped in 0.12s ===" (also the -q form without the equals signs)
  if ((m = text.match(/^=*\s*((?:\d+ (?:failed|passed|skipped|error|errors|xfailed|xpassed|deselected|warnings?)(?:, )?)+) in [\d.]+s/m))) {
    const s = m[1]
    const failures = [...text.matchAll(/^(?:FAILED|ERROR)\s+(\S+?)(?:\s+-\s.*)?$/gm)].map((x) => x[1])
    return { passed: int(s.match(/(\d+) passed/)?.[1]), failed: int(s.match(/(\d+) failed/)?.[1]) + int(s.match(/(\d+) errors?/)?.[1]), skipped: int(s.match(/(\d+) skipped/)?.[1]), unit: 'tests', failures: uniq(failures), runner: 'pytest' }
  }
  // cargo:  "test result: ok. 3 passed; 0 failed; 1 ignored;" (one line per test binary)
  const cargo = [...text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)]
  if (cargo.length > 0) {
    const failures = [...text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map((x) => x[1])
    return { passed: sum(cargo, 1), failed: sum(cargo, 2), skipped: sum(cargo, 3), unit: 'tests', failures: uniq(failures), runner: 'cargo test' }
  }
  // dotnet:  "Passed!  - Failed:     0, Passed:     5, Skipped:     0, Total:     5"
  if ((m = text.match(/(?:Passed|Failed)!\s+-\s+Failed:\s+(\d+),\s+Passed:\s+(\d+),\s+Skipped:\s+(\d+)/))) {
    const failures = [...text.matchAll(/^\s*Failed (\S+)/gm)].map((x) => x[1])
    return { passed: int(m[2]), failed: int(m[1]), skipped: int(m[3]), unit: 'tests', failures: uniq(failures), runner: 'dotnet test' }
  }
  // go: verbose runs print one "--- PASS/FAIL/SKIP" per test; otherwise only per-package "ok"/"FAIL" lines exist
  const goTests = [...text.matchAll(/^\s*--- (PASS|FAIL|SKIP): (\S+)/gm)]
  if (goTests.length > 0) {
    return {
      passed: goTests.filter((x) => x[1] === 'PASS').length,
      failed: goTests.filter((x) => x[1] === 'FAIL').length,
      skipped: goTests.filter((x) => x[1] === 'SKIP').length,
      unit: 'tests',
      failures: uniq(goTests.filter((x) => x[1] === 'FAIL').map((x) => x[2])),
      runner: 'go test'
    }
  }
  const okPk = [...text.matchAll(/^ok\s+\S+\s+[\d.]+s/gm)].length
  const failPk = [...text.matchAll(/^FAIL\s+(\S+)/gm)].filter((x) => !/^\[?(setup|build)/.test(x[1]))
  if (okPk + failPk.length > 0) return { passed: okPk, failed: failPk.length, skipped: 0, unit: 'packages', failures: uniq(failPk.map((x) => x[1])), runner: 'go test' }
  return null
}

const sum = (ms: RegExpMatchArray[], i: number): number => ms.reduce((a, m) => a + int(m[i]), 0)
const uniq = (xs: string[]): string[] => [...new Set(xs)].slice(0, 100)

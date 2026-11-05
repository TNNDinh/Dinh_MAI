import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AutomationRun } from '../src/shared/ipc'
import { AutomationService } from '../src/main/automation/service'
import { detectDevCommand, detectStaticFolders, detectTasks, packageManager } from '../src/main/automation/detect'
import { parseProblems, parseTests, relPath, stripAnsi } from '../src/main/automation/parsers'
import { Database } from '../src/main/db/database'
import { EventService } from '../src/main/services/events'
import { ApprovalService, CommandService } from '../src/main/workspace/commands'
import { ContextIndexer } from '../src/main/workspace/indexer'
import { FileLocks } from '../src/main/workspace/locks'
import { WorkspaceService } from '../src/main/workspace/workspace'

const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj'

// The sample outputs below are copied from the real tools' formats. The end-to-end cases further down run real processes.

describe('parseProblems', () => {
  it('reads tsc errors and warnings with positions', () => {
    const out = [
      'src/app.ts(12,5): error TS2322: Type \'string\' is not assignable to type \'number\'.',
      'src/lib/util.ts:7:3 - error TS2304: Cannot find name \'foo\'.',
      'Found 2 errors.'
    ].join('\n')
    const p = parseProblems(out, ROOT)
    expect(p).toHaveLength(2)
    expect(p[0]).toMatchObject({ severity: 'error', file: 'src/app.ts', line: 12, column: 5, code: 'TS2322', tool: 'tsc' })
    expect(p[1]).toMatchObject({ file: 'src/lib/util.ts', line: 7, column: 3, code: 'TS2304' })
  })

  it('reads dotnet / MSBuild errors and drops the project suffix', () => {
    const p = parseProblems('Program.cs(10,13): error CS1002: ; expected [C:\\proj\\App.csproj]', ROOT)
    expect(p[0]).toMatchObject({ file: 'Program.cs', line: 10, column: 13, code: 'CS1002', message: '; expected', tool: 'dotnet' })
  })

  it('reads gcc / clang style lines, with and without a column', () => {
    const p = parseProblems('main.c:5:10: error: expected \';\' before \'}\' token\nutil.c:22: warning: unused variable \'x\' [-Wunused-variable]', ROOT)
    expect(p[0]).toMatchObject({ severity: 'error', file: 'main.c', line: 5, column: 10 })
    expect(p[1]).toMatchObject({ severity: 'warning', file: 'util.c', line: 22, column: null, code: '-Wunused-variable' })
  })

  it('reads rustc errors from the arrow line that follows', () => {
    const out = ['error[E0425]: cannot find value `y` in this scope', ' --> src/main.rs:4:13', '  |', '4 |     let x = y;', 'error: aborting due to 1 previous error'].join('\n')
    const p = parseProblems(out, ROOT)
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ file: 'src/main.rs', line: 4, column: 13, code: 'E0425', tool: 'rustc' })
  })

  it('reads Go compiler errors', () => {
    const p = parseProblems('# example.com/app\n./main.go:9:2: undefined: foo', ROOT)
    expect(p[0]).toMatchObject({ file: 'main.go', line: 9, column: 2, tool: 'go' })
  })

  it('reads ESLint stylish blocks', () => {
    const file = process.platform === 'win32' ? 'C:\\proj\\src\\a.ts' : '/proj/src/a.ts'
    const out = ['', file, "  3:7   error    'x' is assigned a value but never used  @typescript-eslint/no-unused-vars", '  9:1   warning  Unexpected console statement             no-console', '', '✖ 2 problems (1 error, 1 warning)'].join('\n')
    const p = parseProblems(out, ROOT)
    expect(p).toHaveLength(2)
    expect(p[0]).toMatchObject({ severity: 'error', file: 'src/a.ts', line: 3, column: 7, code: '@typescript-eslint/no-unused-vars', tool: 'eslint' })
    expect(p[1]).toMatchObject({ severity: 'warning', line: 9, code: 'no-console' })
  })

  it('reports a Python exception at its innermost frame', () => {
    const out = ['Traceback (most recent call last):', '  File "app.py", line 8, in <module>', '    main()', '  File "app.py", line 4, in main', '    return 1 / 0', 'ZeroDivisionError: division by zero'].join('\n')
    const p = parseProblems(out, ROOT)
    expect(p).toHaveLength(1)
    expect(p[0]).toMatchObject({ file: 'app.py', line: 4, code: 'ZeroDivisionError', message: 'division by zero', tool: 'python' })
  })

  it('ignores ordinary output and URLs, and removes duplicates', () => {
    expect(parseProblems('Server listening on http://localhost:3000\nCompiled successfully\nhttps://example.com:8080/error: fine', ROOT)).toEqual([])
    const line = 'a.ts(1,1): error TS1005: x'
    expect(parseProblems(`${line}\n${line}`, ROOT)).toHaveLength(1)
  })

  it('strips colour codes before reading', () => {
    expect(stripAnsi('\u001b[31merror\u001b[0m')).toBe('error')
    // npm echoes the script line ("> cmd") before running it; when that command text contains a diagnostic it must not count twice.
    const echoed = `> app@1.0.0 build\n> node -e "console.error('src/a.ts(3,5): error TS2322: boom')"\nsrc/a.ts(3,5): error TS2322: boom`
    expect(parseProblems(echoed, ROOT)).toHaveLength(1)
    expect(parseProblems('$ node -e "console.error(\'a.ts(1,2): error TS1: x\')"', ROOT)).toEqual([])
    expect(parseProblems('\u001b[90ma.ts\u001b[0m(1,2): \u001b[31merror\u001b[0m TS1005: boom', ROOT)).toMatchObject([{ file: 'a.ts', line: 1, column: 2, code: 'TS1005' }])
  })

  it('makes only in-project paths relative', () => {
    const inside = join(ROOT, 'src', 'x.ts')
    expect(relPath(inside, ROOT)).toBe('src/x.ts')
    const outside = process.platform === 'win32' ? 'D:\\elsewhere\\y.ts' : '/elsewhere/y.ts'
    expect(relPath(outside, ROOT)).toBe(outside.replace(/\\/g, '/'))
    expect(relPath('..\\..\\evil.ts', ROOT)).toBe('../../evil.ts')
  })
})

describe('parseTests', () => {
  it('vitest', () => {
    const t = parseTests(' FAIL  tests/a.test.ts > math > adds\n\n Test Files  1 failed | 2 passed (3)\n      Tests  2 failed | 17 passed | 1 skipped (20)\n')
    expect(t).toMatchObject({ passed: 17, failed: 2, skipped: 1, runner: 'vitest' })
    expect(t?.failures).toEqual(['tests/a.test.ts > math > adds'])
    expect(parseTests(' Test Files  16 passed (16)\n      Tests  556 passed (556)\n')).toMatchObject({ passed: 556, failed: 0 })
  })
  it('jest', () => {
    const t = parseTests('  ● adds › fails\n\nTests:       1 failed, 2 passed, 3 total\nSnapshots:   0 total')
    expect(t).toMatchObject({ passed: 2, failed: 1, runner: 'jest' })
    expect(t?.failures).toEqual(['adds › fails'])
  })
  it('pytest', () => {
    const t = parseTests('FAILED tests/test_a.py::test_x - assert 1 == 2\n=================== 1 failed, 5 passed, 1 skipped in 0.12s ===================')
    expect(t).toMatchObject({ passed: 5, failed: 1, skipped: 1, runner: 'pytest' })
    expect(t?.failures).toEqual(['tests/test_a.py::test_x'])
    expect(parseTests('5 passed in 0.03s')).toMatchObject({ passed: 5, failed: 0 })
  })
  it('cargo sums every test binary', () => {
    const t = parseTests('test a::b ... FAILED\ntest result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured\ntest result: ok. 2 passed; 0 failed; 1 ignored; 0 measured')
    expect(t).toMatchObject({ passed: 5, failed: 1, skipped: 1, runner: 'cargo test' })
    expect(t?.failures).toEqual(['a::b'])
  })
  it('dotnet', () => {
    expect(parseTests('Failed!  - Failed:     2, Passed:     5, Skipped:     1, Total:     8, Duration: 12 ms')).toMatchObject({ passed: 5, failed: 2, skipped: 1, runner: 'dotnet test' })
  })
  it('go counts tests when verbose and packages otherwise', () => {
    expect(parseTests('--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.00s)\n--- SKIP: TestC (0.00s)')).toMatchObject({ passed: 1, failed: 1, skipped: 1, unit: 'tests' })
    expect(parseTests('ok  \texample.com/a\t0.012s\nFAIL\texample.com/b\t0.3s')).toMatchObject({ passed: 1, failed: 1, unit: 'packages', failures: ['example.com/b'] })
  })
  it('returns null when the output has no summary', () => {
    expect(parseTests('hello world\nnothing here')).toBeNull()
  })
})

describe('detection', () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mads-auto-')))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const pkg = (o: unknown): void => writeFileSync(join(dir, 'package.json'), JSON.stringify(o))

  it('finds scripts in package.json and skips npm\'s placeholder test', () => {
    pkg({ scripts: { build: 'vite build', test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .', typecheck: 'tsc --noEmit', dev: 'vite' } })
    const t = detectTasks(dir)
    expect(t.map((x) => [x.kind, x.command])).toEqual([
      ['build', 'npm run build'],
      ['lint', 'npm run lint'],
      ['typecheck', 'npm run typecheck']
    ])
    expect(detectDevCommand(dir)).toBe('npm run dev')
  })

  it('follows the lockfile for the package manager', () => {
    pkg({ scripts: { test: 'vitest run', start: 'node .' } })
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '')
    expect(packageManager(dir)).toBe('pnpm')
    expect(detectTasks(dir).find((t) => t.kind === 'test')?.command).toBe('pnpm test')
    expect(detectDevCommand(dir)).toBe('pnpm start')
  })

  it('falls back to tsc for a TypeScript project without a script', () => {
    pkg({ name: 'x' })
    writeFileSync(join(dir, 'tsconfig.json'), '{}')
    expect(detectTasks(dir)).toEqual([{ kind: 'typecheck', label: 'Type-check', command: 'npx tsc --noEmit', source: 'tsconfig.json' }])
  })

  it('detects cargo, go and dotnet projects', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '')
    writeFileSync(join(dir, 'go.mod'), '')
    writeFileSync(join(dir, 'App.csproj'), '')
    const t = detectTasks(dir)
    expect(t.find((x) => x.kind === 'build')?.command).toBe('cargo build') // the first source wins
    expect(t.find((x) => x.kind === 'test')?.command).toBe('cargo test')
  })

  it('detects python tests only when test files exist', () => {
    writeFileSync(join(dir, 'requirements.txt'), 'flask')
    expect(detectTasks(dir)).toEqual([])
    mkdirSync(join(dir, 'tests'))
    writeFileSync(join(dir, 'tests', 'test_app.py'), '')
    expect(detectTasks(dir).map((x) => x.command)).toEqual(['python -m pytest'])
  })

  it('returns nothing for an empty or unreadable project and tolerates broken package.json', () => {
    expect(detectTasks(dir)).toEqual([])
    writeFileSync(join(dir, 'package.json'), '{ not json')
    expect(detectTasks(dir)).toEqual([])
    expect(detectDevCommand(dir)).toBeNull()
    expect(detectTasks(join(dir, 'missing'))).toEqual([])
  })

  it('lists folders with an index.html', () => {
    mkdirSync(join(dir, 'dist'))
    writeFileSync(join(dir, 'dist', 'index.html'), '<p>')
    writeFileSync(join(dir, 'index.html'), '<p>')
    expect(detectStaticFolders(dir)).toEqual(['', 'dist'])
  })
})

describe('AutomationService (real processes)', () => {
  let dir: string
  let db: Database
  let svc: AutomationService
  let updates: AutomationRun[]

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'mads-auto-run-')))
    db = new Database(':memory:')
    db.migrate()
    db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p1', 'P', 'web', ?, 1, 1)`, dir)
    const events = new EventService(db)
    const workspace = new WorkspaceService(db, events, new FileLocks(db), new ContextIndexer(db))
    svc = new AutomationService(events, workspace, new CommandService(db, events, new ApprovalService()))
    updates = []
    svc.subscribe((r) => updates.push(r))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const done = async (id: string): Promise<AutomationRun> => {
    for (let i = 0; i < 400; i++) {
      const r = svc.get(id)
      if (r && r.status !== 'running') return r
      await new Promise((res) => setTimeout(res, 50))
    }
    throw new Error('run did not finish')
  }

  it('runs a passing build script and reports it', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "console.log(\'built ok\')"' } }))
    const started = svc.start('p1', 'build')
    expect(started.status).toBe('running')
    const r = await done(started.id)
    expect(r).toMatchObject({ status: 'passed', exitCode: 0, kind: 'build', command: 'npm run build' })
    expect(r.output).toContain('built ok')
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
    expect(updates[0].status).toBe('running')
    expect(updates[updates.length - 1].status).toBe('passed')
    expect(svc.list('p1').map((x) => x.id)).toEqual([r.id])
  })

  it('reports a failing real test run with its summary and failing test names', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
    writeFileSync(
      join(dir, 'a.test.js'),
      "const test = require('node:test'); const assert = require('node:assert')\ntest('adds', () => assert.strictEqual(1 + 1, 2))\ntest('breaks', () => assert.strictEqual(1 + 1, 3))\ntest.skip('later', () => {})\n"
    )
    const r = await done(svc.start('p1', 'test').id)
    expect(r.status).toBe('failed')
    expect(r.exitCode).not.toBe(0)
    expect(r.tests).toMatchObject({ passed: 1, failed: 1, skipped: 1, runner: 'node:test' })
    expect(r.tests?.failures).toEqual(['breaks'])
  })

  it('turns a failing script\'s compiler-style output into problems with project-relative paths', async () => {
    // The script prints a tsc-formatted line (a stand-in for tsc itself) so the parsing path is exercised through a real process.
    const abs = join(dir, 'src', 'a.ts')
    writeFileSync(join(dir, 'p.js'), `console.log(${JSON.stringify(abs)} + '(3,9): error TS2304: Cannot find name x.'); process.exit(2)`)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node p.js' } }))
    const r = await done(svc.start('p1', 'build').id)
    expect(r.status).toBe('failed')
    expect(r.exitCode).toBe(2)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toMatchObject({ file: 'src/a.ts', line: 3, column: 9, code: 'TS2304' })
  })

  it('refuses when the project defines no such command, and does not start a second run of the same kind', async () => {
    expect(() => svc.start('p1', 'test')).toThrow(/does not define a test command/)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "setTimeout(()=>{},800)"' } }))
    const first = svc.start('p1', 'build')
    expect(() => svc.start('p1', 'build')).toThrow(/already in progress/)
    await done(first.id)
    expect(() => svc.start('nope', 'build')).toThrow()
  })

  it('can be cancelled', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node -e "setTimeout(()=>{},30000)"' } }))
    const r0 = svc.start('p1', 'build')
    await new Promise((res) => setTimeout(res, 500))
    expect(svc.cancel(r0.id)).toBe(true)
    const r = await done(r0.id)
    expect(r.status).toBe('cancelled')
  })
})

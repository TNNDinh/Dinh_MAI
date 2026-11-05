import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AutomationKind, AutomationTask } from '../../shared/ipc'

type Pm = 'npm' | 'pnpm' | 'yarn' | 'bun'

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function packageManager(root: string): Pm {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun'
  return 'npm'
}

const runScript = (pm: Pm, name: string): string => (pm === 'npm' ? `npm run ${name}` : `${pm} run ${name}`)

/** npm's placeholder `test` script ("no test specified") is not a test command. */
const isPlaceholderTest = (s: string): boolean => /no test specified/i.test(s)

function scriptsOf(root: string): Record<string, string> {
  const pkg = readJson(join(root, 'package.json'))
  const s = pkg?.scripts
  if (!s || typeof s !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(s)) if (typeof v === 'string') out[k] = v
  return out
}

const hasFile = (root: string, ...names: string[]): boolean => names.some((n) => existsSync(join(root, n)))

function listRoot(root: string): string[] {
  try {
    return readdirSync(root)
  } catch {
    return []
  }
}

/**
 * Finds the build, test, lint and type-check commands a project defines for itself. Only the project's own files are consulted (package.json scripts,
 * Cargo.toml, go.mod, a .NET solution, Python test files); when none exists the task is simply absent.
 */
export function detectTasks(root: string): AutomationTask[] {
  const tasks: AutomationTask[] = []
  const add = (kind: AutomationKind, label: string, command: string, source: string): void => {
    if (!tasks.some((t) => t.kind === kind)) tasks.push({ kind, label, command, source })
  }
  const scripts = scriptsOf(root)
  if (hasFile(root, 'package.json')) {
    const pm = packageManager(root)
    if (scripts.build) add('build', 'Build', runScript(pm, 'build'), 'package.json scripts.build')
    if (scripts.test && !isPlaceholderTest(scripts.test)) add('test', 'Test', pm === 'npm' ? 'npm test' : `${pm} test`, 'package.json scripts.test')
    if (scripts.lint) add('lint', 'Lint', runScript(pm, 'lint'), 'package.json scripts.lint')
    const tc = scripts.typecheck ? 'typecheck' : scripts['type-check'] ? 'type-check' : null
    if (tc) add('typecheck', 'Type-check', runScript(pm, tc), `package.json scripts.${tc}`)
    else if (hasFile(root, 'tsconfig.json')) add('typecheck', 'Type-check', 'npx tsc --noEmit', 'tsconfig.json')
  }
  if (hasFile(root, 'Cargo.toml')) {
    add('build', 'Build', 'cargo build', 'Cargo.toml')
    add('test', 'Test', 'cargo test', 'Cargo.toml')
    add('lint', 'Lint', 'cargo clippy', 'Cargo.toml')
  }
  if (hasFile(root, 'go.mod')) {
    add('build', 'Build', 'go build ./...', 'go.mod')
    add('test', 'Test', 'go test ./...', 'go.mod')
    add('lint', 'Vet', 'go vet ./...', 'go.mod')
  }
  const files = listRoot(root)
  if (files.some((f) => /\.(sln|csproj|fsproj)$/i.test(f))) {
    add('build', 'Build', 'dotnet build', 'solution / project file')
    add('test', 'Test', 'dotnet test', 'solution / project file')
  }
  const python = hasFile(root, 'pytest.ini', 'tox.ini', 'conftest.py') || (hasFile(root, 'pyproject.toml', 'setup.cfg') && hasPythonTests(root))
  if (python || (hasFile(root, 'requirements.txt') && hasPythonTests(root))) add('test', 'Test', 'python -m pytest', 'Python tests found')
  return tasks
}

function hasPythonTests(root: string): boolean {
  for (const dir of ['', 'tests', 'test']) {
    const base = dir ? join(root, dir) : root
    try {
      if (dir && !statSync(base).isDirectory()) continue
      if (readdirSync(base).some((f) => /^test_.*\.py$|.*_test\.py$/.test(f))) return true
    } catch {
      /* folder does not exist */
    }
  }
  return false
}

/** The project's own command for running a development server, if it has one. */
export function detectDevCommand(root: string): string | null {
  if (!hasFile(root, 'package.json')) return null
  const scripts = scriptsOf(root)
  const pm = packageManager(root)
  if (scripts.dev) return runScript(pm, 'dev')
  if (scripts.start) return pm === 'npm' ? 'npm start' : `${pm} start`
  if (scripts.serve) return runScript(pm, 'serve')
  return null
}

/** Folders that hold an index.html: candidates for the built-in static server. */
export function detectStaticFolders(root: string): string[] {
  const out: string[] = []
  for (const dir of ['', 'dist', 'build', 'out', 'public', 'docs', 'www', 'web', 'site', 'src']) {
    if (existsSync(join(root, dir, 'index.html'))) out.push(dir)
  }
  return out
}

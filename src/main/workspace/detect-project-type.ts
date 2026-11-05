import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectType } from '../../shared/ipc'

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readPackageJson(dir: string): { deps: Record<string, unknown> } | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return { deps: { ...pkg.dependencies, ...pkg.devDependencies } }
  } catch {
    return null
  }
}

/** Inspect a folder's marker files to guess which kind of project it is. Cheap: top level only. */
export function detectProjectType(dir: string): ProjectType {
  const entries = listDir(dir)
  const lower = entries.map((e) => e.toLowerCase())
  const has = (name: string) => lower.includes(name.toLowerCase())
  const hasExt = (ext: string) => lower.some((e) => e.endsWith(ext))

  if (has('ProjectSettings') && has('Assets')) return 'unity'
  if (hasExt('.uproject')) return 'unreal'
  if (has('project.godot')) return 'godot'

  const pkg = readPackageJson(dir)
  if (pkg) {
    if ('next' in pkg.deps) return 'nextjs'
    if ('react' in pkg.deps) return 'react'
    return 'web'
  }
  if (has('index.html')) return 'web'

  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || hasExt('.py')) return 'python'
  if (hasExt('.csproj') || hasExt('.sln')) return 'csharp'
  if (has('CMakeLists.txt') || hasExt('.cpp') || hasExt('.vcxproj')) return 'cpp'
  return 'other'
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

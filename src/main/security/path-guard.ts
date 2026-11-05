import { homedir } from 'node:os'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'

/** Normalise for comparison: absolute, no trailing separator, case-folded on Windows. */
export function normalizePath(p: string): string {
  let out = resolve(p)
  const root = parse(out).root
  if (out.length > root.length && out.endsWith(sep)) out = out.slice(0, -1)
  return IS_WINDOWS ? out.toLowerCase() : out
}

/** True when `candidate` is `root` itself or lies inside it (lexically; `..` is resolved). */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  if (rel === '') return true
  if (isAbsolute(rel)) return false // different drive
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

const FORBIDDEN_WINDOWS_ROOTS = ['windows', 'windows\\system32', 'program files', 'program files (x86)', 'programdata']

/**
 * A project root becomes the sandbox in which AI agents may read/write/run commands,
 * so it must never be something broad like a drive root or the user's home folder.
 */
export function assertSafeProjectRoot(rootPath: string): string {
  if (!rootPath || !isAbsolute(rootPath)) throw new Error('Project folder must be an absolute path.')
  const resolved = resolve(rootPath)
  const parsed = parse(resolved)

  if (resolved === parsed.root) throw new Error('A drive root cannot be used as a project folder.')
  if (normalizePath(resolved) === normalizePath(homedir())) {
    throw new Error('Your home folder cannot be used as a project folder. Choose or create a subfolder.')
  }
  if (IS_WINDOWS) {
    const rel = resolved.slice(parsed.root.length).toLowerCase()
    if (FORBIDDEN_WINDOWS_ROOTS.some((f) => rel === f || rel.startsWith(`${f}\\`))) {
      throw new Error('System folders cannot be used as a project folder.')
    }
  }
  return resolved
}

/** Windows-safe folder name derived from a project name. */
export function toFolderName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i
  const safe = cleaned || 'project'
  return reserved.test(safe) ? `${safe}-project` : safe.slice(0, 80)
}

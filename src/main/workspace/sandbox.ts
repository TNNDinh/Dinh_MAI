import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { FileContent as SharedFileContent, FileEntry, SearchHit } from '../../shared/ipc'
import { languageFor } from '../../shared/language'
import { isPathInside } from '../security/path-guard'

export type WorkspaceErrorCode = 'outside' | 'invalid' | 'denied' | 'not_found' | 'exists' | 'too_large' | 'conflict' | 'binary' | 'locked' | 'not_a_file' | 'not_a_dir'

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly code: WorkspaceErrorCode
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/** Folders that are generated or huge. Hidden from listings, search and the index (but still reachable by exact path). */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'target', 'bin', 'obj', '__pycache__', '.venv', 'venv',
  '.idea', '.vs', 'Library', 'Temp', 'Logs', '.gradle', 'coverage', '.turbo', '.cache', '.pytest_cache'
])

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'psd', 'tga', 'dds', 'exr', 'hdr', 'tif', 'tiff',
  'mp3', 'wav', 'ogg', 'flac', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'zip', 'gz', 'tgz', '7z', 'rar', 'tar',
  'exe', 'dll', 'so', 'dylib', 'pdb', 'obj', 'o', 'a', 'lib', 'class', 'jar', 'pyc', 'wasm',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'pdf', 'fbx', 'blend', 'glb', 'bin', 'dat', 'db', 'sqlite', 'unitypackage', 'asset', 'prefab', 'meta'
])

export const MAX_READ_BYTES = 1_000_000
export const MAX_WRITE_BYTES = 2_000_000
/** Images and other binary assets. */
export const MAX_BINARY_WRITE_BYTES = 25_000_000
export const MAX_LIST_ENTRIES = 2000
export const MAX_WALK_FILES = 5000

const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const SECRET_NAME = /^(\.env(\..+)?|\.npmrc|\.netrc|\.pypirc|id_rsa.*|id_ed25519.*|id_ecdsa.*|.*\.(pem|key|pfx|p12|keystore|jks))$/i
const SECRET_EXEMPT = /^\.env\.(example|sample|template|dist)$/i

/** Files that commonly hold credentials. Agents may not read them: their content would be sent to a model provider. */
export function isSecretPath(rel: string): boolean {
  const name = basename(rel)
  return SECRET_NAME.test(name) && !SECRET_EXEMPT.test(name)
}

export function isBinaryExt(path: string): boolean {
  const dot = path.lastIndexOf('.')
  return dot >= 0 && BINARY_EXT.has(path.slice(dot + 1).toLowerCase())
}

/**
 * Validates a project-relative path and returns it normalised (forward slashes, no `.`/empty segments).
 * Rejects anything that could name something outside the project or something Windows treats specially.
 */
export function normalizeRel(input: unknown): string {
  if (typeof input !== 'string') throw new WorkspaceError('A path is required.', 'invalid')
  if (input.includes('\0')) throw new WorkspaceError('The path contains a null character.', 'invalid')
  const p = input.replace(/\\/g, '/').trim()
  if (p === '' || p === '.' || p === './') return ''
  if (/^[a-zA-Z]:/.test(p) || p.startsWith('/')) throw new WorkspaceError('Use a path relative to the project folder, not an absolute path.', 'outside')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') throw new WorkspaceError('Paths may not contain "..".', 'outside')
    if (/[<>:"|?*\u0000-\u001f]/.test(seg)) throw new WorkspaceError(`"${seg}" contains a character that is not allowed in file names (< > : " | ? *).`, 'invalid')
    if (/[. ]$/.test(seg)) throw new WorkspaceError(`"${seg}" ends with a dot or space, which Windows does not allow.`, 'invalid')
    if (RESERVED_NAME.test(seg)) throw new WorkspaceError(`"${seg}" is a reserved Windows device name.`, 'invalid')
    if (seg.toLowerCase() === '.git') throw new WorkspaceError('The .git folder is managed by the app and cannot be accessed here.', 'denied')
    out.push(seg)
  }
  return out.join('/')
}

export type FileContent = Omit<SharedFileContent, 'lockedBy'>

export interface WalkedFile {
  path: string
  size: number
  mtimeMs: number
}

export const sha1 = (data: Buffer | string): string => createHash('sha1').update(data).digest('hex')

/**
 * File operations confined to one project folder. Every public method validates its path, resolves symlinks
 * and junctions, and refuses anything that lands outside the root. (A race between the check and the
 * operation is possible for an attacker who can already write inside the project; this is a guard against
 * mistakes and prompt-driven path tricks, not an OS-level sandbox.)
 */
export class Sandbox {
  readonly root: string

  constructor(rootPath: string) {
    let real: string
    try {
      real = realpathSync(rootPath)
      if (!statSync(real).isDirectory()) throw new Error('not a directory')
    } catch {
      throw new WorkspaceError(`The project folder does not exist or is not a folder: ${rootPath}`, 'not_found')
    }
    this.root = real
  }

  /** Absolute path for a project-relative one, after proving it cannot escape the root through links. */
  resolve(rel: string): { rel: string; full: string } {
    const n = normalizeRel(rel)
    const full = n === '' ? this.root : join(this.root, ...n.split('/'))
    let probe = full
    for (;;) {
      try {
        const real = realpathSync(probe)
        if (!isPathInside(this.root, real)) throw new WorkspaceError(`"${n}" resolves outside the project folder (through a link or junction).`, 'outside')
        break
      } catch (e) {
        if (e instanceof WorkspaceError) throw e
        const up = dirname(probe)
        if (up === probe) throw new WorkspaceError('The path could not be resolved.', 'invalid')
        probe = up
      }
    }
    return { rel: n, full }
  }

  async list(rel: string, opts: { includeIgnored?: boolean } = {}): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    const { rel: n, full } = this.resolve(rel)
    let dirents
    try {
      dirents = await fsp.readdir(full, { withFileTypes: true })
    } catch (e) {
      throw this.fsError(e, n || '.')
    }
    const entries: FileEntry[] = []
    for (const d of dirents) {
      if (d.name.toLowerCase() === '.git' || d.isSymbolicLink()) continue
      const isDir = d.isDirectory()
      if (!isDir && !d.isFile()) continue
      const ignored = isDir && IGNORED_DIRS.has(d.name)
      if (ignored && !opts.includeIgnored) continue
      let size = 0
      let mtimeMs = 0
      try {
        const st = await fsp.stat(join(full, d.name))
        size = isDir ? 0 : st.size
        mtimeMs = st.mtimeMs
      } catch {
        continue
      }
      entries.push({ name: d.name, path: n ? `${n}/${d.name}` : d.name, type: isDir ? 'dir' : 'file', size, mtimeMs, ignored })
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1))
    return { entries: entries.slice(0, MAX_LIST_ENTRIES), truncated: entries.length > MAX_LIST_ENTRIES }
  }

  async read(rel: string, opts: { maxBytes?: number } = {}): Promise<FileContent> {
    const { rel: n, full } = this.resolve(rel)
    if (!n) throw new WorkspaceError('That is the project folder, not a file.', 'not_a_file')
    const max = opts.maxBytes ?? MAX_READ_BYTES
    let st
    try {
      st = await fsp.stat(full)
    } catch (e) {
      throw this.fsError(e, n)
    }
    if (!st.isFile()) throw new WorkspaceError(`"${n}" is a folder, not a file.`, 'not_a_file')
    if (st.size > max) throw new WorkspaceError(`"${n}" is ${(st.size / 1024).toFixed(0)} KB, more than the ${(max / 1024).toFixed(0)} KB limit for reading.`, 'too_large')
    const buf = await fsp.readFile(full)
    if (buf.subarray(0, 8000).includes(0)) throw new WorkspaceError(`"${n}" looks like a binary file, which cannot be shown as text.`, 'binary')
    const content = buf.toString('utf8')
    return { path: n, content, size: st.size, mtimeMs: st.mtimeMs, hash: sha1(buf), language: languageFor(n), lines: content === '' ? 0 : content.split('\n').length }
  }

  /** Atomic write (temp file + rename). `expectedHash`: refuse if the file changed since it was read; `null`: refuse if it exists. */
  async write(rel: string, content: string, opts: { expectedHash?: string | null } = {}): Promise<{ path: string; size: number; hash: string; created: boolean }> {
    const { rel: n, full } = this.resolve(rel)
    if (!n) throw new WorkspaceError('A file path is required.', 'invalid')
    if (typeof content !== 'string') throw new WorkspaceError('File content must be text.', 'invalid')
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > MAX_WRITE_BYTES) throw new WorkspaceError(`The content is ${(bytes.length / 1e6).toFixed(1)} MB; the limit is ${(MAX_WRITE_BYTES / 1e6).toFixed(0)} MB.`, 'too_large')
    let existing: Buffer | null = null
    try {
      const st = await fsp.stat(full)
      if (!st.isFile()) throw new WorkspaceError(`"${n}" is a folder, not a file.`, 'not_a_file')
      existing = await fsp.readFile(full)
    } catch (e) {
      if (e instanceof WorkspaceError) throw e
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw this.fsError(e, n)
    }
    if (opts.expectedHash === null && existing) throw new WorkspaceError(`"${n}" already exists.`, 'exists')
    if (typeof opts.expectedHash === 'string' && existing && sha1(existing) !== opts.expectedHash) {
      throw new WorkspaceError(`"${n}" was changed on disk after it was opened.`, 'conflict')
    }
    await fsp.mkdir(dirname(full), { recursive: true })
    const tmp = join(dirname(full), `.${basename(full)}.${randomBytes(4).toString('hex')}.tmp`)
    try {
      await fsp.writeFile(tmp, bytes)
      await fsp.rename(tmp, full)
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
      throw this.fsError(e, n)
    }
    return { path: n, size: bytes.length, hash: sha1(bytes), created: existing === null }
  }

  /** Atomic write of raw bytes (images and other assets). Never overwrites unless `overwrite` is set. */
  async writeBinary(rel: string, data: Buffer, opts: { overwrite?: boolean; maxBytes?: number } = {}): Promise<{ path: string; size: number; hash: string; created: boolean }> {
    const { rel: n, full } = this.resolve(rel)
    if (!n) throw new WorkspaceError('A file path is required.', 'invalid')
    const max = opts.maxBytes ?? MAX_BINARY_WRITE_BYTES
    if (data.length > max) throw new WorkspaceError(`The file is ${(data.length / 1e6).toFixed(1)} MB; the limit is ${(max / 1e6).toFixed(0)} MB.`, 'too_large')
    let existed = false
    try {
      const st = await fsp.stat(full)
      if (!st.isFile()) throw new WorkspaceError(`"${n}" is a folder, not a file.`, 'not_a_file')
      existed = true
    } catch (e) {
      if (e instanceof WorkspaceError) throw e
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw this.fsError(e, n)
    }
    if (existed && !opts.overwrite) throw new WorkspaceError(`"${n}" already exists.`, 'exists')
    await fsp.mkdir(dirname(full), { recursive: true })
    const tmp = join(dirname(full), `.${basename(full)}.${randomBytes(4).toString('hex')}.tmp`)
    try {
      await fsp.writeFile(tmp, data)
      await fsp.rename(tmp, full)
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
      throw this.fsError(e, n)
    }
    return { path: n, size: data.length, hash: sha1(data), created: !existed }
  }

  /** Raw bytes of a file, however large up to `maxBytes`. Unlike `read` it does not refuse binary content. */
  async readBinary(rel: string, opts: { maxBytes?: number } = {}): Promise<Buffer> {
    const { rel: n, full } = this.resolve(rel)
    if (!n) throw new WorkspaceError('That is the project folder, not a file.', 'not_a_file')
    const max = opts.maxBytes ?? MAX_BINARY_WRITE_BYTES
    let st
    try {
      st = await fsp.stat(full)
    } catch (e) {
      throw this.fsError(e, n)
    }
    if (!st.isFile()) throw new WorkspaceError(`"${n}" is a folder, not a file.`, 'not_a_file')
    if (st.size > max) throw new WorkspaceError(`"${n}" is ${(st.size / 1e6).toFixed(1)} MB, more than the ${(max / 1e6).toFixed(0)} MB limit.`, 'too_large')
    return fsp.readFile(full)
  }

  async mkdir(rel: string): Promise<string> {
    const { rel: n, full } = this.resolve(rel)
    if (!n) throw new WorkspaceError('A folder path is required.', 'invalid')
    try {
      await fsp.mkdir(full, { recursive: true })
    } catch (e) {
      throw this.fsError(e, n)
    }
    return n
  }

  async remove(rel: string, opts: { filesOnly?: boolean } = {}): Promise<{ path: string; wasDir: boolean }> {
    const { rel: n, full } = this.resolve(rel)
    if (!n) throw new WorkspaceError('The project folder itself cannot be deleted.', 'denied')
    let st
    try {
      st = await fsp.lstat(full)
    } catch (e) {
      throw this.fsError(e, n)
    }
    if (st.isDirectory() && opts.filesOnly) throw new WorkspaceError(`"${n}" is a folder; only files can be deleted with this tool.`, 'not_a_file')
    try {
      await fsp.rm(full, { recursive: st.isDirectory(), force: false })
    } catch (e) {
      throw this.fsError(e, n)
    }
    return { path: n, wasDir: st.isDirectory() }
  }

  async rename(fromRel: string, toRel: string): Promise<{ from: string; to: string }> {
    const from = this.resolve(fromRel)
    const to = this.resolve(toRel)
    if (!from.rel || !to.rel) throw new WorkspaceError('The project folder itself cannot be renamed.', 'denied')
    if (from.rel === to.rel) throw new WorkspaceError('The new name is the same as the old one.', 'invalid')
    const caseOnly = from.rel.toLowerCase() === to.rel.toLowerCase()
    if (!caseOnly) {
      const taken = await fsp.stat(to.full).then(() => true, () => false)
      if (taken) throw new WorkspaceError(`"${to.rel}" already exists.`, 'exists')
    }
    if (to.rel.toLowerCase().startsWith(`${from.rel.toLowerCase()}/`)) throw new WorkspaceError('A folder cannot be moved into itself.', 'invalid')
    try {
      await fsp.mkdir(dirname(to.full), { recursive: true })
      await fsp.rename(from.full, to.full)
    } catch (e) {
      throw this.fsError(e, from.rel)
    }
    return { from: from.rel, to: to.rel }
  }

  /** Every non-ignored text-like file under `rel`, depth-first. */
  async walk(rel = '', opts: { max?: number; includeBinary?: boolean; maxFileBytes?: number } = {}): Promise<{ files: WalkedFile[]; truncated: boolean }> {
    const max = opts.max ?? MAX_WALK_FILES
    const maxFileBytes = opts.maxFileBytes ?? MAX_READ_BYTES
    const files: WalkedFile[] = []
    let truncated = false
    const start = this.resolve(rel)
    const visit = async (relDir: string, fullDir: string): Promise<void> => {
      let dirents
      try {
        dirents = await fsp.readdir(fullDir, { withFileTypes: true })
      } catch {
        return
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name))
      for (const d of dirents) {
        if (truncated) return
        if (d.name.toLowerCase() === '.git' || d.isSymbolicLink()) continue
        const childRel = relDir ? `${relDir}/${d.name}` : d.name
        if (d.isDirectory()) {
          if (!IGNORED_DIRS.has(d.name)) await visit(childRel, join(fullDir, d.name))
        } else if (d.isFile()) {
          if (!opts.includeBinary && isBinaryExt(d.name)) continue
          let st
          try {
            st = await fsp.stat(join(fullDir, d.name))
          } catch {
            continue
          }
          if (st.size > maxFileBytes) continue
          if (files.length >= max) {
            truncated = true
            return
          }
          files.push({ path: childRel, size: st.size, mtimeMs: st.mtimeMs })
        }
      }
    }
    await visit(start.rel, start.full)
    return { files, truncated }
  }

  /** Plain-text search over the project's text files. `skip` lets the caller exclude files (e.g. secrets). */
  async search(query: string, opts: { regex?: boolean; path?: string; maxResults?: number; caseSensitive?: boolean; skip?: (rel: string) => boolean } = {}): Promise<{ hits: SearchHit[]; truncated: boolean; scanned: number }> {
    if (typeof query !== 'string' || !query) throw new WorkspaceError('A search query is required.', 'invalid')
    if (query.length > 300) throw new WorkspaceError('The search query is too long.', 'invalid')
    let re: RegExp
    try {
      re = new RegExp(opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), opts.caseSensitive ? '' : 'i')
    } catch {
      throw new WorkspaceError('That is not a valid regular expression.', 'invalid')
    }
    const max = opts.maxResults ?? 60
    const { files } = await this.walk(opts.path ?? '', { maxFileBytes: 512_000 })
    const hits: SearchHit[] = []
    let scanned = 0
    let truncated = false
    for (const f of files) {
      if (opts.skip?.(f.path)) continue
      let text: string
      try {
        const buf = await fsp.readFile(join(this.root, ...f.path.split('/')))
        if (buf.subarray(0, 4000).includes(0)) continue
        text = buf.toString('utf8')
      } catch {
        continue
      }
      scanned++
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          if (hits.length >= max) {
            truncated = true
            return { hits, truncated, scanned }
          }
          hits.push({ path: f.path, line: i + 1, text: lines[i].slice(0, 240).trimEnd() })
        }
      }
    }
    return { hits, truncated, scanned }
  }

  private fsError(e: unknown, rel: string): WorkspaceError {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return new WorkspaceError(`"${rel}" does not exist.`, 'not_found')
    if (code === 'ENOTDIR') return new WorkspaceError(`A part of "${rel}" is a file, not a folder.`, 'not_a_dir')
    if (code === 'EEXIST') return new WorkspaceError(`"${rel}" already exists.`, 'exists')
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return new WorkspaceError(`"${rel}" is locked or read-only (another program may be using it): ${code}.`, 'denied')
    return new WorkspaceError(`${rel}: ${e instanceof Error ? e.message : String(e)}`, 'invalid')
  }
}

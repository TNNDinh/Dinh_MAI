import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import type { PreviewInfo, PreviewMode, PreviewOptions } from '../../shared/ipc'
import { detectDevCommand, detectStaticFolders } from '../automation/detect'
import { stripAnsi } from '../automation/parsers'
import type { EventService } from '../services/events'
import { killTree, sanitizedEnv } from '../workspace/commands'
import { normalizeRel } from '../workspace/sandbox'
import type { WorkspaceService } from '../workspace/workspace'
import { startStaticServer, type RunningStaticServer } from './static-server'

const OUTPUT_TAIL = 8000
const START_TIMEOUT_MS = 60_000
const RELOAD_DEBOUNCE_MS = 250

/** The first address a dev server prints that points back at this machine: http://localhost:5173/, http://127.0.0.1:3000 ... */
export function findLocalUrl(text: string): string | null {
  const m = stripAnsi(text).match(/https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})(\/[^\s'"<>)\]]*)?/i)
  if (!m) return null
  const host = m[1].toLowerCase() === '0.0.0.0' ? '127.0.0.1' : m[1]
  return `http://${host}:${m[2]}${m[3] ?? '/'}`
}

interface Session {
  info: PreviewInfo
  server?: RunningStaticServer
  child?: ChildProcess
  timers: Set<NodeJS.Timeout>
  stopped: boolean
}

/**
 * Live preview of a project: either the built-in static file server, or the project's own dev server (its package.json `dev` / `start` script).
 * One preview per project. Only loopback addresses are ever shown; the dev command is chosen from the project's files, never taken from the UI.
 */
export class PreviewService {
  private readonly sessions = new Map<string, Session>()
  private readonly listeners = new Set<(i: PreviewInfo) => void>()
  private readonly reloadTimers = new Map<string, NodeJS.Timeout>()
  private readonly offChange: () => void

  constructor(
    private readonly events: EventService,
    private readonly workspace: WorkspaceService
  ) {
    this.offChange = workspace.onChange((c) => {
      const s = this.sessions.get(c.projectId)
      if (!s || s.info.mode !== 'static' || s.info.status !== 'running') return
      clearTimeout(this.reloadTimers.get(c.projectId))
      this.reloadTimers.set(
        c.projectId,
        setTimeout(() => {
          this.reloadTimers.delete(c.projectId)
          if (s.stopped) return
          s.info.reloadToken++
          this.push(s)
        }, RELOAD_DEBOUNCE_MS)
      )
    })
  }

  subscribe(cb: (i: PreviewInfo) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private push(s: Session): void {
    const snap = { ...s.info }
    for (const l of this.listeners) l(snap)
  }

  options(projectId: string): PreviewOptions {
    const root = this.workspace.sandbox(projectId).root
    return { staticFolders: detectStaticFolders(root), devCommand: detectDevCommand(root) }
  }

  get(projectId: string): PreviewInfo | null {
    const s = this.sessions.get(projectId)
    return s ? { ...s.info } : null
  }

  async start(projectId: string, mode: PreviewMode, folder = ''): Promise<PreviewInfo> {
    const sandbox = this.workspace.sandbox(projectId)
    await this.stop(projectId)
    const s: Session = {
      info: { projectId, mode, status: 'starting', url: null, folder: '', command: null, output: '', message: null, reloadToken: 0, startedAt: Date.now() },
      timers: new Set(),
      stopped: false
    }
    this.sessions.set(projectId, s)
    try {
      if (mode === 'static') await this.startStatic(s, sandbox.root, folder)
      else this.startDev(s, sandbox.root)
    } catch (e) {
      this.fail(s, e instanceof Error ? e.message : String(e))
    }
    this.push(s)
    return { ...s.info }
  }

  private async startStatic(s: Session, root: string, folder: string): Promise<void> {
    const rel = normalizeRel(folder)
    if (!detectStaticFolders(root).includes(rel)) throw new Error(`"${rel || 'the project folder'}" has no index.html to show.`)
    s.info.folder = rel
    s.server = await startStaticServer({ root, folder: rel, token: () => s.info.reloadToken })
    s.info.url = s.server.url
    s.info.status = 'running'
    this.events.record({ projectId: s.info.projectId, type: 'preview.started', message: `Preview of ${rel || 'the project folder'} at ${s.info.url}` })
  }

  private startDev(s: Session, root: string): void {
    const command = detectDevCommand(root)
    if (!command) throw new Error('This project has no dev server: add a "dev" or "start" script to package.json, or preview a static folder instead.')
    s.info.command = command
    // CI=1 (set for build/test runs) makes some dev servers refuse to start or print differently; a dev server is interactive by nature.
    const env: NodeJS.ProcessEnv = { ...sanitizedEnv(), BROWSER: 'none' }
    delete env.CI
    const child = spawn(command, { cwd: root, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    s.child = child
    this.events.record({ projectId: s.info.projectId, type: 'preview.starting', message: `Starting dev server: ${command}` })
    let buffer = ''
    const onData = (b: Buffer): void => {
      const text = stripAnsi(b.toString('utf8'))
      s.info.output = (s.info.output + text).slice(-OUTPUT_TAIL)
      if (s.info.status === 'starting') {
        buffer = (buffer + text).slice(-4000)
        const url = findLocalUrl(buffer)
        if (url) void this.waitForPort(s, url)
      }
      this.push(s)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => this.fail(s, e.message))
    child.on('close', (code) => {
      if (s.stopped) return
      if (s.info.status === 'starting') this.fail(s, `The dev server exited (code ${code}) before it printed a local address.`)
      else {
        s.info.status = 'stopped'
        s.info.message = `The dev server exited (code ${code}).`
        this.push(s)
      }
    })
    const t = setTimeout(() => {
      if (!s.stopped && s.info.status === 'starting') {
        this.kill(s)
        this.fail(s, `No local address appeared in the dev server's output within ${START_TIMEOUT_MS / 1000} seconds.`)
      }
    }, START_TIMEOUT_MS)
    s.timers.add(t)
  }

  private urlProbing = new WeakSet<Session>()

  /** The address was printed; wait until it actually accepts connections before showing it. */
  private async waitForPort(s: Session, url: string): Promise<void> {
    if (this.urlProbing.has(s)) return
    this.urlProbing.add(s)
    const u = new URL(url)
    const host = u.hostname === '[::1]' ? '::1' : u.hostname
    const port = Number(u.port)
    for (let i = 0; i < 120 && !s.stopped && s.info.status === 'starting'; i++) {
      if (await probe(host, port)) {
        if (s.stopped || s.info.status !== 'starting') return
        s.info.url = url
        s.info.status = 'running'
        this.events.record({ projectId: s.info.projectId, type: 'preview.started', message: `Dev server running at ${url}` })
        this.push(s)
        return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  private fail(s: Session, message: string): void {
    s.info.status = 'failed'
    s.info.message = message
    this.events.record({ projectId: s.info.projectId, level: 'warn', type: 'preview.failed', message })
    this.cleanup(s)
    this.push(s)
  }

  private kill(s: Session): void {
    if (s.child) killTree(s.child)
  }

  private cleanup(s: Session): void {
    s.stopped = true
    for (const t of s.timers) clearTimeout(t)
    s.timers.clear()
    this.kill(s)
    void s.server?.close().catch(() => undefined)
  }

  async stop(projectId: string): Promise<void> {
    const s = this.sessions.get(projectId)
    if (!s) return
    clearTimeout(this.reloadTimers.get(projectId))
    this.reloadTimers.delete(projectId)
    const was = s.info.status
    this.cleanup(s)
    this.sessions.delete(projectId)
    if (was !== 'failed' && was !== 'stopped') {
      s.info.status = 'stopped'
      s.info.url = null
      this.events.record({ projectId, type: 'preview.stopped', message: 'Preview stopped' })
      this.push(s)
    }
  }

  /** Emergency stop and quit: nothing may keep running. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)))
  }

  async dispose(): Promise<void> {
    this.offChange()
    await this.stopAll()
  }
}

function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port })
    const done = (ok: boolean): void => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(1500, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { promises as fsp } from 'node:fs'
import { extname } from 'node:path'
import { Sandbox, WorkspaceError, isSecretPath } from '../workspace/sandbox'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.xml': 'application/xml; charset=utf-8'
}

export const RELOAD_PATH = '/__mads/reload'

/** Polls the server and reloads the page when a served file changed. Injected into HTML responses. */
const RELOAD_SNIPPET = `<script>(function(){var t=null;function p(){fetch('${RELOAD_PATH}',{cache:'no-store'}).then(function(r){return r.text()}).then(function(v){if(t!==null&&v!==t){location.reload();return}t=v}).catch(function(){}).then(function(){setTimeout(p,700)})}p()})()</script>`

export interface StaticServerOptions {
  /** Project folder (the sandbox root). */
  root: string
  /** Folder inside it to serve, project-relative ('' = the project folder). */
  folder: string
  /** Current reload token; the page reloads when it changes. */
  token: () => number
}

export interface RunningStaticServer {
  port: number
  url: string
  close(): Promise<void>
}

/**
 * A small file server for previewing a static site. It listens on 127.0.0.1 only, serves GET/HEAD only, never follows a link out of the project,
 * and never serves dotfiles, `.git` or credential-looking files. HTML gets a few lines of script that reload the page when a file changes.
 */
export async function startStaticServer(opts: StaticServerOptions): Promise<RunningStaticServer> {
  const sandbox = new Sandbox(opts.root)
  const base = opts.folder ? sandbox.resolve(opts.folder).rel : ''
  let port = 0

  const server: Server = createServer((req, res) => {
    void handle(req.method ?? '', req.url ?? '/', req.headers.host ?? '').then(
      (r) => {
        res.writeHead(r.status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...r.headers })
        if (req.method === 'HEAD') res.end()
        else res.end(r.body)
      },
      () => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Internal error')
      }
    )
  })

  async function handle(method: string, rawUrl: string, host: string): Promise<{ status: number; headers: Record<string, string>; body: Buffer | string }> {
    const text = (status: number, msg: string): { status: number; headers: Record<string, string>; body: string } => ({ status, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: msg })
    // A page on the web must not be able to read this server through DNS rebinding: only our own address is accepted as Host.
    if (!(host === `127.0.0.1:${port}` || host === `localhost:${port}`)) return text(403, 'Forbidden host')
    if (method !== 'GET' && method !== 'HEAD') return text(405, 'Method not allowed')
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(rawUrl, 'http://x').pathname)
    } catch {
      return text(400, 'Bad request')
    }
    if (pathname === RELOAD_PATH) return text(200, String(opts.token()))
    if (pathname.includes('\0')) return text(400, 'Bad request')
    const segs = pathname.split('/').filter(Boolean)
    if (segs.some((s) => s.startsWith('.') || s === '..')) return text(403, 'Hidden files are not served')
    if (segs.some((s) => isSecretPath(s))) return text(403, 'Credential files are not served')
    let rel = [base, ...segs].filter(Boolean).join('/')
    try {
      let full = sandbox.resolve(rel).full
      let st = await fsp.stat(full)
      if (st.isDirectory()) {
        if (!pathname.endsWith('/') && pathname !== '') return { status: 301, headers: { Location: pathname + '/' }, body: '' }
        rel = [rel, 'index.html'].filter(Boolean).join('/')
        full = sandbox.resolve(rel).full
        st = await fsp.stat(full)
      }
      if (!st.isFile()) return text(404, 'Not found')
      const type = MIME[extname(full).toLowerCase()] ?? 'application/octet-stream'
      let body: Buffer | string = await fsp.readFile(full)
      if (type.startsWith('text/html')) {
        const html = body.toString('utf8')
        const at = html.search(/<\/body>/i)
        body = at >= 0 ? html.slice(0, at) + RELOAD_SNIPPET + html.slice(at) : html + RELOAD_SNIPPET
      }
      return { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)) }, body }
    } catch (e) {
      if (e instanceof WorkspaceError) return text(e.code === 'not_found' ? 404 : 403, 'Not available')
      return text(404, 'Not found')
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  port = (server.address() as AddressInfo).port
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}

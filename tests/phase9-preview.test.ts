import { request } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PreviewInfo } from '../src/shared/ipc'
import { Database } from '../src/main/db/database'
import { PreviewService, findLocalUrl } from '../src/main/preview/service'
import { startStaticServer, type RunningStaticServer } from '../src/main/preview/static-server'
import { EventService } from '../src/main/services/events'
import { ContextIndexer } from '../src/main/workspace/indexer'
import { FileLocks } from '../src/main/workspace/locks'
import { WorkspaceService } from '../src/main/workspace/workspace'

interface Res {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** Raw HTTP so the path and Host header are sent exactly as written (fetch would normalise them). */
function http(server: { port: number }, path: string, opts: { method?: string; host?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path, method: opts.method ?? 'GET', headers: { Host: opts.host ?? `127.0.0.1:${server.port}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

let dir: string
const w = (rel: string, text: string): void => {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'mads-prev-')))
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })) // Windows keeps a killed child's cwd locked for a moment

describe('findLocalUrl', () => {
  it('finds loopback addresses in dev-server output', () => {
    expect(findLocalUrl('  VITE v6  ready\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host')).toBe('http://localhost:5173/')
    expect(findLocalUrl('\u001b[32mListening on http://127.0.0.1:3000\u001b[0m')).toBe('http://127.0.0.1:3000/')
    expect(findLocalUrl('http://0.0.0.0:8080/app')).toBe('http://127.0.0.1:8080/app')
    expect(findLocalUrl('started at http://[::1]:4000/')).toBe('http://[::1]:4000/')
  })
  it('ignores addresses that are not this machine', () => {
    expect(findLocalUrl('docs at https://example.com:8080/')).toBeNull()
    expect(findLocalUrl('Network: http://192.168.1.20:5173/')).toBeNull()
    expect(findLocalUrl('nothing')).toBeNull()
  })
})

describe('static server', () => {
  let server: RunningStaticServer
  let token = 0
  beforeEach(async () => {
    token = 0
    w('index.html', '<html><body><h1>Home</h1></body></html>')
    w('app.js', 'console.log(1)')
    w('style.css', 'body{}')
    w('sub/index.html', '<p>sub</p>')
    w('sub/data.json', '{"a":1}')
    w('.env', 'SECRET=1')
    w('.hidden/x.txt', 'nope')
    w('keys/server.pem', 'PRIVATE')
    w('www/index.html', '<p>www root</p>')
    server = await startStaticServer({ root: dir, folder: '', token: () => token })
  })
  afterEach(() => server.close())

  it('serves files with the right types and no caching, on loopback only', async () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    const js = await http(server, '/app.js')
    expect(js).toMatchObject({ status: 200, body: 'console.log(1)' })
    expect(js.headers['content-type']).toContain('text/javascript')
    expect(js.headers['cache-control']).toBe('no-store')
    expect(js.headers['x-content-type-options']).toBe('nosniff')
    expect((await http(server, '/style.css')).headers['content-type']).toContain('text/css')
    expect((await http(server, '/sub/data.json')).headers['content-type']).toContain('application/json')
  })

  it('serves index.html for folders and redirects a folder without a trailing slash', async () => {
    expect((await http(server, '/')).body).toContain('<h1>Home</h1>')
    expect((await http(server, '/sub/')).body).toContain('sub')
    const r = await http(server, '/sub')
    expect(r.status).toBe(301)
    expect(r.headers.location).toBe('/sub/')
  })

  it('injects the reload script into HTML only, and the token endpoint follows file changes', async () => {
    const html = await http(server, '/')
    expect(html.body).toContain('/__mads/reload')
    expect(html.body.indexOf('<script>')).toBeLessThan(html.body.indexOf('</body>'))
    expect(html.headers['content-length']).toBe(String(Buffer.byteLength(html.body)))
    expect((await http(server, '/app.js')).body).not.toContain('__mads')
    expect((await http(server, '/__mads/reload')).body).toBe('0')
    token = 3
    expect((await http(server, '/__mads/reload')).body).toBe('3')
  })

  it('answers 404 for missing files', async () => {
    expect((await http(server, '/nope.html')).status).toBe(404)
    expect((await http(server, '/sub/nope/')).status).toBe(404)
  })

  it('never serves dotfiles, credential files or anything outside the project', async () => {
    for (const p of ['/.env', '/.hidden/x.txt', '/.git/config', '/keys/server.pem', '/%2e%2e/secret.txt', '/..%2f..%2fwindows/win.ini', '/sub/%2e%2e/%2e%2e/x', '/%00.html']) {
      const r = await http(server, p)
      expect(r.status, p).toBeGreaterThanOrEqual(400)
      expect(r.body, p).not.toContain('SECRET=1')
      expect(r.body, p).not.toContain('PRIVATE')
    }
  })

  it('does not follow a link that leads out of the project', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'mads-outside-')))
    try {
      writeFileSync(join(outside, 'leak.txt'), 'LEAKED')
      try {
        symlinkSync(outside, join(dir, 'link'), 'junction')
      } catch {
        return // links cannot be created here: nothing to test
      }
      const r = await http(server, '/link/leak.txt')
      expect(r.status).toBeGreaterThanOrEqual(400)
      expect(r.body).not.toContain('LEAKED')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('accepts only GET and HEAD, and only its own Host name (DNS rebinding)', async () => {
    expect((await http(server, '/', { method: 'POST' })).status).toBe(405)
    expect((await http(server, '/', { method: 'HEAD' })).status).toBe(200)
    expect((await http(server, '/', { host: 'evil.example.com' })).status).toBe(403)
    expect((await http(server, '/', { host: `localhost:${server.port}` })).status).toBe(200)
  })

  it('can serve a sub-folder as its root and refuses a folder outside the project', async () => {
    const s2 = await startStaticServer({ root: dir, folder: 'www', token: () => 0 })
    try {
      expect((await http(s2, '/')).body).toContain('www root')
      expect((await http(s2, '/app.js')).status).toBe(404)
    } finally {
      await s2.close()
    }
    await expect(startStaticServer({ root: dir, folder: '../x', token: () => 0 })).rejects.toThrow()
  })

  it('stops listening when closed', async () => {
    const s2 = await startStaticServer({ root: dir, folder: '', token: () => 0 })
    await s2.close()
    await expect(http(s2, '/')).rejects.toThrow()
  })
})

describe('PreviewService', () => {
  let db: Database
  let ws: WorkspaceService
  let svc: PreviewService
  let updates: PreviewInfo[]

  beforeEach(() => {
    db = new Database(':memory:')
    db.migrate()
    db.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p1', 'P', 'web', ?, 1, 1)`, dir)
    const events = new EventService(db)
    ws = new WorkspaceService(db, events, new FileLocks(db), new ContextIndexer(db))
    svc = new PreviewService(events, ws)
    updates = []
    svc.subscribe((i) => updates.push(i))
  })
  afterEach(async () => {
    await svc.dispose()
  })

  const until = async (cond: () => boolean, ms = 15000): Promise<void> => {
    const end = Date.now() + ms
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out waiting')
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('offers the folders and the dev command the project actually has', () => {
    expect(svc.options('p1')).toEqual({ staticFolders: [], devCommand: null })
    w('index.html', '<p>x</p>')
    w('package.json', JSON.stringify({ scripts: { dev: 'vite' } }))
    expect(svc.options('p1')).toEqual({ staticFolders: [''], devCommand: 'npm run dev' })
  })

  it('previews a static folder, reloads on file changes and stops cleanly', async () => {
    w('index.html', '<body>hello</body>')
    const info = await svc.start('p1', 'static', '')
    expect(info).toMatchObject({ mode: 'static', status: 'running', reloadToken: 0 })
    const res = await http({ port: Number(new URL(info.url!).port) }, '/')
    expect(res.body).toContain('hello')
    ws.notify({ projectId: 'p1', path: 'index.html', kind: 'write', by: 'agent' })
    ws.notify({ projectId: 'p1', path: 'app.js', kind: 'write', by: 'agent' })
    await until(() => svc.get('p1')!.reloadToken === 1)
    await new Promise((r) => setTimeout(r, 400))
    expect(svc.get('p1')!.reloadToken).toBe(1) // the two changes were one burst
    ws.notify({ projectId: 'other', path: 'x', kind: 'write', by: 'agent' })
    await new Promise((r) => setTimeout(r, 400))
    expect(svc.get('p1')!.reloadToken).toBe(1)
    await svc.stop('p1')
    expect(svc.get('p1')).toBeNull()
    expect(updates[updates.length - 1].status).toBe('stopped')
    await expect(http({ port: Number(new URL(info.url!).port) }, '/')).rejects.toThrow()
  })

  it('refuses a folder without index.html or outside the project', async () => {
    expect(await svc.start('p1', 'static', '')).toMatchObject({ status: 'failed', message: expect.stringContaining('no index.html') })
    w('index.html', 'x')
    expect(await svc.start('p1', 'static', '../escape')).toMatchObject({ status: 'failed' })
    expect(await svc.start('p1', 'static', '.git')).toMatchObject({ status: 'failed' })
  })

  it('refuses a dev preview when the project has no dev script', async () => {
    const info = await svc.start('p1', 'dev')
    expect(info.status).toBe('failed')
    expect(info.message).toMatch(/no dev server/)
  })

  it('runs the project\'s own dev server, shows its address once it accepts connections, and kills it on stop', async () => {
    // A real HTTP server started by the project's own "dev" script, listening on a free port and printing its address like Vite or Next do.
    w(
      'server.js',
      "const http = require('http'); const s = http.createServer((q, r) => r.end('dev ok')); s.listen(0, '127.0.0.1', () => console.log('  Local:   http://127.0.0.1:' + s.address().port + '/'))"
    )
    w('package.json', JSON.stringify({ scripts: { dev: 'node server.js' } }))
    const started = await svc.start('p1', 'dev')
    expect(started.status).toBe('starting')
    expect(started.command).toBe('npm run dev')
    await until(() => svc.get('p1')?.status === 'running')
    const info = svc.get('p1')!
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(info.output).toContain('Local:')
    expect((await http({ port: Number(new URL(info.url!).port) }, '/')).body).toBe('dev ok')
    await svc.stop('p1')
    // The process tree is gone: the port stops answering.
    const port = Number(new URL(info.url!).port)
    let dead = false
    for (let i = 0; i < 60 && !dead; i++) {
      dead = await http({ port }, '/').then(
        () => false,
        () => true
      )
      if (!dead) await new Promise((r) => setTimeout(r, 100))
    }
    expect(dead).toBe(true)
  })

  it('reports a dev server that exits before printing an address', async () => {
    w('package.json', JSON.stringify({ scripts: { dev: 'node -e "console.error(\'boom\'); process.exit(3)"' } }))
    await svc.start('p1', 'dev')
    await until(() => svc.get('p1')?.status === 'failed')
    const info = svc.get('p1')!
    expect(info.message).toMatch(/exited \(code 3\)/)
    expect(info.output).toContain('boom')
  })

  it('starting again replaces the previous preview', async () => {
    w('index.html', 'x')
    const a = await svc.start('p1', 'static', '')
    const b = await svc.start('p1', 'static', '')
    expect(b.url).not.toBe(a.url)
    await expect(http({ port: Number(new URL(a.url!).port) }, '/')).rejects.toThrow()
  })
})

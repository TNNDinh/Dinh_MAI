import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AssetService } from '../src/main/assets/service'
import { FORMAT_EXT, bgraToRaster, decodeImage, imageFormat, imageSize, setForeignDecoder } from '../src/main/assets/codec'
import { assetFolder, guessKind, slugify, suggestName, uniquePath } from '../src/main/assets/conventions'
import { PixelError, decodePng, encodePng, hasTransparency, newRaster } from '../src/main/assets/pixels'
import { Database } from '../src/main/db/database'
import { MIGRATIONS } from '../src/main/db/migrations'
import { CallCancelledError, type CompleteRequest, type CompleteResult, type LlmGateway } from '../src/main/orchestrator/gateway'
import { environmentNote, Orchestrator } from '../src/main/orchestrator/orchestrator'
import { plannerInstructions } from '../src/main/orchestrator/plan'
import { toolsFor } from '../src/main/orchestrator/tools'
import { createChatProvider, createImageProvider } from '../src/main/providers/registry'
import { AgentService } from '../src/main/services/agents'
import { ConnectionService } from '../src/main/services/connections'
import { EventService } from '../src/main/services/events'
import { TaskService } from '../src/main/services/tasks'
import { ApprovalService, CommandService } from '../src/main/workspace/commands'
import { ContextIndexer } from '../src/main/workspace/indexer'
import { FileLocks } from '../src/main/workspace/locks'
import { WorkspaceService } from '../src/main/workspace/workspace'
import type { FsChange } from '../src/shared/ipc'
import { MemorySecrets } from './helpers/memory-secrets'
import { MockServer, json } from './helpers/mock-server'

const server = new MockServer()
beforeAll(() => server.start())
afterAll(() => server.stop())

const tmpRoots: string[] = []
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true })
})

const until = async (cond: () => boolean, ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A real PNG built by our encoder: white background with a red square in the middle (a flat background to remove). */
function squarePng(size = 64, square = 24, transparent = false): Buffer {
  const img = newRaster(size, size)
  const lo = (size - square) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= lo && x < lo + square && y >= lo && y < lo + square
      img.data.set(inside ? [200, 30, 30, 255] : transparent ? [0, 0, 0, 0] : [255, 255, 255, 255], (y * size + x) * 4)
    }
  }
  return encodePng(img)
}

/** Opaque noise: no flat background, so background removal must refuse. */
function noisePng(): Buffer {
  const img = newRaster(32, 32)
  let s = 12345
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    img.data.set([s & 255, (s >> 8) & 255, (s >> 16) & 255, 255], i)
  }
  return encodePng(img)
}

const b64 = (b: Buffer): string => b.toString('base64')

// ------------------------------------------------------------------ conventions

describe('asset folder conventions', () => {
  it('follows the layout of each project type', () => {
    expect(assetFolder('unity', 'sprite')).toBe('Assets/Sprites')
    expect(assetFolder('unity', 'ui')).toBe('Assets/UI')
    expect(assetFolder('unreal', 'texture')).toBe('SourceArt/textures')
    expect(assetFolder('react', 'icon')).toBe('public/assets/icons')
    expect(assetFolder('nextjs', 'background')).toBe('public/assets/backgrounds')
    expect(assetFolder('web', 'concept')).toBe('assets/concepts')
    expect(assetFolder('something-new', 'other')).toBe('assets/other')
  })

  it('makes safe, readable file names', () => {
    expect(slugify('Goblin Warrior!! (idle)')).toBe('goblin-warrior-idle')
    expect(slugify('Đồ họa nền')).toBe('do-hoa-nen')
    expect(slugify('../../etc/passwd')).toBe('etc-passwd')
    expect(slugify('???', 'icon')).toBe('icon')
    expect(slugify('x'.repeat(100)).length).toBeLessThanOrEqual(40)
    expect(suggestName('  My Hero ', 'ignored', 'sprite')).toBe('my-hero')
    expect(suggestName(undefined, 'a green goblin with a club standing in a cave at night', 'sprite')).toBe('a-green-goblin-with-a-club')
    expect(suggestName('', '', 'texture')).toBe('texture')
  })

  it('finds a free path with numeric suffixes', () => {
    const taken = new Set(['assets/a.png', 'assets/a-2.png'])
    expect(uniquePath('assets', 'a', 'png', (p) => taken.has(p))).toBe('assets/a-3.png')
    expect(uniquePath('', 'a', 'png', () => false)).toBe('a.png')
  })

  it('guesses the kind of picture from a task text', () => {
    expect(guessKind('Create an app icon')).toBe('icon')
    expect(guessKind('Goblin enemy sprite')).toBe('sprite')
    expect(guessKind('Seamless stone texture')).toBe('texture')
    expect(guessKind('Forest background with parallax')).toBe('background')
    expect(guessKind('Main menu button')).toBe('ui')
    expect(guessKind('Moody key art')).toBe('concept')
  })
})

// ------------------------------------------------------------------ codec

describe('image codec', () => {
  afterEach(() => setForeignDecoder(null))

  it('recognises formats from bytes', () => {
    expect(imageFormat(squarePng())).toBe('png')
    expect(imageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(imageFormat(Buffer.from('GIF89a......'))).toBe('gif')
    expect(imageFormat(Buffer.from('RIFF....WEBPVP8 '))).toBe('webp')
    expect(imageFormat(Buffer.from('hello world'))).toBeNull()
    expect(FORMAT_EXT.jpeg).toBe('jpg')
  })

  it('reads sizes from headers without decoding', () => {
    expect(imageSize(squarePng(40))).toEqual({ width: 40, height: 40 })
    const gif = Buffer.alloc(16)
    gif.write('GIF89a', 0, 'latin1')
    gif.writeUInt16LE(30, 6)
    gif.writeUInt16LE(20, 8)
    expect(imageSize(gif)).toEqual({ width: 30, height: 20 })
    // JPEG: SOI, an APP0 segment to skip, then SOF0 with height 480, width 640.
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x01, 0x01, 0x11, 0x00])
    expect(imageSize(jpg)).toEqual({ width: 640, height: 480 })
    // WebP lossless (VP8L): 14-bit width-1 and height-1 packed after the signature byte.
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'latin1')
    webp.write('WEBP', 8, 'latin1')
    webp.write('VP8L', 12, 'latin1')
    webp[20] = 0x2f
    webp.writeUInt32LE((99 | (49 << 14)) >>> 0, 21)
    expect(imageSize(webp)).toEqual({ width: 100, height: 50 })
    // WebP extended (VP8X): 24-bit width-1 and height-1.
    const vp8x = Buffer.alloc(30)
    vp8x.write('RIFF', 0, 'latin1')
    vp8x.write('WEBP', 8, 'latin1')
    vp8x.write('VP8X', 12, 'latin1')
    vp8x.writeUIntLE(255, 24, 3)
    vp8x.writeUIntLE(127, 27, 3)
    expect(imageSize(vp8x)).toEqual({ width: 256, height: 128 })
    expect(imageSize(Buffer.from('nope'))).toBeNull()
    expect(imageSize(squarePng().subarray(0, 10))).toBeNull()
  })

  it('converts the host bitmap (BGRA, premultiplied) to straight RGBA', () => {
    const bgra = new Uint8Array([10, 20, 30, 255, 50, 40, 20, 128, 9, 9, 9, 0])
    const r = bgraToRaster(bgra, 3, 1, true)
    expect([...r.data.slice(0, 4)]).toEqual([30, 20, 10, 255])
    // 128 alpha: colours are divided by alpha again (r 20 -> 40, g 40 -> 80, b 50 -> 100).
    expect([...r.data.slice(4, 8)]).toEqual([40, 80, 100, 128])
    expect(r.data[11]).toBe(0)
    expect([...bgraToRaster(bgra, 3, 1, false).data.slice(4, 8)]).toEqual([20, 40, 50, 128])
    expect(() => bgraToRaster(new Uint8Array(4), 2, 2)).toThrow(PixelError)
  })

  it('decodes PNG itself and sends everything else to the host decoder, or says it cannot', () => {
    expect(decodeImage(squarePng(8, 4)).width).toBe(8)
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])
    expect(() => decodeImage(jpeg)).toThrow(/only be read inside the running app/)
    let calls = 0
    setForeignDecoder((data) => {
      calls++
      expect(data.equals(jpeg)).toBe(true)
      const r = newRaster(2, 2)
      return r
    })
    expect(decodeImage(jpeg).width).toBe(2)
    expect(calls).toBe(1)
    setForeignDecoder(() => null)
    expect(() => decodeImage(jpeg)).toThrow(/could not be decoded/)
  })

  it('does not hand corrupt PNGs to the host decoder', () => {
    let called = false
    setForeignDecoder(() => {
      called = true
      return newRaster(1, 1)
    })
    const broken = squarePng().subarray(0, 60)
    expect(() => decodeImage(broken)).toThrow(PixelError)
    expect(called).toBe(false)
  })
})

// ------------------------------------------------------------------ migration

describe('migration v5', () => {
  it('adds image prices and asset provenance on top of an older database', () => {
    const old = new Database(':memory:')
    old.migrate(MIGRATIONS.slice(0, 4))
    old.run(`INSERT INTO projects (id, name, type, root_path, created_at, updated_at) VALUES ('p', 'P', 'web', 'x', 1, 1)`)
    old.run(`INSERT INTO assets (id, project_id, kind, name, rel_path, created_at) VALUES ('a', 'p', 'sprite', 'a.png', 'a.png', 1)`)
    expect(old.migrate()).toBe(MIGRATIONS[MIGRATIONS.length - 1].version)
    const cols = old.all<{ name: string }>(`PRAGMA table_info(assets)`).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['origin', 'bytes']))
    expect(old.get<{ origin: string; bytes: number }>(`SELECT origin, bytes FROM assets WHERE id = 'a'`)).toEqual({ origin: 'generated', bytes: 0 })
    expect(old.all(`SELECT * FROM image_pricing`)).toEqual([])
  })
})

// ------------------------------------------------------------------ fixtures

let db: Database
let events: EventService
let conns: ConnectionService
let agents: AgentService
let tasks: TaskService
let ws: WorkspaceService
let assets: AssetService
let commands: CommandService
let connId: string
let root: string
let changes: FsChange[]

const KEY = 'sk-test-key-0123456789'

beforeEach(async () => {
  server.reset()
  server.handler = (_r, res) => json(res, 404, {})
  root = mkdtempSync(join(tmpdir(), 'mads-p7-'))
  tmpRoots.push(root)
  db = new Database(':memory:')
  db.migrate()
  events = new EventService(db)
  conns = new ConnectionService(db, events, new MemorySecrets(), {
    providerFactory: (c) => createChatProvider({ ...c, maxRetries: 0 }),
    imageProviderFactory: (c) => createImageProvider({ ...c, maxRetries: 0 })
  })
  agents = new AgentService(db, events, conns)
  tasks = new TaskService(db, events)
  ws = new WorkspaceService(db, events, new FileLocks(db), new ContextIndexer(db))
  commands = new CommandService(db, events, new ApprovalService())
  assets = new AssetService({ db, events, workspace: ws, connections: conns })
  changes = []
  ws.onChange((c) => changes.push(c))
  db.run(`INSERT INTO projects (id, name, type, root_path, goal, created_at, updated_at) VALUES ('p1', 'Proj', 'web', ?, 'Ship the thing', 1, 1)`, root)
  connId = (await conns.create({ kind: 'openai', name: 'Conn', baseUrl: `${server.url}/v1`, apiKey: KEY })).id
})

/** The loopback OpenAI-wire server answers every image request with the given picture. */
const serveImage = (png: Buffer = squarePng()): void => {
  server.handler = (r, res) => {
    if (!r.url.endsWith('/images/generations') && !r.url.endsWith('/images/edits')) return json(res, 404, {})
    const n = typeof r.body === 'object' && r.body && typeof r.body.n === 'number' ? r.body.n : 1
    json(res, 200, { data: Array.from({ length: n }, () => ({ b64_json: b64(png) })) })
  }
}

const gen = (over: Partial<Parameters<AssetService['generate']>[0]> = {}) =>
  assets.generate({ requestId: randomUUID(), projectId: 'p1', connectionId: connId, model: 'gpt-image-1', prompt: 'a red square on white', kind: 'sprite', count: 1, transparent: false, ...over })

// ------------------------------------------------------------------ the asset service

describe('AssetService.generate', () => {
  it('saves the picture in the project convention folder and records it', async () => {
    serveImage()
    const r = await gen({ name: 'Red Square' })
    expect(r.assets).toHaveLength(1)
    const a = r.assets[0]
    expect(a).toMatchObject({ projectId: 'p1', kind: 'sprite', name: 'red-square.png', path: 'assets/sprites/red-square.png', model: 'gpt-image-1', width: 64, height: 64, transparent: false, origin: 'generated', exists: true, connectionName: 'Conn' })
    expect(a.prompt).toBe('a red square on white')
    const onDisk = readFileSync(join(root, 'assets/sprites/red-square.png'))
    expect(onDisk.equals(squarePng())).toBe(true)
    expect(a.bytes).toBe(onDisk.length)
    expect(changes).toContainEqual({ projectId: 'p1', path: 'assets/sprites/red-square.png', kind: 'write', by: 'user' })
    expect(db.get(`SELECT 1 FROM events WHERE type = 'asset.generated'`)).toBeTruthy()
    expect(assets.list('p1')).toHaveLength(1)
    expect(assets.list('p1', 'icon')).toHaveLength(0)
  })

  it('sends the key to the provider and the requested settings', async () => {
    serveImage()
    await gen({ size: '1920x1080', transparent: true })
    const rec = server.requests[0]
    expect(rec.url).toBe('/v1/images/generations')
    expect(rec.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(rec.body).toMatchObject({ model: 'gpt-image-1', n: 1, size: '1536x1024', background: 'transparent' })
  })

  it('never overwrites: a second picture with the same name gets a suffix', async () => {
    serveImage(squarePng(64, 24))
    await gen({ name: 'hero' })
    serveImage(squarePng(32, 8))
    const b = (await gen({ name: 'hero' })).assets[0]
    expect(b.path).toBe('assets/sprites/hero-2.png')
    expect(readFileSync(join(root, 'assets/sprites/hero.png')).equals(squarePng(64, 24))).toBe(true)
  })

  it('uses the Unity folder layout for Unity projects', async () => {
    db.run(`UPDATE projects SET type = 'unity' WHERE id = 'p1'`)
    serveImage()
    expect((await gen({ kind: 'ui', name: 'btn' })).assets[0].path).toBe('Assets/UI/btn.png')
  })

  it('records the call with the price per image, and says so when no price is known', async () => {
    serveImage()
    const unpriced = await gen()
    expect(unpriced.costUsd).toBeNull()
    expect(unpriced.notes.join(' ')).toMatch(/No price is set for gpt-image-1/)
    expect(db.get<{ cost_usd: number | null; kind: string; input_tokens: number }>(`SELECT cost_usd, kind, input_tokens FROM llm_calls`)).toEqual({ cost_usd: null, kind: 'image', input_tokens: 0 })

    conns.setImagePrice(connId, 'gpt-image-1', 0.04)
    const priced = await gen({ count: 2 })
    expect(priced.assets).toHaveLength(2)
    expect(priced.costUsd).toBeCloseTo(0.08)
    expect(db.all<{ cost_usd: number | null }>(`SELECT cost_usd FROM llm_calls ORDER BY created_at, rowid`).map((r) => r.cost_usd)).toEqual([null, 0.08])
  })

  it('removes a flat background itself when the model cannot make transparent pictures, and says so', async () => {
    serveImage(squarePng(64, 24))
    const r = await gen({ model: 'dall-e-3', transparent: true, name: 'cut' })
    const a = r.assets[0]
    expect(a.transparent).toBe(true)
    expect(r.notes.join(' ')).toMatch(/cannot make transparent pictures/)
    const sent = server.requests[0].body.prompt as string
    expect(sent).toContain('plain, solid, uniform white background')
    expect(a.prompt).toBe('a red square on white')
    const raster = decodePng(readFileSync(join(root, a.path)))
    expect(hasTransparency(raster)).toBe(true)
    expect(raster.data[3]).toBe(0)
    const center = (32 * 64 + 32) * 4
    expect([...raster.data.slice(center, center + 4)]).toEqual([200, 30, 30, 255])
  })

  it('keeps the model’s own transparency when it delivers it', async () => {
    serveImage(squarePng(64, 24, true))
    const r = await gen({ transparent: true })
    expect(r.assets[0].transparent).toBe(true)
    expect(r.notes.filter((n) => /removed/.test(n))).toEqual([])
    expect(readFileSync(join(root, r.assets[0].path)).equals(squarePng(64, 24, true))).toBe(true)
  })

  it('saves the picture as it came and explains when the background cannot be removed', async () => {
    serveImage(noisePng())
    const r = await gen({ transparent: true })
    expect(r.assets[0].transparent).toBe(false)
    expect(r.notes.join(' ')).toMatch(/background could not be removed automatically/)
  })

  it('validates input before spending anything', async () => {
    serveImage()
    await expect(gen({ prompt: '   ' })).rejects.toThrow(/Describe the picture/)
    await expect(gen({ prompt: 'x'.repeat(4001) })).rejects.toThrow(/limit is 4000/)
    await expect(gen({ count: 0 })).rejects.toThrow(/between 1 and/)
    await expect(gen({ count: 99 })).rejects.toThrow(/between 1 and/)
    await expect(gen({ model: ' ' })).rejects.toThrow(/Choose an image model/)
    await expect(gen({ size: 'big' })).rejects.toThrow(/1024x1024/)
    await expect(gen({ projectId: 'nope' })).rejects.toThrow()
    await expect(gen({ connectionId: 'nope' })).rejects.toThrow(/no longer exists/)
    await conns.update({ id: connId, enabled: false })
    await expect(gen()).rejects.toThrow(/turned off/)
    expect(server.requests).toHaveLength(0)
    expect(db.all(`SELECT 1 FROM llm_calls`)).toHaveLength(0)
  })

  it('refuses providers without an image API', async () => {
    const a = await conns.create({ kind: 'anthropic', name: 'Claude', apiKey: 'sk-ant-0123456789abcdef' })
    await expect(gen({ connectionId: a.id, model: 'claude-x' })).rejects.toThrow(/no image generation API/)
  })

  it('records a failure without leaking the key, and saves nothing', async () => {
    server.handler = (_r, res) => json(res, 401, { error: { message: `Incorrect API key provided: ${KEY}` } })
    const err = (await gen().catch((e) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).not.toContain(KEY)
    const call = db.get<{ status: string; error: string; cost_usd: number | null }>(`SELECT status, error, cost_usd FROM llm_calls`)!
    expect(call.status).toBe('error')
    expect(call.error).not.toContain(KEY)
    expect(call.cost_usd).toBeNull()
    expect(assets.list('p1')).toEqual([])
    expect(db.get(`SELECT 1 FROM events WHERE type = 'asset.failed'`)).toBeTruthy()
    expect(JSON.stringify(db.all(`SELECT message FROM events`))).not.toContain(KEY)
  })

  it('can be cancelled while the provider is working', async () => {
    server.handler = () => undefined // never answers
    const p = gen({ requestId: 'r-cancel' })
    p.catch(() => undefined)
    await until(() => server.requests.length > 0)
    expect(assets.cancel('r-cancel')).toBe(true)
    await expect(p).rejects.toThrow(/stopped/)
    expect(assets.cancel('r-cancel')).toBe(false)
    expect(db.get<{ status: string }>(`SELECT status FROM llm_calls`)?.status).toBe('cancelled')
    expect(assets.list('p1')).toEqual([])
  })

  it('stops with the run that asked for it', async () => {
    server.handler = () => undefined
    const ctl = new AbortController()
    const p = assets.generate({ requestId: 'r2', projectId: 'p1', connectionId: connId, model: 'gpt-image-1', prompt: 'x', kind: 'concept', count: 1, transparent: false }, { signal: ctl.signal })
    p.catch(() => undefined)
    await until(() => server.requests.length > 0)
    ctl.abort()
    await expect(p).rejects.toThrow(/stopped/)
  })

  it('attributes the call to the run, task and agent that made it', async () => {
    serveImage()
    db.run(`INSERT INTO runs (id, project_id, goal, status, created_at) VALUES ('run1', 'p1', 'g', 'running', 1)`)
    db.run(`INSERT INTO tasks (id, project_id, run_id, title, description, status, created_at, updated_at) VALUES ('t1', 'p1', 'run1', 'T', '', 'in_progress', 1, 1)`)
    const agent = agents.create({ templateKey: 'image_generator', projectId: 'p1', connectionId: connId, model: 'gpt-image-1' })
    const r = await assets.generate(
      { requestId: 'x1', projectId: 'p1', connectionId: connId, model: 'gpt-image-1', prompt: 'p', kind: 'icon', count: 1, transparent: false },
      { runId: 'run1', taskId: 't1', agent: { id: agent.id, name: agent.name } }
    )
    expect(db.get(`SELECT run_id, task_id, agent_id FROM llm_calls`)).toEqual({ run_id: 'run1', task_id: 't1', agent_id: agent.id })
    expect(db.get<{ task_id: string }>(`SELECT task_id FROM assets WHERE id = ?`, r.assets[0].id)?.task_id).toBe('t1')
    expect(changes[0].by).toBe('agent')
  })

  it('edits an existing asset when asked to vary it, and records the lineage', async () => {
    serveImage()
    const first = (await gen({ name: 'base' })).assets[0]
    server.reset()
    const second = (await gen({ name: 'variant', referenceAssetId: first.id })).assets[0]
    expect(server.requests[0].url).toBe('/v1/images/edits')
    expect(second.parentId).toBe(first.id)
    await expect(gen({ referenceAssetId: 'nope' })).rejects.toThrow(/not found/i)
  })

  it('describes models that were typed in by hand', () => {
    expect(assets.describeModel(connId, 'gpt-image-1')).toMatchObject({ providerKind: 'openai', listedAsImage: false, supportsEdit: true, priceUsd: null })
    conns.setImagePrice(connId, 'gpt-image-1', 0.5)
    expect(assets.describeModel(connId, 'gpt-image-1')?.priceUsd).toBe(0.5)
    expect(assets.describeModel('missing', 'x')).toBeNull()
  })

  it('lists only models the provider reports as image models, with their price', () => {
    db.run(`INSERT INTO connection_models (connection_id, model, kind, fetched_at) VALUES (?, 'gpt-image-1', 'image', 1), (?, 'gpt-4o', 'chat', 1)`, connId, connId)
    conns.setImagePrice(connId, 'gpt-image-1', 0.04)
    const list = assets.imageModels()
    expect(list.map((m) => m.model)).toEqual(['gpt-image-1'])
    expect(list[0]).toMatchObject({ connectionName: 'Conn', priceUsd: 0.04, listedAsImage: true })
  })

  it('remembers hand-typed models once they have a price, and marks them as not listed by the provider', () => {
    expect(assets.imageModels()).toEqual([])
    conns.setImagePrice(connId, 'my-custom-image', 0.02)
    const list = assets.imageModels()
    expect(list.map((m) => m.model)).toEqual(['my-custom-image'])
    expect(list[0]).toMatchObject({ listedAsImage: false, priceUsd: 0.02 })
    // listing the same model as an image model later does not duplicate it
    db.run(`INSERT INTO connection_models (connection_id, model, kind, fetched_at) VALUES (?, 'my-custom-image', 'image', 1)`, connId)
    expect(assets.imageModels().map((m) => m.model)).toEqual(['my-custom-image'])
  })
})

describe('image prices', () => {
  it('are validated and can be cleared', () => {
    conns.setImagePrice(connId, 'm', 0.1)
    expect(conns.imagePriceFor(connId, 'm')).toBe(0.1)
    conns.setImagePrice(connId, 'm', 0)
    expect(conns.imagePriceFor(connId, 'm')).toBe(0)
    conns.setImagePrice(connId, 'm', null)
    expect(conns.imagePriceFor(connId, 'm')).toBeUndefined()
    expect(() => conns.setImagePrice(connId, 'm', -1)).toThrow(/between 0 and 1000/)
    expect(() => conns.setImagePrice(connId, 'm', Number.NaN)).toThrow()
    expect(() => conns.setImagePrice('missing', 'm', 1)).toThrow()
  })
})

describe('AssetService.process', () => {
  let base: string

  beforeEach(async () => {
    serveImage(squarePng(64, 24))
    base = (await gen({ name: 'base' })).assets[0].id
  })

  it('removes a flat background into a new asset and keeps the original', async () => {
    const out = await assets.process({ id: base, operation: { type: 'removeBackground' } })
    expect(out).toMatchObject({ origin: 'processed', parentId: base, transparent: true, width: 64, height: 64, path: 'assets/sprites/base-nobg.png', kind: 'sprite' })
    expect(out.note).toMatch(/Removed a flat background/)
    expect(readFileSync(join(root, 'assets/sprites/base.png')).equals(squarePng(64, 24))).toBe(true)
    expect(assets.list('p1')).toHaveLength(2)
  })

  it('trims transparent borders, resizes, and chains operations', async () => {
    const nobg = await assets.process({ id: base, operation: { type: 'removeBackground' } })
    const trimmed = await assets.process({ id: nobg.id, operation: { type: 'trim', padding: 2 } })
    expect(trimmed).toMatchObject({ width: 28, height: 28, parentId: nobg.id, path: 'assets/sprites/base-nobg-trimmed.png' })
    const small = await assets.process({ id: trimmed.id, operation: { type: 'resize', width: 16, height: 8, fit: 'contain', pixelArt: true } })
    expect(small).toMatchObject({ width: 16, height: 8, path: 'assets/sprites/base-nobg-trimmed-16x8.png' })
    expect(small.note).toMatch(/Resized to 16×8/)
    // Doing the same thing again must not pile up suffixes.
    const again = await assets.process({ id: nobg.id, operation: { type: 'trim' } })
    expect(again.path).toBe('assets/sprites/base-nobg-trimmed-2.png')
  })

  it('can replace the file in place', async () => {
    const before = readFileSync(join(root, 'assets/sprites/base.png'))
    const out = await assets.process({ id: base, operation: { type: 'resize', width: 32, height: 32, fit: 'stretch' }, replace: true })
    expect(out.id).toBe(base)
    expect(out).toMatchObject({ width: 32, height: 32, path: 'assets/sprites/base.png' })
    expect(readFileSync(join(root, 'assets/sprites/base.png')).equals(before)).toBe(false)
    expect(assets.list('p1')).toHaveLength(1)
  })

  it('rejects bad parameters and pictures it cannot process, with a reason', async () => {
    await expect(assets.process({ id: base, operation: { type: 'resize', width: 0, height: 10, fit: 'contain' } })).rejects.toThrow(/Width must be/)
    await expect(assets.process({ id: base, operation: { type: 'resize', width: 8192, height: 8192, fit: 'contain' } })).rejects.toThrow(/too many pixels/)
    await expect(assets.process({ id: base, operation: { type: 'trim', padding: 9999 } })).rejects.toThrow(/Padding/)
    await expect(assets.process({ id: base, operation: { type: 'removeBackground', tolerance: 500 } })).rejects.toThrow(/Tolerance/)
    await expect(assets.process({ id: base, operation: { type: 'sharpen' } as never })).rejects.toThrow(/not supported/)
    await expect(assets.process({ id: 'nope', operation: { type: 'trim' } })).rejects.toThrow(/not found/i)
    await expect(assets.process({ id: base, operation: { type: 'trim' } })).rejects.toThrow(/nothing to trim/)
    serveImage(noisePng())
    const noisy = (await gen({ name: 'noisy' })).assets[0]
    await expect(assets.process({ id: noisy.id, operation: { type: 'removeBackground' } })).rejects.toThrow(/background/i)
  })

  it('reports a file that was deleted outside the app', async () => {
    rmSync(join(root, 'assets/sprites/base.png'))
    expect(assets.list('p1')[0].exists).toBe(false)
    await expect(assets.process({ id: base, operation: { type: 'trim' } })).rejects.toThrow(/could not be read/)
    expect(await assets.preview(base)).toBeNull()
  })
})

describe('AssetService previews, removal and reveal', () => {
  it('serves a data URL preview of a real file', async () => {
    serveImage()
    const a = (await gen()).assets[0]
    const url = await assets.preview(a.id, 128)
    expect(url).toMatch(/^data:image\/png;base64,/)
    expect(Buffer.from(url!.split(',')[1], 'base64').subarray(0, 4).toString('latin1')).toBe('\x89PNG')
  })

  it('removes from the library and optionally deletes the file', async () => {
    serveImage()
    const a = (await gen({ name: 'one' })).assets[0]
    serveImage(squarePng(32, 8))
    const b = (await gen({ name: 'two' })).assets[0]
    await assets.remove(a.id, false)
    expect(existsSync(join(root, a.path))).toBe(true)
    expect(assets.list('p1').map((x) => x.id)).toEqual([b.id])
    await assets.remove(b.id, true)
    expect(existsSync(join(root, b.path))).toBe(false)
    expect(assets.list('p1')).toEqual([])
    expect(changes).toContainEqual({ projectId: 'p1', path: b.path, kind: 'remove', by: 'user' })
    await expect(assets.remove(b.id, true)).rejects.toThrow(/not found/i)
  })

  it('gives the absolute path inside the project only', async () => {
    serveImage()
    const a = (await gen()).assets[0]
    expect(assets.absolutePath(a.id)).toBe(join(root, a.path))
    db.run(`UPDATE assets SET rel_path = '../outside.png' WHERE id = ?`, a.id)
    expect(() => assets.absolutePath(a.id)).toThrow()
  })
})

// ------------------------------------------------------------------ agents and the orchestrator

describe('image agent readiness', () => {
  it('needs a connection that has an image API, a model, and the permission', async () => {
    const none = agents.create({ templateKey: 'image_generator', projectId: 'p1' })
    expect(none.issues).toEqual(['No model connection selected.'])
    const ok = agents.create({ templateKey: 'image_generator', projectId: 'p1', name: 'Img2', connectionId: connId, model: 'gpt-image-1' })
    expect(ok.issues).toEqual([])
    expect(agents.update({ id: ok.id, model: '' }).issues).toEqual(['No image model selected.'])
    const claude = await conns.create({ kind: 'anthropic', name: 'Claude', apiKey: 'sk-ant-0123456789abcdef' })
    const bad = agents.update({ id: ok.id, connectionId: claude.id, model: 'claude-x' })
    expect(bad.issues[0]).toMatch(/no image-generation API/)
    db.run(`INSERT INTO connection_models (connection_id, model, kind, fetched_at) VALUES (?, 'gpt-4o', 'chat', 1)`, connId)
    expect(agents.update({ id: ok.id, connectionId: connId, model: 'gpt-4o' }).issues[0]).toMatch(/chat model, not an image model/)
    expect(agents.update({ id: ok.id, model: 'my-custom-sd' }).issues).toEqual([])
  })
})

interface Reply {
  text?: string
  tools?: Array<{ name: string; args: Record<string, unknown> }>
}
interface Seen {
  req: CompleteRequest
  role: string
  taskTitle: string | null
  round: number
}

class FakeGateway implements LlmGateway {
  readonly seen: Seen[] = []
  handler: (s: Seen) => Reply = () => ({ text: 'ok' })
  constructor(private readonly db: Database) {}
  async complete(req: CompleteRequest): Promise<CompleteResult> {
    const agent = this.db.get<{ role: string }>(`SELECT role FROM agents WHERE id = ?`, req.ctx.agentId)!
    const task = req.ctx.taskId ? this.db.get<{ title: string }>(`SELECT title FROM tasks WHERE id = ?`, req.ctx.taskId) : undefined
    const round = req.messages.filter((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'tool_result')).length + 1
    const seen: Seen = { req, role: agent.role, taskTitle: task?.title ?? null, round }
    this.seen.push(seen)
    if (req.signal.aborted) throw new CallCancelledError()
    const reply = this.handler(seen)
    this.db.run(
      `INSERT INTO llm_calls (id, project_id, run_id, task_id, agent_id, connection_id, model, kind, input_tokens, output_tokens, cost_usd, latency_ms, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'chat', 10, 5, 0.01, 1, 'ok', ?)`,
      randomUUID(), req.ctx.projectId, req.ctx.runId, req.ctx.taskId, req.ctx.agentId, req.connectionId, req.model, Date.now()
    )
    const toolCalls = (reply.tools ?? []).map((c, i) => ({ id: `call-${this.seen.length}-${i}`, name: c.name, arguments: c.args }))
    return { costUsd: 0.01, response: { model: req.model, text: reply.text ?? '', toolCalls, stopReason: toolCalls.length ? 'tool_use' : 'end', usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1 } }
  }
}

describe('orchestrator and pictures', () => {
  let gw: FakeGateway
  let orch: Orchestrator
  const hire = (role: string, over: Record<string, unknown> = {}) => agents.create({ templateKey: role, projectId: 'p1', connectionId: connId, model: 'gpt-x', ...over })
  const isPlanning = (s: Seen) => !!s.req.tools?.some((t) => t.name === 'submit_plan')
  const planOf = (...tasksIn: Array<Record<string, unknown>>): Reply => ({ tools: [{ name: 'submit_plan', args: { tasks: tasksIn } }] })

  beforeEach(() => {
    hire('project_manager')
    gw = new FakeGateway(db)
    orch = new Orchestrator(db, events, agents, gw, tasks, { workspace: ws, commands, assets })
  })
  afterEach(async () => {
    await orch.stopAll()
  })

  it('runs a task given to an image agent as a real image request and reports the saved file', async () => {
    hire('image_generator', { model: 'gpt-image-1' })
    conns.setImagePrice(connId, 'gpt-image-1', 0.04)
    serveImage(squarePng(64, 24))
    gw.handler = (s) => (isPlanning(s) ? planOf({ key: 'gob', title: 'Goblin sprite', description: 'A green goblin with a club, 64x64, transparent background', role: 'image_generator' }) : { text: 'ok' })
    const run = orch.start({ projectId: 'p1', goal: 'Make a goblin' })
    await orch.whenDone(run.id)
    expect(orch.getRun(run.id)?.status).toBe('completed')

    const body = server.requests.find((r) => r.url.endsWith('/images/generations'))!.body
    expect(body.prompt).toContain('Goblin sprite')
    expect(body.prompt).toContain('A green goblin with a club')
    expect(body).toMatchObject({ model: 'gpt-image-1', n: 1, background: 'transparent' })
    // No chat call is ever made for the image agent: only the planner talked to the language model.
    expect(gw.seen.every((s) => s.role === 'project_manager')).toBe(true)

    const list = assets.list('p1')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ kind: 'sprite', transparent: true, origin: 'generated' })
    expect(list[0].path.startsWith('assets/sprites/')).toBe(true)
    expect(existsSync(join(root, list[0].path))).toBe(true)
    const task = tasks.list({ projectId: 'p1' })[0]
    expect(task.status).toBe('done')
    expect(task.resultSummary).toContain(list[0].path)
    expect(task.resultSummary).toContain('Requested size 64x64')

    const imageCalls = db.all<{ cost_usd: number; run_id: string; agent_id: string }>(`SELECT cost_usd, run_id, agent_id FROM llm_calls WHERE kind = 'image'`)
    expect(imageCalls).toHaveLength(1)
    expect(imageCalls[0].cost_usd).toBeCloseTo(0.04)
    expect(imageCalls[0].run_id).toBe(run.id)
    expect(imageCalls[0].agent_id).toBe(agents.list().find((a) => a.role === 'image_generator')!.id)
  })

  it('fails the task, not the run silently, when the image request fails', async () => {
    hire('image_generator', { model: 'gpt-image-1' })
    server.handler = (_r, res) => json(res, 400, { error: { message: 'Your request was rejected by the safety system.' } })
    gw.handler = (s) => (isPlanning(s) ? planOf({ key: 'a', title: 'Banner', description: 'x', role: 'image_generator' }) : { text: 'ok' })
    const run = orch.start({ projectId: 'p1', goal: 'x' })
    await orch.whenDone(run.id)
    const task = tasks.list({ projectId: 'p1' })[0]
    expect(task.status).toBe('failed')
    expect(task.error).toMatch(/safety system/)
    expect(assets.list('p1')).toEqual([])
  })

  it('stops a run on budget because image spending counts', async () => {
    hire('image_generator', { model: 'gpt-image-1' })
    conns.setImagePrice(connId, 'gpt-image-1', 5)
    serveImage()
    gw.handler = (s) =>
      isPlanning(s)
        ? planOf({ key: 'a', title: 'First picture', description: 'one', role: 'image_generator', priority: 1 }, { key: 'b', title: 'Second picture', description: 'two', role: 'image_generator', priority: 2, depends_on: ['a'] })
        : { text: 'ok' }
    const run = orch.start({ projectId: 'p1', goal: 'x', budgetUsd: 1 })
    await orch.whenDone(run.id)
    expect(server.requests.filter((r) => r.url.endsWith('/images/generations'))).toHaveLength(1)
    expect(orch.getRun(run.id)?.status).toBe('paused')
    expect(assets.list('p1')).toHaveLength(1)
  })

  it('lets a chat agent with permission generate pictures through the team’s image agent', async () => {
    hire('concept_artist')
    hire('image_generator', { model: 'gpt-image-1' })
    serveImage()
    gw.handler = (s) => {
      if (isPlanning(s)) return planOf({ key: 'art', title: 'Art direction', description: 'Make one key art', role: 'concept_artist' })
      if (s.round === 1) return { tools: [{ name: 'generate_image', args: { prompt: 'moody castle at dusk', kind: 'concept', name: 'castle', count: 1 } }, { name: 'list_assets', args: {} }] }
      return { text: 'Made the castle.' }
    }
    const run = orch.start({ projectId: 'p1', goal: 'x' })
    await orch.whenDone(run.id)
    expect(orch.getRun(run.id)?.status).toBe('completed')
    const work = gw.seen.find((s) => s.taskTitle === 'Art direction')!
    expect(work.req.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(['generate_image', 'list_assets']))
    expect(work.req.system).toContain('generate_image makes a picture')
    expect(assets.list('p1').map((a) => a.path)).toEqual(['assets/concepts/castle.png'])
    const results = gw.seen.filter((s) => s.taskTitle === 'Art direction').at(-1)!.req.messages.at(-1)!.content as Array<{ content: string; isError?: boolean }>
    expect(results[0].content).toContain('assets/concepts/castle.png')
    expect(results[0].isError).toBe(false)
    // The tool call is accounted to the chat agent that made it, with the image model's price unknown.
    const call = db.get<{ agent_id: string }>(`SELECT agent_id FROM llm_calls WHERE kind = 'image'`)!
    expect(call.agent_id).toBe(agents.list().find((a) => a.role === 'concept_artist')!.id)
  })

  it('tells the agent plainly when the team has no working image agent', async () => {
    hire('concept_artist')
    let toolResult = ''
    gw.handler = (s) => {
      if (isPlanning(s)) return planOf({ key: 'art', title: 'Art direction', description: 'x', role: 'concept_artist' })
      if (s.round === 1) return { tools: [{ name: 'generate_image', args: { prompt: 'a castle' } }] }
      const last = s.req.messages.at(-1)!.content as Array<{ content: string; isError?: boolean }>
      toolResult = `${last[0].isError}:${last[0].content}`
      return { text: 'No image model, so I only describe it.' }
    }
    const run = orch.start({ projectId: 'p1', goal: 'x' })
    await orch.whenDone(run.id)
    expect(toolResult).toMatch(/^true:.*no working Image Generator/)
    expect(server.requests).toHaveLength(0)
    expect(assets.list('p1')).toEqual([])
  })

  it('does not offer picture tools without permission or without the service', () => {
    const dev = hire('lead_developer')
    expect(toolsFor(dev, { assets: true }).map((t) => t.def.name)).not.toContain('generate_image')
    const artist = hire('concept_artist', { name: 'Artist 2' })
    expect(toolsFor(artist, { assets: true }).map((t) => t.def.name)).toEqual(expect.arrayContaining(['generate_image', 'list_assets']))
    expect(toolsFor(artist, {}).map((t) => t.def.name)).not.toContain('generate_image')
    expect(environmentNote(new Set(['generate_image']))).toContain('Each picture costs money')
    expect(environmentNote(new Set(['list_tasks']))).not.toContain('generate_image')
  })

  it('tells the planner how image tasks are used, only when the team has an image generator', () => {
    const base = { projectName: 'P', projectType: 'unity', goal: 'g', existing: [] as string[] }
    const withImg = plannerInstructions({ ...base, team: [{ role: 'image_generator', roleLabel: 'Image Generator', name: 'I', description: 'd' }] })
    expect(withImg).toMatch(/sent to the image model word for word/)
    const without = plannerInstructions({ ...base, team: [{ role: 'lead_developer', roleLabel: 'Dev', name: 'D', description: 'd' }] })
    expect(without).not.toMatch(/image model/)
  })
})

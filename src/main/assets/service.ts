import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { posix } from 'node:path'
import {
  ASSET_KINDS,
  type AssetItem,
  type AssetKind,
  type AssetOperation,
  type GenerateAssetInput,
  type GenerateAssetResult,
  type ImportAssetsInput,
  type ImportAssetsResult,
  type ImageModelOption,
  type ProcessAssetInput,
  type ScanAssetsResult
} from '../../shared/ipc'
import type { Database } from '../db/database'
import { PROVIDER_CATALOG } from '../providers/catalog'
import { ProviderError } from '../providers/http'
import { MAX_IMAGES_PER_REQUEST, imageCapabilities, nativeTransparency, parseSize } from '../providers/images'
import type { GeneratedImage } from '../providers/types'
import type { ConnectionService } from '../services/connections'
import { redactSecret } from '../services/connections'
import type { EventService } from '../services/events'
import { WorkspaceError, isSecretPath, type Sandbox } from '../workspace/sandbox'
import type { WorkspaceService } from '../workspace/workspace'
import { FORMAT_EXT, FORMAT_MIME, decodeImage, imageFormat, imageSize } from './codec'
import { assetFolder, guessKind, suggestName, uniquePath } from './conventions'
import { MAX_PIXELS, PixelError, encodePng, fitRaster, hasTransparency, removeBackground, resizeRaster, trimRaster, type Raster } from './pixels'

export const MAX_PROMPT_CHARS = 4000

const IMPORT_EXT = /\.(png|jpe?g|webp|gif)$/i
/** Largest picture the library will take over (the same cap as the binary writer). */
const IMPORT_MAX_BYTES = 25_000_000

interface AssetRow {
  id: string
  project_id: string
  task_id: string | null
  kind: AssetKind
  name: string
  rel_path: string
  prompt: string | null
  connection_id: string | null
  model: string | null
  width: number | null
  height: number | null
  transparent: number
  parent_asset_id: string | null
  metadata_json: string
  created_at: number
  origin: 'generated' | 'processed' | 'imported'
  bytes: number
  connection_name: string | null
}

/** Who is asking for the picture and how to account for it. Absent for a person using the Asset Library. */
export interface GenerationContext {
  runId?: string
  taskId?: string
  agent?: { id: string; name: string }
  signal?: AbortSignal
}

export interface AssetServiceDeps {
  db: Database
  events: EventService
  workspace: WorkspaceService
  connections: ConnectionService
  now?: () => number
}

const KINDS = new Set<string>(ASSET_KINDS.map((k) => k.value))

const TRANSPARENT_HINT = 'The subject must be on a plain, solid, uniform white background with no shadow, gradient or texture, and nothing touching the edges of the picture.'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Keeps the lookup of a raster out of the hot path when the same preview is asked for repeatedly. */
class PreviewCache {
  private readonly map = new Map<string, string | null>()
  constructor(private readonly cap = 300) {}
  get(key: string): string | null | undefined {
    return this.map.get(key)
  }
  set(key: string, value: string | null): void {
    if (this.map.size >= this.cap) this.map.delete(this.map.keys().next().value as string)
    this.map.set(key, value)
  }
}

/**
 * The asset pipeline: generates pictures with the user's image models, files them into the project following the engine's
 * folder conventions, records what produced them (prompt, model, cost, lineage) and offers the editing steps games need
 * (resize, trim, background removal). Nothing here invents pixels: a picture exists only if a provider returned it
 * or it was derived from one.
 */
export class AssetService {
  private readonly db: Database
  private readonly events: EventService
  private readonly workspace: WorkspaceService
  private readonly connections: ConnectionService
  private readonly now: () => number
  private readonly inflight = new Map<string, AbortController>()
  private readonly previews = new PreviewCache()

  constructor(deps: AssetServiceDeps) {
    this.db = deps.db
    this.events = deps.events
    this.workspace = deps.workspace
    this.connections = deps.connections
    this.now = deps.now ?? Date.now
  }

  // ------------------------------------------------------------------ reading

  private toItem(r: AssetRow, sb: Sandbox | null): AssetItem {
    let note: string | null = null
    try {
      const m = JSON.parse(r.metadata_json) as { note?: unknown }
      if (typeof m.note === 'string') note = m.note
    } catch {
      /* ignore malformed metadata */
    }
    let exists = false
    if (sb) {
      try {
        exists = statSync(sb.resolve(r.rel_path).full).isFile()
      } catch {
        exists = false
      }
    }
    return {
      id: r.id,
      projectId: r.project_id,
      taskId: r.task_id,
      kind: r.kind,
      name: r.name,
      path: r.rel_path,
      prompt: r.prompt,
      connectionId: r.connection_id,
      connectionName: r.connection_name,
      model: r.model,
      width: r.width,
      height: r.height,
      transparent: r.transparent === 1,
      parentId: r.parent_asset_id,
      origin: r.origin,
      bytes: r.bytes,
      note,
      exists,
      createdAt: r.created_at
    }
  }

  private rows(where: string, ...params: Array<string | number>): AssetRow[] {
    return this.db.all<AssetRow>(
      `SELECT a.*, c.name AS connection_name FROM assets a LEFT JOIN provider_connections c ON c.id = a.connection_id ${where}`,
      ...params
    )
  }

  private row(id: string): AssetRow {
    const r = this.rows('WHERE a.id = ?', String(id))[0]
    if (!r) throw new Error('Asset not found.')
    return r
  }

  private sandboxFor(projectId: string): Sandbox | null {
    try {
      return this.workspace.sandbox(projectId)
    } catch {
      return null // project folder missing: assets are listed but flagged as not on disk
    }
  }

  list(projectId: string, kind?: AssetKind | null): AssetItem[] {
    this.workspace.project(projectId)
    const sb = this.sandboxFor(projectId)
    const rows = kind && KINDS.has(kind) ? this.rows('WHERE a.project_id = ? AND a.kind = ? ORDER BY a.created_at DESC, a.rowid DESC', projectId, kind) : this.rows('WHERE a.project_id = ? ORDER BY a.created_at DESC, a.rowid DESC', projectId)
    return rows.map((r) => this.toItem(r, sb))
  }

  get(id: string): AssetItem {
    const r = this.row(id)
    return this.toItem(r, this.sandboxFor(r.project_id))
  }

  /** A PNG data URL that fits in `max` pixels, for showing in the UI without moving the full file over IPC. */
  async preview(id: string, max = 256): Promise<string | null> {
    const r = this.row(id)
    const limit = Math.max(32, Math.min(2048, Math.floor(max) || 256))
    const sb = this.sandboxFor(r.project_id)
    if (!sb) return null
    let key: string
    try {
      const st = statSync(sb.resolve(r.rel_path).full)
      key = `${r.id}:${st.size}:${Math.floor(st.mtimeMs)}:${limit}`
    } catch {
      return null
    }
    const hit = this.previews.get(key)
    if (hit !== undefined) return hit
    let url: string | null = null
    try {
      const buf = await sb.readBinary(r.rel_path)
      const fmt = imageFormat(buf)
      const dims = imageSize(buf)
      // A small file that already fits is sent as it is, byte for byte.
      if (fmt && dims && Math.max(dims.width, dims.height) <= limit && buf.length <= 1_500_000) {
        url = `data:${FORMAT_MIME[fmt]};base64,${buf.toString('base64')}`
      } else {
        const raster = decodeImage(buf)
        const scale = Math.min(1, limit / Math.max(raster.width, raster.height))
        const small = scale < 1 ? resizeRaster(raster, Math.max(1, Math.round(raster.width * scale)), Math.max(1, Math.round(raster.height * scale))) : raster
        url = `data:image/png;base64,${encodePng(small).toString('base64')}`
      }
    } catch {
      url = null
    }
    this.previews.set(key, url)
    return url
  }

  /** Models that can be used to generate pictures: discovered image models on enabled connections whose provider has an image API. */
  imageModels(): ImageModelOption[] {
    const out: ImageModelOption[] = []
    for (const c of this.connections.list()) {
      if (!c.enabled || !PROVIDER_CATALOG[c.kind]?.imageGeneration) continue
      for (const m of this.connections.listModels(c.id)) {
        if (m.kind !== 'image') continue
        const caps = imageCapabilities(c.kind, m.model)
        out.push({ connectionId: c.id, connectionName: c.name, providerKind: c.kind, model: m.model, listedAsImage: true, priceUsd: m.imagePriceUsd, supportsEdit: caps.supportsEdit, sizes: caps.sizes })
      }
      // Models typed in by hand that the provider never listed: remembered once they have a price, an agent or a picture.
      const listed = new Set(out.filter((o) => o.connectionId === c.id).map((o) => o.model))
      const extra = this.db.all<{ model: string }>(
        `SELECT model FROM image_pricing WHERE connection_id = ?1
         UNION SELECT model FROM assets WHERE connection_id = ?1 AND model IS NOT NULL
         UNION SELECT model FROM agents WHERE connection_id = ?1 AND kind = 'image' AND model IS NOT NULL
         ORDER BY model`,
        c.id
      )
      for (const { model } of extra) {
        if (!model || listed.has(model)) continue
        const opt = this.describeModel(c.id, model)
        if (opt) out.push(opt)
      }
    }
    return out
  }

  /** What a given connection+model can do, for models typed in by hand that were never discovered. */
  describeModel(connectionId: string, model: string): ImageModelOption | null {
    const c = this.connections.get(connectionId)
    if (!c || !PROVIDER_CATALOG[c.kind]?.imageGeneration) return null
    const caps = imageCapabilities(c.kind, model)
    const known = this.connections.listModels(c.id).find((m) => m.model === model)
    return { connectionId: c.id, connectionName: c.name, providerKind: c.kind, model, listedAsImage: known?.kind === 'image', priceUsd: this.connections.imagePriceFor(c.id, model) ?? null, supportsEdit: caps.supportsEdit, sizes: caps.sizes }
  }

  // ------------------------------------------------------------------ generating

  cancel(requestId: string): boolean {
    const ctl = this.inflight.get(String(requestId))
    if (!ctl) return false
    ctl.abort()
    return true
  }

  cancelAll(): void {
    for (const ctl of this.inflight.values()) ctl.abort()
  }

  private recordCall(input: GenerateAssetInput, ctx: GenerationContext, status: 'ok' | 'error' | 'cancelled', costUsd: number | null, latencyMs: number, error: string | null): void {
    this.db.run(
      `INSERT INTO llm_calls (id, project_id, run_id, task_id, agent_id, connection_id, model, kind, input_tokens, output_tokens, cost_usd, latency_ms, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'image', 0, 0, ?, ?, ?, ?, ?)`,
      randomUUID(),
      input.projectId,
      ctx.runId ?? null,
      ctx.taskId ?? null,
      ctx.agent?.id ?? null,
      input.connectionId,
      input.model,
      costUsd,
      latencyMs,
      status,
      error,
      this.now()
    )
  }

  async generate(input: GenerateAssetInput, ctx: GenerationContext = {}): Promise<GenerateAssetResult> {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    if (!prompt) throw new Error('Describe the picture you want.')
    if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`The prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}.`)
    const kind: AssetKind = KINDS.has(input.kind) ? input.kind : 'concept'
    const count = input.count === undefined ? 1 : Math.floor(Number(input.count))
    if (!(count >= 1 && count <= MAX_IMAGES_PER_REQUEST)) throw new Error(`Ask for between 1 and ${MAX_IMAGES_PER_REQUEST} pictures at a time.`)
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    if (!model) throw new Error('Choose an image model.')
    if (input.size !== undefined && input.size !== '' && !parseSize(input.size)) throw new Error('The size must look like 1024x1024.')
    const requestId = String(input.requestId || randomUUID())
    if (this.inflight.has(requestId)) throw new Error('This request is already running.')

    const project = this.workspace.project(input.projectId)
    const sb = this.workspace.sandbox(project.id)
    const conn = this.connections.get(input.connectionId)
    if (!conn) throw new Error('That connection no longer exists.')
    if (!conn.enabled) throw new Error(`The connection "${conn.name}" is turned off.`)

    let reference: { mimeType: string; dataBase64: string } | undefined
    let parent: AssetRow | undefined
    if (input.referenceAssetId) {
      parent = this.row(input.referenceAssetId)
      if (parent.project_id !== project.id) throw new Error('The reference picture belongs to a different project.')
      const buf = await sb.readBinary(parent.rel_path).catch((e) => {
        throw new Error(`The reference picture could not be read: ${errText(e)}`)
      })
      const fmt = imageFormat(buf)
      if (!fmt || fmt === 'gif') throw new Error('Only PNG, JPEG and WebP pictures can be used as a reference.')
      reference = { mimeType: FORMAT_MIME[fmt], dataBase64: buf.toString('base64') }
    }

    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort()
    if (ctx.signal?.aborted) ctl.abort()
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    this.inflight.set(requestId, ctl)

    const notes: string[] = []
    const started = Date.now()
    let secret: string | undefined
    try {
      const resolved = await this.connections.resolveImage(conn.id)
      secret = resolved.secret
      const native = nativeTransparency(conn.kind, model)
      const sent = input.transparent && !native ? `${prompt}\n\n${TRANSPARENT_HINT}` : prompt

      let images: GeneratedImage[]
      try {
        const res = await resolved.provider.generate({ model, prompt: sent, count, size: input.size || undefined, transparent: !!input.transparent && native, referenceImage: reference, signal: ctl.signal })
        images = res.images
      } catch (e) {
        const cancelled = ctl.signal.aborted || (e instanceof ProviderError && e.kind === 'cancelled')
        const message = redactSecret(errText(e), secret)
        this.recordCall(input, ctx, cancelled ? 'cancelled' : 'error', null, Date.now() - started, cancelled ? null : message)
        this.events.record({ projectId: project.id, runId: ctx.runId, agentId: ctx.agent?.id, level: cancelled ? 'info' : 'warn', type: cancelled ? 'asset.cancelled' : 'asset.failed', message: cancelled ? `Image generation with ${model} was stopped` : `Image generation with ${model} failed: ${message}` })
        throw new Error(cancelled ? 'Image generation was stopped.' : message)
      }

      const price = this.connections.imagePriceFor(conn.id, model)
      const costUsd = price === undefined ? null : price * images.length
      this.recordCall(input, ctx, 'ok', costUsd, Date.now() - started, null)
      if (costUsd === null) notes.push(`No price is set for ${model}, so this cost is not counted in your spending. Set a price per image to track it.`)

      const assets: AssetItem[] = []
      const folder = assetFolder(this.projectType(project.id), kind)
      const stem = suggestName(input.name, prompt, kind)
      for (const img of images) {
        const stored = await this.finishImage(img, !!input.transparent, native, notes)
        const rel = uniquePath(folder, stem, stored.ext, (p) => this.exists(sb, p))
        const written = await sb.writeBinary(rel, stored.data)
        const id = randomUUID()
        const meta: Record<string, unknown> = { sentPrompt: sent === prompt ? undefined : sent, revisedPrompt: img.revisedPrompt, requestedSize: input.size || undefined, requestId, by: ctx.agent ? ctx.agent.name : 'user' }
        this.db.run(
          `INSERT INTO assets (id, project_id, task_id, kind, name, rel_path, prompt, connection_id, model, width, height, transparent, parent_asset_id, metadata_json, created_at, origin, bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'generated', ?)`,
          id,
          project.id,
          ctx.taskId ?? null,
          kind,
          posix.basename(written.path),
          written.path,
          prompt,
          conn.id,
          model,
          stored.width,
          stored.height,
          stored.transparent ? 1 : 0,
          parent?.id ?? null,
          JSON.stringify(meta),
          this.now(),
          written.size
        )
        this.workspace.notify({ projectId: project.id, path: written.path, kind: 'write', by: ctx.agent ? 'agent' : 'user' })
        assets.push(this.get(id))
      }
      this.events.record({
        projectId: project.id,
        runId: ctx.runId,
        agentId: ctx.agent?.id,
        type: 'asset.generated',
        message: `${ctx.agent ? ctx.agent.name : 'You'} generated ${assets.length} ${assets.length === 1 ? 'picture' : 'pictures'} with ${model}: ${assets.map((a) => a.path).join(', ')}`
      })
      return { assets, costUsd, notes }
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort)
      this.inflight.delete(requestId)
    }
  }

  private projectType(projectId: string): string {
    return this.db.get<{ type: string }>(`SELECT type FROM projects WHERE id = ?`, projectId)?.type ?? 'other'
  }

  private exists(sb: Sandbox, rel: string): boolean {
    try {
      statSync(sb.resolve(rel).full)
      return true
    } catch {
      return false
    }
  }

  /**
   * Prepares what is stored on disk. The provider's bytes are kept exactly as they came unless transparency was asked for and
   * the model did not deliver it, in which case a flat background is removed (and the result is a PNG).
   */
  private async finishImage(img: GeneratedImage, wantTransparent: boolean, native: boolean, notes: string[]): Promise<{ data: Buffer; ext: string; width: number | null; height: number | null; transparent: boolean }> {
    const original = Buffer.from(img.dataBase64, 'base64')
    const fmt = imageFormat(original)
    if (!fmt) throw new Error('The provider returned data that is not a picture this app can store.')
    const size = imageSize(original)
    if (!wantTransparent) return { data: original, ext: FORMAT_EXT[fmt], width: size?.width ?? null, height: size?.height ?? null, transparent: false }

    let raster: Raster | null = null
    try {
      raster = decodeImage(original)
    } catch (e) {
      notes.push(`Transparency could not be checked: ${errText(e)}`)
    }
    if (!raster) return { data: original, ext: FORMAT_EXT[fmt], width: size?.width ?? null, height: size?.height ?? null, transparent: false }
    if (hasTransparency(raster)) {
      return fmt === 'png' ? { data: original, ext: 'png', width: raster.width, height: raster.height, transparent: true } : { data: encodePng(raster), ext: 'png', width: raster.width, height: raster.height, transparent: true }
    }
    try {
      const r = removeBackground(raster)
      notes.push(native ? 'The model returned an opaque picture, so the app removed the flat background itself.' : 'This model cannot make transparent pictures, so the app removed the flat background itself. Check the edges.')
      return { data: encodePng(r.raster), ext: 'png', width: raster.width, height: raster.height, transparent: true }
    } catch (e) {
      notes.push(`The background could not be removed automatically: ${errText(e)} The picture was saved as it came.`)
      return { data: original, ext: FORMAT_EXT[fmt], width: raster.width, height: raster.height, transparent: false }
    }
  }

  // ------------------------------------------------------------------ editing

  async process(input: ProcessAssetInput): Promise<AssetItem> {
    const r = this.row(input.id)
    const sb = this.workspace.sandbox(r.project_id)
    const op = this.checkOperation(input.operation)
    const buf = await sb.readBinary(r.rel_path).catch((e) => {
      throw new Error(`The file could not be read: ${errText(e)}`)
    })
    let raster: Raster
    try {
      raster = decodeImage(buf)
    } catch (e) {
      throw new Error(errText(e))
    }

    let out: Raster
    let label: string
    let suffix: string
    try {
      switch (op.type) {
        case 'resize': {
          out = op.fit === 'stretch' ? resizeRaster(raster, op.width, op.height, op.pixelArt ? 'nearest' : 'smooth') : fitRaster(raster, op.width, op.height, op.fit, op.pixelArt ? 'nearest' : 'smooth')
          label = `Resized to ${op.width}×${op.height} (${op.fit}${op.pixelArt ? ', pixel art' : ''})`
          suffix = `${op.width}x${op.height}`
          break
        }
        case 'trim': {
          const t = trimRaster(raster, { padding: op.padding })
          out = t.raster
          if (out.width === raster.width && out.height === raster.height) throw new Error('There is nothing to trim: the picture has no transparent border.')
          label = `Trimmed to ${t.raster.width}×${t.raster.height}`
          suffix = 'trimmed'
          break
        }
        default: {
          const b = removeBackground(raster, { tolerance: op.tolerance })
          out = b.raster
          label = `Removed a flat background (${b.background.join(', ')}); ${b.removedPixels} pixels made transparent`
          suffix = 'nobg'
        }
      }
    } catch (e) {
      throw new Error(errText(e))
    }
    const png = encodePng(out)
    const transparent = hasTransparency(out)
    const meta = JSON.stringify({ note: label, operation: op })

    if (input.replace) {
      if (imageFormat(buf) !== 'png') throw new Error('Only PNG pictures can be replaced in place. Save the result as a new picture instead.')
      const written = await sb.writeBinary(r.rel_path, png, { overwrite: true })
      this.db.run(`UPDATE assets SET width = ?, height = ?, transparent = ?, bytes = ?, metadata_json = ? WHERE id = ?`, out.width, out.height, transparent ? 1 : 0, written.size, meta, r.id)
      this.workspace.notify({ projectId: r.project_id, path: written.path, kind: 'write', by: 'user' })
      this.events.record({ projectId: r.project_id, type: 'asset.processed', message: `${label}: ${written.path} (replaced)` })
      return this.get(r.id)
    }

    const dir = posix.dirname(r.rel_path)
    // Processing the same picture twice should not pile up suffixes ("a-trimmed-trimmed").
    const stem = posix.basename(r.rel_path).replace(/\.[^.]+$/, '').replace(new RegExp(`-${suffix}(-\\d+)?$`), '')
    const rel = uniquePath(dir === '.' ? '' : dir, `${stem}-${suffix}`, 'png', (p) => this.exists(sb, p))
    const written = await sb.writeBinary(rel, png)
    const id = randomUUID()
    this.db.run(
      `INSERT INTO assets (id, project_id, task_id, kind, name, rel_path, prompt, connection_id, model, width, height, transparent, parent_asset_id, metadata_json, created_at, origin, bytes)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processed', ?)`,
      id,
      r.project_id,
      r.kind,
      posix.basename(written.path),
      written.path,
      r.prompt,
      r.connection_id,
      r.model,
      out.width,
      out.height,
      transparent ? 1 : 0,
      r.id,
      meta,
      this.now(),
      written.size
    )
    this.workspace.notify({ projectId: r.project_id, path: written.path, kind: 'write', by: 'user' })
    this.events.record({ projectId: r.project_id, type: 'asset.processed', message: `${label}: ${written.path}` })
    return this.get(id)
  }

  private checkOperation(op: AssetOperation): AssetOperation {
    if (!op || typeof op !== 'object') throw new Error('Choose what to do with the picture.')
    const int = (v: unknown, label: string, min: number, max: number): number => {
      const n = Number(v)
      if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`)
      return n
    }
    switch (op.type) {
      case 'resize': {
        const width = int(op.width, 'Width', 1, 8192)
        const height = int(op.height, 'Height', 1, 8192)
        if (width * height > MAX_PIXELS) throw new Error('That size has too many pixels in total.')
        const fit = op.fit === 'cover' || op.fit === 'stretch' ? op.fit : 'contain'
        return { type: 'resize', width, height, fit, pixelArt: op.pixelArt === true }
      }
      case 'trim':
        return { type: 'trim', padding: op.padding === undefined ? 0 : int(op.padding, 'Padding', 0, 512) }
      case 'removeBackground':
        return { type: 'removeBackground', tolerance: op.tolerance === undefined ? undefined : int(op.tolerance, 'Tolerance', 0, 120) }
      default:
        throw new Error('That operation is not supported.')
    }
  }

  // ------------------------------------------------------------------ importing pictures that are already in the project

  /** Picture files in the project folder (outside ignored folders such as node_modules) that the library does not list yet. */
  async scan(projectId: string): Promise<ScanAssetsResult> {
    this.workspace.project(projectId)
    const sb = this.workspace.sandbox(projectId)
    const known = new Set(this.db.all<{ rel_path: string }>('SELECT rel_path FROM assets WHERE project_id = ?', projectId).map((r) => r.rel_path.toLowerCase()))
    const { files, truncated } = await sb.walk('', { includeBinary: true, maxFileBytes: IMPORT_MAX_BYTES, max: 20_000 })
    const found = files.filter((f) => IMPORT_EXT.test(f.path) && !isSecretPath(f.path) && !known.has(f.path.toLowerCase())).map((f) => ({ path: f.path, bytes: f.size }))
    return { files: found.slice(0, 500), truncated: truncated || found.length > 500 }
  }

  /**
   * Adds existing pictures to the library. The files are not copied, moved or changed: the library just starts listing them.
   * The real format and size are read from the file; anything that is not a decodable picture is skipped with the reason.
   */
  async importFiles(input: ImportAssetsInput): Promise<ImportAssetsResult> {
    this.workspace.project(input.projectId)
    if (!Array.isArray(input.paths) || input.paths.length === 0) throw new Error('Choose at least one picture to import.')
    if (input.paths.length > 200) throw new Error('Import at most 200 pictures at a time.')
    if (input.kind && !KINDS.has(input.kind)) throw new Error(`Unknown picture kind "${input.kind}".`)
    const sb = this.workspace.sandbox(input.projectId)
    const result: ImportAssetsResult = { imported: [], skipped: [] }
    const seen = new Set<string>()
    for (const raw of input.paths) {
      const path = String(raw)
      try {
        const resolved = sb.resolve(path)
        if (seen.has(resolved.rel.toLowerCase())) continue
        seen.add(resolved.rel.toLowerCase())
        if (isSecretPath(resolved.rel)) throw new Error('Credential files are never added to the library.')
        if (!IMPORT_EXT.test(resolved.rel)) throw new Error('Only PNG, JPEG, WebP and GIF pictures can be imported.')
        const already = this.db.get<{ id: string }>('SELECT id FROM assets WHERE project_id = ? AND lower(rel_path) = lower(?)', input.projectId, resolved.rel)
        if (already) throw new Error('Already in the library.')
        const buf = await sb.readBinary(resolved.rel, { maxBytes: IMPORT_MAX_BYTES })
        const format = imageFormat(buf)
        if (!format) throw new Error('Not a PNG, JPEG, WebP or GIF picture (the file content does not match).')
        const size = imageSize(buf)
        let transparent = false
        if (format === 'png' && size && size.width * size.height <= MAX_PIXELS) {
          try {
            transparent = hasTransparency(decodeImage(buf))
          } catch {
            /* an undecodable PNG is still listed; transparency is just unknown (shown as opaque) */
          }
        }
        const id = randomUUID()
        const kind = input.kind ?? guessKind(resolved.rel.replace(/[/\\._-]+/g, ' '))
        this.db.run(
          `INSERT INTO assets (id, project_id, task_id, kind, name, rel_path, prompt, connection_id, model, width, height, transparent, parent_asset_id, metadata_json, created_at, origin, bytes)
           VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?, 'imported', ?)`,
          id,
          input.projectId,
          kind,
          posix.basename(resolved.rel),
          resolved.rel,
          size?.width ?? null,
          size?.height ?? null,
          transparent ? 1 : 0,
          JSON.stringify({ note: 'Added to the library from a file that was already in the project.' }),
          this.now(),
          buf.length
        )
        result.imported.push(this.get(id))
      } catch (e) {
        result.skipped.push({ path, reason: e instanceof Error ? e.message : String(e) })
      }
    }
    if (result.imported.length) {
      this.events.record({ projectId: input.projectId, type: 'asset.imported', message: `Added ${result.imported.length} existing picture${result.imported.length === 1 ? '' : 's'} to the library` })
    }
    return result
  }

  // ------------------------------------------------------------------ deleting

  async remove(id: string, deleteFile: boolean): Promise<void> {
    const r = this.row(id)
    if (deleteFile) {
      const sb = this.sandboxFor(r.project_id)
      if (sb) {
        try {
          await sb.remove(r.rel_path, { filesOnly: true })
          this.workspace.notify({ projectId: r.project_id, path: r.rel_path, kind: 'remove', by: 'user' })
        } catch (e) {
          if (!(e instanceof WorkspaceError && e.code === 'not_found')) throw e
        }
      }
    }
    this.db.run(`DELETE FROM assets WHERE id = ?`, r.id)
    this.events.record({ projectId: r.project_id, type: 'asset.removed', message: `${deleteFile ? 'Deleted' : 'Removed from the library'}: ${r.rel_path}` })
  }

  /** Absolute path of an asset's file (for "show in folder"). */
  absolutePath(id: string): string {
    const r = this.row(id)
    return this.workspace.sandbox(r.project_id).resolve(r.rel_path).full
  }
}


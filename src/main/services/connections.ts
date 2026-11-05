import { randomUUID } from 'node:crypto'
import type {
  Connection,
  ConnectionState,
  ConnectionTestResult,
  CreateConnectionInput,
  ModelEntry,
  ModelKindId,
  ProviderCatalogItem,
  ProviderKind,
  SetPricingInput,
  UpdateConnectionInput
} from '../../shared/ipc'
import type { Database } from '../db/database'
import { PROVIDER_CATALOG, PROVIDER_KINDS } from '../providers/catalog'
import { ProviderError } from '../providers/http'
import { createChatProvider, createImageProvider } from '../providers/registry'
import type { ChatProvider, ConnectionConfig, ImageProvider, ModelPricing } from '../providers/types'
import type { SecretStore } from '../secrets/secret-store'
import type { EventService } from './events'

interface ConnRow {
  id: string
  kind: ProviderKind
  name: string
  base_url: string
  secret_ref: string | null
  headers_json: string
  enabled: number
  status: ConnectionState
  last_error: string | null
  last_checked_at: number | null
  created_at: number
  model_count: number
}

interface ModelRow {
  connection_id: string
  model: string
  display_name: string | null
  kind: ModelKindId
  context_window: number | null
  p_in: number | null
  p_out: number | null
  p_source: 'user' | 'provider' | null
  img_usd: number | null
}

export type ProviderFactory = (config: ConnectionConfig) => ChatProvider
export type ImageProviderFactory = (config: ConnectionConfig) => ImageProvider

export interface ResolvedImageConnection {
  provider: ImageProvider
  row: Connection
  secret: string | undefined
}

export interface ResolvedConnection {
  provider: ChatProvider
  row: Connection
  /** Kept only so error text can be scrubbed; never leaves the main process. */
  secret: string | undefined
}

const MAX_PRICE_PER_MTOK = 1_000_000

/** Removes the API key (and bearer-style echoes of it) from text that may reach the UI or the log. */
export function redactSecret(text: string, secret: string | undefined): string {
  let out = text
  if (secret && secret.length >= 6) out = out.split(secret).join('***')
  return out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***')
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/**
 * Normalises and validates a provider base URL. Keys travel in headers, so plain
 * http is only accepted for loopback / private-network hosts (Ollama, LAN servers).
 */
export function validateBaseUrl(raw: string): string {
  const text = raw.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`"${text}" is not a valid URL (expected e.g. https://api.example.com/v1).`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The base URL must start with http:// or https://.')
  if (url.username || url.password) throw new Error('Do not put credentials in the base URL; use the API key field.')
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new Error('Plain http:// is only allowed for localhost and private-network addresses. Use https:// for remote providers.')
  }
  return text.replace(/\/+$/, '')
}

export class ConnectionService {
  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly secrets: SecretStore,
    private readonly opts: { now?: () => number; providerFactory?: ProviderFactory; imageProviderFactory?: ImageProviderFactory } = {}
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  catalog(): ProviderCatalogItem[] {
    return PROVIDER_KINDS.map((k) => {
      const c = PROVIDER_CATALOG[k]
      return {
        kind: c.kind,
        label: c.label,
        defaultBaseUrl: c.defaultBaseUrl,
        requiresApiKey: c.requiresApiKey,
        customBaseUrl: !!c.customBaseUrl,
        local: !!c.local,
        imageGeneration: c.imageGeneration,
        docsUrl: c.docsUrl
      }
    })
  }

  // ------------------------------------------------------------------ CRUD

  private rows(where = '', ...params: string[]): ConnRow[] {
    return this.db.all<ConnRow>(
      `SELECT c.*, (SELECT COUNT(*) FROM connection_models m WHERE m.connection_id = c.id) AS model_count
         FROM provider_connections c ${where} ORDER BY c.created_at, c.id`,
      ...params
    )
  }

  private toDto(r: ConnRow): Connection {
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      baseUrl: r.base_url,
      hasKey: r.secret_ref !== null && this.secrets.has(r.secret_ref),
      enabled: r.enabled === 1,
      status: r.status,
      lastError: r.last_error,
      lastCheckedAt: r.last_checked_at,
      modelCount: r.model_count,
      createdAt: r.created_at
    }
  }

  list(): Connection[] {
    return this.rows().map((r) => this.toDto(r))
  }

  get(id: string): Connection | null {
    const r = this.rows('WHERE c.id = ?', id)[0]
    return r ? this.toDto(r) : null
  }

  private require(id: string): ConnRow {
    const r = this.rows('WHERE c.id = ?', id)[0]
    if (!r) throw new Error('Connection not found.')
    return r
  }

  private cleanName(name: unknown): string {
    const n = typeof name === 'string' ? name.trim() : ''
    if (!n) throw new Error('Connection name is required.')
    if (n.length > 60) throw new Error('Connection name must be 60 characters or fewer.')
    return n
  }

  private cleanKey(key: unknown): string | undefined {
    if (key === undefined || key === null) return undefined
    if (typeof key !== 'string') throw new Error('API key must be text.')
    const k = key.trim()
    if (!k) return undefined
    if (/[\r\n]/.test(k)) throw new Error('API key must not contain line breaks.')
    return k
  }

  async create(input: CreateConnectionInput): Promise<Connection> {
    const entry = PROVIDER_CATALOG[input.kind]
    if (!entry) throw new Error(`Unknown provider "${String(input.kind)}".`)
    const name = this.cleanName(input.name)
    const baseUrl = validateBaseUrl(input.baseUrl?.trim() || entry.defaultBaseUrl || '')
    const apiKey = this.cleanKey(input.apiKey)
    if (entry.requiresApiKey && !apiKey) throw new Error(`${entry.label} requires an API key.`)

    const id = randomUUID()
    const now = this.now()
    const secretRef = apiKey ? `conn:${id}` : null
    this.db.run(
      `INSERT INTO provider_connections (id, kind, name, base_url, secret_ref, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.kind,
      name,
      baseUrl,
      secretRef,
      input.enabled === false ? 0 : 1,
      now,
      now
    )
    if (apiKey && secretRef) {
      try {
        await this.secrets.set(secretRef, apiKey)
      } catch (e) {
        // Never leave a connection that claims to have a key but doesn't.
        this.db.run(`DELETE FROM provider_connections WHERE id = ?`, id)
        throw new Error(redactSecret(e instanceof Error ? e.message : String(e), apiKey))
      }
    }
    this.events.record({ type: 'connection.created', message: `Connection "${name}" (${entry.label}) added` })
    return this.get(id)!
  }

  async update(input: UpdateConnectionInput): Promise<Connection> {
    const row = this.require(input.id)
    const entry = PROVIDER_CATALOG[row.kind]
    const sets: string[] = []
    const params: Array<string | number | null> = []
    let credentialsChanged = false

    if (input.name !== undefined) {
      sets.push('name = ?')
      params.push(this.cleanName(input.name))
    }
    if (input.baseUrl !== undefined) {
      const url = validateBaseUrl(input.baseUrl.trim() || entry.defaultBaseUrl || '')
      if (url !== row.base_url) credentialsChanged = true
      sets.push('base_url = ?')
      params.push(url)
    }
    if (input.enabled !== undefined) {
      sets.push('enabled = ?')
      params.push(input.enabled ? 1 : 0)
    }

    const newKey = this.cleanKey(input.apiKey)
    if (newKey && input.clearKey) throw new Error('Provide either a new API key or clearKey, not both.')
    if (input.clearKey && entry.requiresApiKey) {
      throw new Error(`${entry.label} requires an API key. Replace it, or remove the connection.`)
    }

    if (newKey) {
      const ref = row.secret_ref ?? `conn:${row.id}`
      try {
        await this.secrets.set(ref, newKey)
      } catch (e) {
        throw new Error(redactSecret(e instanceof Error ? e.message : String(e), newKey))
      }
      if (!row.secret_ref) {
        sets.push('secret_ref = ?')
        params.push(ref)
      }
      credentialsChanged = true
    } else if (input.clearKey && row.secret_ref) {
      this.secrets.delete(row.secret_ref)
      sets.push('secret_ref = NULL')
      credentialsChanged = true
    }

    if (credentialsChanged) sets.push(`status = 'unknown'`, 'last_error = NULL')
    if (sets.length > 0) {
      sets.push('updated_at = ?')
      params.push(this.now())
      this.db.run(`UPDATE provider_connections SET ${sets.join(', ')} WHERE id = ?`, ...params, row.id)
      this.events.record({ type: 'connection.updated', message: `Connection "${this.require(row.id).name}" updated` })
    }
    return this.get(row.id)!
  }

  remove(id: string): void {
    const row = this.require(id)
    this.db.run(`DELETE FROM provider_connections WHERE id = ?`, id) // cascades models + prices
    if (row.secret_ref) this.secrets.delete(row.secret_ref)
    this.events.record({ type: 'connection.removed', message: `Connection "${row.name}" removed` })
  }

  // ------------------------------------------------------------------ provider access

  /** Builds a live provider for a connection, pulling the key from the encrypted store. */
  async resolve(id: string): Promise<ResolvedConnection> {
    const { config, row, secret } = await this.configFor(id)
    const provider = (this.opts.providerFactory ?? createChatProvider)(config)
    return { provider, row, secret }
  }

  /** Same as `resolve`, but for the image-generation API of the connection. Throws `unsupported` for providers without one. */
  async resolveImage(id: string): Promise<ResolvedImageConnection> {
    const { config, row, secret } = await this.configFor(id)
    const provider = (this.opts.imageProviderFactory ?? createImageProvider)(config)
    return { provider, row, secret }
  }

  private async configFor(id: string): Promise<{ config: ConnectionConfig; row: Connection; secret: string | undefined }> {
    const row = this.require(id)
    const secret = row.secret_ref ? await this.secrets.get(row.secret_ref) : undefined
    if (row.secret_ref && secret === undefined) {
      throw new ProviderError(
        'The stored API key could not be decrypted (it may have been saved by a different Windows user). Re-enter the key.',
        'auth'
      )
    }
    let headers: Record<string, string> = {}
    try {
      headers = JSON.parse(row.headers_json) as Record<string, string>
    } catch {
      /* ignore malformed header JSON */
    }
    const config: ConnectionConfig = { id: row.id, kind: row.kind, baseUrl: row.base_url, apiKey: secret, headers }
    return { config, row: this.toDto(row), secret }
  }

  private setStatus(id: string, status: ConnectionState, error: string | null): void {
    this.db.run(
      `UPDATE provider_connections SET status = ?, last_error = ?, last_checked_at = ?, updated_at = ? WHERE id = ?`,
      status,
      error,
      this.now(),
      this.now(),
      id
    )
  }

  async test(id: string): Promise<ConnectionTestResult> {
    const row = this.require(id)
    const started = Date.now()
    let secret: string | undefined
    let result: { ok: boolean; latencyMs: number; modelCount?: number; errorKind?: string; error?: string }
    try {
      const resolved = await this.resolve(id)
      secret = resolved.secret
      result = await resolved.provider.testConnection()
    } catch (e) {
      result = {
        ok: false,
        latencyMs: Date.now() - started,
        errorKind: e instanceof ProviderError ? e.kind : 'unknown',
        error: e instanceof Error ? e.message : String(e)
      }
    }
    if (result.error) result.error = redactSecret(result.error, secret)

    this.setStatus(id, result.ok ? 'ok' : 'error', result.ok ? null : (result.error ?? 'Connection failed'))
    this.events.record({
      level: result.ok ? 'info' : 'warn',
      type: result.ok ? 'connection.test_ok' : 'connection.test_failed',
      message: result.ok
        ? `"${row.name}" connected in ${result.latencyMs} ms`
        : `"${row.name}" connection test failed: ${result.error ?? 'unknown error'}`
    })
    return { ...result, connection: this.get(id)! }
  }

  // ------------------------------------------------------------------ models & pricing

  listModels(connectionId: string): ModelEntry[] {
    this.require(connectionId)
    return this.db
      .all<ModelRow>(
        `SELECT m.connection_id, m.model, m.display_name, m.kind, m.context_window,
                p.input_per_mtok AS p_in, p.output_per_mtok AS p_out, p.source AS p_source,
                ip.per_image_usd AS img_usd
           FROM connection_models m
           LEFT JOIN model_pricing p ON p.connection_id = m.connection_id AND p.model = m.model
           LEFT JOIN image_pricing ip ON ip.connection_id = m.connection_id AND ip.model = m.model
          WHERE m.connection_id = ?
          ORDER BY m.kind, m.model COLLATE NOCASE`,
        connectionId
      )
      .map((r) => ({
        connectionId: r.connection_id,
        model: r.model,
        displayName: r.display_name,
        kind: r.kind,
        contextWindow: r.context_window,
        pricing: r.p_in !== null && r.p_out !== null && r.p_source ? { inputPerMTok: r.p_in, outputPerMTok: r.p_out, source: r.p_source } : null,
        imagePriceUsd: r.img_usd
      }))
  }

  async discoverModels(connectionId: string): Promise<ModelEntry[]> {
    const row = this.require(connectionId)
    let secret: string | undefined
    try {
      const resolved = await this.resolve(connectionId)
      secret = resolved.secret
      const models = await resolved.provider.listModels()
      const now = this.now()
      this.db.transaction(() => {
        const keep = new Set<string>()
        for (const m of models) {
          keep.add(m.id)
          this.db.run(
            `INSERT INTO connection_models (connection_id, model, display_name, kind, context_window, fetched_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(connection_id, model) DO UPDATE SET
               display_name = excluded.display_name, kind = excluded.kind,
               context_window = excluded.context_window, fetched_at = excluded.fetched_at`,
            connectionId,
            m.id,
            m.displayName ?? null,
            m.kind,
            m.contextWindow ?? null,
            now
          )
          if (m.pricing) {
            // Provider-reported prices refresh provider rows but never overwrite what the user typed.
            this.db.run(
              `INSERT INTO model_pricing (connection_id, model, input_per_mtok, output_per_mtok, source)
               VALUES (?, ?, ?, ?, 'provider')
               ON CONFLICT(connection_id, model) DO UPDATE SET
                 input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok
               WHERE model_pricing.source = 'provider'`,
              connectionId,
              m.id,
              m.pricing.inputPerMTok,
              m.pricing.outputPerMTok
            )
          }
        }
        // Drop cached models the provider no longer lists (their user-set prices are kept).
        for (const old of this.db.all<{ model: string }>(`SELECT model FROM connection_models WHERE connection_id = ?`, connectionId)) {
          if (!keep.has(old.model)) this.db.run(`DELETE FROM connection_models WHERE connection_id = ? AND model = ?`, connectionId, old.model)
        }
      })
      this.setStatus(connectionId, 'ok', null)
      this.events.record({ type: 'connection.models_discovered', message: `"${row.name}": ${models.length} models found` })
      return this.listModels(connectionId)
    } catch (e) {
      const message = redactSecret(e instanceof Error ? e.message : String(e), secret)
      this.setStatus(connectionId, 'error', message)
      this.events.record({ level: 'warn', type: 'connection.discover_failed', message: `"${row.name}" model discovery failed: ${message}` })
      throw new Error(message)
    }
  }

  setPricing(input: SetPricingInput): void {
    this.require(input.connectionId)
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    if (!model) throw new Error('Model is required.')
    if (input.pricing === null) {
      this.db.run(`DELETE FROM model_pricing WHERE connection_id = ? AND model = ?`, input.connectionId, model)
      return
    }
    const { inputPerMTok: i, outputPerMTok: o } = input.pricing
    for (const [label, v] of [['Input', i], ['Output', o]] as const) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_PRICE_PER_MTOK) {
        throw new Error(`${label} price must be a number between 0 and ${MAX_PRICE_PER_MTOK} (USD per 1M tokens).`)
      }
    }
    this.db.run(
      `INSERT INTO model_pricing (connection_id, model, input_per_mtok, output_per_mtok, source)
       VALUES (?, ?, ?, ?, 'user')
       ON CONFLICT(connection_id, model) DO UPDATE SET
         input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok, source = 'user'`,
      input.connectionId,
      model,
      i,
      o
    )
  }

  /** Sets (or with null removes) the price of one generated picture. Without it the cost of image calls is recorded as unknown. */
  setImagePrice(connectionId: string, model: string, perImageUsd: number | null): void {
    this.require(connectionId)
    const m = typeof model === 'string' ? model.trim() : ''
    if (!m) throw new Error('Model is required.')
    if (perImageUsd === null) {
      this.db.run(`DELETE FROM image_pricing WHERE connection_id = ? AND model = ?`, connectionId, m)
      return
    }
    if (typeof perImageUsd !== 'number' || !Number.isFinite(perImageUsd) || perImageUsd < 0 || perImageUsd > 1000) {
      throw new Error('The price per image must be a number between 0 and 1000 (USD).')
    }
    this.db.run(
      `INSERT INTO image_pricing (connection_id, model, per_image_usd) VALUES (?, ?, ?)
       ON CONFLICT(connection_id, model) DO UPDATE SET per_image_usd = excluded.per_image_usd`,
      connectionId,
      m,
      perImageUsd
    )
  }

  /** USD per generated picture, or undefined when the user has not entered one (the cost is then unknown, never guessed). */
  imagePriceFor(connectionId: string, model: string): number | undefined {
    return this.db.get<{ p: number }>(`SELECT per_image_usd p FROM image_pricing WHERE connection_id = ? AND model = ?`, connectionId, model)?.p
  }

  /** Price for cost estimates: user/provider row, else free for local providers, else unknown (undefined). */
  pricingFor(connectionId: string, model: string): ModelPricing | undefined {
    const p = this.db.get<{ i: number; o: number }>(
      `SELECT input_per_mtok i, output_per_mtok o FROM model_pricing WHERE connection_id = ? AND model = ?`,
      connectionId,
      model
    )
    if (p) return { inputPerMTok: p.i, outputPerMTok: p.o }
    const kind = this.db.get<{ kind: ProviderKind }>(`SELECT kind FROM provider_connections WHERE id = ?`, connectionId)?.kind
    return kind && PROVIDER_CATALOG[kind]?.local ? { inputPerMTok: 0, outputPerMTok: 0 } : undefined
  }
}

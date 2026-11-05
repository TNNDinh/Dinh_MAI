import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The slice of Electron's `safeStorage` (DPAPI-backed on Windows) that we depend on.
 * Async on purpose: Electron 45 deprecated the synchronous methods.
 */
export interface Cipher {
  isEncryptionAvailable(): Promise<boolean>
  encryptString(plain: string): Promise<Buffer>
  decryptString(encrypted: Buffer): Promise<string>
}

export interface SecretStore {
  set(ref: string, value: string): Promise<void>
  get(ref: string): Promise<string | undefined>
  delete(ref: string): void
  has(ref: string): boolean
}

/**
 * Stores each secret encrypted with the OS cipher (Windows DPAPI via Electron
 * safeStorage) in a single file under userData. Ciphertext is bound to the
 * current Windows user, so the file is useless if copied elsewhere.
 *
 * If encryption is unavailable we refuse to store anything rather than fall
 * back to plaintext.
 */
export class EncryptedFileSecretStore implements SecretStore {
  private cache: Record<string, string> | undefined

  constructor(
    private readonly filePath: string,
    private readonly cipher: Cipher
  ) {}

  private load(): Record<string, string> {
    if (this.cache) return this.cache
    if (!existsSync(this.filePath)) return (this.cache = {})
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
      this.cache = parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      // Corrupt file: keep a backup for forensics, start clean rather than crash the app.
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
      } catch {
        /* ignore */
      }
      this.cache = {}
    }
    return this.cache!
  }

  private persist(data: Record<string, string>): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.filePath) // atomic replace: a crash never leaves a half-written file
    this.cache = data
  }

  async set(ref: string, value: string): Promise<void> {
    if (!(await this.cipher.isEncryptionAvailable())) {
      throw new Error('OS encryption (Windows DPAPI) is not available; refusing to store the secret in plaintext.')
    }
    const encrypted = (await this.cipher.encryptString(value)).toString('base64')
    // Re-read after the await so concurrent set() calls don't overwrite each other's entries.
    this.persist({ ...this.load(), [ref]: encrypted })
  }

  async get(ref: string): Promise<string | undefined> {
    const enc = this.load()[ref]
    if (enc === undefined) return undefined
    try {
      return await this.cipher.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      return undefined // e.g. file copied from another Windows user
    }
  }

  has(ref: string): boolean {
    return ref in this.load()
  }

  delete(ref: string): void {
    const data = { ...this.load() }
    if (!(ref in data)) return
    delete data[ref]
    this.persist(data)
  }
}

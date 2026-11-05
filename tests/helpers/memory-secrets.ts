import type { SecretStore } from '../../src/main/secrets/secret-store'

/** In-memory SecretStore for tests; `failNextSet` simulates DPAPI being unavailable. */
export class MemorySecrets implements SecretStore {
  readonly data = new Map<string, string>()
  failNextSet = false

  async set(ref: string, value: string): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false
      throw new Error('OS encryption (Windows DPAPI) is not available; refusing to store the secret in plaintext.')
    }
    this.data.set(ref, value)
  }
  async get(ref: string): Promise<string | undefined> {
    return this.data.get(ref)
  }
  delete(ref: string): void {
    this.data.delete(ref)
  }
  has(ref: string): boolean {
    return this.data.has(ref)
  }
}

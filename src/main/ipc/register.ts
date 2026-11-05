import type { IpcResult } from '../../shared/ipc'
import type { Handlers } from './handlers'

/** The slice of Electron's `ipcMain` we use. */
export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: { senderFrame?: { url: string } | null }, ...args: unknown[]) => unknown
  ): void
}

export interface RegisterOptions {
  /** Only frames served by the app itself may call privileged handlers. */
  isTrustedSender: (url: string | undefined) => boolean
  onError?: (channel: string, error: unknown) => void
}

/**
 * Registers every handler behind a uniform envelope: the renderer always receives
 * `{ok:true,data}` or `{ok:false,error}`, never a raw Electron "Error invoking remote method" string.
 */
export function registerIpc(ipc: IpcMainLike, handlers: Handlers, opts: RegisterOptions): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipc.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
      if (!opts.isTrustedSender(event.senderFrame?.url)) {
        opts.onError?.(channel, new Error(`Rejected call from untrusted sender: ${event.senderFrame?.url ?? 'unknown'}`))
        return { ok: false, error: { message: 'Untrusted caller.' } }
      }
      try {
        const data = await (handler as (...a: unknown[]) => unknown)(...args)
        return { ok: true, data: data === undefined ? null : data }
      } catch (e) {
        opts.onError?.(channel, e)
        return { ok: false, error: { message: e instanceof Error ? e.message : String(e) } }
      }
    })
  }
}

import { contextBridge, ipcRenderer } from 'electron'
import {
  ACTIVITY_CHANNEL,
  APPROVAL_CHANNEL,
  AUTOMATION_CHANNEL,
  CHAT_CHANNEL,
  FS_CHANNEL,
  IPC_CHANNELS,
  PREVIEW_CHANNEL,
  TERMINAL_CHANNEL,
  type ActivityEvent,
  type AutomationRun,
  type ChatStreamEvent,
  type FsChange,
  type IpcResult,
  type PendingApproval,
  type PreviewInfo,
  type StudioApi,
  type TerminalEvent
} from '../shared/ipc'

/** Subscribes to one push channel; returns the unsubscribe function. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * The renderer gets exactly two capabilities: invoke an allow-listed channel, and
 * subscribe to activity events. `ipcRenderer` itself is never exposed.
 */
const api: StudioApi = {
  async invoke(channel, ...args) {
    if (!Object.prototype.hasOwnProperty.call(IPC_CHANNELS, channel)) {
      throw new Error(`Unknown IPC channel: ${String(channel)}`)
    }
    const res = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<never>
    if (!res.ok) throw new Error(res.error.message)
    return res.data
  },
  onActivity(cb) {
    const listener = (_e: unknown, event: ActivityEvent) => cb(event)
    ipcRenderer.on(ACTIVITY_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(ACTIVITY_CHANNEL, listener)
    }
  },
  onChatEvent: (cb) => subscribe<ChatStreamEvent>(CHAT_CHANNEL, cb),
  onTerminalEvent: (cb) => subscribe<TerminalEvent>(TERMINAL_CHANNEL, cb),
  onApprovalsChanged: (cb) => subscribe<PendingApproval[]>(APPROVAL_CHANNEL, cb),
  onFsChange: (cb) => subscribe<FsChange>(FS_CHANNEL, cb),
  onAutomation: (cb) => subscribe<AutomationRun>(AUTOMATION_CHANNEL, cb),
  onPreview: (cb) => subscribe<PreviewInfo>(PREVIEW_CHANNEL, cb)
}

contextBridge.exposeInMainWorld('api', api)

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { statSync } from 'node:fs'
import { BrowserWindow, Menu, app, dialog, ipcMain, nativeImage, safeStorage, shell } from 'electron'
import { ACTIVITY_CHANNEL, APPROVAL_CHANNEL, CHAT_CHANNEL, FS_CHANNEL, TERMINAL_CHANNEL, type AppInfo, type ChatStreamEvent } from '../shared/ipc'
import { AssetService } from './assets/service'
import { bgraToRaster, setForeignDecoder } from './assets/codec'
import { Database } from './db/database'
import { createHandlers } from './ipc/handlers'
import { registerIpc, type IpcMainLike } from './ipc/register'
import { EncryptedFileSecretStore, type Cipher } from './secrets/secret-store'
import { AgentService } from './services/agents'
import { ChatService } from './services/chat'
import { ConnectionService } from './services/connections'
import { DashboardService } from './services/dashboard'
import { EventService } from './services/events'
import { Orchestrator } from './orchestrator/orchestrator'
import { ProjectService } from './services/projects'
import { TaskService } from './services/tasks'
import { runSmokeTest } from './smoke'
import { ApprovalService, CommandService } from './workspace/commands'
import { WorkflowEngine } from './workflows/engine'
import { WorkflowService } from './workflows/service'
import { ContextIndexer } from './workspace/indexer'
import { FileLocks } from './workspace/locks'
import { WorkspaceService } from './workspace/workspace'

// Tests and smoke runs use an isolated data directory instead of the real profile.
const dataOverride = process.env.MADS_USER_DATA
if (dataOverride) app.setPath('userData', dataOverride)

const smokeDir = process.env.MADS_SMOKE
const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL

if (!smokeDir && !app.requestSingleInstanceLock()) {
  app.quit()
}

function gitInit(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['init'], { cwd: dir, timeout: 15_000, windowsHide: true }, (err) => resolve(!err))
  })
}

/** Electron 45 deprecated the sync safeStorage calls, so adapt the async ones (DPAPI on Windows). */
const cipher: Cipher = {
  isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encryptString: (plain) => safeStorage.encryptStringAsync(plain),
  decryptString: async (encrypted) => (await safeStorage.decryptStringAsync(encrypted)).result
}

function isTrustedUrl(url: string | undefined): boolean {
  if (!url) return false
  if (isDev) return url.startsWith(process.env.ELECTRON_RENDERER_URL!)
  return url.startsWith('file://')
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData')
  const db = new Database(join(userData, 'studio.db'))
  const dbVersion = db.migrate()

  const events = new EventService(db)
  events.prune()
  const secrets = new EncryptedFileSecretStore(join(userData, 'secrets.json'), cipher)
  const encryptionAvailable = await cipher.isEncryptionAvailable()
  const defaultProjectsRoot = join(app.getPath('documents'), 'MultiAIStudio', 'Projects')
  const projects = new ProjectService(db, events, { defaultProjectsRoot, gitInit })
  const dashboard = new DashboardService(db)
  const connections = new ConnectionService(db, events, secrets)
  const chat = new ChatService(db, events, connections)
  const agents = new AgentService(db, events, connections)
  const tasks = new TaskService(db, events)
  const locks = new FileLocks(db)
  const commands = new CommandService(db, events, new ApprovalService())
  const workspace = new WorkspaceService(db, events, locks, new ContextIndexer(db))
  const assets = new AssetService({ db, events, workspace, connections })
  // JPEG, WebP, GIF and interlaced PNG are decoded by Electron; PNG uses the built-in decoder.
  setForeignDecoder((data) => {
    const img = nativeImage.createFromBuffer(data)
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    return bgraToRaster(img.toBitmap(), width, height, true)
  })
  const orchestrator = new Orchestrator(db, events, agents, chat, tasks, { workspace, commands, assets })
  // No task can still be running after a restart, so every file lock left in the database is stale.
  locks.clearAll()
  // A run cannot survive a restart: pause what was interrupted so the UI never shows a ghost "running" run.
  const recovered = orchestrator.recover()
  const workflows = new WorkflowService(db, events)
  const workflowEngine = new WorkflowEngine(db, events, agents, orchestrator, workflows, { workspace, commands })
  workflowEngine.recover()

  const mainWindow = () => BrowserWindow.getAllWindows()[0]

  const host = {
    appInfo: (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      userDataPath: userData,
      defaultProjectsRoot,
      dbVersion,
      encryptionAvailable
    }),
    emitChat(event: ChatStreamEvent): void {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(CHAT_CHANNEL, event)
    },
    async pickFolder(): Promise<string | null> {
      const win = mainWindow()
      const opts = { title: 'Choose project folder', properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
    },
    revealInFolder(path: string): void {
      // A file is shown selected in its folder (opening it would launch another program); a folder is opened.
      try {
        if (statSync(path).isFile()) return shell.showItemInFolder(path)
      } catch {
        /* fall through to openPath, which reports nothing for a missing path */
      }
      void shell.openPath(path)
    }
  }

  registerIpc(ipcMain as unknown as IpcMainLike, createHandlers({ projects, dashboard, events, connections, chat, agents, tasks, orchestrator, workspace, commands, assets, workflows, workflowEngine, host }), {
    isTrustedSender: isTrustedUrl,
    onError: (channel, error) =>
      events.record({ level: 'error', type: 'ipc.error', message: `${channel}: ${error instanceof Error ? error.message : String(error)}` })
  })

  // Push every new event to the UI in real time.
  events.subscribe((e) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ACTIVITY_CHANNEL, e)
  })

  const broadcast = (channel: string, payload: unknown): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
  commands.subscribe((e) => broadcast(TERMINAL_CHANNEL, e))
  commands.approvals.subscribe((list) => broadcast(APPROVAL_CHANNEL, list))
  workspace.onChange((c) => broadcast(FS_CHANNEL, c))

  events.record({ type: 'app.started', message: `Multi-AI Development Studio ${app.getVersion()} started` })
  if (!encryptionAvailable) {
    events.record({
      level: 'warn',
      type: 'security.encryption_unavailable',
      message: 'Windows encryption (DPAPI) is unavailable: API keys cannot be stored securely, so saving keys is disabled.'
    })
  }

  if (recovered.runs > 0) {
    events.record({ level: 'warn', type: 'run.recovered_summary', message: `${recovered.runs} interrupted run(s) paused, ${recovered.tasks} task(s) returned to the queue` })
  }

  const win = createWindow()
  if (smokeDir) {
    void runSmokeTest({ win, outDir: smokeDir, secretStoreFactory: (file) => new EncryptedFileSecretStore(file, cipher) })
  }

  app.on('before-quit', () => {
    chat.cancelAll()
    commands.killAll()
    void workflowEngine.stopAll()
    void orchestrator.stopAll()
    db.close()
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1020,
    minHeight: 640,
    show: false,
    backgroundColor: '#0b0d12',
    title: 'Multi-AI Development Studio',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0d12', symbolColor: '#9aa4b2', height: 36 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // The UI is a closed app: never open new windows or navigate away from it.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) e.preventDefault()
  })

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

app.whenReady().then(() => {
  if (app.isPackaged) Menu.setApplicationMenu(null)
  return bootstrap()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

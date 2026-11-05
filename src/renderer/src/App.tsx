import { Suspense, lazy } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { Lock, ShieldAlert, ShieldQuestion } from 'lucide-react'
import { useStudio, type Page } from './store'
import { loadLayout, saveLayout } from './lib/layout-storage'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { RightPanel } from './components/RightPanel'
import { BottomPanel } from './components/BottomPanel'
import { Dashboard } from './pages/Dashboard'
import { Projects } from './pages/Projects'
import { Connections } from './pages/Connections'
import { Agents } from './pages/Agents'
import { Tasks } from './pages/Tasks'
import { Assets } from './pages/Assets'
import { Settings } from './pages/Settings'
import { SourceControl } from './pages/SourceControl'
import { Preview } from './pages/Preview'
import { ApprovalDialog } from './components/ApprovalDialog'
import { useWatchWorkspaceFolder } from './lib/use-workspace-project'

// The workflow editor ships React Flow; load it the first time the page is opened.
const WorkflowPage = lazy(() => import('./pages/Workflow').then((m) => ({ default: m.WorkflowPage })))
// Monaco is large: load it the first time the Workspace page is opened, not at startup.
const Workspace = lazy(() => import('./pages/Workspace').then((m) => ({ default: m.Workspace })))

function PageHost() {
  const page = useStudio((s) => s.page)
  if (page === 'dashboard') return <Dashboard />
  if (page === 'projects') return <Projects />
  if (page === 'workspace')
    return (
      <Suspense fallback={<p className="p-6 text-xs text-faint">Loading editor…</p>}>
        <Workspace />
      </Suspense>
    )
  if (page === 'source') return <SourceControl />
  if (page === 'preview') return <Preview />
  if (page === 'agents') return <Agents />
  if (page === 'connections') return <Connections />
  if (page === 'tasks') return <Tasks />
  if (page === 'assets') return <Assets />
  if (page === 'settings') return <Settings />
  return (
    <Suspense fallback={<p className="p-6 text-xs text-faint">Loading the workflow editor…</p>}>
      <WorkflowPage />
    </Suspense>
  )
}

function StatusBar() {
  const info = useStudio((s) => s.info)
  const approvals = useStudio((s) => s.approvals)
  const minimized = useStudio((s) => s.approvalsMinimized)
  const setMinimized = useStudio((s) => s.setApprovalsMinimized)
  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-line bg-bg px-3 text-[11px] text-faint">
      <span>{info ? `v${info.version} · Electron ${info.electron}` : '…'}</span>
      <span className="flex items-center gap-3">
        {approvals.length > 0 && minimized && (
          <button onClick={() => setMinimized(false)} className="flex items-center gap-1 rounded bg-warn/15 px-1.5 text-warn hover:bg-warn/25" data-approval-chip>
            <ShieldQuestion size={11} /> {approvals.length} request{approvals.length === 1 ? '' : 's'} waiting for your approval
          </button>
        )}
        {info && (
          <span
            className={info.encryptionAvailable ? 'flex items-center gap-1 text-ok' : 'flex items-center gap-1 text-err'}
            title={info.encryptionAvailable ? 'API keys are encrypted with Windows DPAPI' : 'OS encryption unavailable: API keys will NOT be stored'}
          >
            {info.encryptionAvailable ? <Lock size={11} /> : <ShieldAlert size={11} />}
            {info.encryptionAvailable ? 'Key encryption: DPAPI' : 'Key encryption unavailable'}
          </span>
        )}
        {info && <span>DB schema v{info.dbVersion}</span>}
      </span>
    </footer>
  )
}

// A 1px separator is too small a target; the library lets us enlarge the hit area.
const HIT = 8

export function App() {
  useWatchWorkspaceFolder()
  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <Group
        orientation="horizontal"
        id="main"
        className="min-h-0 flex-1"
        resizeTargetMinimumSize={{ coarse: 20, fine: HIT }}
        defaultLayout={loadLayout('main')}
        onLayoutChanged={(l) => saveLayout('main', l)}
      >
        <Panel id="sidebar" defaultSize="14%" minSize="11%" maxSize="24%">
          <Sidebar />
        </Panel>
        <Separator />
        <Panel id="center" minSize="30%">
          <Group
            orientation="vertical"
            id="center-col"
            resizeTargetMinimumSize={{ coarse: 20, fine: HIT }}
            defaultLayout={loadLayout('center')}
            onLayoutChanged={(l) => saveLayout('center', l)}
          >
            <Panel id="workspace" minSize="25%">
              <main className="h-full overflow-y-auto bg-bg">
                <PageHost />
              </main>
            </Panel>
            <Separator />
            <Panel id="bottom" defaultSize="26%" minSize="8%" maxSize="60%">
              <BottomPanel />
            </Panel>
          </Group>
        </Panel>
        <Separator />
        <Panel id="right" defaultSize="22%" minSize="15%" maxSize="40%">
          <RightPanel />
        </Panel>
      </Group>
      <StatusBar />
      <ApprovalDialog />
    </div>
  )
}

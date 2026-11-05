import { Lock, ShieldAlert } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { CommandPolicyInfo } from '../../../shared/ipc'
import { useStudio } from '../store'
import { Badge, Card, CardHeader, PageHeader } from '../components/ui'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-line/60 px-4 py-2.5 last:border-0">
      <dt className="shrink-0 text-xs text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-[12px] break-all" data-selectable>
        {children}
      </dd>
    </div>
  )
}

/** Read-only for now: shows the facts that matter for trust. Editable settings arrive with the features they control. */
export function Settings() {
  const info = useStudio((s) => s.info)
  const [policy, setPolicy] = useState<CommandPolicyInfo | null>(null)
  useEffect(() => {
    void window.api.invoke('term:policy').then(setPolicy, () => undefined)
  }, [])
  if (!info) return <p className="p-6 text-xs text-faint">Loading…</p>

  return (
    <div className="page-enter mx-auto max-w-3xl space-y-4 p-6">
      <PageHeader title="Settings" subtitle="System and security information for this installation." />

      <Card>
        <CardHeader title="Security" />
        <dl>
          <Row label="API key encryption">
            {info.encryptionAvailable ? (
              <span className="inline-flex items-center gap-1 text-ok">
                <Lock size={12} /> Windows DPAPI available
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-err">
                <ShieldAlert size={12} /> Unavailable: keys cannot be saved
              </span>
            )}
          </Row>
          <Row label="Key storage">Encrypted file in the data folder, bound to your Windows user. Never stored in plain text.</Row>
          <Row label="Keys in the UI">Never sent to the interface after saving. Only “a key is stored” is shown.</Row>
          <Row label="Renderer isolation">Sandboxed, context-isolated, no Node access. Only an allow-listed set of IPC calls is exposed.</Row>
        </dl>
      </Card>

      <Card>
        <CardHeader title="Commands and files" />
        <dl>
          <Row label="Agent file access">Only inside the project folder. Links and junctions that lead elsewhere are refused. Agents cannot read or write credential files such as .env, keys and certificates, nor the .git folder.</Row>
          <Row label="Agent commands">
            Each agent has a setting: none, ask every time, or allow-list. With the allow-list, only the safe commands below run unattended; everything else waits for your approval in a dialog.
          </Row>
          <Row label="Always blocked">Destructive or privilege-changing commands are refused for everyone, even if you would approve them.</Row>
          <Row label="Limits">This is a guard rail, not an operating-system sandbox: a command you allow runs with your Windows user’s permissions. Commands get a cleaned environment (no API keys or tokens), no keyboard input, and a time limit.</Row>
        </dl>
        {policy && (
          <div className="grid gap-4 border-t border-line p-4 md:grid-cols-2" data-policy>
            <div>
              <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-ok uppercase">Runs without asking (allow-list)</h4>
              <ul className="space-y-1 text-[12px] text-muted">
                {policy.safe.map((s) => (
                  <li key={s} className="font-mono" data-selectable>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-err uppercase">Always blocked</h4>
              <ul className="space-y-1 text-[12px] text-muted">
                {policy.blocked.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Storage" />
        <dl>
          <Row label="Data folder">{info.userDataPath}</Row>
          <Row label="Default projects folder">{info.defaultProjectsRoot}</Row>
          <Row label="Database schema">v{info.dbVersion}</Row>
        </dl>
      </Card>

      <Card>
        <CardHeader title="Application" />
        <dl>
          <Row label="Version">{info.version}</Row>
          <Row label="Electron / Node">
            {info.electron} / {info.node}
          </Row>
          <Row label="Platform">{info.platform}</Row>
        </dl>
      </Card>

      <Card>
        <CardHeader title="Not yet available" />
        <ul className="space-y-2 p-4 text-xs text-muted">
          <li className="flex items-center justify-between gap-3">
            Interactive terminal (a real shell with typed input) <Badge>Not built</Badge>
          </li>
          <li className="flex items-center justify-between gap-3">
            App-wide default budget and review-round limits (today they are set per project and per run) <Badge>Not built</Badge>
          </li>
        </ul>
      </Card>
    </div>
  )
}

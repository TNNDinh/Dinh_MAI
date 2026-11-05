import type { Connection } from '../../../../shared/ipc'
import { Badge } from '../ui'
import { timeAgo } from '../../lib/format'

export function ConnectionStatusBadge({ c }: { c: Pick<Connection, 'status' | 'enabled' | 'lastCheckedAt' | 'lastError'> }) {
  if (!c.enabled) return <Badge tone="neutral">Disabled</Badge>
  const when = c.lastCheckedAt ? `checked ${timeAgo(c.lastCheckedAt)}` : ''
  if (c.status === 'ok') return <Badge tone="ok" title={when}>Connected</Badge>
  if (c.status === 'error') return <Badge tone="err" title={c.lastError ?? when}>Error</Badge>
  return <Badge tone="neutral" title="Run “Test connection” to check it">Not tested</Badge>
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

import type { RunStatus, Task, TaskStatus } from '../../../../shared/ipc'
import { Badge } from '../ui'

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  failed: 'Failed',
  blocked: 'Blocked'
}

export const TASK_STATUS_DOT: Record<TaskStatus, string> = {
  todo: 'bg-faint',
  in_progress: 'bg-info',
  review: 'bg-accent',
  testing: 'bg-accent',
  done: 'bg-ok',
  failed: 'bg-err',
  blocked: 'bg-warn'
}

const TASK_TONE = { todo: 'neutral', in_progress: 'info', review: 'accent', testing: 'accent', done: 'ok', failed: 'err', blocked: 'warn' } as const

export const TaskStatusBadge = ({ status }: { status: TaskStatus }) => <Badge tone={TASK_TONE[status]}>{TASK_STATUS_LABEL[status]}</Badge>

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  pending: 'Starting',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped'
}
const RUN_TONE = { pending: 'info', running: 'info', paused: 'warn', completed: 'ok', failed: 'err', cancelled: 'neutral' } as const

export const RunStatusBadge = ({ status }: { status: RunStatus }) => <Badge tone={RUN_TONE[status]}>{RUN_STATUS_LABEL[status]}</Badge>

export const isActiveRun = (status: RunStatus): boolean => status === 'running' || status === 'pending'

export const PRIORITY_LABEL: Record<number, string> = { 1: 'High', 2: 'Normal', 3: 'Low' }

/** Tasks that still need work (used for sidebar counters). */
export const isOpenTask = (t: Pick<Task, 'status'>): boolean => t.status === 'todo' || t.status === 'in_progress' || t.status === 'review' || t.status === 'testing'

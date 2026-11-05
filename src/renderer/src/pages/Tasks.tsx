import {
  AlertTriangle,
  ListChecks,
  Play,
  Plus,
  RotateCcw,
  Square,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { Run, Task, TaskStatus } from "../../../shared/ipc";
import { useStudio } from "../store";
import { fmtUsd, timeAgo } from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  ProgressBar,
  Select,
  cx,
} from "../components/ui";
import { errMsg } from "../components/connections/StatusBadge";
import { AddTaskModal } from "../components/tasks/AddTaskModal";
import { ResumeModal, StartRunModal } from "../components/tasks/RunModals";
import { TaskDrawer } from "../components/tasks/TaskDrawer";
import {
  RunStatusBadge,
  TASK_STATUS_DOT,
  TASK_STATUS_LABEL,
  isActiveRun,
} from "../components/tasks/meta";

const BASE_COLUMNS: TaskStatus[] = [
  "todo",
  "in_progress",
  "done",
  "failed",
  "blocked",
];

function TaskCard({
  task,
  selected,
  roleLabel,
  onOpen,
}: {
  task: Task;
  selected: boolean;
  roleLabel: string | null;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        data-task={task.title}
        data-status={task.status}
        aria-current={selected}
        onClick={onOpen}
        className={cx(
          "w-full rounded-md border px-2.5 py-2 text-left transition-colors",
          selected
            ? "border-accent/60 bg-accent-soft"
            : "border-line bg-panel hover:bg-hover",
        )}
      >
        <div className="text-[12.5px] leading-snug font-medium break-words">
          {task.title}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
          {(task.assignedAgentName ?? roleLabel) && (
            <span className="max-w-full truncate text-muted">
              {task.assignedAgentName ?? roleLabel}
            </span>
          )}
          {task.priority === 1 && <span className="text-warn">High</span>}
          {task.dependsOn.length > 0 && (
            <span title="Waits for other tasks">⛓ {task.dependsOn.length}</span>
          )}
          {task.attempts > 1 && <span title="Attempts">↻ {task.attempts}</span>}
          {task.costUsd > 0 && (
            <span className="tabular-nums">{fmtUsd(task.costUsd)}</span>
          )}
        </div>
        {task.status === "failed" && task.error && (
          <div className="mt-1.5 line-clamp-2 text-[11px] break-words text-err">
            {task.error}
          </div>
        )}
        {task.status === "blocked" && task.error && (
          <div className="mt-1.5 line-clamp-2 text-[11px] break-words text-warn">
            {task.error}
          </div>
        )}
      </button>
    </li>
  );
}

function RunPanel({
  run,
  project,
  onStart,
  onResume,
}: {
  run: Run | undefined;
  project: { name: string };
  onStart: () => void;
  onResume: () => void;
}) {
  const refresh = useStudio((s) => s.refresh);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  async function stop() {
    if (!run) return;
    setStopping(true);
    setError(null);
    try {
      await window.api.invoke("runs:stop", run.id);
      await refresh();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setStopping(false);
    }
  }

  if (!run) {
    return (
      <Card className="mb-4 flex items-center justify-between gap-4 p-4">
        <div>
          <div className="text-[13px] font-medium">
            No run yet in {project.name}
          </div>
          <p className="mt-0.5 text-xs text-muted">
            Start a run and the Project Manager will plan the work, then the
            team carries it out.
          </p>
        </div>
        <Button variant="primary" onClick={onStart} data-action="start-run">
          <Play size={13} /> Start run
        </Button>
      </Card>
    );
  }

  const total = Object.values(run.taskCounts).reduce((a, b) => a + b, 0);
  const active = isActiveRun(run.status);
  const overBudget = run.budgetUsd !== null && run.spentUsd >= run.budgetUsd;
  const pct = total === 0 ? 0 : run.taskCounts.done / total;

  return (
    <Card className="mb-4 p-4" data-testid="run-panel">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <RunStatusBadge status={run.status} />
            <span className="text-[11px] text-faint">
              {run.finishedAt
                ? `finished ${timeAgo(run.finishedAt)}`
                : run.startedAt
                  ? `started ${timeAgo(run.startedAt)}`
                  : ""}
            </span>
          </div>
          <p
            className="mt-1.5 line-clamp-2 text-[13px] break-words"
            title={run.goal}
            data-selectable
          >
            {run.goal}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {active ? (
            <Button
              variant="danger"
              onClick={() => void stop()}
              disabled={stopping}
              data-action="stop-run"
            >
              <Square size={12} /> {stopping ? "Stopping…" : "Stop"}
            </Button>
          ) : (
            <>
              {run.status !== "completed" && (
                <Button onClick={onResume} data-action="resume-run">
                  <RotateCcw size={13} /> Resume
                </Button>
              )}
              <Button
                variant="primary"
                onClick={onStart}
                data-action="start-run"
              >
                <Play size={13} /> New run
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <ProgressBar value={pct} className="flex-1" />
        <span className="text-xs text-muted tabular-nums">
          {run.taskCounts.done}/{total} done
        </span>
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="flex gap-1.5">
          <dt className="text-faint">Spent</dt>
          <dd
            className={cx("tabular-nums", overBudget && "text-warn")}
            data-testid="run-spent"
          >
            {run.unpricedCalls > 0 ? "≥ " : ""}
            {fmtUsd(run.spentUsd)}
            {run.budgetUsd !== null ? ` of ${fmtUsd(run.budgetUsd)}` : ""}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-faint">Review rounds</dt>
          <dd className="tabular-nums">
            {run.iteration}/{run.maxIterations}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-faint">Parallel</dt>
          <dd className="tabular-nums">{run.concurrency}</dd>
        </div>
        {run.unpricedCalls > 0 && (
          <div
            className="text-warn"
            title="These calls used a model with no price set, so cost is a lower bound and can’t be held to the budget."
          >
            {run.unpricedCalls} unpriced call
            {run.unpricedCalls === 1 ? "" : "s"}
          </div>
        )}
      </dl>

      {run.error && run.status !== "completed" && (
        <p
          role="status"
          data-testid="run-error"
          className={cx(
            "mt-3 flex gap-2 rounded-md border p-2.5 text-xs break-words",
            run.status === "paused"
              ? "border-warn/30 bg-warn/10 text-warn"
              : run.status === "cancelled"
                ? "border-line bg-bg text-muted"
                : "border-err/30 bg-err/10 text-err",
          )}
        >
          <AlertTriangle size={13} className="mt-px shrink-0" />
          <span data-selectable>{run.error}</span>
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-err">
          {error}
        </p>
      )}
    </Card>
  );
}

export function Tasks() {
  const {
    projects,
    runs,
    tasks,
    agentTemplates,
    taskProjectId,
    setTaskProject,
    selectedProjectId,
    selectedTaskId,
    setSelectedTask,
  } = useStudio();
  const [starting, setStarting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [adding, setAdding] = useState(false);

  const projectId = projects.some((p) => p.id === taskProjectId)
    ? taskProjectId
    : ((projects.find((p) => p.id === selectedProjectId) ?? projects[0])?.id ??
      null);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === projectId),
    [tasks, projectId],
  );
  const latestRun = runs.find((r) => r.projectId === projectId); // runs:list is newest-first
  const selected = projectTasks.find((t) => t.id === selectedTaskId) ?? null;
  const roleLabel = (key: string | null) =>
    key ? (agentTemplates.find((t) => t.key === key)?.label ?? key) : null;

  const columns = BASE_COLUMNS.flatMap<TaskStatus>((s) =>
    s === "done" ? ["review", "testing", "done"] : [s],
  ).filter(
    (s) => BASE_COLUMNS.includes(s) || projectTasks.some((t) => t.status === s),
  );

  if (!project) {
    return (
      <div className="page-enter mx-auto max-w-6xl p-6">
        <PageHeader
          title="Task Manager"
          subtitle="The shared task board for your AI team."
        />
        <Card>
          <EmptyState icon={<ListChecks size={22} />} title="No projects yet">
            Create a project first. Its tasks, runs and team all live under it.
          </EmptyState>
        </Card>
      </div>
    );
  }

  return (
    <div
      className={cx(
        "page-enter mx-auto max-w-[1400px] p-6",
        selected && "pr-[484px]",
      )}
    >
      <PageHeader
        title="Task Manager"
        subtitle="The Project Manager plans the work onto this board; agents pick tasks up in dependency order."
        action={
          <Button onClick={() => setAdding(true)} data-action="add-task">
            <Plus size={14} /> Add task
          </Button>
        }
      />

      <div className="mb-4 flex items-center gap-2">
        <Select
          value={project.id}
          onChange={(e) => setTaskProject(e.target.value)}
          aria-label="Project"
          className="w-72"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Badge>
          {projectTasks.length} task{projectTasks.length === 1 ? "" : "s"}
        </Badge>
      </div>

      <RunPanel
        run={latestRun}
        project={project}
        onStart={() => setStarting(true)}
        onResume={() => setResuming(true)}
      />

      {projectTasks.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ListChecks size={22} />}
            title="The board is empty"
          >
            Start a run to have the Project Manager break the goal into tasks,
            or add tasks yourself. Tasks you assign to a role or agent are
            picked up by the next run.
          </EmptyState>
        </Card>
      ) : (
        <div className="overflow-x-auto pb-2">
          <div
            className="grid min-w-max items-start gap-3"
            style={{
              gridTemplateColumns: `repeat(${columns.length}, minmax(190px, 1fr))`,
            }}
            data-testid="board"
          >
            {columns.map((status) => {
              const items = projectTasks.filter((t) => t.status === status);
              return (
                <section
                  key={status}
                  aria-label={TASK_STATUS_LABEL[status]}
                  data-column={status}
                  className="min-w-0 rounded-lg border border-line bg-bg/60"
                >
                  <h3 className="flex items-center gap-2 border-b border-line px-3 py-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
                    <span
                      className={cx(
                        "size-2 rounded-full",
                        TASK_STATUS_DOT[status],
                      )}
                    />
                    {TASK_STATUS_LABEL[status]}
                    <span className="ml-auto font-normal tabular-nums text-faint">
                      {items.length}
                    </span>
                  </h3>
                  <ul className="space-y-1.5 p-2">
                    {items.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        selected={t.id === selectedTaskId}
                        roleLabel={roleLabel(t.role)}
                        onOpen={() => setSelectedTask(t.id)}
                      />
                    ))}
                    {items.length === 0 && (
                      <li className="px-1 py-3 text-center text-[11px] text-faint">
                        —
                      </li>
                    )}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      )}

      {selected && (
        <TaskDrawer
          key={selected.id}
          task={selected}
          onClose={() => setSelectedTask(null)}
        />
      )}
      {starting && (
        <StartRunModal
          project={project}
          onClose={() => setStarting(false)}
          onStarted={() => setStarting(false)}
        />
      )}
      {resuming && latestRun && (
        <ResumeModal
          run={latestRun}
          onClose={() => setResuming(false)}
          onResumed={() => setResuming(false)}
        />
      )}
      {adding && (
        <AddTaskModal
          project={project}
          onClose={() => setAdding(false)}
          onCreated={(t) => {
            setAdding(false);
            setSelectedTask(t.id);
          }}
        />
      )}
    </div>
  );
}

import { FolderOpen, FolderPlus, GitBranch } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { PROJECT_TYPES, type FolderInspection, type Project, type ProjectType } from '../../../shared/ipc'
import { useStudio } from '../store'
import { timeAgo } from '../lib/format'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, ProgressBar, Select, Textarea } from '../components/ui'
import { ProjectDetail } from './ProjectDetail'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const { info, refresh, openProject } = useStudio()
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [rootPath, setRootPath] = useState('')
  const [type, setType] = useState<ProjectType | ''>('')
  const [budget, setBudget] = useState('')
  const [maxIter, setMaxIter] = useState('10')
  const [inspection, setInspection] = useState<FolderInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)

  // A previous failure no longer applies once the user edits anything.
  useEffect(() => setError(null), [name, goal, rootPath, type, budget, maxIter])

  // Inspect the chosen folder so we can auto-detect the type and warn about duplicates.
  useEffect(() => {
    if (!rootPath.trim()) {
      setInspection(null)
      return
    }
    const mine = ++seq.current
    const t = setTimeout(() => {
      window.api.invoke('projects:inspectFolder', rootPath.trim()).then(
        (r) => mine === seq.current && setInspection(r),
        () => mine === seq.current && setInspection(null)
      )
    }, 250)
    return () => clearTimeout(t)
  }, [rootPath])

  const effectiveType: ProjectType = type || inspection?.detectedType || 'other'

  async function browse() {
    try {
      const picked = await window.api.invoke('projects:pickFolder')
      if (picked) setRootPath(picked)
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const budgetNum = budget.trim() === '' ? null : Number(budget)
      if (budgetNum !== null && (!Number.isFinite(budgetNum) || budgetNum < 0)) throw new Error('Budget must be a positive number or empty.')
      const project = await window.api.invoke('projects:create', {
        name: name.trim(),
        goal: goal.trim(),
        rootPath: rootPath.trim() || undefined,
        type: type || undefined,
        budgetUsd: budgetNum,
        maxIterations: Number(maxIter) || 10
      })
      await refresh()
      onClose()
      openProject(project.id)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy || !name.trim() || inspection?.alreadyRegistered === true} data-testid="create-project-submit">
            {busy ? 'Creating…' : 'Create project'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="2D Survival Game" data-testid="project-name" />
        </Field>
        <Field label="Goal" hint="What should the AI team build? Agents read this as the project brief.">
          <Textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="A top-down 2D survival game with crafting, day/night cycle and enemies." />
        </Field>

        <Field
          label="Project folder"
          hint={rootPath.trim() ? undefined : `Leave empty to create a new folder under ${info?.defaultProjectsRoot ?? 'the default projects directory'}.`}
        >
          <div className="flex gap-2">
            <Input value={rootPath} onChange={(e) => setRootPath(e.target.value)} placeholder="Existing folder or a new path" className="flex-1" />
            <Button onClick={browse} type="button">
              <FolderOpen size={14} /> Browse
            </Button>
          </div>
        </Field>

        {inspection && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {!inspection.exists && <Badge tone="info">Folder will be created</Badge>}
            {inspection.exists && inspection.isEmpty && <Badge>Empty folder</Badge>}
            {inspection.exists && !inspection.isEmpty && <Badge tone="accent">Existing files will be kept</Badge>}
            {inspection.isGitRepo ? <Badge tone="ok">Git repository</Badge> : <Badge>Git will be initialised</Badge>}
            {inspection.alreadyRegistered && <Badge tone="err">Already registered as a project</Badge>}
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <Field label="Type" hint={!type && inspection ? 'Auto-detected' : undefined}>
            <Select value={type || effectiveType} onChange={(e) => setType(e.target.value as ProjectType)}>
              {PROJECT_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Budget (USD)" hint="Empty = no limit">
            <Input type="number" min="0" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="∞" />
          </Field>
          <Field label="Max iterations" hint="Fix-loop cap">
            <Input type="number" min="1" max="50" value={maxIter} onChange={(e) => setMaxIter(e.target.value)} />
          </Field>
        </div>

        {error && (
          <div role="alert" className="rounded-md border border-err/30 bg-err/10 px-3 py-2 text-xs text-err" data-testid="create-project-error">
            {error}
          </div>
        )}
      </div>
    </Modal>
  )
}

function ProjectCard({ p }: { p: Project }) {
  const openProject = useStudio((s) => s.openProject)
  return (
    <button data-project-card={p.id} onClick={() => openProject(p.id)} className="text-left">
      <Card className="h-full p-4 transition-colors hover:border-accent/50 hover:bg-hover/40">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-sm font-semibold">{p.name}</h3>
          <Badge tone={p.status === 'active' ? 'accent' : p.status === 'completed' ? 'ok' : 'neutral'}>{p.status}</Badge>
        </div>
        <p className="mt-1 line-clamp-2 min-h-8 text-xs text-muted">{p.goal || 'No goal set.'}</p>
        <div className="mt-3 flex items-center gap-3">
          <ProgressBar value={p.progress} className="flex-1" />
          <span className="text-[11px] text-faint tabular-nums">{Math.round(p.progress * 100)}%</span>
        </div>
        <div className="mt-3 flex items-center justify-between text-[11px] text-faint">
          <span className="flex items-center gap-1 truncate" title={p.rootPath}>
            <GitBranch size={11} /> {p.type}
          </span>
          <span>{timeAgo(p.updatedAt)}</span>
        </div>
      </Card>
    </button>
  )
}

export function Projects() {
  const { projects, selectedProjectId } = useStudio()
  const [creating, setCreating] = useState(false)
  const selected = selectedProjectId ? projects.find((p) => p.id === selectedProjectId) : undefined

  if (selected) return <ProjectDetail project={selected} />

  return (
    <div className="page-enter mx-auto max-w-6xl p-6">
      <PageHeader
        title="Projects"
        subtitle="Each project is a folder on disk. Agents can only read and write inside it."
        action={
          <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-project">
            <FolderPlus size={14} /> New project
          </Button>
        }
      />
      {projects.length === 0 ? (
        <Card>
          <EmptyState icon={<FolderPlus size={24} />} title="No projects yet">
            Create a project to give your AI team a workspace. You can start from an empty folder or open an existing codebase.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}
      {creating && <CreateProjectModal onClose={() => setCreating(false)} />}
    </div>
  )
}

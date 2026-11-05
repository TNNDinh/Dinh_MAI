import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  PROJECT_TYPES,
  type CreateProjectInput,
  type FolderInspection,
  type Project,
  type ProjectStatus,
  type ProjectType,
  type UpdateProjectInput
} from '../../shared/ipc'
import type { Database } from '../db/database'
import { assertSafeProjectRoot, normalizePath, toFolderName } from '../security/path-guard'
import { detectProjectType, isGitRepo } from '../workspace/detect-project-type'
import type { EventService } from './events'

interface ProjectRow {
  id: string
  name: string
  type: ProjectType
  root_path: string
  goal: string
  status: ProjectStatus
  progress: number
  budget_usd: number | null
  max_iterations: number
  auto_recovery: number
  created_at: number
  updated_at: number
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  name: r.name,
  type: r.type,
  rootPath: r.root_path,
  goal: r.goal,
  status: r.status,
  progress: r.progress,
  budgetUsd: r.budget_usd,
  maxIterations: r.max_iterations,
  autoRecovery: r.auto_recovery === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

const VALID_TYPES = new Set<string>(PROJECT_TYPES.map((t) => t.value))
const VALID_STATUS = new Set<string>(['active', 'completed', 'archived'])

function validateName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Project name is required.')
  const n = name.trim()
  if (n.length > 80) throw new Error('Project name must be 80 characters or fewer.')
  return n
}

function validateBudget(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error('Budget must be a non-negative number.')
  return v
}

function validateIterations(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 50) {
    throw new Error('Max iterations must be a whole number between 1 and 50.')
  }
  return v
}

export interface ProjectServiceOptions {
  /** Where new project folders are created when no folder is chosen. */
  defaultProjectsRoot: string
  /** Initialises a git repo. Injected so tests don't need git; returns false on failure. */
  gitInit: (dir: string) => Promise<boolean>
}

export class ProjectService {
  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly opts: ProjectServiceOptions
  ) {}

  list(): Project[] {
    return this.db.all<ProjectRow>('SELECT * FROM projects ORDER BY updated_at DESC').map(toProject)
  }

  get(id: string): Project | null {
    const r = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
    return r ? toProject(r) : null
  }

  private findByPath(rootPath: string): Project | undefined {
    const target = normalizePath(rootPath)
    return this.list().find((p) => normalizePath(p.rootPath) === target)
  }

  inspectFolder(path: string): FolderInspection {
    const root = resolve(path)
    const exists = existsSync(root) && statSync(root).isDirectory()
    return {
      exists,
      isEmpty: exists ? readdirSync(root).length === 0 : true,
      isGitRepo: exists && isGitRepo(root),
      detectedType: exists ? detectProjectType(root) : 'other',
      alreadyRegistered: !!this.findByPath(root)
    }
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const name = validateName(input.name)
    const budgetUsd = validateBudget(input.budgetUsd)
    const maxIterations = validateIterations(input.maxIterations ?? 5)
    if (input.type !== undefined && !VALID_TYPES.has(input.type)) throw new Error(`Unknown project type "${input.type}".`)

    const usingDefaultLocation = !input.rootPath
    const root = assertSafeProjectRoot(input.rootPath ?? join(this.opts.defaultProjectsRoot, toFolderName(name)))

    if (existsSync(root)) {
      if (!statSync(root).isDirectory()) throw new Error('The chosen path is a file, not a folder.')
      // A brand-new project must not silently adopt an unrelated, populated folder.
      if (usingDefaultLocation && readdirSync(root).length > 0) {
        throw new Error(`The folder "${root}" already exists and is not empty. Pick a different name or choose that folder explicitly.`)
      }
    } else {
      mkdirSync(root, { recursive: true })
    }
    if (this.findByPath(root)) throw new Error('This folder is already a project in the studio.')

    const type = input.type ?? detectProjectType(root)
    const now = Date.now()
    const id = randomUUID()
    this.db.run(
      `INSERT INTO projects (id, name, type, root_path, goal, status, progress, budget_usd, max_iterations, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)`,
      id,
      name,
      type,
      root,
      (input.goal ?? '').trim(),
      budgetUsd,
      maxIterations,
      now,
      now
    )
    this.events.record({ projectId: id, type: 'project.created', message: `Project "${name}" created (${type}) at ${root}` })

    // Git underpins checkpoints, branches and rollback, so every project gets a repo.
    if (!isGitRepo(root)) {
      const ok = await this.opts.gitInit(root)
      this.events.record(
        ok
          ? { projectId: id, type: 'git.initialized', message: 'Initialised a git repository' }
          : { projectId: id, level: 'warn', type: 'git.init_failed', message: 'Could not initialise git (is git installed?). Checkpoints and rollback will be unavailable.' }
      )
    }
    return this.get(id)!
  }

  update(input: UpdateProjectInput): Project {
    const current = this.get(input.id)
    if (!current) throw new Error('Project not found.')
    const name = input.name !== undefined ? validateName(input.name) : current.name
    const type = input.type ?? current.type
    if (!VALID_TYPES.has(type)) throw new Error(`Unknown project type "${type}".`)
    const status = input.status ?? current.status
    if (!VALID_STATUS.has(status)) throw new Error(`Unknown status "${status}".`)
    const budgetUsd = input.budgetUsd !== undefined ? validateBudget(input.budgetUsd) : current.budgetUsd
    const maxIterations = input.maxIterations !== undefined ? validateIterations(input.maxIterations) : current.maxIterations
    if (input.autoRecovery !== undefined && typeof input.autoRecovery !== 'boolean') throw new Error('Auto Recovery must be on or off.')
    const autoRecovery = input.autoRecovery ?? current.autoRecovery

    this.db.run(
      `UPDATE projects SET name=?, type=?, goal=?, status=?, budget_usd=?, max_iterations=?, auto_recovery=?, updated_at=? WHERE id=?`,
      name,
      type,
      (input.goal ?? current.goal).trim(),
      status,
      budgetUsd,
      maxIterations,
      autoRecovery ? 1 : 0,
      Date.now(),
      input.id
    )
    if (status !== current.status) {
      this.events.record({ projectId: input.id, type: 'project.status', message: `Project "${name}" marked ${status}` })
    }
    if (autoRecovery !== current.autoRecovery) {
      this.events.record({ projectId: input.id, type: 'project.auto_recovery', message: `Auto Recovery ${autoRecovery ? 'turned on' : 'turned off'} for "${name}"` })
    }
    return this.get(input.id)!
  }

  /** Unregisters the project. Files on disk are never touched. */
  remove(id: string): void {
    const p = this.get(id)
    if (!p) return
    this.db.run('DELETE FROM projects WHERE id = ?', id)
    this.events.record({ type: 'project.removed', message: `Project "${p.name}" removed from the studio (files kept at ${p.rootPath})` })
  }
}

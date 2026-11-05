import type { ToolDefinition } from '../providers/types'

export const MAX_PLAN_TASKS = 40

export interface PlanTask {
  key: string
  title: string
  description: string
  role: string
  priority: number
  dependsOn: string[]
}

export type PlanResult = { ok: true; tasks: PlanTask[] } | { ok: false; errors: string[] }

export const SUBMIT_PLAN_TOOL: ToolDefinition = {
  name: 'submit_plan',
  description:
    'Submit the complete task plan for the goal. Call it exactly once when the plan is final. If it is rejected, the reply lists what to fix: correct it and call again.',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: `1 to ${MAX_PLAN_TASKS} tasks.`,
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'Short unique id used by other tasks in depends_on, e.g. "design" or "player_code".' },
            title: { type: 'string', description: 'Imperative title, max 200 characters.' },
            description: { type: 'string', description: 'What to do and the acceptance criteria, specific enough to act on without further questions.' },
            role: { type: 'string', description: 'The role key of the team member who does it (see the team list).' },
            priority: { type: 'integer', description: '1 = high, 2 = normal, 3 = low.' },
            depends_on: { type: 'array', items: { type: 'string' }, description: 'Keys of tasks that must be finished first.' }
          },
          required: ['key', 'title', 'description', 'role']
        }
      }
    },
    required: ['tasks']
  }
}

const KEY = /^[A-Za-z0-9_-]{1,40}$/

/**
 * Checks a plan the model produced. Everything the model says is untrusted: roles must exist on this
 * project's team, dependencies must resolve and be acyclic, sizes are bounded. The errors are written to be
 * fed straight back to the model so it can correct itself.
 */
export function validatePlan(raw: unknown, availableRoles: ReadonlySet<string>): PlanResult {
  const errors: string[] = []
  const list = (raw as { tasks?: unknown } | null)?.tasks
  if (!Array.isArray(list) || list.length === 0) return { ok: false, errors: ['`tasks` must be a non-empty array.'] }
  if (list.length > MAX_PLAN_TASKS) return { ok: false, errors: [`Too many tasks (${list.length}); the maximum is ${MAX_PLAN_TASKS}. Merge small tasks.`] }

  const tasks: PlanTask[] = []
  const keys = new Set<string>()
  list.forEach((t, i) => {
    const at = `Task #${i + 1}`
    if (typeof t !== 'object' || t === null) return errors.push(`${at} is not an object.`)
    const o = t as Record<string, unknown>
    const key = typeof o.key === 'string' ? o.key.trim() : ''
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    const description = typeof o.description === 'string' ? o.description.trim() : ''
    const role = typeof o.role === 'string' ? o.role.trim() : ''
    if (!KEY.test(key)) errors.push(`${at}: key must be 1-40 letters, digits, "_" or "-".`)
    else if (keys.has(key)) errors.push(`${at}: duplicate key "${key}".`)
    else keys.add(key)
    if (!title || title.length > 200) errors.push(`${at} (${key}): title is required (max 200 characters).`)
    if (description.length > 4000) errors.push(`${at} (${key}): description is too long (max 4000 characters).`)
    if (!availableRoles.has(role)) errors.push(`${at} (${key}): role "${role}" is not on the team. Available roles: ${[...availableRoles].join(', ')}.`)
    const pr = o.priority === undefined ? 2 : o.priority
    if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1 || pr > 3) errors.push(`${at} (${key}): priority must be 1, 2 or 3.`)
    const deps = o.depends_on === undefined ? [] : o.depends_on
    if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) errors.push(`${at} (${key}): depends_on must be an array of keys.`)
    tasks.push({ key, title, description, role, priority: typeof pr === 'number' ? pr : 2, dependsOn: Array.isArray(deps) ? [...new Set(deps.map(String))] : [] })
  })
  if (errors.length) return { ok: false, errors }

  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (d === t.key) errors.push(`Task "${t.key}" depends on itself.`)
      else if (!keys.has(d)) errors.push(`Task "${t.key}" depends on unknown key "${d}".`)
    }
  }
  if (errors.length) return { ok: false, errors }

  // Kahn's algorithm: whatever cannot be ordered sits on a cycle.
  const indeg = new Map(tasks.map((t) => [t.key, t.dependsOn.length]))
  const queue = tasks.filter((t) => t.dependsOn.length === 0).map((t) => t.key)
  let seen = 0
  while (queue.length) {
    const k = queue.shift()!
    seen++
    for (const t of tasks) {
      if (t.dependsOn.includes(k)) {
        const n = indeg.get(t.key)! - 1
        indeg.set(t.key, n)
        if (n === 0) queue.push(t.key)
      }
    }
  }
  if (seen !== tasks.length) {
    const stuck = tasks.filter((t) => indeg.get(t.key)! > 0).map((t) => t.key)
    return { ok: false, errors: [`The dependencies form a cycle involving: ${stuck.join(', ')}.`] }
  }
  return { ok: true, tasks }
}

export interface TeamMember {
  role: string
  roleLabel: string
  name: string
  description: string
}

/** The instruction given to the Project Manager on top of its own system prompt. */
export function plannerInstructions(opts: { projectName: string; projectType: string; goal: string; team: TeamMember[]; existing: string[] }): string {
  const team = opts.team.map((m) => `- role "${m.role}" (${m.roleLabel}, agent "${m.name}"): ${m.description}`).join('\n')
  const existing = opts.existing.length ? `\nTasks that already exist on the board (do not duplicate them; you may depend on none of them, they run too):\n${opts.existing.map((t) => `- ${t}`).join('\n')}\n` : ''
  const imageRule = opts.team.some((m) => m.role === 'image_generator')
    ? '\n- A task for the image_generator role is sent to the image model word for word as its prompt (title, then description) and produces exactly one picture. Write its description as the finished prompt: subject, art style, palette, view, background (say "transparent background" when needed) and size such as 1024x1024. Plan one task per picture; do not put instructions to a person in it.'
    : ''
  return `Plan the work for this project and submit it with the submit_plan tool.

Project: ${opts.projectName} (type: ${opts.projectType})
Goal: ${opts.goal}

Your team (use these exact role keys; each role can only be given work that fits it):
${team}
${existing}
Guidelines:
- Keep the plan as small as the goal allows; every task must be independently verifiable and have acceptance criteria.
- Order the work like a real team: design and architecture first; art/asset work in parallel with implementation when the roles exist; then integration; then a code review task; then a QA/testing task; a final task that summarises the result. Skip stages for which the team has no role.
- Use depends_on so a task starts only when what it needs exists. Tasks without dependencies start immediately and may run in parallel.
- A reviewer or QA task must depend on the implementation it checks. They can send work back for changes, so do not plan separate "fix" tasks.
- Do not assign work to roles that are not in the team list.${imageRule}
Call submit_plan once.`
}

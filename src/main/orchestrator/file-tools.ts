import { CommandRefusedError, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../workspace/commands'
import { MAX_READ_BYTES } from '../workspace/sandbox'
import type { Actor, WorkspaceService } from '../workspace/workspace'
import type { CommandService } from '../workspace/commands'
import type { AgentTool, ToolContext } from './tools'

const READ_OUTPUT_CHARS = 60_000
const DEFAULT_READ_LINES = 400
const MAX_WRITE_CHARS = 400_000
const COMMAND_OUTPUT_CHARS = 20_000

const text = (v: unknown, what: string, max = 1000): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} is required.`)
  if (v.length > max) throw new Error(`${what} is too long.`)
  return v
}

const need = (ctx: ToolContext): { ws: WorkspaceService; actor: Actor } => {
  if (!ctx.workspace) throw new Error('The project workspace is not available.')
  return { ws: ctx.workspace, actor: { agent: ctx.agent, runId: ctx.runId, taskId: ctx.taskId } }
}

const int = (v: unknown, fallback: number, min: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.trunc(v), min), max) : fallback)

const listFiles: AgentTool = {
  def: {
    name: 'list_files',
    description: 'List the files and folders in a project folder. Paths are relative to the project root. Generated folders (node_modules, dist, …) are skipped unless include_ignored is true. With recursive=true, returns up to 300 files below the folder instead.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Folder, relative to the project root. Default: the root.' }, recursive: { type: 'boolean' }, include_ignored: { type: 'boolean' } }
    }
  },
  allowed: (a) => a.permissions.readFiles,
  execute: async (ctx, args) => {
    const { ws, actor } = need(ctx)
    const path = typeof args.path === 'string' ? args.path : ''
    if (args.recursive === true) {
      const { files, truncated } = await ws.agentTree(ctx.projectId, path, actor, 300)
      if (files.length === 0) return '(no files)'
      return files.map((f) => `${f.path}  (${f.size} bytes)`).join('\n') + (truncated ? '\n[list truncated: narrow it with a sub-folder or use search_files / find_context]' : '')
    }
    const r = await ws.agentList(ctx.projectId, path, args.include_ignored === true, actor)
    if (r.entries.length === 0) return '(empty folder)'
    return r.entries.map((e) => (e.type === 'dir' ? `${e.path}/` : `${e.path}  (${e.size} bytes)`)).join('\n') + (r.truncated ? '\n[list truncated]' : '')
  }
}

const readFile: AgentTool = {
  def: {
    name: 'read_file',
    description: `Read a text file of the project. Returns up to ${DEFAULT_READ_LINES} lines starting at start_line (default 1); use start_line/end_line to page through longer files. Credential files such as .env cannot be read.`,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, start_line: { type: 'integer', description: '1-based.' }, end_line: { type: 'integer', description: 'Inclusive.' } },
      required: ['path']
    }
  },
  allowed: (a) => a.permissions.readFiles,
  execute: async (ctx, args) => {
    const { ws, actor } = need(ctx)
    const f = await ws.agentRead(ctx.projectId, text(args.path, 'path', 500), actor, MAX_READ_BYTES)
    const lines = f.content.split('\n')
    const total = f.content === '' ? 0 : lines.length
    const start = int(args.start_line, 1, 1, Math.max(total, 1))
    const end = int(args.end_line, start + DEFAULT_READ_LINES - 1, start, total || 1)
    let body = lines.slice(start - 1, end).join('\n')
    let shownEnd = Math.min(end, total)
    if (body.length > READ_OUTPUT_CHARS) {
      // Cut at a line boundary so the "more" hint points at a whole line.
      const cut = body.lastIndexOf('\n', READ_OUTPUT_CHARS)
      body = body.slice(0, cut > 0 ? cut : READ_OUTPUT_CHARS)
      shownEnd = start + body.split('\n').length - 1
    }
    const more = shownEnd < total ? `\n[more: lines ${shownEnd + 1}-${total} remain; call read_file again with start_line=${shownEnd + 1}]` : ''
    return `[${f.path} · lines ${total === 0 ? '0' : `${start}-${shownEnd}`} of ${total} · ${f.language}]\n${body}${more}`
  }
}

const writeFile: AgentTool = {
  def: {
    name: 'write_file',
    description: 'Create a file or replace its entire content (parent folders are created). To change part of an existing file, prefer edit_file. Taking a file for writing locks it for you until your task ends.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: 'The complete new content of the file.' } }, required: ['path', 'content'] }
  },
  allowed: (a) => a.permissions.writeFiles,
  execute: async (ctx, args) => {
    const { ws, actor } = need(ctx)
    if (typeof args.content !== 'string') throw new Error('content is required (use an empty string for an empty file).')
    if (args.content.length > MAX_WRITE_CHARS) throw new Error(`content is too large for one call (max ${MAX_WRITE_CHARS} characters). Split it into several files.`)
    const r = await ws.agentWrite(ctx.projectId, text(args.path, 'path', 500), args.content, actor)
    return `${r.created ? 'Created' : 'Replaced'} ${r.path} (${r.size} bytes).`
  }
}

const editFile: AgentTool = {
  def: {
    name: 'edit_file',
    description:
      'Change part of an existing file by replacing an exact piece of text. old_text must match the file exactly (including indentation) and must occur once, unless replace_all is true. Read the file first so old_text is accurate.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
      required: ['path', 'old_text', 'new_text']
    }
  },
  allowed: (a) => a.permissions.writeFiles,
  execute: async (ctx, args) => {
    const { ws, actor } = need(ctx)
    const path = text(args.path, 'path', 500)
    const oldText = text(args.old_text, 'old_text', MAX_WRITE_CHARS)
    if (typeof args.new_text !== 'string') throw new Error('new_text is required (use an empty string to delete the old text).')
    if (oldText === args.new_text) throw new Error('old_text and new_text are identical; nothing to change.')
    const f = await ws.agentRead(ctx.projectId, path, actor, MAX_READ_BYTES)
    const crlf = f.content.includes('\r\n')
    const body = crlf ? f.content.replace(/\r\n/g, '\n') : f.content
    const oldN = oldText.replace(/\r\n/g, '\n')
    const newN = args.new_text.replace(/\r\n/g, '\n')
    let count = 0
    for (let i = body.indexOf(oldN); i !== -1; i = body.indexOf(oldN, i + oldN.length)) count++
    if (count === 0) throw new Error(`old_text was not found in ${f.path}. Read the file again and copy the text exactly, including whitespace.`)
    if (count > 1 && args.replace_all !== true) throw new Error(`old_text occurs ${count} times in ${f.path}. Include more surrounding lines to make it unique, or set replace_all to true.`)
    const next = args.replace_all === true ? body.split(oldN).join(newN) : body.replace(oldN, () => newN)
    const out = crlf ? next.replace(/\n/g, '\r\n') : next
    // The hash makes this a compare-and-swap: if the file changed since we read it, the write is refused.
    const r = await ws.agentWrite(ctx.projectId, path, out, actor, f.hash)
    return `Edited ${r.path}: replaced ${args.replace_all === true ? count : 1} occurrence${count === 1 || args.replace_all !== true ? '' : 's'} (${r.size} bytes now).`
  }
}

const deleteFile: AgentTool = {
  def: { name: 'delete_file', description: 'Delete one file (not a folder).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  allowed: (a) => a.permissions.writeFiles,
  execute: async (ctx, args) => {
    const { ws, actor } = need(ctx)
    const p = await ws.agentRemove(ctx.projectId, text(args.path, 'path', 500), actor)
    return `Deleted ${p}.`
  }
}

const searchFiles: AgentTool = {
  def: {
    name: 'search_files',
    description: 'Search the text files of the project for a string (or a regular expression with regex=true). Returns up to 60 matching lines as path:line: text.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, regex: { type: 'boolean' }, path: { type: 'string', description: 'Limit to this folder.' } }, required: ['query'] }
  },
  allowed: (a) => a.permissions.readFiles,
  execute: async (ctx, args) => {
    const { ws, actor } = need(ctx)
    const r = await ws.agentSearch(ctx.projectId, text(args.query, 'query', 300), { regex: args.regex === true, path: typeof args.path === 'string' ? args.path : undefined }, actor)
    if (r.hits.length === 0) return `No matches (searched ${r.scanned} files).`
    return r.hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n') + (r.truncated ? '\n[more matches exist: refine the query]' : '')
  }
}

const findContext: AgentTool = {
  def: {
    name: 'find_context',
    description: 'Ask where something is in the codebase (e.g. "player movement", "login form"). Uses an index of file names, exported symbols and file summaries and returns the most relevant files. It is a quick map, not a guarantee: confirm with read_file.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
  },
  allowed: (a) => a.permissions.readFiles,
  execute: async (ctx, args) => {
    const { ws, actor } = need(ctx)
    const m = await ws.agentFindContext(ctx.projectId, text(args.query, 'query', 300), actor)
    if (m.length === 0) return 'No indexed file matches. Try list_files or search_files.'
    return m.map((x) => `${x.path}${x.summary ? ` — ${x.summary}` : ''}${x.symbols.length ? `\n   symbols: ${x.symbols.join(', ')}` : ''}`).join('\n')
  }
}

const runCommand: AgentTool = {
  def: {
    name: 'run_command',
    description:
      'Run a shell command in the project folder (build, test, lint, git status, …). Common read-only/check commands run immediately; anything else waits for the user to approve it, which can take minutes or be denied (do not retry a denied command: explain instead). Commands cannot read input, run for at most the timeout, and their output is clipped. Dangerous commands are always refused.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Sub-folder of the project to run in. Default: the project root.' },
        timeout_seconds: { type: 'integer', description: `Default ${DEFAULT_TIMEOUT_MS / 1000}, max ${MAX_TIMEOUT_MS / 1000}.` }
      },
      required: ['command']
    }
  },
  allowed: (a) => a.permissions.runCommands !== 'none',
  execute: async (ctx, args) => {
    if (!ctx.workspace || !ctx.commands) throw new Error('Running commands is not available.')
    const command = text(args.command, 'command', 2000)
    const project = ctx.workspace.project(ctx.projectId)
    const task = ctx.db.get<{ title: string }>(`SELECT title FROM tasks WHERE id = ?`, ctx.taskId)
    const timeoutMs = int(args.timeout_seconds, DEFAULT_TIMEOUT_MS / 1000, 1, MAX_TIMEOUT_MS / 1000) * 1000
    try {
      const r = await (ctx.commands as CommandService).run({
        projectId: ctx.projectId,
        projectName: project.name,
        sandbox: ctx.workspace.sandbox(ctx.projectId),
        command,
        cwd: typeof args.cwd === 'string' ? args.cwd : undefined,
        origin: 'agent',
        policy: ctx.agent.permissions.runCommands,
        agent: { id: ctx.agent.id, name: ctx.agent.name },
        runId: ctx.runId,
        taskId: ctx.taskId,
        taskTitle: task?.title ?? null,
        timeoutMs,
        signal: ctx.signal
      })
      const out = r.output.length > COMMAND_OUTPUT_CHARS ? `${r.output.slice(0, COMMAND_OUTPUT_CHARS / 2)}\n[… clipped …]\n${r.output.slice(-COMMAND_OUTPUT_CHARS / 2)}` : r.output
      const head =
        r.outcome === 'exited' ? `Exit code ${r.exitCode} after ${(r.durationMs / 1000).toFixed(1)}s.` : r.outcome === 'timeout' ? `Timed out after ${(timeoutMs / 1000).toFixed(0)}s and was killed.` : `${r.outcome}${r.message ? `: ${r.message}` : ''}`
      return `${head}${r.truncated ? ' (output was clipped)' : ''}\n${out || '(no output)'}`
    } catch (e) {
      if (e instanceof CommandRefusedError) throw new Error(e.message)
      throw e
    }
  }
}

export const WORKSPACE_TOOLS: AgentTool[] = [listFiles, readFile, searchFiles, findContext, writeFile, editFile, deleteFile, runCommand]

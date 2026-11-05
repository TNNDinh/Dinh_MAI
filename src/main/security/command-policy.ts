import type { CommandPolicy } from '../../shared/ipc'

/**
 * Decides what may be run. This is a guard rail, not an OS sandbox: commands that are allowed still run with
 * the user's own permissions, so the list of automatically allowed commands is deliberately short and the
 * default for anything unknown is "ask the user".
 */

export type Classification =
  | { kind: 'blocked'; reason: string }
  | { kind: 'safe'; reason: string }
  | { kind: 'ask'; reason: string }

export type Decision =
  | { action: 'deny'; reason: string }
  | { action: 'blocked'; reason: string }
  | { action: 'auto'; reason: string }
  | { action: 'ask'; reason: string }

interface BlockRule {
  re: RegExp
  reason: string
}

/** Never run, even if the user approves: destructive or privilege-changing, and almost never what an agent should do. */
const BLOCKED: BlockRule[] = [
  { re: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z]*\s+)*(\/|~|\*|\$home|%userprofile%|[a-z]:[\\/]?)(\s|$)/i, reason: 'recursive delete of a root, home or drive' },
  { re: /\b(del|erase)\b[^\n]*\s\/[sq]\b[^\n]*\s(['"]?[a-z]:[\\/]?(windows([\\/][^\s'"]*)?|users)?['"]?|\\|%userprofile%|%systemroot%)(\s|$)/i, reason: 'bulk delete of a drive or system folder' },
  { re: /\b(rd|rmdir)\b[^\n]*\s\/s\b[^\n]*\s(['"]?[a-z]:[\\/]?(windows([\\/][^\s'"]*)?|users|program files[^\s'"]*)?['"]?|\\|%userprofile%|%systemroot%|%programfiles%)(\s|$)/i, reason: 'recursive folder delete of a drive or system folder' },
  { re: /remove-item\b[^\n]*-recurse[^\n]*\s(['"]?[a-z]:[\\/]?['"]?|~|\$home|\$env:userprofile)(\s|$)/i, reason: 'recursive delete of a drive or home folder' },
  { re: /\b(format|diskpart|mkfs(\.\w+)?|fdisk|bcdedit|cipher\s+\/w|vssadmin|wbadmin)\b/i, reason: 'disk or boot configuration tool' },
  { re: /\bdd\s+if=/i, reason: 'raw disk copy' },
  { re: /\b(shutdown|restart-computer|stop-computer|logoff)\b/i, reason: 'shuts down or restarts the computer' },
  { re: /\breg(\.exe)?\s+(add|delete|import)\b/i, reason: 'edits the Windows registry' },
  { re: /\b(set-itemproperty|new-itemproperty|remove-itemproperty)\b[^\n]*\bhk(lm|cu|cr)/i, reason: 'edits the Windows registry' },
  { re: /\b(net\s+user|net\s+localgroup|takeown|runas|sudo|su\s+-|schtasks\s+\/create|sc(\.exe)?\s+(create|delete|config)|wmic\b[^\n]*\b(delete|call))\b/i, reason: 'changes accounts, services, scheduled tasks or privileges' },
  { re: /\b(powershell|pwsh)(\.exe)?\b[^\n]*\s-(e|enc|encodedcommand)\b/i, reason: 'encoded PowerShell commands hide what they do' },
  { re: /\b(iex|invoke-expression)\b/i, reason: 'runs text as code' },
  { re: /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod|irm)\b[^\n]*\|\s*(sh|bash|zsh|iex|invoke-expression|powershell|pwsh|cmd)\b/i, reason: 'downloads and runs code in one step' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:/, reason: 'fork bomb' },
  { re: /\bgit\s+(push\b[^\n]*(--force|-f\b|--delete)|clean\s+-[a-z]*f[a-z]*d|reset\s+--hard\s+origin)/i, reason: 'rewrites or discards history in a way that cannot be undone' },
  { re: /\b(chmod|chown|icacls)\b[^\n]*\s(-r|\/t|\/grant|\/reset)\b/i, reason: 'recursive permission change' }
]

/** Characters that let one command start another, redirect output or expand variables. */
const SHELL_OPERATORS = /[&|;<>`\r\n]|\$\(|\$\{|%[a-z_][a-z0-9_]*%|\^/i

function tokenize(command: string): string[] | null {
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let any = false
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      any = true
    } else if (/\s/.test(ch)) {
      if (cur || any) tokens.push(cur)
      cur = ''
      any = false
    } else cur += ch
  }
  if (quote) return null // unbalanced quote
  if (cur || any) tokens.push(cur)
  return tokens
}

/** Tokens that point at an absolute location or climb out of the project. */
function escapesProject(tokens: string[]): boolean {
  return tokens.slice(1).some((t) => {
    const v = t.replace(/^--?[\w-]+=/, '')
    return /^[a-z]:/i.test(v) || /^[\\/]/.test(v) || /(^|[\\/])\.\.([\\/]|$)/.test(v) || v.startsWith('~')
  })
}

const BUILD_SCRIPTS = new Set(['build', 'test', 'lint', 'typecheck', 'check', 'format', 'compile', 'tsc', 'test:unit', 'test:e2e'])

/** Each rule returns a reason when the token list is a known-safe command. */
type SafeRule = (t: string[]) => string | null

const exe = (t: string[]): string => t[0].toLowerCase().replace(/\.(cmd|exe|bat)$/, '')
const isVersion = (t: string[]): boolean => t.length === 2 && ['--version', '-v', '-version', 'version'].includes(t[1].toLowerCase())

const SAFE_RULES: SafeRule[] = [
  (t) => (isVersion(t) && ['node', 'npm', 'npx', 'pnpm', 'yarn', 'git', 'python', 'python3', 'py', 'dotnet', 'cargo', 'go', 'tsc', 'java'].includes(exe(t)) ? 'prints a version' : null),
  (t) => (['npm', 'pnpm', 'yarn'].includes(exe(t)) && t[1] === 'test' && t.length <= 4 ? 'runs the project’s tests' : null),
  (t) => (['npm', 'pnpm', 'yarn'].includes(exe(t)) && t[1] === 'run' && BUILD_SCRIPTS.has(t[2] ?? '') && t.length <= 5 ? `runs the “${t[2]}” script` : null),
  (t) => (['pnpm', 'yarn'].includes(exe(t)) && BUILD_SCRIPTS.has(t[1] ?? '') && t.length <= 3 ? `runs the “${t[1]}” script` : null),
  (t) => (exe(t) === 'npm' && ['ls', 'outdated', 'audit'].includes(t[1]) && !t.includes('fix') ? 'reads package information' : null),
  (t) => (['tsc', 'eslint', 'prettier', 'vitest', 'jest'].includes(exe(t)) && !t.some((x) => /^--(fix|write)$/.test(x) || x === '-w') ? 'runs a checker' : null),
  (t) => (exe(t) === 'npx' && ['tsc', 'eslint', 'vitest', 'jest'].includes(t[1] === '--no-install' ? (t[2] ?? '') : (t[1] ?? '')) && !t.some((x) => /^--(fix|write)$/.test(x)) ? 'runs a checker' : null),
  (t) => (exe(t) === 'git' && ['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame'].includes(t[1]) && !t.some((x) => /^--(output|exec)/.test(x)) && !(t[1] === 'branch' && t.some((x) => /^-[dDmMcC]/.test(x) || x === '--delete')) ? 'reads git state' : null),
  (t) => (exe(t) === 'dotnet' && ['build', 'test', 'restore', 'format'].includes(t[1]) ? `runs dotnet ${t[1]}` : null),
  (t) => (exe(t) === 'cargo' && ['build', 'test', 'check', 'clippy', 'fmt'].includes(t[1]) ? `runs cargo ${t[1]}` : null),
  (t) => (exe(t) === 'go' && ['build', 'test', 'vet', 'fmt'].includes(t[1]) ? `runs go ${t[1]}` : null),
  (t) => (['python', 'python3', 'py'].includes(exe(t)) && t[1] === '-m' && ['pytest', 'unittest', 'compileall', 'mypy'].includes(t[2]) ? `runs python -m ${t[2]}` : null),
  (t) => (exe(t) === 'pytest' ? 'runs the tests' : null),
  (t) => (exe(t) === 'node' && t.length >= 2 && !t[1].startsWith('-') && /\.(c|m)?js$/i.test(t[1]) ? 'runs a script of the project' : null)
]

/** Looks at the command text only; the caller decides what to do with the answer. */
export function classifyCommand(command: unknown): Classification {
  if (typeof command !== 'string' || !command.trim()) return { kind: 'blocked', reason: 'the command is empty' }
  if (command.length > 2000) return { kind: 'blocked', reason: 'the command is longer than 2000 characters' }
  for (const rule of BLOCKED) {
    if (rule.re.test(command)) return { kind: 'blocked', reason: rule.reason }
  }
  if (SHELL_OPERATORS.test(command)) return { kind: 'ask', reason: 'it chains commands, redirects output or uses variables, so it cannot be checked automatically' }
  const tokens = tokenize(command)
  if (!tokens || tokens.length === 0) return { kind: 'ask', reason: 'it could not be parsed' }
  if (escapesProject(tokens)) return { kind: 'ask', reason: 'it refers to a location outside the project folder' }
  for (const rule of SAFE_RULES) {
    const reason = rule(tokens)
    if (reason) return { kind: 'safe', reason }
  }
  return { kind: 'ask', reason: 'it is not on the list of commands that run automatically' }
}

/** Combines the command's classification with the agent's policy. */
export function decideCommand(policy: CommandPolicy, command: unknown): Decision {
  const c = classifyCommand(command)
  if (c.kind === 'blocked') return { action: 'blocked', reason: `Blocked: ${c.reason}.` }
  if (policy === 'none') return { action: 'deny', reason: 'This agent is not allowed to run commands.' }
  if (policy === 'allowlist' && c.kind === 'safe') return { action: 'auto', reason: `Allowed automatically: ${c.reason}.` }
  return { action: 'ask', reason: policy === 'ask' ? 'This agent must ask before every command.' : `Needs approval: ${c.reason}.` }
}

/** For the Settings page: what the rules are, in words. */
export function describePolicy(): { safe: string[]; blocked: string[] } {
  return {
    safe: [
      'npm / pnpm / yarn: test, and run build · test · lint · typecheck · check · format · compile',
      'tsc, eslint, prettier, vitest, jest (without --fix / --write)',
      'git: status, diff, log, show, branch (listing only), rev-parse, ls-files, blame',
      'dotnet build · test · restore · format; cargo build · test · check · clippy · fmt; go build · test · vet · fmt',
      'python -m pytest · unittest · compileall · mypy; pytest; node <script>.js',
      '<tool> --version for the tools above'
    ],
    blocked: [...new Set(BLOCKED.map((b) => b.reason))]
  }
}

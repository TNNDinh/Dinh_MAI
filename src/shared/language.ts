/** File extension -> Monaco language id. Shared so the index, the tools and the editor agree. */
const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  py: 'python', cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', h: 'cpp', hpp: 'cpp',
  java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift',
  lua: 'lua', sh: 'shell', bash: 'shell', ps1: 'powershell', bat: 'bat', cmd: 'bat',
  yml: 'yaml', yaml: 'yaml', xml: 'xml', csproj: 'xml', sln: 'plaintext', toml: 'ini', ini: 'ini',
  sql: 'sql', gd: 'gdscript', shader: 'hlsl', hlsl: 'hlsl', glsl: 'plaintext', txt: 'plaintext',
  vue: 'html', svelte: 'html', svg: 'xml', dockerfile: 'dockerfile'
}

export function languageFor(path: string): string {
  const name = path.split('/').pop() ?? path
  const lower = name.toLowerCase()
  if (lower === 'dockerfile') return 'dockerfile'
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return BY_EXT[lower.slice(dot + 1)] ?? 'plaintext'
}

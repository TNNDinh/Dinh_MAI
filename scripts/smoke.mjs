// Runs the built app in smoke-test mode with an isolated data dir and prints the report.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const electron = createRequire(import.meta.url)('electron')
const out = process.env.SMOKE_OUT ?? mkdtempSync(join(tmpdir(), 'mads-smoke-'))
const userData = mkdtempSync(join(tmpdir(), 'mads-userdata-'))
if (existsSync(join(out, 'smoke.json'))) rmSync(join(out, 'smoke.json'))

// VS Code's terminal (and some CI shells) export ELECTRON_RUN_AS_NODE=1, which makes the
// Electron binary behave as plain Node: `require('electron')` then has no `app`.
const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env
const r = spawnSync(electron, [resolve('.')], {
  env: { ...cleanEnv, MADS_SMOKE: out, MADS_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  stdio: 'inherit',
  timeout: 240_000
})
const report = join(out, 'smoke.json')
console.log(existsSync(report) ? readFileSync(report, 'utf8') : 'NO REPORT WRITTEN')
console.log(`\nexit=${r.status} screenshots=${out}`)
process.exit(r.status ?? 1)

// `npm run dev` wrapper. VS Code's integrated terminal exports ELECTRON_RUN_AS_NODE=1, which
// makes Electron start as plain Node (and crash on `app` being undefined), so remove it first.
import { spawn } from 'node:child_process'

const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env
const child = spawn('npx', ['electron-vite', 'dev', ...process.argv.slice(2)], { env, stdio: 'inherit', shell: true })
child.on('exit', (code) => process.exit(code ?? 0))

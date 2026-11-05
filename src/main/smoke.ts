import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { app, nativeImage, type BrowserWindow } from 'electron'
import { newNode, type WorkflowGraph } from '../shared/workflow'
import { encodePng, newRaster } from './assets/pixels'
import type { SecretStore } from './secrets/secret-store'

/**
 * A 96x96 picture made by our own PNG encoder: a flat light background with a red square in the middle.
 * The mock below serves it for image requests (as a JPEG when asked), so the pixel pipeline processes real image bytes.
 */
function smokePicture(asJpeg: boolean): Buffer {
  const img = newRaster(96, 96)
  for (let y = 0; y < 96; y++) {
    for (let x = 0; x < 96; x++) {
      const i = (y * 96 + x) * 4
      const inside = x >= 28 && x < 68 && y >= 28 && y < 68
      img.data.set(inside ? [200, 40, 40, 255] : [240, 240, 240, 255], i)
    }
  }
  const png = encodePng(img)
  return asJpeg ? nativeImage.createFromBuffer(png).toJPEG(92) : png
}

/**
 * Minimal OpenAI-wire-compatible server on loopback: /models, streamed /chat/completions and /images/*.
 * It is a protocol stand-in for a provider, used only by this self test; the app itself never fabricates responses.
 */
async function startMockOpenAI(expectedKey: string) {
  const authSeen: string[] = []
  const imageRequests: Array<{ path: string; model: string; prompt: string; n: number; size: string }> = []
  let workflowReviews = 0
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const auth = String(req.headers.authorization ?? '')
      authSeen.push(auth)
      if (auth !== `Bearer ${expectedKey}`) {
        // Real providers often echo the offending key back; the app must not pass that on.
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${auth.replace('Bearer ', '')}` } }))
        return
      }
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'smoke-chat' }, { id: 'smoke-chat-mini' }, { id: 'text-embedding-smoke' }] }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages: Array<{ role: string; content: string | null }>
          tools?: Array<{ function: { name: string } }>
        }
        const lastMsg = body.messages[body.messages.length - 1]
        const last = typeof lastMsg.content === 'string' ? lastMsg.content : ''
        const firstUser = body.messages.find((m) => m.role === 'user')
        const first = typeof firstUser?.content === 'string' ? firstUser.content : ''
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const frame = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`)
        const toolCall = (name: string, args: unknown) => {
          const json = JSON.stringify(args)
          const half = Math.floor(json.length / 2)
          frame({ model: 'smoke-chat', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: json.slice(0, half) } }] } }] })
          frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(half) } }] } }] })
          frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
          frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 } })
          res.write('data: [DONE]\n\n')
          res.end()
        }
        const say = (text: string) => {
          frame({ model: 'smoke-chat', choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })
          frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 } })
          res.write('data: [DONE]\n\n')
          res.end()
        }
        if (last.includes('slow')) {
          let i = 0
          const timer = setInterval(() => {
            frame({ choices: [{ index: 0, delta: { content: `tok${i++} ` } }] })
            if (i >= 40) {
              clearInterval(timer)
              res.end()
            }
          }, 120)
          res.on('close', () => clearInterval(timer))
          return
        }
        // Phase 6: an agent that works on project files and runs a command that needs the user's approval.
        if (first.includes('workspace tools smoke')) {
          if (lastMsg.role !== 'tool' && body.tools?.some((t) => t.function.name === 'submit_plan')) {
            return toolCall('submit_plan', {
              tasks: [
                { key: 'hello', title: 'Create hello module', description: 'Write src/hello.js.', role: 'lead_developer' },
                { key: 'check', title: 'Run custom check', description: 'Run a one-off command.', role: 'lead_developer', depends_on: ['hello'] }
              ]
            })
          }
          if (lastMsg.role === 'tool') return say('Done.')
          if (first.includes('Your task: Create hello module')) return toolCall('write_file', { path: 'src/hello.js', content: "console.log('hello from an agent')\n" })
          if (first.includes('Your task: Run custom check')) return toolCall('run_command', { command: 'node -e "console.log(41+1)"' })
        }
        // Phase 8: workflow steps. The reviewer sends the work back once and approves the second round.
        if (first.includes('workflow smoke') && first.includes('Your task: Review') && lastMsg.role !== 'tool' && body.tools?.some((t) => t.function.name === 'submit_verdict')) {
          workflowReviews++
          return toolCall('submit_verdict', workflowReviews === 1 ? { verdict: 'changes', feedback: 'Add a comment header.' } : { verdict: 'approved', feedback: 'Looks good now.' })
        }
        // Phase 7: a plan with a picture task for the Image Generator and a chat agent that asks for a picture through a tool.
        if (first.includes('image pipeline smoke') && lastMsg.role !== 'tool' && body.tools?.some((t) => t.function.name === 'submit_plan')) {
          return toolCall('submit_plan', {
            tasks: [
              { key: 'art', title: 'Red square sprite', description: 'A red square sprite, transparent background, 64x64', role: 'image_generator' },
              { key: 'coin', title: 'Draw a coin icon', description: 'Ask for a coin icon.', role: 'concept_artist', depends_on: ['art'] }
            ]
          })
        }
        if (first.includes('Your task: Draw a coin icon') && lastMsg.role !== 'tool') return toolCall('generate_image', { prompt: 'a tiny jpeg coin icon', kind: 'icon', name: 'coin' })
        if (first.includes('Your task: Draw a coin icon') && lastMsg.role === 'tool') return say('The coin icon is saved in the asset library.')
        // Orchestrator traffic (Phase 5): the project manager asked to plan, then agents working on tasks.
        const slow = last.includes('slow') || first.includes('slow')
        if (!slow && lastMsg.role !== 'tool' && body.tools?.some((t) => t.function.name === 'submit_plan')) {
          return toolCall('submit_plan', {
            tasks: [
              { key: 'arch', title: 'Write architecture notes', description: 'Document the module layout in the shared memory.', role: 'technical_architect', priority: 1 },
              { key: 'impl', title: 'Implement feature', description: 'Implement the core feature.', role: 'lead_developer', depends_on: ['arch'] },
              { key: 'review', title: 'Review feature', description: 'Review the implementation.', role: 'code_reviewer', depends_on: ['impl'] }
            ]
          })
        }
        if (!slow && body.tools?.length && first.includes('Your task: Write architecture notes') && lastMsg.role !== 'tool') {
          return toolCall('write_memory', { kind: 'design_doc', title: 'Architecture', content: 'Modules: core, ui, data.' })
        }
        if (!slow && lastMsg.role === 'tool') return say('Finished. The architecture notes are in shared memory.')
        if (!slow && first.includes('Your task: ')) return say(`Completed “${/Your task: (.*)/.exec(first)?.[1] ?? 'task'}”.`)
        frame({ model: 'smoke-chat', choices: [{ index: 0, delta: { content: 'Hello from ' } }] })
        frame({ choices: [{ index: 0, delta: { content: 'the smoke ' } }] })
        frame({ choices: [{ index: 0, delta: { content: 'server.' }, finish_reason: 'stop' }] })
        frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 6 } })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      if (req.url === '/v1/images/generations' || req.url === '/v1/images/edits') {
        const isJson = String(req.headers['content-type'] ?? '').includes('json')
        const body = isJson ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model?: string; prompt?: string; n?: number; size?: string }) : {}
        const prompt = body.prompt ?? ''
        const n = body.n ?? 1
        imageRequests.push({ path: req.url, model: body.model ?? '', prompt, n, size: body.size ?? '' })
        if (prompt.includes('refuse')) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Your request was rejected by the safety system.' } }))
          return
        }
        const png = smokePicture(prompt.includes('jpeg')).toString('base64')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ created: 1, data: Array.from({ length: n }, () => ({ b64_json: png })) }))
        return
      }
      res.writeHead(404).end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    authSeen,
    imageRequests,
    reviewCalls: () => workflowReviews,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      })
  }
}

/**
 * End-to-end self test, enabled only by the MADS_SMOKE=<output dir> environment variable.
 * It drives the real app (real IPC, real DB, real DPAPI) and saves screenshots so the
 * UI can be inspected without manual clicking. Never runs in normal use.
 */
export async function runSmokeTest(opts: {
  win: BrowserWindow
  outDir: string
  secretStoreFactory: (file: string) => SecretStore
}): Promise<void> {
  const { win, outDir } = opts
  mkdirSync(outDir, { recursive: true })
  const results: Record<string, unknown> = {}
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const js = <T>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>
  const shot = async (name: string) => {
    await wait(700)
    writeFileSync(join(outDir, name), (await win.webContents.capturePage()).toPNG())
  }
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      results[name] = (await fn()) ?? 'ok'
    } catch (e) {
      results[name] = `FAILED: ${e instanceof Error ? e.message : String(e)}`
    }
    // Progress file: if the run is cut off (a hang, the runner's time limit), this shows how far it got.
    writeFileSync(join(outDir, 'smoke.partial.json'), JSON.stringify(results, null, 2))
  }

  try {
    await new Promise<void>((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', () => r()) : r()))
    win.setSize(1480, 920)
    await wait(1200)

    await step('dpapi_roundtrip', async () => {
      const file = join(outDir, 'secrets-smoke.json')
      const store = opts.secretStoreFactory(file)
      const secret = 'sk-smoke-test-0123456789'
      await store.set('smoke', secret)
      if (readFileSync(file, 'utf8').includes(secret)) throw new Error('plaintext found on disk')
      if ((await store.get('smoke')) !== secret) throw new Error('decrypt mismatch')
      store.delete('smoke')
      return 'encrypted on disk, decrypted correctly'
    })
    await step('renderer_api_present', () => js<boolean>(`typeof window.api?.invoke === 'function' && typeof window.require === 'undefined'`))
    await step('app_info', () => js(`window.api.invoke('app:info').then(i => ({ electron: i.electron, node: i.node, enc: i.encryptionAvailable, db: i.dbVersion }))`))
    await step('unknown_channel_rejected', () =>
      js<string>(`window.api.invoke('fs:readAnything').then(() => 'NOT REJECTED', e => 'rejected: ' + e.message)`)
    )
    await shot('01-dashboard-empty.png')

    await step('create_project', () =>
      js(`window.api.invoke('projects:create', { name: 'Smoke Survival Game', type: 'godot', goal: 'Create a 2D survival game with pixel art, crafting, monsters and a day/night cycle.', rootPath: ${JSON.stringify(join(outDir, 'smoke-project'))}, budgetUsd: 5, maxIterations: 4 }).then(p => ({ id: p.id, type: p.type }))`)
    )
    await step('reject_unsafe_root', () =>
      js<string>(`window.api.invoke('projects:create', { name: 'Bad', rootPath: 'C:\\\\' }).then(() => 'NOT REJECTED', e => 'rejected: ' + e.message)`)
    )
    await wait(500)
    await js(`document.querySelector('[data-nav="projects"]')?.click()`)
    await shot('02-projects.png')

    // Drive the New Project modal through the real UI (React-controlled inputs need the native setter + an input event).
    const setInput = (sel: string, value: string) =>
      js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('missing ${sel}');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    const pathSel = 'input[placeholder="Existing folder or a new path"]'
    await step('ui_modal_opens', async () => {
      await js(`document.querySelector('[data-testid="new-project"]').click()`)
      await wait(300)
      return js<boolean>(`!!document.querySelector('[role="dialog"]')`)
    })
    await step('ui_modal_rejects_unsafe_root', async () => {
      await setInput('[data-testid="project-name"]', 'UI Created Game')
      await setInput(pathSel, 'C:\\')
      await wait(500)
      await js(`document.querySelector('[data-testid="create-project-submit"]').click()`)
      await wait(600)
      const msg = await js<string | null>(`document.querySelector('[data-testid="create-project-error"]')?.textContent ?? null`)
      if (!msg || !/drive root/.test(msg)) throw new Error(`expected inline error, got ${msg}`)
      return `inline error shown: ${msg}`
    })
    await shot('05-new-project-error.png')
    const uiRoot = join(outDir, 'ui-project')
    mkdirSync(uiRoot, { recursive: true })
    writeFileSync(join(uiRoot, 'package.json'), JSON.stringify({ dependencies: { react: '19.0.0' } }))
    await step('ui_modal_autodetects_and_creates', async () => {
      await setInput(pathSel, uiRoot)
      await wait(700) // debounce + inspect round trip
      if (await js<boolean>(`!!document.querySelector('[data-testid="create-project-error"]')`)) throw new Error('stale error still visible after editing the form')
      const type = await js<string>(`document.querySelector('[role="dialog"] select').value`)
      if (type !== 'react') throw new Error(`expected auto-detected react, got ${type}`)
      await shot('06-new-project-detected.png')
      await js(`document.querySelector('[data-testid="create-project-submit"]').click()`)
      await wait(900)
      const onDetail = await js<boolean>(`document.body.innerText.includes('UI Created Game') && !document.querySelector('[role="dialog"]')`)
      if (!onDetail) throw new Error('project detail did not open after create')
      return 'created via UI, type auto-detected as react'
    })
    await js(`document.querySelector('[data-nav="projects"]')?.click()`)
    await wait(300)
    await js(`document.querySelector('[data-project-card]')?.click()`)
    await shot('03-project-detail.png')
    await js(`document.querySelector('[data-nav="dashboard"]')?.click()`)
    await shot('04-dashboard.png')
    await step('dom_after_navigation', () => js(`document.body.innerText.includes('Smoke Survival Game')`))

    // ------------------------------------------------------------------ Phase 3: connections
    // A real HTTP server speaking the OpenAI wire format, so the UI -> IPC -> main -> fetch -> SSE -> UI path is genuine.
    // (It is a protocol stand-in for a provider; no real provider is contacted and no key leaves this machine.)
    const SMOKE_KEY = 'sk-smoke-connection-key-9876543210'
    const mock = await startMockOpenAI(SMOKE_KEY)
    const setNative = (sel: string, value: string) =>
      js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('missing ' + ${JSON.stringify(sel)});
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })); })()`)
    const clickText = (text: string) =>
      js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)}) && !b.disabled);
        if (!b) throw new Error('no enabled button containing: ' + ${JSON.stringify(text)}); b.click(); })()`)
    const waitFor = async (what: string, code: string, timeoutMs = 8000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeoutMs) {
        if (await js<boolean>(code)) return
        await wait(100)
      }
      throw new Error(`timed out waiting for ${what}`)
    }

    await js(`document.querySelector('[data-nav="connections"]')?.click()`)
    await shot('07-connections-empty.png')

    await step('ui_add_connection_tests_it', async () => {
      await clickText('Add connection')
      await wait(400)
      await setNative('input[aria-label="Connection name"]', 'Smoke OpenAI')
      await setNative('input[aria-label="Base URL"]', `${mock.url}/v1`)
      await setNative('input[aria-label="API key"]', SMOKE_KEY)
      await shot('08-add-connection.png')
      await clickText('Add & test')
      await waitFor('modal to close', `!document.querySelector('[role="dialog"]')`)
      await waitFor('connected badge', `document.body.innerText.includes('Connected')`)
      const list = await js<Array<Record<string, unknown>>>(`window.api.invoke('connections:list')`)
      const c = list[0]
      if (list.length !== 1 || c.status !== 'ok' || c.hasKey !== true) throw new Error(`unexpected connection state ${JSON.stringify(c)}`)
      if (JSON.stringify(list).includes(SMOKE_KEY)) throw new Error('API key leaked to the renderer')
      if (mock.authSeen[0] !== `Bearer ${SMOKE_KEY}`) throw new Error('provider did not receive the stored key')
      return 'connection saved, key stored, test succeeded'
    })
    await step('key_not_plaintext_on_disk', async () => {
      const dir = app.getPath('userData')
      const secretsFile = readFileSync(join(dir, 'secrets.json'), 'utf8')
      if (secretsFile.includes(SMOKE_KEY)) throw new Error('plaintext key in secrets.json')
      return `secrets.json holds ${Object.keys(JSON.parse(secretsFile)).length} encrypted entr(y/ies)`
    })

    await step('ui_discover_models', async () => {
      await clickText('Discover models')
      await waitFor('model rows', `document.querySelectorAll('tr[data-model]').length === 3`)
      return js(`[...document.querySelectorAll('tr[data-model]')].map(r => r.dataset.model)`)
    })
    await step('ui_set_price', async () => {
      await js(`document.querySelector('tr[data-model="smoke-chat"] button[title="Edit price"]').click()`)
      await wait(200)
      await setNative('input[aria-label="Input price for smoke-chat"]', '2.5')
      await setNative('input[aria-label="Output price for smoke-chat"]', '10')
      await clickText('Save')
      await waitFor('price shown', `document.querySelector('tr[data-model="smoke-chat"]')?.innerText.includes('$2.50')`)
      return 'price saved via UI'
    })
    await shot('09-models.png')

    await step('ui_playground_streams_with_cost', async () => {
      await js(`document.querySelector('[data-tab="playground"]').click()`)
      await wait(400)
      await setNative('select[aria-label="Model"]', 'smoke-chat')
      await setNative('textarea[aria-label="Message"]', 'Say hello')
      await clickText('Send')
      await waitFor('stats badges', `!!document.querySelector('[data-stats]')`)
      const reply = await js<string>(`document.querySelector('[data-role="assistant"]').innerText`)
      const stats = await js<string>(`document.querySelector('[data-stats]').innerText`)
      if (!reply.includes('Hello from the smoke server')) throw new Error(`unexpected reply: ${reply}`)
      if (!/12\s*in/.test(stats) || !/6\s*out/.test(stats)) throw new Error(`token stats missing: ${stats}`)
      // 12 * 2.5/1M + 6 * 10/1M = 0.00009
      if (!/\$0\.0001|<\$0\.0001|0\.00009/.test(stats)) throw new Error(`cost missing/wrong: ${stats}`)
      return { reply, stats }
    })
    await shot('10-playground.png')

    await step('ui_playground_stop_cancels', async () => {
      await setNative('textarea[aria-label="Message"]', 'slow please')
      await clickText('Send')
      await waitFor('first streamed token', `(document.querySelectorAll('[data-role="assistant"]')[1]?.innerText ?? '').includes('tok0')`)
      await clickText('Stop')
      await waitFor('cancelled turn', `document.querySelectorAll('[data-turn-status="cancelled"]').length === 1`)
      return 'stream stopped from the UI'
    })

    await step('usage_recorded_per_model', async () => {
      const rows = await js<Array<Record<string, any>>>(`window.api.invoke('usage:byModel')`)
      const r = rows.find((x) => x.model === 'smoke-chat')
      if (!r) throw new Error(`no usage row: ${JSON.stringify(rows)}`)
      if (r.calls !== 2 || r.failedCalls !== 1 || r.inputTokens !== 12 || r.outputTokens !== 6) throw new Error(`unexpected usage ${JSON.stringify(r)}`)
      if (Math.abs(r.costUsd - 0.00009) > 1e-9) throw new Error(`unexpected cost ${r.costUsd}`)
      return r
    })
    await step('ui_usage_tab_lists_model', async () => {
      await js(`document.querySelector('[data-testid="right-tab-usage"]').click()`)
      await waitFor('by-model usage list', `(document.querySelector('[data-usage-by-model]')?.innerText ?? '').includes('smoke-chat')`)
      return await js<string>(`document.querySelector('[data-usage-by-model]').innerText`)
    })
    await shot('11-usage.png')

    // ------------------------------------------------------------------ Phase 4: agents (driven through the real UI)
    const connId = (await js<Array<{ id: string }>>(`window.api.invoke('connections:list')`))[0].id
    const agentList = () => js<Array<Record<string, any>>>(`window.api.invoke('agents:list')`)
    await js(`document.querySelector('[data-nav="agents"]').click()`)
    await step('ui_agents_empty_state', async () => {
      await waitFor('empty state', `document.body.innerText.includes('No agents yet')`)
      return 'empty state shown'
    })
    await shot('14-agents-empty.png')

    await step('ui_create_agent_from_template', async () => {
      await js(`document.querySelector('[data-action="new-agent"]').click()`)
      await waitFor('modal', `!!document.querySelector('[role="dialog"]')`)
      await js(`document.querySelector('[data-template="game_designer"]').click()`)
      await wait(200)
      await shot('15-new-agent.png')
      await js(`document.querySelector('[data-action="create-agent"]').click()`)
      await waitFor('modal to close', `!document.querySelector('[role="dialog"]')`)
      await waitFor('agent in list', `!!document.querySelector('[data-agent="Game Designer"]')`)
      const issues = await js<string>(`document.querySelector('[data-agent-issues]')?.innerText ?? ''`)
      if (!/No model connection selected/.test(issues)) throw new Error(`expected a readiness warning, got: ${issues}`)
      const [a] = await agentList()
      if (a.name !== 'Game Designer' || a.systemPrompt.length < 50 || a.permissions.runCommands !== 'none' || a.permissions.internet !== false || a.permissions.gitCommit !== false) throw new Error(`template not applied: ${JSON.stringify(a)}`)
      return `created from template; readiness warning: ${issues}`
    })
    await shot('16-agent-needs-setup.png')

    await step('ui_assign_connection_and_model_saves', async () => {
      await setNative('select[aria-label="Connection"]', connId)
      await waitFor('model options', `[...document.querySelectorAll('select[aria-label="Model"] option')].some(o => o.value === 'smoke-chat')`)
      await setNative('select[aria-label="Model"]', 'smoke-chat')
      await setNative('input[aria-label="Temperature"]', '0.4')
      await setNative('input[aria-label="Max output tokens"]', '256')
      await setNative('input[aria-label="Cost limit"]', '0.5')
      await js(`document.querySelector('[data-action="save-agent"]').click()`)
      await waitFor('saved', `document.body.innerText.includes('Saved.') || !document.querySelector('[data-agent-issues]')`)
      await waitFor('warning cleared', `!document.querySelector('[data-agent-issues]')`)
      const [a] = await agentList()
      if (a.connectionId !== connId || a.model !== 'smoke-chat' || a.temperature !== 0.4 || a.maxTokens !== 256 || a.maxCostUsd !== 0.5 || a.issues.length) {
        throw new Error(`unexpected saved agent ${JSON.stringify(a)}`)
      }
      return 'saved; readiness warning cleared'
    })
    await shot('17-agent-configured.png')

    await step('ui_agent_test_streams_and_is_attributed', async () => {
      const [a] = await agentList()
      await js(`document.querySelector('[data-tab="test"]').click()`)
      await waitFor('agent config line', `!!document.querySelector('[data-agent-config]')`)
      await setNative('textarea[aria-label="Message"]', 'Say hello')
      await clickText('Send')
      await waitFor('stats badges', `!!document.querySelector('[data-stats]')`)
      const reply = await js<string>(`document.querySelector('[data-role="assistant"]').innerText`)
      if (!reply.includes('Hello from the smoke server')) throw new Error(`unexpected reply: ${reply}`)
      const ev = await js<Array<{ type: string; agentId: string | null; message: string }>>(`window.api.invoke('events:recent', { limit: 20 })`)
      const call = ev.find((e) => e.type === 'llm.call' && e.agentId === a.id)
      if (!call) throw new Error('the agent call was not attributed to the agent')
      const rows = await js<Array<Record<string, any>>>(`window.api.invoke('usage:byModel')`)
      const r = rows.find((x) => x.model === 'smoke-chat')
      if (!r || r.calls !== 3) throw new Error(`expected 3 calls on smoke-chat, got ${JSON.stringify(r)}`)
      return call.message
    })
    await shot('18-agent-test.png')

    await step('ui_duplicate_agent', async () => {
      await js(`document.querySelector('[data-action="duplicate-agent"]').click()`)
      await waitFor('copy in list', `!!document.querySelector('[data-agent="Game Designer (copy)"]')`)
      const list = await agentList()
      const copy = list.find((x) => x.name === 'Game Designer (copy)')
      if (!copy || copy.model !== 'smoke-chat' || list.length !== 2) throw new Error(`bad duplicate ${JSON.stringify(list.map((x) => x.name))}`)
      return 'duplicated with the same model and settings'
    })

    await step('ui_disable_agent_blocks_chat', async () => {
      await js(`document.querySelector('[data-action="toggle-agent"]').click()`)
      await waitFor('disabled badge', `document.body.innerText.includes('Disabled')`)
      const copy = (await agentList()).find((x) => x.name === 'Game Designer (copy)')
      if (!copy || copy.enabled !== false) throw new Error('agent not disabled')
      const msg = await js<string>(
        `window.api.invoke('chat:start', { connectionId: ${JSON.stringify(connId)}, model: 'smoke-chat', messages: [{ role: 'user', content: 'hi' }], agentId: ${JSON.stringify(copy.id)} }).then(() => 'NOT REJECTED', e => e.message)`
      )
      if (!/disabled/i.test(msg)) throw new Error(`disabled agent was not refused: ${msg}`)
      return `refused: ${msg}`
    })

    await step('ui_delete_agent_keeps_usage', async () => {
      await clickText('Delete agent')
      await clickText('Yes, delete')
      await waitFor('copy gone', `!document.querySelector('[data-agent="Game Designer (copy)"]')`)
      const list = await agentList()
      if (list.length !== 1 || list[0].name !== 'Game Designer') throw new Error(`wrong agents left: ${JSON.stringify(list.map((x) => x.name))}`)
      return 'deleted the copy; original untouched'
    })

    await step('ui_add_full_team_to_project', async () => {
      const projects = await js<Array<{ id: string; name: string }>>(`window.api.invoke('projects:list')`)
      const p = projects.find((x) => x.name === 'Smoke Survival Game')
      if (!p) throw new Error('smoke project missing')
      await setNative('select[aria-label="Show agents from"]', p.id)
      await clickText('Add the full team')
      await waitFor('12 project agents', `document.querySelectorAll('[data-agent]').length === 12`, 10000)
      const list = await agentList()
      if (list.filter((x) => x.projectId === p.id).length !== 12) throw new Error('expected 12 project agents')
      await clickText('Add the full team')
      await waitFor('idempotent message', `document.body.innerText.includes('Every role is already there')`)
      if ((await agentList()).length !== 13) throw new Error('adding the team twice created duplicates')
      return '12 roles created once; repeating adds nothing'
    })
    await shot('19-agents-team.png')

    // ------------------------------------------------------------------ Phase 5: orchestrator + task board (driven through the real UI)
    const smokeProject = (await js<Array<{ id: string; name: string }>>(`window.api.invoke('projects:list')`)).find((x) => x.name === 'Smoke Survival Game')!
    const runsList = () => js<Array<Record<string, any>>>(`window.api.invoke('runs:list', ${JSON.stringify(smokeProject.id)})`)
    const tasksList = () => js<Array<Record<string, any>>>(`window.api.invoke('tasks:list', { projectId: ${JSON.stringify(smokeProject.id)} })`)
    const smokeUsage = async () => (await js<Array<Record<string, any>>>(`window.api.invoke('usage:byModel')`)).find((x) => x.model === 'smoke-chat')!
    const closeDialog = () => js(`document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click()`)
    const openStartRun = async () => {
      await js(`document.querySelector('[data-action="start-run"]').click()`)
      await waitFor('start-run modal', `!!document.querySelector('[role="dialog"]')`)
    }
    const panelText = `(document.querySelector('[data-testid="run-panel"]')?.innerText ?? '')`

    await js(`document.querySelector('[data-nav="tasks"]').click()`)
    await step('ui_tasks_page_empty_board', async () => {
      await waitFor('project select', `!!document.querySelector('select[aria-label="Project"]')`)
      await setNative('select[aria-label="Project"]', smokeProject.id)
      await waitFor('empty board', `document.body.innerText.includes('The board is empty')`)
      return 'empty board, no run yet'
    })
    await step('ui_start_run_refused_until_pm_is_ready', async () => {
      await openStartRun()
      await waitFor('readiness warning', `!!document.querySelector('[data-testid="run-not-ready"]')`)
      const warn = await js<string>(`document.querySelector('[data-testid="run-not-ready"]').innerText`)
      if (!/cannot run/.test(warn)) throw new Error(`unexpected warning: ${warn}`)
      if (!(await js<boolean>(`document.querySelector('[data-action="confirm-start-run"]').disabled`))) throw new Error('Start was enabled although the PM cannot run')
      const direct = await js<string>(`window.api.invoke('runs:start', { projectId: ${JSON.stringify(smokeProject.id)}, goal: 'x' }).then(() => 'NOT REJECTED', e => e.message)`)
      if (!/cannot run/.test(direct)) throw new Error(`backend did not refuse: ${direct}`)
      await shot('20-start-run-not-ready.png')
      await closeDialog()
      return warn
    })

    // Give every project agent the mock connection + model, exactly as the Agents page would.
    await step('assign_model_to_project_team', async () => {
      const team = (await agentList()).filter((a) => a.projectId === smokeProject.id)
      for (const a of team) {
        await js(`window.api.invoke('agents:update', { id: ${JSON.stringify(a.id)}, connectionId: ${JSON.stringify(connId)}, model: 'smoke-chat' })`)
      }
      const after = (await agentList()).filter((a) => a.projectId === smokeProject.id)
      const stuck = after.filter((a) => a.issues.length).map((a) => `${a.name}: ${a.issues.join('; ')}`)
      if (stuck.length !== 1 || !stuck[0].startsWith('Image Generator')) throw new Error(`expected only the image agent to be unready (it has a chat model): ${JSON.stringify(stuck)}`)
      if (!/chat model/.test(stuck[0])) throw new Error(`unexpected reason: ${stuck[0]}`)
      // An image agent needs an image model: the id is typed by hand because the mock does not list it.
      const img = after.find((a) => a.kind === 'image')!
      await js(`window.api.invoke('agents:update', { id: ${JSON.stringify(img.id)}, connectionId: ${JSON.stringify(connId)}, model: 'smoke-image' })`)
      const final = (await agentList()).filter((a) => a.projectId === smokeProject.id)
      const still = final.filter((a) => a.issues.length).map((a) => `${a.name}: ${a.issues.join('; ')}`)
      if (still.length) throw new Error(`agents still not ready: ${JSON.stringify(still)}`)
      return `all ${final.length} agents ready (image agent uses smoke-image)`
    })

    let usageBefore = 0
    await step('ui_start_run_plans_and_completes', async () => {
      usageBefore = (await smokeUsage()).calls
      await openStartRun()
      await setNative('textarea[aria-label="Run goal"]', 'Build the core loop of the survival game')
      await setNative('input[aria-label="Run budget"]', '1')
      await shot('21-start-run.png')
      await js(`document.querySelector('[data-action="confirm-start-run"]').click()`)
      await waitFor('modal to close', `!document.querySelector('[role="dialog"]')`)
      await waitFor('run completed', `${panelText}.includes('Completed')`, 30000)
      const [run] = await runsList()
      const tasks = await tasksList()
      if (run.status !== 'completed' || run.error) throw new Error(`run ended as ${run.status}: ${run.error}`)
      if (tasks.length !== 3 || tasks.some((t) => t.status !== 'done')) throw new Error(`unexpected tasks ${JSON.stringify(tasks.map((t) => [t.title, t.status]))}`)
      const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t]))
      const impl = byTitle['Implement feature']
      const arch = byTitle['Write architecture notes']
      if (impl.dependsOn[0] !== arch.id || byTitle['Review feature'].dependsOn[0] !== impl.id) throw new Error('dependencies were not kept')
      if (arch.assignedAgentName !== 'Technical Architect' || impl.assignedAgentName !== 'Lead Developer') throw new Error('tasks went to the wrong agents')
      if (!/Completed “Implement feature”/.test(impl.resultSummary)) throw new Error(`result not stored: ${impl.resultSummary}`)
      return { status: run.status, tasks: tasks.map((t) => `${t.title} → ${t.assignedAgentName}`) }
    })
    await shot('22-run-completed.png')

    await step('run_cost_is_attributed_to_run_and_tasks', async () => {
      const calls = (await smokeUsage()).calls - usageBefore
      const [run] = await runsList()
      const tasks = await tasksList()
      const perCall = (12 * 2.5 + 6 * 10) / 1_000_000 // the price set earlier in this run of the smoke test
      // plan(1) + architect(2: tool call + report) + developer(1) + reviewer(1)
      if (calls !== 5) throw new Error(`expected 5 model calls for the run, got ${calls}`)
      if (Math.abs(run.spentUsd - calls * perCall) > 1e-9) throw new Error(`run spent ${run.spentUsd}, expected ${calls * perCall}`)
      const taskSum = tasks.reduce((a, t) => a + t.costUsd, 0)
      if (Math.abs(taskSum - (calls - 1) * perCall) > 1e-9) throw new Error(`task costs ${taskSum} != ${(calls - 1) * perCall} (plan call has no task)`)
      if (run.unpricedCalls !== 0) throw new Error('calls were unexpectedly unpriced')
      const text = await js<string>(panelText)
      if (!text.includes('of $1.00')) throw new Error(`budget not shown in the run panel: ${text}`)
      return { calls, spentUsd: run.spentUsd, budget: run.budgetUsd }
    })

    await step('agents_shared_memory_through_tools', async () => {
      const ev = await js<Array<{ type: string; message: string }>>(`window.api.invoke('events:recent', { limit: 200 })`)
      const w = ev.find((e) => e.type === 'memory.written')
      if (!w) throw new Error('write_memory left no trace')
      return w.message
    })

    await step('ui_task_drawer_shows_agent_log', async () => {
      await js(`document.querySelector('[data-task="Write architecture notes"]').click()`)
      await waitFor('drawer', `!!document.querySelector('[data-testid="task-drawer"]')`)
      await waitFor('log entries', `document.querySelectorAll('[data-testid="task-log"] [data-log-role]').length >= 3`)
      const roles = await js<string[]>(`[...document.querySelectorAll('[data-testid="task-log"] [data-log-role]')].map(e => e.dataset.logRole)`)
      const log = await js<string>(`document.querySelector('[data-testid="task-log"]').innerText`)
      if (!roles.includes('tool') || !roles.includes('assistant') || !roles.includes('user')) throw new Error(`log roles: ${roles}`)
      if (!log.includes('write_memory')) throw new Error('tool call missing from the log')
      return roles
    })
    await shot('23-task-drawer.png')
    await js(`document.querySelector('button[aria-label="Close task details"]').click()`)

    await step('ui_manual_task_add_and_delete', async () => {
      await js(`document.querySelector('[data-action="add-task"]').click()`)
      await waitFor('modal', `!!document.querySelector('[role="dialog"]')`)
      await setNative('input[aria-label="Task title"]', 'Write release notes')
      await js(`document.querySelector('[data-action="confirm-add-task"]').click()`)
      await waitFor('drawer for the new task', `document.querySelector('[data-testid="task-drawer"]')?.innerText.includes('Write release notes')`)
      const t = (await tasksList()).find((x) => x.title === 'Write release notes')
      if (!t || t.status !== 'todo' || t.runId !== null || t.role !== null) throw new Error(`unexpected new task ${JSON.stringify(t)}`)
      await clickText('Delete')
      await waitFor('task gone', `!document.querySelector('[data-task="Write release notes"]')`)
      if ((await tasksList()).some((x) => x.title === 'Write release notes')) throw new Error('task was not deleted')
      return 'created and deleted from the board'
    })

    // A budget that covers the plan but not the whole job: the run must pause (not fail) and resume after the budget is raised.
    await step('ui_budget_pauses_run_and_resume_completes', async () => {
      await openStartRun()
      await setNative('textarea[aria-label="Run goal"]', 'Second pass over the survival game')
      await setNative('input[aria-label="Run budget"]', '0.0003') // each call costs 0.00009
      await js(`document.querySelector('[data-action="confirm-start-run"]').click()`)
      await waitFor('run paused', `${panelText}.includes('Paused')`, 30000)
      const [paused] = await runsList()
      if (paused.status !== 'paused' || !/budget/i.test(paused.error ?? '')) throw new Error(`expected a budget pause, got ${paused.status}: ${paused.error}`)
      const failed = (await tasksList()).filter((t) => t.runId === paused.id && t.status === 'failed')
      if (failed.length) throw new Error('budget exhaustion was recorded as a task failure')
      await shot('24-run-paused-budget.png')
      await js(`document.querySelector('[data-action="resume-run"]').click()`)
      await waitFor('resume modal', `!!document.querySelector('input[aria-label="Resume budget"]')`)
      await setNative('input[aria-label="Resume budget"]', '1')
      await js(`document.querySelector('[data-action="confirm-resume-run"]').click()`)
      await waitFor('run completed', `${panelText}.includes('Completed')`, 30000)
      const [done] = await runsList()
      const mine = (await tasksList()).filter((t) => t.runId === done.id)
      if (done.status !== 'completed' || mine.length !== 3 || mine.some((t) => t.status !== 'done')) throw new Error(`resume did not finish the job: ${done.status}, ${JSON.stringify(mine.map((t) => t.status))}`)
      return { pausedWith: paused.error, spent: done.spentUsd }
    })

    // STOP: a streaming call is in flight; the run must end as "cancelled", the call be recorded as cancelled and agents go idle.
    await step('ui_stop_run_aborts_inflight_call', async () => {
      const failedBefore = (await smokeUsage()).failedCalls
      await openStartRun()
      await setNative('textarea[aria-label="Run goal"]', 'slow planning run')
      await js(`document.querySelector('[data-action="confirm-start-run"]').click()`)
      await waitFor('run running', `${panelText}.includes('Running')`)
      await waitFor('the PM is mid-call', `[...document.querySelectorAll('button')].some(b => b.dataset.action === 'stop-run')`)
      await wait(900)
      await js(`document.querySelector('[data-action="stop-run"]').click()`)
      await waitFor('run stopped', `${panelText}.includes('Stopped')`, 15000)
      const [run] = await runsList()
      if (run.status !== 'cancelled') throw new Error(`run is ${run.status}`)
      const agents = (await agentList()).filter((a) => a.projectId === smokeProject.id)
      if (agents.some((a) => a.status !== 'idle')) throw new Error(`agents still busy: ${agents.filter((a) => a.status !== 'idle').map((a) => a.name)}`)
      const failedAfter = (await smokeUsage()).failedCalls
      if (failedAfter <= failedBefore) throw new Error('the aborted call was not recorded')
      return 'run cancelled, in-flight call recorded as cancelled, agents idle'
    })
    await shot('25-run-stopped.png')

    await step('ui_stop_all_button', async () => {
      if (!(await js<boolean>(`document.querySelector('[data-action="stop-all"]').disabled`))) throw new Error('STOP ALL should be disabled while nothing runs')
      await openStartRun()
      await setNative('textarea[aria-label="Run goal"]', 'slow planning run again')
      await js(`document.querySelector('[data-action="confirm-start-run"]').click()`)
      await waitFor('STOP ALL enabled', `!document.querySelector('[data-action="stop-all"]').disabled`)
      await wait(700)
      await js(`document.querySelector('[data-action="stop-all"]').click()`)
      await waitFor('result shown', `(document.querySelector('[data-testid="stop-all-result"]')?.innerText ?? '').includes('Stopped 1 run')`, 15000)
      const [run] = await runsList()
      if (run.status !== 'cancelled') throw new Error(`run is ${run.status}`)
      await waitFor('STOP ALL disabled again', `document.querySelector('[data-action="stop-all"]').disabled`)
      return 'emergency stop cancelled the active run'
    })

    await step('ui_right_panel_lists_tasks', async () => {
      await js(`document.querySelector('[data-testid="right-tab-tasks"]').click()`)
      await waitFor('task list', `document.querySelectorAll('[data-testid="right-task-list"] button').length > 0`)
      return await js<number>(`document.querySelectorAll('[data-testid="right-task-list"] button').length`)
    })
    await shot('26-tasks-right-panel.png')

    // ------------------------------------------------------------------ Phase 6: workspace, editor, terminal, agent file tools, approvals
    const wsRead = (path: string) => js<{ content: string; hash: string }>(`window.api.invoke('fs:read', { projectId: ${JSON.stringify(smokeProject.id)}, path: ${JSON.stringify(path)} })`)
    const wsWrite = (path: string, content: string) => js(`window.api.invoke('fs:write', { projectId: ${JSON.stringify(smokeProject.id)}, path: ${JSON.stringify(path)}, content: ${JSON.stringify(content)} })`)
    const key = async (keyCode: string, modifiers: Array<'control' | 'shift'> = []) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      await wait(150)
    }

    await step('workspace_seed_files', async () => {
      await wsWrite('README.md', '# Smoke Survival Game\n\nA tiny project used by the self test.\n')
      await wsWrite('src/main.js', "export function start() {\n  return 'needle-in-a-haystack'\n}\n")
      await wsWrite('notes/todo.txt', 'ship it\n')
      return 'three files written through the sandbox'
    })

    await js(`document.querySelector('[data-nav="workspace"]').click()`)
    await step('ui_workspace_tree_lists_project_files', async () => {
      await waitFor('workspace page', `!!document.querySelector('[data-page="workspace"]')`, 15000)
      await waitFor('project select', `!!document.querySelector('[data-page="workspace"] select[aria-label="Project"]')`)
      await setNative('[data-page="workspace"] select[aria-label="Project"]', smokeProject.id)
      await waitFor('tree entries', `!!document.querySelector('[role="treeitem"][data-path="README.md"]')`)
      const paths = await js<string[]>(`[...document.querySelectorAll('[role="treeitem"]')].map(e => e.dataset.path)`)
      if (!paths.includes('src') || !paths.includes('notes')) throw new Error(`folders missing: ${paths}`)
      return paths
    })
    await shot('27-workspace-tree.png')

    await step('ui_monaco_opens_file', async () => {
      await js(`document.querySelector('[role="treeitem"][data-path="README.md"]').click()`)
      await waitFor('editor host', `!!document.querySelector('[data-editor-host] .monaco-editor')`, 20000)
      await waitFor('file text in the editor', `(document.querySelector('[data-editor-host] .view-lines')?.innerText ?? '').replace(/\u00a0/g, ' ').includes('Smoke Survival Game')`, 10000)
      if (!(await js<boolean>(`!!document.querySelector('[role="tab"][data-tab="README.md"]')`))) throw new Error('no tab for the file')
      return 'Monaco mounted with the file content'
    })
    await shot('28-editor-open.png')

    await step('ui_editor_edit_and_ctrl_s_saves_to_disk', async () => {
      await js(`document.querySelector('[data-editor-host] textarea').focus()`)
      await key('Home', ['control']) // top of the file
      win.webContents.insertText('EDITED ')
      await waitFor('dirty state', `/unsaved/i.test(document.querySelector('[data-save-state]')?.innerText ?? '')`, 5000)
      await shot('29-editor-dirty.png')
      await key('S', ['control'])
      await waitFor('saved state', `/^saved$/i.test((document.querySelector('[data-save-state]')?.innerText ?? '').trim())`, 8000)
      const disk = (await wsRead('README.md')).content
      if (!disk.startsWith('EDITED # Smoke Survival Game')) throw new Error(`file on disk is: ${JSON.stringify(disk.slice(0, 60))}`)
      return 'edit typed into Monaco, Ctrl+S wrote it to disk'
    })

    await step('ui_search_finds_text', async () => {
      await js(`[...document.querySelectorAll('[data-page="workspace"] [role="tab"]')].find(b => b.textContent.includes('Search')).click()`)
      await waitFor('search box', `!!document.querySelector('input[aria-label="Search in project"]')`)
      await setNative('input[aria-label="Search in project"]', 'needle-in')
      await js(`document.querySelector('input[aria-label="Search in project"]').form.requestSubmit()`)
      await waitFor('hit', `document.querySelectorAll('[data-hit]').length >= 1`)
      const hits = await js<number>(`document.querySelectorAll('[data-hit]').length`)
      if (hits !== 1) throw new Error(`expected exactly 1 hit, got ${hits}`)
      await shot('30-search.png')
      await js(`document.querySelector('[data-hit]').click()`)
      await waitFor('file opened from the hit', `!!document.querySelector('[role="tab"][data-tab="src/main.js"]')`)
      await waitFor('its text', `(document.querySelector('[data-editor-host] .view-lines')?.innerText ?? '').replace(/\u00a0/g, ' ').includes('needle-in-a-haystack')`)
      await js(`[...document.querySelectorAll('[data-page="workspace"] [role="tab"]')].find(b => b.textContent.includes('Files')).click()`)
      return 'one hit, opens the file at the match'
    })

    await step('ui_index_builds', async () => {
      await clickText('Index')
      await waitFor('index status', `/\\d+ files indexed/.test(document.querySelector('[data-index-status]')?.innerText ?? '')`, 15000)
      const hits = await js<Array<{ path: string }>>(`window.api.invoke('index:find', { projectId: ${JSON.stringify(smokeProject.id)}, query: 'start' })`)
      if (!hits.some((h) => h.path === 'src/main.js')) throw new Error(`index did not find src/main.js: ${JSON.stringify(hits)}`)
      return await js<string>(`document.querySelector('[data-index-status]').innerText`)
    })

    await step('ui_terminal_runs_a_command', async () => {
      await js(`[...document.querySelectorAll('[aria-label="Output panel"] [role="tab"]')].find(b => b.textContent.trim() === 'Terminal').click()`)
      await waitFor('terminal', `!!document.querySelector('[data-terminal-input]')`)
      await setNative('[data-terminal-input]', 'node -e "console.log(6*7)"')
      await js(`document.querySelector('[data-terminal-input]').form.requestSubmit()`)
      await waitFor('output', `(document.querySelector('[data-terminal-output]')?.innerText ?? '').includes('42')`, 15000)
      await waitFor('exit status', `(document.querySelector('[data-terminal-entry]')?.innerText ?? '').includes('exit 0')`, 8000)
      return 'command ran in the project folder with streamed output'
    })
    await step('ui_terminal_blocks_dangerous_command', async () => {
      await setNative('[data-terminal-input]', 'format C:')
      await js(`document.querySelector('[data-terminal-input]').form.requestSubmit()`)
      await waitFor('blocked entry', `[...document.querySelectorAll('[data-terminal-entry]')].some(e => e.innerText.includes('format C:') && /blocked/.test(e.innerText))`, 8000)
      return 'refused before any process started'
    })
    await shot('31-terminal.png')

    // Run an agent task that writes a file and one that needs approval, driven by the real orchestrator.
    const latestRun = async () => (await runsList())[0]
    const runAndWaitForApproval = async (goal: string) => {
      await js(`document.querySelector('[data-nav="tasks"]').click()`)
      await waitFor('tasks page', `!!document.querySelector('[data-action="start-run"]')`)
      const prev = (await latestRun())?.id
      await openStartRun()
      await setNative('textarea[aria-label="Run goal"]', goal)
      await setNative('input[aria-label="Run budget"]', '1')
      await js(`document.querySelector('[data-action="confirm-start-run"]').click()`)
      await waitFor('modal to close', `!document.querySelector('[role="dialog"]:not([data-approval-overlay])')`)
      return prev
    }
    const waitRunDone = async (prev: string | undefined, status = 'completed') => {
      const t0 = Date.now()
      while (Date.now() - t0 < 40000) {
        const r = await latestRun()
        if (r && r.id !== prev && r.status === status) return r
        if (r && r.id !== prev && ['failed', 'cancelled'].includes(r.status) && r.status !== status) throw new Error(`run ended as ${r.status}: ${r.error}`)
        await wait(150)
      }
      throw new Error(`run did not reach ${status}`)
    }

    let approvalRunPrev: string | undefined
    await step('agent_write_file_and_command_needs_approval', async () => {
      approvalRunPrev = await runAndWaitForApproval('workspace tools smoke: build the hello module and check it')
      await waitFor('approval dialog', `!!document.querySelector('[data-approval-overlay]')`, 30000)
      const cmd = await js<string>(`document.querySelector('[data-approval-command]').innerText`)
      if (!cmd.includes('console.log(41+1)')) throw new Error(`dialog shows: ${cmd}`)
      // the file the first task wrote must already be on disk, written by the agent through the sandbox
      const f = await wsRead('src/hello.js')
      if (!f.content.includes('hello from an agent')) throw new Error(`agent file content: ${f.content}`)
      await shot('32-approval-dialog.png')
      return `dialog asked about: ${cmd.trim()}; agent wrote src/hello.js`
    })
    await step('approval_allow_runs_the_command', async () => {
      await js(`document.querySelector('[data-approval="allow"]').click()`)
      await waitRunDone(approvalRunPrev)
      await waitFor('dialog gone', `!document.querySelector('[data-approval-overlay]')`)
      const hist = await js<Array<{ command: string; origin: string; decision: string; exitCode: number | null }>>(`window.api.invoke('term:history', ${JSON.stringify(smokeProject.id)})`)
      const h = hist.find((x) => x.origin === 'agent' && x.command.includes('41+1'))
      if (!h || h.decision !== 'user_approved' || h.exitCode !== 0) throw new Error(`agent command history: ${JSON.stringify(hist.slice(0, 3))}`)
      return 'approved once, ran, exit 0, recorded as an agent command'
    })
    await step('approval_deny_does_not_run_the_command', async () => {
      const before = (await js<Array<unknown>>(`window.api.invoke('term:history', ${JSON.stringify(smokeProject.id)})`)).length
      const prev = await runAndWaitForApproval('workspace tools smoke: second pass')
      await waitFor('approval dialog', `!!document.querySelector('[data-approval-overlay]')`, 30000)
      await js(`document.querySelector('[data-approval="deny"]').click()`)
      await waitRunDone(prev)
      const hist = await js<Array<{ command: string; decision: string; exitCode: number | null }>>(`window.api.invoke('term:history', ${JSON.stringify(smokeProject.id)})`)
      const newest = hist[0]
      if (hist.length <= before || newest.decision !== 'user_denied' || newest.exitCode !== null) throw new Error(`expected a denied entry, got ${JSON.stringify(newest)}`)
      return 'denied: the command never ran (recorded as not approved)'
    })

    await step('ui_workspace_shows_agent_file', async () => {
      await js(`document.querySelector('[data-nav="workspace"]').click()`)
      await waitFor('tree', `!!document.querySelector('[role="treeitem"][data-path="src"]')`)
      if (!(await js<boolean>(`!!document.querySelector('[role="treeitem"][data-path="src/hello.js"]')`))) await js(`document.querySelector('[role="treeitem"][data-path="src"]').click()`)
      await waitFor('agent file in the tree', `!!document.querySelector('[role="treeitem"][data-path="src/hello.js"]')`)
      return 'file written by the agent is visible in the tree'
    })
    await shot('33-workspace-after-agent.png')

    await step('ui_settings_policy_card', async () => {
      await js(`document.querySelector('[data-nav="settings"]').click()`)
      await waitFor('policy card', `!!document.querySelector('[data-policy]')`)
      const t = await js<string>(`document.querySelector('[data-policy]').innerText`)
      if (!/format|diskpart|blocked/i.test(t)) throw new Error(`policy text: ${t.slice(0, 200)}`)
      return 'policy listed in Settings'
    })
    await shot('34-settings-policy.png')

    // ------------------------------------------------------------------ Phase 7: image generation and the asset library
    // The mock above answers /v1/images/* with pictures made by our own PNG encoder (and a JPEG for the foreign-decoder path).
    const assetList = () => js<Array<Record<string, any>>>(`window.api.invoke('assets:list', { projectId: ${JSON.stringify(smokeProject.id)} })`)
    const projectRoot = (await js<Array<{ id: string; rootPath: string }>>(`window.api.invoke('projects:list')`)).find((p) => p.id === smokeProject.id)!.rootPath
    const pngOnDisk = (rel: string) => {
      const buf = readFileSync(join(projectRoot, rel))
      return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    }
    const selectAsset = async (name: string) => {
      await js(`document.querySelector('[data-asset=${JSON.stringify(name)}]').click()`)
      await waitFor('detail pane', `!!document.querySelector('[data-asset-detail=${JSON.stringify(name)}]')`)
    }

    await step('ui_asset_library_starts_empty', async () => {
      await js(`document.querySelector('[data-nav="assets"]').click()`)
      await waitFor('empty library', `document.body.innerText.includes('No pictures yet')`)
      return 'no pictures yet, nothing invented'
    })
    await shot('35-assets-empty.png')

    await step('ui_generate_dialog_accepts_hand_typed_model_and_price', async () => {
      await js(`document.querySelector('[data-action="open-generate"]').click()`)
      await waitFor('generate form', `!!document.querySelector('[data-generate-form]')`)
      await setNative('input[aria-label="Image model"]', 'smoke-image')
      await setNative('textarea[aria-label="Prompt"]', 'A red square sprite on a plain background')
      await setNative('input[aria-label="Count"]', '2')
      await js(`document.querySelector('input[aria-label="Transparent background"]').click()`)
      await waitFor('price field', `!!document.querySelector('input[aria-label="Price per picture"]')`)
      await setNative('input[aria-label="Price per picture"]', '0.04')
      await js(`document.querySelector('[data-action="save-price"]').click()`)
      await waitFor('price saved', `document.querySelector('[data-price-message]')?.innerText.includes('Price saved')`)
      await shot('36-generate-dialog.png')
      return 'connection offered, model typed by hand, price saved'
    })

    await step('ui_generate_two_transparent_pictures', async () => {
      const before = mock.imageRequests.length
      await js(`document.querySelector('[data-action="run-generate"]').click()`)
      await waitFor('generation result', `!!document.querySelector('[data-generate-result]') || !!document.querySelector('[data-generate-error]')`, 20000)
      const err = await js<string | null>(`document.querySelector('[data-generate-error]')?.innerText ?? null`)
      if (err) throw new Error(`generation failed: ${err}`)
      const text = await js<string>(`document.querySelector('[data-generate-result]').innerText`)
      const req = mock.imageRequests[before]
      if (mock.imageRequests.length !== before + 1 || req.path !== '/v1/images/generations' || req.model !== 'smoke-image' || req.n !== 2) throw new Error(`provider saw ${JSON.stringify(mock.imageRequests.slice(before))}`)
      if (!req.prompt.includes('red square sprite')) throw new Error(`prompt not forwarded: ${req.prompt}`)
      if (!text.includes('$0.08')) throw new Error(`expected the 2 x $0.04 cost in: ${text}`)
      await shot('37-generate-done.png')
      return text.replace(/\s+/g, ' ')
    })
    await js(`document.querySelector('[data-action="close-generate"]').click()`)
    await waitFor('dialog closed', `!document.querySelector('[role="dialog"]')`)

    let firstAsset: Record<string, any> = {}
    await step('library_lists_real_files', async () => {
      await waitFor('two pictures in the grid', `document.querySelectorAll('[data-asset]').length === 2`)
      const list = await assetList()
      if (list.length !== 2) throw new Error(`expected 2 assets, got ${list.length}`)
      for (const a of list) {
        if (a.width !== 96 || a.height !== 96 || !a.exists || a.bytes <= 0 || !a.transparent || a.origin !== 'generated') throw new Error(`bad asset ${JSON.stringify(a)}`)
        if (!pngOnDisk(a.path)) throw new Error(`${a.path} is not a PNG on disk`)
        const url = await js<string | null>(`window.api.invoke('assets:preview', { id: ${JSON.stringify(a.id)}, max: 64 })`)
        if (!url?.startsWith('data:image/png;base64,')) throw new Error(`no preview for ${a.path}`)
      }
      firstAsset = list.find((a) => !/-2\./.test(a.path)) ?? list[0]
      const usage = (await js<Array<Record<string, any>>>(`window.api.invoke('usage:byModel')`)).find((x) => x.model === 'smoke-image')
      if (!usage || usage.calls !== 1 || Math.abs(usage.costUsd - 0.08) > 1e-9) throw new Error(`image spend not recorded: ${JSON.stringify(usage)}`)
      return `${list.map((a) => a.path).join(', ')}; image spend $${usage.costUsd} recorded`
    })
    await step('ui_asset_detail_shows_prompt_model_and_size', async () => {
      await selectAsset(firstAsset.name)
      const t = await js<string>(`document.querySelector('[data-asset-detail]').innerText`)
      if (!t.includes('smoke-image') || !t.includes('96×96') || !t.includes('red square sprite')) throw new Error(`detail pane: ${t.slice(0, 300)}`)
      return 'prompt, model and size shown'
    })
    await shot('38-asset-detail.png')

    let resized: Record<string, any> = {}
    await step('ui_resize_creates_derived_picture_and_keeps_original', async () => {
      await setNative('input[aria-label="Width"]', '48')
      await setNative('input[aria-label="Height"]', '48')
      await js(`document.querySelector('[data-action="apply-process"]').click()`)
      await waitFor('derived picture in the grid', `document.querySelectorAll('[data-asset]').length === 3 || !!document.querySelector('[data-asset-error]')`)
      const err = await js<string | null>(`document.querySelector('[data-asset-error]')?.innerText ?? null`)
      if (err) throw new Error(err)
      const list = await assetList()
      resized = list.find((a) => a.origin === 'processed')!
      if (list.length !== 3 || !resized || resized.width !== 48 || resized.height !== 48 || resized.parentId !== firstAsset.id) throw new Error(`unexpected library ${JSON.stringify(list.map((a) => [a.path, a.origin, a.width, a.parentId]))}`)
      if (!pngOnDisk(resized.path) || !pngOnDisk(firstAsset.path)) throw new Error('files missing on disk')
      return `${resized.path} (48x48) derived from ${firstAsset.path}, original kept`
    })
    await shot('39-asset-resized.png')

    await step('ui_trim_cuts_the_transparent_border', async () => {
      await selectAsset(firstAsset.name)
      await setNative('select[aria-label="Operation"]', 'trim')
      await js(`document.querySelector('[data-action="apply-process"]').click()`)
      await waitFor('trimmed picture in the grid', `document.querySelectorAll('[data-asset]').length === 4 || !!document.querySelector('[data-asset-error]')`)
      const err = await js<string | null>(`document.querySelector('[data-asset-error]')?.innerText ?? null`)
      if (err) throw new Error(err)
      const trimmed = (await assetList()).find((a) => a.origin === 'processed' && a.width === 40)
      if (!trimmed || trimmed.height !== 40) throw new Error('expected a 40x40 trimmed picture (the red square)')
      return `${trimmed.path}: 96x96 -> 40x40`
    })

    let jpegAsset: Record<string, any> = {}
    await step('provider_jpeg_is_decoded_and_stored', async () => {
      const r = await js<{ assets: Array<Record<string, any>> }>(
        `window.api.invoke('assets:generate', { requestId: 'smoke-jpeg', projectId: ${JSON.stringify(smokeProject.id)}, connectionId: ${JSON.stringify(connId)}, model: 'smoke-image', prompt: 'a jpeg picture', kind: 'concept', count: 1, transparent: false })`
      )
      const a = r.assets[0]
      jpegAsset = a
      if (a.width !== 96 || a.height !== 96 || !a.exists) throw new Error(`jpeg result: ${JSON.stringify(a)}`)
      const bytes = readFileSync(join(projectRoot, a.path))
      return `${a.path}: ${bytes.length} bytes, ${bytes[0] === 0x89 ? 'PNG' : bytes[0] === 0xff ? 'JPEG' : 'other'} on disk, decoded 96x96`
    })

    await step('ui_trimming_a_picture_without_transparent_border_is_refused', async () => {
      await waitFor('jpeg picture in the grid', `!!document.querySelector('[data-asset=${JSON.stringify(jpegAsset.name)}]')`)
      await selectAsset(jpegAsset.name)
      await setNative('select[aria-label="Operation"]', 'trim')
      await js(`document.querySelector('[data-action="apply-process"]').click()`)
      await waitFor('error shown', `!!document.querySelector('[data-asset-error]')`)
      return await js<string>(`document.querySelector('[data-asset-error]').innerText`)
    })

    await step('variation_uses_the_edit_endpoint', async () => {
      const before = mock.imageRequests.length
      await js(`window.api.invoke('assets:generate', { requestId: 'smoke-edit', projectId: ${JSON.stringify(smokeProject.id)}, connectionId: ${JSON.stringify(connId)}, model: 'smoke-image', prompt: 'same but blue', kind: 'sprite', count: 1, transparent: false, referenceAssetId: ${JSON.stringify(firstAsset.id)} })`)
      const seen = mock.imageRequests.slice(before)
      if (seen.length !== 1 || seen[0].path !== '/v1/images/edits') throw new Error(`provider saw ${JSON.stringify(seen)}`)
      return 'reference picture sent to /images/edits'
    })

    await step('ui_provider_refusal_is_shown_and_saves_nothing', async () => {
      const before = (await assetList()).length
      await js(`document.querySelector('[data-action="open-generate"]').click()`)
      await waitFor('generate form', `!!document.querySelector('[data-generate-form]')`)
      await setNative('input[aria-label="Image model"]', 'smoke-image')
      await setNative('textarea[aria-label="Prompt"]', 'please refuse this one')
      await js(`document.querySelector('[data-action="run-generate"]').click()`)
      await waitFor('error', `!!document.querySelector('[data-generate-error]')`, 15000)
      const msg = await js<string>(`document.querySelector('[data-generate-error]').innerText`)
      if (!/safety system/.test(msg)) throw new Error(`error text: ${msg}`)
      if ((await assetList()).length !== before) throw new Error('a refused request left a picture behind')
      await shot('40-generate-refused.png')
      await js(`document.querySelector('[data-action="close-generate"]').click()`)
      await waitFor('dialog closed', `!document.querySelector('[role="dialog"]')`)
      return msg
    })

    await step('ui_delete_removes_entry_and_file', async () => {
      await selectAsset(resized.name)
      await js(`document.querySelector('[data-action="delete-asset"]').click()`)
      await js(`document.querySelector('[data-action="confirm-delete-asset"]').click()`)
      await waitFor('entry gone', `!document.querySelector('[data-asset=${JSON.stringify(resized.name)}]')`)
      let still = true
      try {
        readFileSync(join(projectRoot, resized.path))
      } catch {
        still = false
      }
      if (still) throw new Error('the file is still on disk')
      return `${resized.path} removed from the library and from disk`
    })
    await shot('41-assets-library.png')

    await step('image_agent_and_agent_tool_make_pictures_in_a_run', async () => {
      const before = mock.imageRequests.length
      const prev = await runAndWaitForApproval('image pipeline smoke: make a sprite and a coin icon')
      await waitRunDone(prev)
      const tasks = await tasksList()
      const art = tasks.find((t) => t.title === 'Red square sprite')
      const coin = tasks.find((t) => t.title === 'Draw a coin icon')
      if (!art || !coin || art.status !== 'done' || coin.status !== 'done') throw new Error(`tasks: ${JSON.stringify(tasks.map((t) => [t.title, t.status]))}`)
      const list = await assetList()
      const fromTask = list.find((a) => a.taskId === art.id)
      const coinAsset = list.find((a) => a.taskId === coin.id)
      if (!fromTask || fromTask.kind !== 'sprite' || !fromTask.transparent) throw new Error(`image task asset: ${JSON.stringify(fromTask)}`)
      if (!coinAsset || coinAsset.kind !== 'icon' || !coinAsset.name.startsWith('coin')) throw new Error(`tool asset: ${JSON.stringify(coinAsset)}`)
      const seen = mock.imageRequests.slice(before)
      if (seen.length !== 2 || !seen[0].prompt.includes('Red square sprite')) throw new Error(`provider saw ${JSON.stringify(seen)}`)
      return `Image Generator task -> ${fromTask.path}; generate_image tool -> ${coinAsset.path}`
    })
    await step('ui_assets_page_after_run', async () => {
      await js(`document.querySelector('[data-nav="assets"]').click()`)
      await waitFor('grid', `document.querySelectorAll('[data-asset]').length >= 4`)
      return await js<number>(`document.querySelectorAll('[data-asset]').length`)
    })
    await shot('42-assets-after-run.png')

    // ------------------------------------------------------------------ Phase 8: the workflow editor
    const wfNodes = () => js<number>(`document.querySelectorAll('[data-wf-node]').length`)
    const wfProblems = () => js<number>(`Number(/\\((\\d+)\\)/.exec(document.querySelector('[data-wf-tab="problems"]')?.textContent ?? '')?.[1] ?? -1)`)
    const wfList = () => js<Array<Record<string, any>>>(`window.api.invoke('workflows:list', ${JSON.stringify(smokeProject.id)})`)
    const wfRuns = (id: string) => js<Array<Record<string, any>>>(`window.api.invoke('workflows:runs', ${JSON.stringify(id)})`)
    const wfState = (runId: string) => js<{ run: Record<string, any>; nodes: Array<Record<string, any>> }>(`window.api.invoke('workflows:runState', ${JSON.stringify(runId)})`)
    const wfNode = (s: { nodes: Array<Record<string, any>> }, id: string) => s.nodes.find((n) => n.nodeId === id)
    const wfWaitRun = async (workflowId: string, prev: string | undefined, status: string, ms = 40000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        const r = (await wfRuns(workflowId)).sort((a, b) => b.createdAt - a.createdAt)[0]
        if (r && r.id !== prev && r.status === status) return r
        if (r && r.id !== prev && ['failed', 'cancelled'].includes(r.status) && r.status !== status) throw new Error(`workflow run ended as ${r.status}: ${r.error}`)
        await wait(150)
      }
      throw new Error(`workflow run did not reach ${status}`)
    }
    const wfLatest = async (workflowId: string) => (await wfRuns(workflowId)).sort((a, b) => b.createdAt - a.createdAt)[0] as Record<string, any> | undefined
    const wfOpenRunDialog = async (goal: string) => {
      await waitFor('Run button to be enabled', `document.querySelector('[data-wf-action="run"]')?.disabled === false`, 15000)
      await js(`document.querySelector('[data-wf-action="run"]').click()`)
      await waitFor('run dialog',`!!document.querySelector('[data-wf-action="confirm-run"]')`)
      await setNative('[data-wf-field="run-goal"]', goal)
      await setNative('[data-wf-field="run-budget"]', '2')
      await js(`document.querySelector('[data-wf-action="confirm-run"]').click()`)
      await waitFor('run dialog to close', `!document.querySelector('[data-wf-action="confirm-run"]')`)
    }
    const wfCreate = async (template: string, name: string) => {
      await js(`(document.querySelector('[data-wf-action="new"]')).click()`)
      await waitFor('new dialog', `!!document.querySelector('[data-wf-template]')`)
      await js(`document.querySelector('[data-wf-template="${template}"]').click()`)
      await setNative('[data-wf-field="new-name"]', name)
      await js(`document.querySelector('[data-wf-action="create-workflow"]').click()`)
      await waitFor('new graph drawn', `document.querySelector('[data-wf-name]')?.value === ${JSON.stringify(name)} && document.querySelectorAll('[data-wf-node]').length > 0`)
    }

    await step('ui_workflow_page_starts_empty', async () => {
      await js(`document.querySelector('[data-nav="workflow"]').click()`)
      await waitFor('workflow page', `!!document.querySelector('[data-wf-page]')`, 15000)
      await waitFor('empty state', `document.body.innerText.includes('No workflow open')`)
      if ((await wfList()).length !== 0) throw new Error('expected no saved workflows yet')
      return 'lazy-loaded editor shows its empty state'
    })
    await shot('43-workflow-empty.png')

    await step('ui_workflow_game_template_draws_ten_steps', async () => {
      await js(`document.querySelector('[data-wf-action="new-empty"]').click()`)
      await waitFor('new dialog', `!!document.querySelector('[data-wf-template]')`)
      await shot('44-workflow-new-dialog.png')
      await js(`document.querySelector('[data-wf-template="game-pipeline"]').click()`)
      await js(`document.querySelector('[data-wf-action="create-workflow"]').click()`)
      await waitFor('graph drawn', `document.querySelectorAll('[data-wf-node]').length === 10`)
      const kinds = await js<string[]>(`[...new Set([...document.querySelectorAll('[data-wf-node]')].map((n) => n.getAttribute('data-wf-type')))].sort()`)
      if (kinds.join() !== 'agent,approval,debate,image,loop,review,test') throw new Error(`node kinds: ${kinds.join()}`)
      await waitFor('connections drawn', `document.querySelectorAll('.react-flow__edge').length >= 13`, 8000).catch(() => undefined)
      const edges = await js<number>(`document.querySelectorAll('.react-flow__edge').length`)
      if (edges !== 13) throw new Error(`expected 13 connections drawn, found ${edges}`)
      return `10 steps and 13 connections; ${await wfProblems()} problems reported for this team`
    })
    await wait(500)
    await shot('45-workflow-game-pipeline.png')

    await step('ui_workflow_review_loop_template_is_valid_for_the_team', async () => {
      await wfCreate('review-loop', 'Smoke review loop')
      if ((await wfNodes()) !== 4) throw new Error(`nodes: ${await wfNodes()}`)
      const p = await wfProblems()
      if (p !== 0) throw new Error(`expected no problems with the project's team, found ${p}`)
      return 'no problems: roles resolve to ready agents of the project team'
    })

    await step('ui_workflow_drag_from_palette_adds_a_step_and_inspector_edits_it', async () => {
      await js(`(() => { const dt = new DataTransfer(); const item = document.querySelector('[data-wf-palette-item="test"]');
        item.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        const c = document.querySelector('[data-wf-canvas]'); const r = c.getBoundingClientRect(); const at = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 420, clientY: r.top + 260 };
        c.dispatchEvent(new DragEvent('dragover', at)); c.dispatchEvent(new DragEvent('drop', at)); })()`)
      await waitFor('fifth step', `document.querySelectorAll('[data-wf-node]').length === 5`)
      await waitFor('inspector for the new step', `!!document.querySelector('[data-wf-inspector]')`)
      await setNative('[data-wf-field="label"]', 'Check it')
      await setNative('[data-wf-field="command"]', 'node pass.js')
      await waitFor('renamed on the canvas', `[...document.querySelectorAll('[data-wf-node]')].some((n) => n.innerText.includes('Check it') && n.innerText.includes('node pass.js'))`)
      await waitFor('unsaved marker', `!!document.querySelector('[data-wf-dirty]')`)
      return 'a Test step was dropped on the canvas and edited in the inspector'
    })
    await shot('46-workflow-inspector.png')

    await step('ui_workflow_unfinished_step_blocks_running', async () => {
      // the dropped Test step is still selected: delete it from the inspector
      await js(`document.querySelector('[data-wf-action="delete-node"]').click()`)
      await waitFor('back to four', `document.querySelectorAll('[data-wf-node]').length === 4`)
      await js(`document.querySelector('[data-wf-palette-item="agent"]').click()`)
      await waitFor('fifth step', `document.querySelectorAll('[data-wf-node]').length === 5`)
      const before = await wfProblems()
      if (before < 2) throw new Error(`an agent step without agent or instruction should report 2 problems, found ${before}`)
      await js(`document.querySelector('[data-wf-action="run"]').click()`)
      await waitFor('refusal notice', `!!document.querySelector('[data-wf-notice="err"]')`)
      const msg = await js<string>(`document.querySelector('[data-wf-notice="err"]').innerText`)
      if (!/cannot run/.test(msg)) throw new Error(`notice: ${msg}`)
      await waitFor('problem list', `!!document.querySelector('[data-wf-problems] li')`)
      await shot('47-workflow-problems.png')
      await js(`document.querySelector('[data-wf-action="delete-node"]').click()`)
      await waitFor('back to four', `document.querySelectorAll('[data-wf-node]').length === 4`)
      return msg
    })

    await step('ui_workflow_save_persists_graph_and_name', async () => {
      await setNative('[data-wf-name]', 'Smoke review loop v2')
      await js(`document.querySelector('[data-wf-action="save"]').click()`)
      await waitFor('saved', `!document.querySelector('[data-wf-dirty]') && !!document.querySelector('[data-wf-notice="ok"]')`)
      const l = await wfList()
      if (l.length !== 1 || l[0].name !== 'Smoke review loop v2' || l[0].nodeCount !== 4) throw new Error(`list: ${JSON.stringify(l)}`)
      const wf = await js<{ graph: { nodes: Array<{ id: string; position: { x: number } }>; edges: unknown[] } }>(`window.api.invoke('workflows:get', ${JSON.stringify(l[0].id)})`)
      if (wf.graph.edges.length !== 5) throw new Error(`edges saved: ${wf.graph.edges.length}`)
      return `saved as “${l[0].name}”: ${wf.graph.nodes.length} steps, ${wf.graph.edges.length} connections`
    })

    await step('ui_workflow_run_loops_until_the_reviewer_approves', async () => {
      const id = (await wfList())[0].id
      const prev = (await wfLatest(id))?.id
      const reviewsBefore = mock.reviewCalls()
      await wfOpenRunDialog('workflow smoke: add a greeting')
      await waitFor('a step lights up', `!!document.querySelector('[data-wf-status]')`, 15000)
      const run = await wfWaitRun(id, prev, 'completed')
      await waitFor('final statuses on the canvas', `document.querySelector('[data-wf-node="summary"]')?.getAttribute('data-wf-status') === 'done'`)
      const s = await wfState(run.id)
      const write = wfNode(s, 'write')
      const review = wfNode(s, 'review')
      if (write?.runs !== 2 || review?.runs !== 2) throw new Error(`write ran ${write?.runs}×, review ${review?.runs}×`)
      if (review.handle !== 'approved') throw new Error(`last verdict: ${review.handle}`)
      if (mock.reviewCalls() - reviewsBefore !== 2) throw new Error(`provider saw ${mock.reviewCalls() - reviewsBefore} reviews`)
      const text = await js<string>(`document.querySelector('[data-wf-node="write"]').innerText`)
      if (!/ran 2×/.test(text)) throw new Error(`canvas shows: ${text}`)
      if (!(run.spentUsd >= 0) || run.workflowId !== id) throw new Error(`run: ${JSON.stringify(run)}`)
      return `Write and Review ran twice (changes → approved), then Summary; ${run.spentUsd > 0 ? `$${run.spentUsd.toFixed(4)} spent` : 'cost unpriced'}`
    })
    await shot('48-workflow-run-done.png')

    await step('ui_workflow_run_panel_shows_step_output', async () => {
      await js(`document.querySelector('[data-wf-run-node="review"]').click()`)
      await waitFor('output of the review', `(document.querySelector('[data-wf-output]')?.innerText ?? '').length > 10`)
      return await js<string>(`document.querySelector('[data-wf-output]').innerText.slice(0, 160)`)
    })

    await step('workflow_steps_are_tasks_and_events_in_the_project', async () => {
      const id = (await wfList())[0].id
      const run = (await wfLatest(id))!
      const tasks = (await tasksList()).filter((t) => t.runId === run.id)
      if (tasks.length < 5 || !tasks.some((t) => t.title === 'Summary' && t.status === 'done')) throw new Error(`tasks: ${JSON.stringify(tasks.map((t) => [t.title, t.status]))}`)
      return `${tasks.length} tasks (one per step execution) on the Tasks board, all attributed to the run`
    })

    // Graphs made here with the shared builders, saved through the real IPC like the editor does.
    const agentStep = (id: string, label: string, role: string, instruction: string, x: number) => ({ ...newNode('agent', id, { x, y: 0 }), label, config: { agent: { agentId: null, role }, instruction } })
    const saveGraph = (name: string, graph: WorkflowGraph) =>
      js<{ id: string }>(`window.api.invoke('workflows:save', ${JSON.stringify({ projectId: smokeProject.id, name, graph })})`)
    const wfOpen = async (id: string) => {
      await js(`document.querySelector('[data-nav="tasks"]').click()`)
      await js(`document.querySelector('[data-nav="workflow"]').click()`)
      await waitFor('editor', `!!document.querySelector('[data-wf-select]') && !!document.querySelector('[data-wf-select] option[value="${id}"]')`, 15000)
      await setNative('[data-wf-select]', id)
      await waitFor('graph drawn', `document.querySelectorAll('[data-wf-node]').length > 0 && document.querySelector('[data-wf-select]').value === '${id}'`)
    }
    const decide = async (button: 'allow' | 'deny') => {
      await waitFor('approval dialog', `!!document.querySelector('[data-approval-overlay]')`, 20000)
      await js(`document.querySelector('[data-approval="${button}"]').click()`)
      await waitFor('dialog gone', `!document.querySelector('[data-approval-overlay]')`)
    }

    let gateId = ''
    await step('ui_workflow_human_approval_dialog_and_approved_branch', async () => {
      const gate = { ...newNode('approval', 'gate', { x: 300, y: 0 }), label: 'Gate', config: { message: 'Ship the greeting?' } }
      const g: WorkflowGraph = {
        nodes: [agentStep('write', 'Write', 'lead_developer', 'Write the greeting.', 0), gate, agentStep('summary', 'Summary', 'project_manager', 'Summarise what happened.', 600)],
        edges: [
          { id: 'e1', source: 'write', target: 'gate', sourceHandle: null, targetHandle: null },
          { id: 'e2', source: 'gate', target: 'summary', sourceHandle: 'approved', targetHandle: null }
        ]
      }
      gateId = (await saveGraph('Smoke approval gate', g)).id
      await wfOpen(gateId)
      const prev = (await wfLatest(gateId))?.id
      await wfOpenRunDialog('workflow smoke: gate')
      await waitFor('approval dialog', `!!document.querySelector('[data-approval-overlay]')`, 20000)
      const title = await js<string>(`document.querySelector('#approval-title').innerText`)
      const body = await js<string>(`document.querySelector('[role="alertdialog"]').innerText`)
      if (!/workflow step needs your decision/.test(title)) throw new Error(`dialog title: ${title}`)
      if (!body.includes('Ship the greeting?')) throw new Error('the question is not in the dialog')
      if (/Folder|wants to run a command/.test(body)) throw new Error('the dialog still looks like a command approval')
      if (!body.includes('Completed') && !(await js<boolean>(`!!document.querySelector('[data-approval-detail]')`))) throw new Error('what the earlier step produced is not shown')
      await shot('49-workflow-approval-dialog.png')
      await js(`document.querySelector('[data-approval="allow"]').click()`)
      const run = await wfWaitRun(gateId, prev, 'completed')
      const s = await wfState(run.id)
      if (wfNode(s, 'gate')?.handle !== 'approved' || wfNode(s, 'summary')?.status !== 'done') throw new Error(`states: ${JSON.stringify(s.nodes.map((n) => [n.nodeId, n.status, n.handle]))}`)
      return `dialog: “${title}”; approving continued down the approved branch`
    })

    await step('ui_workflow_rejecting_skips_the_approved_branch', async () => {
      const prev = (await wfLatest(gateId))?.id
      await wfOpenRunDialog('workflow smoke: gate again')
      await decide('deny')
      const run = await wfWaitRun(gateId, prev, 'completed')
      const s = await wfState(run.id)
      if (wfNode(s, 'gate')?.handle !== 'rejected' || wfNode(s, 'summary')?.status !== 'skipped') throw new Error(`states: ${JSON.stringify(s.nodes.map((n) => [n.nodeId, n.status, n.handle]))}`)
      await waitFor('skipped shown', `document.querySelector('[data-wf-node="summary"]')?.getAttribute('data-wf-status') === 'skipped'`)
      return 'rejected → the Summary step was skipped and the run still completed'
    })
    await shot('50-workflow-rejected.png')

    await step('ui_workflow_stop_aborts_the_call_and_resume_finishes_the_rest', async () => {
      const g: WorkflowGraph = {
        nodes: [agentStep('slow', 'Slow work', 'lead_developer', 'Do the slow thing.', 0), agentStep('wrap', 'Wrap up', 'project_manager', 'Wrap up.', 300)],
        edges: [{ id: 'e1', source: 'slow', target: 'wrap', sourceHandle: null, targetHandle: null }]
      }
      const id = (await saveGraph('Smoke slow run', g)).id
      await wfOpen(id)
      const prev = (await wfLatest(id))?.id
      await wfOpenRunDialog('workflow smoke: slow')
      await waitFor('running on the canvas', `document.querySelector('[data-wf-node="slow"]')?.getAttribute('data-wf-status') === 'running'`, 15000)
      await shot('51-workflow-running.png')
      await js(`document.querySelector('[data-wf-action="stop"]').click()`)
      const stopped = await wfWaitRun(id, prev, 'paused', 15000).catch(() => wfWaitRun(id, prev, 'cancelled', 5000))
      const s1 = await wfState(stopped.id)
      if (wfNode(s1, 'wrap')?.status === 'done') throw new Error('the next step ran after the stop')
      await waitFor('resume button', `!!document.querySelector('[data-wf-action="resume"]')`)
      await js(`document.querySelector('[data-wf-action="resume"]').click()`)
      let done: Record<string, any> | undefined
      for (let t0 = Date.now(); Date.now() - t0 < 30000 && done?.status !== 'completed'; await wait(200)) done = await wfLatest(id)
      if (done?.status !== 'completed') throw new Error(`resumed run ended as ${done?.status}: ${done?.error}`)
      const s2 = await wfState(done.id)
      if (done.id !== stopped.id || wfNode(s2, 'slow')?.status !== 'done' || wfNode(s2, 'wrap')?.status !== 'done') throw new Error(`after resume: ${JSON.stringify(s2.nodes.map((n) => [n.nodeId, n.status]))}`)
      return `stopped (${stopped.status}) with “Wrap up” untouched; Resume finished the same run`
    })

    await step('wrong_key_reports_error_and_redacts_it', async () => {
      const bad = 'sk-this-is-a-wrong-key-123456'
      const id = (await js<Array<{ id: string }>>(`window.api.invoke('connections:list')`))[0].id
      await js(`window.api.invoke('connections:update', { id: ${JSON.stringify(id)}, apiKey: ${JSON.stringify(bad)} })`)
      const r = await js<{ ok: boolean; error?: string; errorKind?: string; connection: { status: string; lastError: string | null } }>(`window.api.invoke('connections:test', ${JSON.stringify(id)})`)
      if (r.ok || r.errorKind !== 'auth' || r.connection.status !== 'error') throw new Error(`expected auth failure, got ${JSON.stringify(r)}`)
      if (JSON.stringify(r).includes(bad)) throw new Error('wrong key echoed back to the UI')
      await shot('12-connection-error.png')
      await js(`window.api.invoke('connections:update', { id: ${JSON.stringify(id)}, apiKey: ${JSON.stringify(SMOKE_KEY)} })`)
      const again = await js<{ ok: boolean }>(`window.api.invoke('connections:test', ${JSON.stringify(id)})`)
      if (!again.ok) throw new Error('connection did not recover after restoring the key')
      return `auth error surfaced (${r.error}); recovered after restoring the key`
    })

    await step('remove_connection_deletes_key', async () => {
      const id = (await js<Array<{ id: string }>>(`window.api.invoke('connections:list')`))[0].id
      await js(`window.api.invoke('connections:remove', ${JSON.stringify(id)})`)
      const left = Object.keys(JSON.parse(readFileSync(join(app.getPath('userData'), 'secrets.json'), 'utf8')))
      if (left.some((k) => k === `conn:${id}`)) throw new Error('key survived connection removal')
      return 'row and encrypted key removed'
    })
    await step('agent_survives_connection_removal_with_warning', async () => {
      const a = (await agentList()).find((x) => x.name === 'Game Designer' && x.projectId === null)
      if (!a) throw new Error('library agent vanished with its connection')
      if (a.connectionId !== null || !a.issues.some((i: string) => /No model connection/.test(i))) throw new Error(`unexpected state ${JSON.stringify(a)}`)
      return 'agent kept, connection cleared, readiness warning shown'
    })

    await js(`document.querySelector('[data-nav="settings"]')?.click()`)
    await shot('13-settings.png')
    await mock.close()
  } catch (e) {
    results.fatal = e instanceof Error ? e.stack : String(e)
  }

  writeFileSync(join(outDir, 'smoke.json'), JSON.stringify(results, null, 2))
  const failed = Object.values(results).some((v) => typeof v === 'string' && v.startsWith('FAILED')) || 'fatal' in results
  app.exit(failed ? 1 : 0)
}

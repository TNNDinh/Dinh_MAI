# Multi-AI Development Studio — Architecture

Status: **Phases 1–10 complete** (foundation, shell, connections, agents, orchestrator + task board, workspace/editor/terminal/approvals, image generation + asset library, workflow editor and engine, git/checkpoints, build/test automation, live preview, auto recovery). Phase 10 packages it as a Windows installer and a portable exe.

## 1. Stack decisions

| Concern | Choice | Why |
|---|---|---|
| Desktop shell | **Electron 45** | Tauri needs a Rust toolchain (not installed here, and a large extra dependency for contributors). Electron ships Node 24, so the backend, file/process APIs and SDKs are all TypeScript. Installer via `electron-builder` (NSIS). |
| Language | TypeScript everywhere | One language/type system across main process, preload, renderer, and shared IPC types. |
| UI | React + Tailwind + Monaco + React Flow | Monaco = VS Code's editor; React Flow = node-based workflow canvas. (Phase 2/6/8) |
| Database | **SQLite via built-in `node:sqlite`** | Verified working inside Electron 45. Avoids `better-sqlite3`, whose native binary must be rebuilt per Electron ABI and would break either the app or the Node test runner. |
| Secrets | Electron `safeStorage` → **Windows DPAPI** | Keys are encrypted per Windows user in `secrets.json`; the DB only stores a `secret_ref`. If encryption is unavailable we refuse to store, never fall back to plaintext. |
| AI access | Official HTTP APIs via `fetch` (no vendor SDKs) | Three thin adapters cover 8 providers, keep the bundle small, and give us direct control over streaming, retries and error mapping. |
| VCS | System `git` CLI | Checkpoints, branches and rollback. |
| Tests | Vitest + real local HTTP servers replaying vendor wire formats | Adapters are exercised over real sockets and chunked streams. |

## 2. Process model

```
┌────────────── Renderer (React, sandboxed, no Node) ──────────────┐
│ Dashboard · Projects · Agents · Connections · Workflow · Assets  │
└───────────────▲──────────────────────────────┬───────────────────┘
        typed IPC events (stream)        typed IPC invoke
┌───────────────┴──────────────────────────────▼───────────────────┐
│ Preload: contextBridge exposes a small, typed API (no ipcRenderer)│
└───────────────▲──────────────────────────────┬───────────────────┘
┌───────────────┴──────────────────────────────▼───────────────────┐
│ Main process                                                      │
│  ┌ Orchestrator ┐  ┌ Agent runtime ┐  ┌ Provider layer ┐         │
│  │ runs, tasks, │─▶│ tool loop,    │─▶│ Anthropic /    │─▶ APIs  │
│  │ budget, stop │  │ permissions   │  │ OpenAI-compat /│         │
│  └──────┬───────┘  └───────┬───────┘  │ Gemini         │         │
│         │                  │          └────────────────┘         │
│  ┌──────▼──────────────────▼─────────────────────────────┐       │
│  │ Shared Workspace: files · index · locks · memory ·    │       │
│  │ assets · git · command runner (policy-gated)          │       │
│  └──────────────────────────┬────────────────────────────┘       │
│                       SQLite (node:sqlite)                        │
└───────────────────────────────────────────────────────────────────┘
```

The renderer is untrusted by design: it holds no API keys and cannot touch the filesystem. Everything privileged happens in main behind typed IPC.

## 3. Core pattern: Central Orchestrator + Specialized Agents + Shared Workspace

Agents never call each other directly. One **Orchestrator** owns scheduling, permissions, budget, file access, and state; specialist agents are stateless workers that receive a task plus retrieved context and return results.

- **Orchestrator** — executes a workflow graph (or autonomous plan). Topologically schedules ready tasks, runs independent ones in parallel, enforces `max_iterations` and `budget_usd` before every model call, persists state after every step (`runs.state_json`, `run_node_states`) so interrupted runs resume, and exposes one global **STOP** that aborts every in-flight request (`AbortSignal`) and child process.
- **Agent runtime** — a tool-use loop: build prompt (system prompt + task + retrieved context) → stream model → execute requested tool calls through the permission gate → feed results back → stop on completion, iteration cap, or budget. Tools: `read_file`, `write_file`, `edit_file`, `list_files`, `search_code`, `run_command`, `generate_image`, `create_task`, `update_task`, `write_memory`, `read_memory`, `request_review`.
- **Shared workspace** — the only way agents exchange information: files, memory entries, task board, asset library. Conversation history is *not* broadcast; agents pull what they need.

### Concurrency safety
1. Each write-capable agent works on its **own git branch/worktree**; the orchestrator merges, and conflicts are routed to the Lead Developer as a task.
2. Inside a branch, `file_locks` gives pessimistic per-file leases (`PRIMARY KEY (project_id, path)` makes double-locking impossible at the DB level; leases expire so a crash cannot deadlock).

### Context management (no repeated dumping of the whole repo)
`file_index` stores hash, language, symbols, imports and a short summary per file. Context for a task = task text + the design doc + files named in the task + their direct dependencies (import graph) + top memory entries, packed to a token budget. Unchanged files are re-summarised only when their hash changes.

## 4. Provider layer (implemented — `src/main/providers`)

```
ChatProvider (interface)            catalog.ts  ← UI + registry read this
 └ BaseChatProvider                 registry.ts ← createChatProvider(config)
    ├ AnthropicProvider      /v1/messages          (Claude)
    ├ OpenAICompatibleProvider /chat/completions   (OpenAI, OpenRouter, DeepSeek, Groq, Ollama, custom)
    └ GeminiProvider         :streamGenerateContent (Gemini)
http.ts  fetchWithRetry: per-attempt timeout, cancellation, backoff, Retry-After
sse.ts   incremental SSE parser with idle-timeout and cancellation
```

- One neutral message model (`ChatMessage`, `ToolCall`, `ToolResultPart`, `TokenUsage`); adapters translate to/from each wire format, including tool calls and images.
- Streaming is the single implementation; `chat()` drains the stream.
- Errors are normalised to `ProviderError{kind, status, retryable, retryAfterMs}` (`auth`, `rate_limit`, `timeout`, `network`, `server`, `bad_request`, `cancelled`, …). 429/5xx/network are retried with exponential backoff; auth/4xx are not.
- Provider quirks handled: OpenAI `max_completion_tokens` vs `max_tokens`; Groq's `x_groq.usage`; Gemini's name-keyed function responses, schema subset and `thoughtSignature` echo; Anthropic's cumulative `output_tokens`; Ollama's native `/api/tags`; OpenRouter's published pricing.
- **Adding a provider**: if it speaks an existing protocol, add one `PROVIDER_CATALOG` entry. If it is a new protocol, add one adapter class and one `switch` case.
- **Cost**: never guessed. Price comes from the provider (OpenRouter) or the user-editable `model_pricing` table; otherwise cost is `NULL` ("unknown") in the UI. Local models are `$0`.
- **Image generation** is a separate interface (`ImageProvider`, `providers/images.ts`) so it never shares code paths with text chat. Implemented for the OpenAI family (gpt-image with native transparency, dall-e-3, dall-e-2, any OpenAI-compatible server via `/images/generations` and `/images/edits`) and Gemini (Imagen `predict`, native image models via `generateContent`). Anthropic, OpenRouter, DeepSeek, Groq and Ollama have no image API here and are refused with a clear message (`imageGeneration` flag in the catalog). Image calls are written to `llm_calls` (`kind = 'image'`), so they count towards usage and run budgets.

## 5. Security model

- Agents are confined to the project root: every path is resolved and rejected if it escapes the workspace (symlinks and `..` included).
- `run_command` goes through a policy: an allowlist of known-safe commands (build/test/lint/git status) can auto-run when the agent's permission is `allowlist`; everything else shows a **command preview** and needs user approval; destructive patterns (`rm -rf`, `del /s`, `format`, `git push --force`, network downloads piped to a shell, …) are blocked outright. Commands run without a shell where possible, with a timeout and output cap. Every decision is written to `command_log`.
- Per-agent `permissions_json` (read / write / commands / images / tasks / git commit) is enforced by the tool layer, not by the prompt.
- Renderer is sandboxed, `contextIsolation` on, `nodeIntegration` off, strict CSP, no remote content.
- Budget/iteration limits are checked in the orchestrator before each call. The STOP button aborts everything.

## 6. Data model (`src/main/db/migrations.ts`)

`settings` · `provider_connections` · `connection_models` · `model_pricing` · `model_profiles` · `projects` · `agents` · `workflows` · `runs` · `run_node_states` · `tasks` · `task_dependencies` · `agent_messages` · `llm_calls` · `events` · `file_index` · `file_locks` · `memory_entries` · `assets` · `command_log` · `checkpoints`

Migrations are append-only and versioned via `PRAGMA user_version`; foreign keys are enforced.

## 7. Folder structure

```
src/
  shared/            IPC contracts & types shared by main and renderer
  main/
    providers/       ✔ Phase 1  adapters, retry, SSE, catalog, usage
    db/              ✔ Phase 1  node:sqlite wrapper + migrations
    secrets/         ✔ Phase 1  DPAPI-backed secret store
    agents/          ✔ Phase 1 templates · (CRUD lives in services/agents.ts) · Phase 5 runtime
    orchestrator/    ✔ Phase 5  planning (submit_plan), scheduler, tool loop, rework, budget, stop, recovery
    assets/          ✔ Phase 7  PNG codec + resize/trim/background removal (no native deps), naming and engine folder conventions, asset service
    workspace/       ✔ Phase 6  fs sandbox, file locks, context index, command runner · ✔ Phase 9 undo journal (memory is in services)
    git/             ✔ Phase 9  git runner (no hooks, no remotes), repo status/diff/commit/branches/log, checkpoints (refs/mads/checkpoints), Auto Recovery
    automation/      ✔ Phase 9  build/test/lint/type-check detection from the project's own files, run service, output parsers (problems, test counts)
    preview/         ✔ Phase 9  loopback static server with live reload, dev-server launcher
    security/        ✔ Phase 2 path guard · ✔ Phase 6 command policy + approvals
    services/        ✔ Phase 2  projects, dashboard, events · ✔ Phase 3 connections, chat (streaming + usage) · ✔ Phase 4 agents · ✔ Phase 5 tasks
    ipc/             ✔ Phase 4  typed handlers + envelope + sender check
  preload/           ✔ Phase 3  contextBridge (invoke + onActivity + onChatEvent only)
  renderer/          ✔ Phase 9  shell, dashboard, projects, workspace (Monaco), terminal, Build/Problems/Test tabs, source control, live preview, approvals, connections, agents, tasks, asset library, workflow editor, settings
tests/               Vitest
docs/
```

## 8. The five additional features

| Feature | Design | Phase |
|---|---|---|
| **1. AI auto-assigns work** | The Project Manager agent receives a catalog of enabled models (`model_profiles`: strengths + cost tier) and each template's `wants`, and returns an assignment as structured output. The orchestrator validates it (model exists, supports the needed kind, within budget) and the user can override. | 5 |
| **2. Live preview** | Live Preview page: a built-in static server for a folder with an `index.html` (loopback only, reloads the page when files change), or the project's own `dev`/`start` script, whose printed local URL is shown in a sandboxed frame. **Implemented (web projects only).** | 9 |
| **3. Asset pipeline** | Image result → auto-name and classify (`assets` row) → convert/resize/trim (transparent PNG) → write to the engine's conventional folder (e.g. `Assets/Sprites`, `res://sprites`) → register in the asset library → expose its path to the Developer agent. | 7 |
| **4. Debate & critique** | A workflow node type `debate`: N agents answer the same prompt, then critique each other for a bounded number of rounds; the Project Manager synthesises and records the decision in memory. | 5, 8 |
| **5. Auto recovery** | Opt-in per project. Before each agent task an automatic checkpoint is saved (a git commit under `refs/mads/checkpoints`, without touching the branch or index) and an in-memory journal records each file's original content as the agent's write/delete tools touch it. When the task **fails**, the journal puts the files back before the retry, and the retry prompt tells the agent what failed. Stopping a run or a budget pause never rolls back. **Implemented**; it does not yet judge a task that finished without error (e.g. a regressed build), and shell-command side effects are not undone. | 9 |

## 9. Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Architecture, schema, provider abstraction, secret store, agent templates | **Done** |
| 2 | Electron shell, typed IPC, React UI layout, project management, dashboard | **Done** |
| 3 | Connections UI, key storage, model discovery, connection status, usage/cost | **Done** |
| 4 | Agent manager (CRUD, duplicate, enable/disable, templates) | **Done** |
| 5 | Orchestrator, task board, tool loop, parallel execution, budget/stop | **Done** |
| 6 | Workspace fs sandbox, Monaco editor, terminal, command policy, agent file tools, approvals | **Done** |
| 7 | Image providers + asset pipeline | **Done** |
| 8 | Visual workflow editor (React Flow), workflow engine, debate node, human-approval node | **Done** |
| 9 | Git integration, test/build automation, recovery, live preview | **Done** |
| 10 | electron-builder NSIS installer + portable exe | **Done** |

## 10. Packaging (Phase 10)

`npm run package` runs `electron-vite build` and then electron-builder (`electron-builder.yml`), producing in `release/`:

| File | What it is |
|---|---|
| `MultiAI-Studio-<version>-setup.exe` | NSIS installer (per user, choose the folder, desktop + Start-menu shortcuts, uninstaller; user data is kept on uninstall) |
| `MultiAI-Studio-<version>-portable.exe` | single-file portable exe (unpacks to a temp folder on start; data stays in `%APPDATA%`) |
| `release/win-unpacked/` | the unpacked app (`npm run package:dir` builds only this, faster) |

- The main process imports only `electron` and Node built-ins (`node:sqlite` is part of Node), and the renderer is bundled by Vite, so **no `node_modules` ships**: every library is a devDependency and `app.asar` is about 9 MB. Electron itself (~250 MB unpacked) is the bulk of the installer.
- The icon (`build/icon.ico`, `build/icon.png`) is generated by `npm run icon` (`scripts/make-icon.mjs`, no dependencies), so it can be re-drawn from code.
- **Verified on the built artifacts:** the self test (`scripts/smoke.mjs`, 80+ checks driving the real UI) passes against `win-unpacked`, the portable exe, and the exe installed by a silent run of the installer (then uninstalled cleanly): `SMOKE_EXE=<path to exe> node scripts/smoke.mjs`. That covers the SQLite store, DPAPI key encryption, Monaco, the workflow canvas, git, preview and image processing from inside the asar. In self-test mode the app disables Chromium's window-occlusion tracking, otherwise a covered window stops painting and Monaco/the canvas never render.
- **Not done / limits:** the binaries are **not code-signed** (no certificate), so Windows SmartScreen will warn on first run. There is no auto-update (no update server is configured). Only Windows x64 is built. Git must be installed separately (the app does not bundle it; the Source Control page says so when it is missing).


## 11. Known limitations (after Phase 10)

**Phase 9 (git, checkpoints, automation, preview, auto recovery):**
- **Git is local only.** The app never pushes, pulls, fetches or clones; there are no remote operations or credentials. Git runs with hooks disabled, a cleaned environment and no pager. It needs `git` installed (the UI says so when it is missing). Agents have no git tools yet; they cannot read or write inside `.git`. A folder inside another repository is not treated as a repository of its own.
- Staging is by file (no hunk staging), there is no merge/rebase/conflict UI, and branch switching is refused when it would overwrite local changes. Credential files (`.env`, keys) are shown as "never committed" and are excluded from commits and checkpoints.
- **Checkpoints** snapshot every project file except credential files into a commit under `refs/mads/checkpoints/<id>` using a temporary index, so the branch, staging area and history are untouched. Restoring puts the files back (deleting files created since) and first saves a "safety" checkpoint; it is refused while a run is running. Automatic checkpoints are pruned to the newest 25 per project, safety checkpoints to 10. Files ignored by git (e.g. `node_modules`) are not in a checkpoint. A checkpoint is not a backup: it lives in the project's own `.git`.
- **Build/test automation** runs only commands found in the project's own files (package.json scripts, Cargo.toml, go.mod, .NET projects, Python tests); if none exists the button is absent. Commands go through the same sandbox and hard blocks as the terminal. Problem and test-count parsers recognise tsc, MSBuild/dotnet, rustc, gcc/clang/javac/mypy/eslint (unix format), Go, node:test, vitest/jest, pytest, cargo test and `go test` output; anything else is shown as raw output only. Counts come from parsing text, not from a test-runner API.
- **Live preview** serves static folders on 127.0.0.1 only (GET/HEAD, Host-header check against DNS rebinding, dotfiles and credential files denied, symlink escapes refused) and runs a project's own `dev`/`start` script (never a command typed into the preview). The frame is sandboxed and cannot reach the app's API. The preview is for web projects: Unity/Godot/other engines are not launched. The dev-server URL is taken from what the server prints, so a server that prints none cannot be shown.
- **Auto Recovery** is off by default and per project. The journal keeps up to 2 MB per file and 20 MB per task in memory; larger files are listed as "not rolled back". A file changed by someone else after the task's last write is left alone. Only the agent write/edit/delete tools are journaled: files changed by `run_command` (npm install, a build, a code generator) are not undone. Only failed tasks (errors, retries exhausted) trigger it; a stop or budget pause does not. Rolled-back state is reported in the activity log.

**Phase 8 (workflow editor and engine):**
- Eight step types: agent, image, review, test, condition, loop, human approval, debate. A step runs when every incoming connection is decided and at least one is active; steps on a branch that was not taken are marked skipped. Multi-output steps take exactly one output (review: approved/changes, test: pass/fail, condition: true/false, loop: body/done, approval: approved/rejected).
- Loops repeat their body until nothing is sent back, the "until" phrase appears, or the iteration cap is hit. Only connections into a loop's "again" input may point backwards; any other cycle is a problem and the workflow will not run.
- A **debate** costs `participants × (1 + rounds) + 1` model calls (the editor shows the estimate). Debate participants and the synthesiser use the same agents, connections and budget as any other step; nothing is simulated.
- Review, condition and test results come from the reviewer's `submit_verdict` / `submit_decision` tool call or the command's exit code. A model that never calls the tool makes the step fail (it is not guessed from prose).
- Each agent step becomes a task on the board (titled with the step name) and runs through the normal orchestrator, so budgets, stop, file locks and command approvals all apply. Spend is attributed to the run.
- Workflows can be per project or shared. Agents are chosen by id or by **role**; roles are resolved against the project's team **when the run starts**, so a shared workflow runs with whichever team the chosen project has. The Problems tab lists missing roles and agents that are not ready.
- Editing a workflow while a run of it is in progress does not change that run (the graph is copied at start). Resume continues the saved copy.
- Stop aborts the call in flight; steps after it stay "pending" and Resume continues the same run, keeping finished steps. A run paused by the budget resumes the same way.
- Human-approval steps use the same approval dialog as commands. They expire after 12 hours (counted as rejected) if unanswered, and pending approvals are lost when the app closes.
- **Editing aids:** undo/redo (Ctrl+Z, Ctrl+Y or Ctrl+Shift+Z; 100 steps, edits within 350 ms such as a drag are one step), copy/paste/duplicate of selected steps with the connections between them (Ctrl+C, Ctrl+V, Ctrl+D; fresh ids, pasted next to the original; the clipboard lives in memory for the session only) and **Tidy** (left-to-right layered layout). Tidy ignores a loop's "again" connections and any connection that would close a cycle, so loops lay out as a line. History is cleared when another workflow is opened. Deleting a step removes its connections (undo brings them back).
- Verified in the real app against a loopback OpenAI-wire server standing in for a provider (protocol checks only); no live-API runs of workflows were made.

**Phase 7 (image generation, asset library):**
- Image generation works only with OpenAI, Google Gemini and OpenAI-compatible servers. Anthropic, OpenRouter, DeepSeek, Groq and Ollama have no image API in this app. Verified against loopback servers speaking the vendors' wire formats, **not against live APIs**.
- **Prices are never guessed.** You enter the price per picture for each model (Generate dialog). Without one, the cost of that call is recorded as unknown, shown as such, and cannot count against a budget (the run notes this once). Provider model lists do not say which models draw pictures reliably, so models you type by hand are allowed (and remembered once they have a price, an agent or a picture).
- Requested sizes are hints: every model picks the nearest size it supports, and the real size is shown after the picture arrives. Exact sizes come from the Resize tool.
- Transparency: gpt-image models make it natively. For all others the app asks for a plain background and then removes it, which works for flat, uniform backgrounds only (gradients, shadows, backgrounds the same colour as the subject will not come out clean). A note is attached to the result.
- Editing tools (resize, trim, background removal) are our own code: results are always **PNG**. Pixel work runs synchronously on the main process, so a very large picture (up to the 50-megapixel limit) can freeze the window for a moment. Provider JPEG/WebP is decoded by Electron's image decoder and saved with its own format when it is not edited.
- Variations/edits need a provider with an edit API (gpt-image, dall-e-2, OpenAI-compatible servers); other models refuse them with a message.
- The Image Generator agent turns one task into one picture and uses the task text word for word as the prompt; other agents ask for pictures with the `generate_image` tool, which needs a ready Image Generator agent on the team (its connection and model are used). Image cost of an agent's run is counted against the run budget.
- A model can be told to cut a picture out, but nothing checks the art style or content. Generated pictures are not scanned or moderated by the app; the provider's own filters apply and their refusals are shown as errors.
- The asset library lists what the app generated or derived, plus pictures you add with **Import existing** (Assets page): it scans the project folder for PNG/JPEG/WebP/GIF files the library does not list and adds the ones you pick. Importing never copies, moves or changes a file; the real format and size are read from the file content (a renamed text file is refused), credential files are never imported, and a scan lists at most 500 pictures (files over 25 MB are skipped). The kind is guessed from the path unless you choose one.


**Phase 6 (workspace, editor, terminal, approvals):**
- **The command policy is a guard rail, not an OS sandbox.** Approved and auto-allowed commands run with your Windows user's permissions. Hard blocks (disk tools, recursive deletes of system folders, `shutdown`, registry edits, …) apply to everyone; approval applies to agents only (a command you type yourself is never questioned, but the hard blocks still apply). The check reads the command text, so it cannot see what a script does.
- The allow-list runs `npm test`, `npm run build`, `node <script>.js`, `tsc`, `vitest` etc. **without asking**. Those execute code in the project, which an agent may have just written. Set an agent's command permission to "ask" to be asked every time.
- Agents cannot read or write secret files (`.env`, key files) or anything inside `.git` (git itself is operated from the Source Control page, Phase 9).
- The file sandbox resolves real paths (so symlinks/junctions out of the project are refused) but there is a small time-of-check/time-of-use window between the check and the write.
- File locks are per agent+task, taken on first write and released when the task ends, with a 10-minute lease. The Workspace page shows locked files and has a manual "Release lock". Your own saves use a content-hash check and are refused (with a conflict message) if an agent changed the file meanwhile.
- **External changes are watched** (since Phase 10 catch-up): the project on screen is watched with the operating system's recursive folder watch, so the file tree, open editors, Assets and Source Control refresh when another program edits the folder (a clean open file reloads; one with unsaved edits is marked as conflicting). Only one project is watched at a time, `.git`, `node_modules` and the other hidden folders are skipped, bursts are debounced and capped (200 paths), and the app's own writes are not echoed back. If the platform cannot watch the folder, the Refresh button still works. A rename done by another program is seen as a removal plus a new file.
- The context index (`find_context` for agents) is built from the code itself (names, exports, headings, first comment). It is not LLM-written and not semantic search; rebuild it with the Index button.
- The terminal is a **command runner, not an interactive shell** (no node-pty): stdin is closed, programs that wait for input or draw full screens will not work, output is clipped. This is labelled in the UI.
- Search accepts a user-supplied regular expression without a ReDoS guard (it only hurts your own session). Search skips `node_modules`, `dist` and binary files.
- Monaco is bundled with the core editor and basic (Monarch) syntax highlighting only. There is no TypeScript/JSON language service (no IntelliSense or squiggles). The Workspace chunk is large (~6 MB) and loads only when the page is opened.
- Pending approvals expire after 15 minutes (counted as denied) and are lost when the app closes (nothing runs without an answer).

**Phase 5 (orchestrator):**
- (Resolved in Phase 6: agents now also have file tools and `run_command`, subject to their permissions.)
- The run budget is checked before each model call and before launching a task, so a call already in flight can finish slightly over budget. Models without a price cannot be counted against a budget (the run warns once). A budget stop pauses the run; Resume asks for a higher budget.
- A call cannot be paused midway: Stop aborts it (recorded as cancelled, 0 tokens, no cost) and unfinished tasks return to to-do.
- A run only picks up tasks that have an owner (role or agent). Unassigned manual tasks stay on the board.
- (Resolved in Phase 7: Image Generator agents run; they need a connection to an image-capable provider and an image model.)
- The right-panel **Chat** tab is a read-only team feed (newest first, 40 messages, all projects): what agents replied and the change requests they sent each other, clipped to 600 characters, each linking to its task. It is built from the per-task agent log, so it shows no prompts or tool output and you cannot type into it: there is no live agent-to-agent chat room, and the user steers agents through tasks, not chat.
- There is no app-wide default budget or review-round setting; they are set per project and per run.
- The smoke test drives the planner and agents against a loopback OpenAI-wire server, so it proves the protocol and accounting, not model quality.

**Earlier phases:**

- Agent permissions and the per-run cost limit are now enforced for the memory/task tools (Phase 5); file and command permissions take effect since Phase 6; network permission is stored but no network tool exists yet.
- Agent usage is attributed (`llm_calls.agent_id`, activity events) and the right panel's Usage tab lists spend per agent (for the project on screen or all projects). Deleting an agent keeps its usage rows with the agent link cleared; they then show under "no agent". Deleting a connection clears the agent's connection and shows a warning rather than deleting the agent.
- Agent role can be changed after creation to another template of the same kind or to custom; the prompt and permissions are not changed with it (the orchestrator hands tasks out by role). "Add the full team" skips roles that already exist in that scope, matched by role.
- (Resolved in Phase 8/9: the workflow editor exists and the bottom-panel tabs are all built.) The global STOP ALL button is enabled only while a run is active; it also stops a running live preview.
- Provider adapters are verified against vendor wire formats using local servers, **not against live APIs** (no keys available in this environment). The end-to-end smoke test drives the real Electron UI against a loopback OpenAI-wire server; the Anthropic and Gemini adapters are covered by mock-server unit tests only. First live run with real keys may surface provider-specific behaviour; the error normalisation and connection test are designed to make that visible.
- Pricing is intentionally empty until entered by the user or published by the provider (only OpenRouter publishes prices through its API; they are stored as source `provider` and never overwrite prices you entered).
- Cancelled and failed chat calls record 0 tokens and no cost, because the tokens consumed before a cancel are unknown. They are counted as `failedCalls`, not as unpriced.
- Playground history is persisted in the window's local storage (last 40 turns per connection or agent, long texts trimmed). It is per machine and not encrypted; entries of a deleted connection or agent stay until the storage is cleared.
- The Settings page shows the command policy (read-only); per-run budget/iteration limits are set when starting a run (Phase 5).
- API keys: DPAPI via Electron's async `safeStorage`; if encryption is unavailable keys are refused, never stored in plain text. Removing a connection deletes its key but keeps its usage history ("(deleted connection)").
- Deleting a project cascades to its tasks, runs and `llm_calls`, so lifetime spend figures drop. Projects can be **archived** instead (project page; archived projects are collapsed on the Projects list and keep all their data) and restored at any time.
- The native Windows min/max/close overlay is not captured by `capturePage`, so it is not covered by the screenshots; check it by eye with `npm run dev`.
- Panel resize + persisted layout is implemented (react-resizable-panels, localStorage) but not exercised by the automated smoke test.
- `npm run dev` / `smoke` strip `ELECTRON_RUN_AS_NODE`, which VS Code's terminal sets and which otherwise makes Electron boot as plain Node.

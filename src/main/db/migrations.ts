/**
 * Ordered, append-only migrations. Never edit a shipped migration; add a new one.
 * The applied version is tracked with `PRAGMA user_version`.
 *
 * Conventions: ids are TEXT (uuid), timestamps are INTEGER unix-ms, JSON blobs
 * are TEXT columns suffixed `_json`.
 */
export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: /* sql */ `
    -- ============================================================ settings
    CREATE TABLE settings (
      key        TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- ============================================================ providers
    -- API keys are NOT stored here. secret_ref is a key into the OS-encrypted
    -- secret store (Windows DPAPI via Electron safeStorage).
    CREATE TABLE provider_connections (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      name            TEXT NOT NULL,
      base_url        TEXT NOT NULL,
      secret_ref      TEXT,
      headers_json    TEXT NOT NULL DEFAULT '{}',
      enabled         INTEGER NOT NULL DEFAULT 1,
      status          TEXT NOT NULL DEFAULT 'unknown',   -- unknown | ok | error
      last_error      TEXT,
      last_checked_at INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    -- Cached /models results so the UI can offer a model picker offline.
    CREATE TABLE connection_models (
      connection_id  TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
      model          TEXT NOT NULL,
      display_name   TEXT,
      kind           TEXT NOT NULL DEFAULT 'chat',        -- chat | image | embedding | other
      context_window INTEGER,
      fetched_at     INTEGER NOT NULL,
      PRIMARY KEY (connection_id, model)
    );

    -- User-editable prices (USD per 1M tokens). Unknown model => cost unknown, never guessed.
    CREATE TABLE model_pricing (
      connection_id   TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
      model           TEXT NOT NULL,
      input_per_mtok  REAL NOT NULL,
      output_per_mtok REAL NOT NULL,
      source          TEXT NOT NULL DEFAULT 'user',        -- user | provider
      PRIMARY KEY (connection_id, model)
    );

    -- Strengths used by the "AI auto-assigns work" feature (project manager picks models).
    CREATE TABLE model_profiles (
      connection_id     TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
      model             TEXT NOT NULL,
      strengths_json    TEXT NOT NULL DEFAULT '[]',        -- e.g. ["coding","design","review","vision"]
      cost_tier         TEXT NOT NULL DEFAULT 'standard',  -- cheap | standard | premium
      PRIMARY KEY (connection_id, model)
    );

    -- ============================================================ projects
    CREATE TABLE projects (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      type             TEXT NOT NULL,                      -- unity|unreal|godot|web|react|nextjs|python|csharp|cpp|other
      root_path        TEXT NOT NULL UNIQUE,
      goal             TEXT NOT NULL DEFAULT '',
      status           TEXT NOT NULL DEFAULT 'active',     -- active | completed | archived
      progress         REAL NOT NULL DEFAULT 0,            -- 0..1
      budget_usd       REAL,                               -- NULL = unlimited
      max_iterations   INTEGER NOT NULL DEFAULT 5,
      settings_json    TEXT NOT NULL DEFAULT '{}',
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    -- ============================================================ agents
    -- project_id NULL = global agent library entry; otherwise scoped to a project.
    CREATE TABLE agents (
      id               TEXT PRIMARY KEY,
      project_id       TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      role             TEXT NOT NULL,                      -- template key, e.g. lead_developer
      kind             TEXT NOT NULL DEFAULT 'chat',       -- chat | image
      connection_id    TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
      model            TEXT,
      system_prompt    TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      temperature      REAL,
      max_tokens       INTEGER,
      enabled          INTEGER NOT NULL DEFAULT 1,
      status           TEXT NOT NULL DEFAULT 'idle',       -- idle | working | waiting | error | disabled
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE INDEX idx_agents_project ON agents(project_id);

    -- ============================================================ runs & tasks
    -- A run is one execution of a workflow (or an autonomous-mode session) on a project.
    CREATE TABLE workflows (
      id          TEXT PRIMARY KEY,
      project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = reusable template
      name        TEXT NOT NULL,
      graph_json  TEXT NOT NULL,                                   -- nodes + edges (see Phase 8)
      version     INTEGER NOT NULL DEFAULT 1,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE runs (
      id               TEXT PRIMARY KEY,
      project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      workflow_id      TEXT REFERENCES workflows(id) ON DELETE SET NULL,
      goal             TEXT NOT NULL,
      mode             TEXT NOT NULL DEFAULT 'workflow',   -- workflow | autonomous
      status           TEXT NOT NULL DEFAULT 'pending',    -- pending|running|paused|completed|failed|cancelled
      iteration        INTEGER NOT NULL DEFAULT 0,
      max_iterations   INTEGER NOT NULL DEFAULT 5,
      budget_usd       REAL,
      spent_usd        REAL NOT NULL DEFAULT 0,
      state_json       TEXT NOT NULL DEFAULT '{}',         -- engine checkpoint for pause/resume/recovery
      error            TEXT,
      started_at       INTEGER,
      finished_at      INTEGER,
      created_at       INTEGER NOT NULL
    );
    CREATE INDEX idx_runs_project ON runs(project_id, created_at DESC);

    CREATE TABLE run_node_states (
      run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      node_id      TEXT NOT NULL,
      status       TEXT NOT NULL,                          -- pending|running|done|failed|skipped
      output_json  TEXT,                                   -- intermediate result, inspectable in the UI
      error        TEXT,
      started_at   INTEGER,
      finished_at  INTEGER,
      PRIMARY KEY (run_id, node_id)
    );

    CREATE TABLE tasks (
      id                TEXT PRIMARY KEY,
      project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id            TEXT REFERENCES runs(id) ON DELETE SET NULL,
      parent_task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      title             TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      status            TEXT NOT NULL DEFAULT 'todo',      -- todo|in_progress|review|testing|done|failed|blocked
      priority          INTEGER NOT NULL DEFAULT 2,        -- 1 high .. 3 low
      iteration         INTEGER NOT NULL DEFAULT 0,
      result_summary    TEXT,
      error             TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);

    CREATE TABLE task_dependencies (
      task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on_task_id)
    );

    -- ============================================================ conversations & telemetry
    CREATE TABLE agent_messages (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id      TEXT REFERENCES runs(id) ON DELETE CASCADE,
      task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
      role        TEXT NOT NULL,                           -- system | user | assistant | tool
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_messages_run ON agent_messages(run_id, created_at);

    -- One row per LLM/image API call: powers token usage, cost and latency dashboards.
    CREATE TABLE llm_calls (
      id             TEXT PRIMARY KEY,
      project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
      run_id         TEXT REFERENCES runs(id) ON DELETE CASCADE,
      task_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      agent_id       TEXT REFERENCES agents(id) ON DELETE SET NULL,
      connection_id  TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
      model          TEXT NOT NULL,
      kind           TEXT NOT NULL DEFAULT 'chat',         -- chat | image
      input_tokens   INTEGER NOT NULL DEFAULT 0,
      output_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd       REAL,                                 -- NULL = unknown price
      latency_ms     INTEGER,
      status         TEXT NOT NULL,                        -- ok | error | cancelled
      error          TEXT,
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX idx_llm_calls_project ON llm_calls(project_id, created_at);
    CREATE INDEX idx_llm_calls_agent ON llm_calls(agent_id, created_at);

    -- Activity feed + application log in one table.
    CREATE TABLE events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
      run_id      TEXT REFERENCES runs(id) ON DELETE CASCADE,
      agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
      level       TEXT NOT NULL DEFAULT 'info',            -- debug | info | warn | error
      type        TEXT NOT NULL,                           -- e.g. agent.started, file.written, task.failed
      message     TEXT NOT NULL,
      data_json   TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_events_project ON events(project_id, id DESC);

    -- ============================================================ shared workspace
    -- File index + summaries let agents retrieve *relevant* context instead of the whole repo.
    CREATE TABLE file_index (
      project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path          TEXT NOT NULL,                         -- relative, forward slashes
      content_hash  TEXT NOT NULL,
      size          INTEGER NOT NULL,
      language      TEXT,
      summary       TEXT,                                  -- short LLM- or heuristic-generated summary
      symbols_json  TEXT NOT NULL DEFAULT '[]',            -- exported classes/functions
      imports_json  TEXT NOT NULL DEFAULT '[]',            -- dependency edges for impact analysis
      indexed_at    INTEGER NOT NULL,
      PRIMARY KEY (project_id, path)
    );

    -- Pessimistic write locks so two agents never edit the same file at once.
    CREATE TABLE file_locks (
      project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      path         TEXT NOT NULL,
      agent_id     TEXT NOT NULL,
      task_id      TEXT,
      acquired_at  INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,                       -- leases expire so a crash cannot deadlock
      PRIMARY KEY (project_id, path)
    );

    -- Shared project memory: decisions, design docs, conventions, summaries.
    CREATE TABLE memory_entries (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,                           -- decision | design_doc | convention | summary | note
      title       TEXT NOT NULL,
      content     TEXT NOT NULL,
      author      TEXT,                                    -- agent id or 'user'
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_memory_project ON memory_entries(project_id, kind);

    CREATE TABLE assets (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      task_id        TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      kind           TEXT NOT NULL,                        -- sprite | texture | background | ui | icon | concept | other
      name           TEXT NOT NULL,
      rel_path       TEXT NOT NULL,                        -- inside the project's asset folder
      prompt         TEXT,
      connection_id  TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
      model          TEXT,
      width          INTEGER,
      height         INTEGER,
      transparent    INTEGER NOT NULL DEFAULT 0,
      parent_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,  -- variation / regeneration lineage
      metadata_json  TEXT NOT NULL DEFAULT '{}',
      created_at     INTEGER NOT NULL
    );
    CREATE INDEX idx_assets_project ON assets(project_id, kind);

    -- ============================================================ safety & recovery
    -- Every command an agent asked to run, and what the policy / user decided.
    CREATE TABLE command_log (
      id          TEXT PRIMARY KEY,
      project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
      run_id      TEXT REFERENCES runs(id) ON DELETE SET NULL,
      agent_id    TEXT REFERENCES agents(id) ON DELETE SET NULL,
      command     TEXT NOT NULL,
      cwd         TEXT NOT NULL,
      decision    TEXT NOT NULL,                           -- auto_allowed | user_approved | user_denied | blocked
      reason      TEXT,
      exit_code   INTEGER,
      duration_ms INTEGER,
      created_at  INTEGER NOT NULL
    );

    -- Git checkpoints taken before risky steps: "Auto Recovery" rolls back to these.
    CREATE TABLE checkpoints (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id      TEXT REFERENCES runs(id) ON DELETE CASCADE,
      task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      git_ref     TEXT NOT NULL,                           -- commit sha
      branch      TEXT,
      label       TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );
    `
  },
  {
    version: 2,
    name: 'agent_cost_limit',
    sql: /* sql */ `
    -- Per-run spend cap for an agent (USD). NULL = no cap. Enforced by the orchestrator (Phase 5).
    ALTER TABLE agents ADD COLUMN max_cost_usd REAL;
    `
  },
  {
    version: 3,
    name: 'orchestrator',
    sql: /* sql */ `
    -- The role the planner asked for; the agent is resolved from it when the task is scheduled.
    ALTER TABLE tasks ADD COLUMN role TEXT;
    ALTER TABLE tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE runs ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 3;
    CREATE INDEX idx_llm_calls_run ON llm_calls(run_id, agent_id);
    CREATE INDEX idx_llm_calls_task ON llm_calls(task_id);
    `
  },
  {
    version: 4,
    name: 'workspace',
    sql: /* sql */ `
    -- Who ran the command (a person typing in the terminal or an agent) and the tail of what it printed.
    ALTER TABLE command_log ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent';
    ALTER TABLE command_log ADD COLUMN output_tail TEXT;
    CREATE INDEX idx_command_log_project ON command_log(project_id, created_at);
    -- Lets the index skip files that did not change without reading them.
    ALTER TABLE file_index ADD COLUMN mtime_ms INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    version: 5,
    name: 'image_assets',
    sql: /* sql */ `
    -- Image models are billed per picture, not per token. The user enters the price; an unpriced model has unknown cost.
    CREATE TABLE image_pricing (
      connection_id  TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
      model          TEXT NOT NULL,
      per_image_usd  REAL NOT NULL,
      PRIMARY KEY (connection_id, model)
    );
    -- How an asset was made (generated, or derived by an editing step) and what size/format the file on disk is.
    ALTER TABLE assets ADD COLUMN origin TEXT NOT NULL DEFAULT 'generated';
    ALTER TABLE assets ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX idx_assets_parent ON assets(parent_asset_id);
    `
  }
]

import type { Migration } from './store';

/** Knowledge schema is shared by the global and project stores so one service handles both. */
const KNOWLEDGE_SQL = `
CREATE TABLE knowledge (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global','roblox','domain','project','task','session')),
  category TEXT NOT NULL CHECK (category IN ('authoritative','research','experimental','project','agent')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  sources TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  version_applicability TEXT,
  domain TEXT,
  task_id TEXT,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','disputed','retracted')),
  superseded_by TEXT,
  promoted_from TEXT,
  validated_at TEXT,
  validation TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX knowledge_scope ON knowledge(scope, status);
CREATE VIRTUAL TABLE knowledge_fts USING fts5(title, body, tags, content='knowledge', content_rowid='rowid', tokenize='porter unicode61');
CREATE TRIGGER knowledge_ai AFTER INSERT ON knowledge BEGIN
  INSERT INTO knowledge_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER knowledge_ad AFTER DELETE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER knowledge_au AFTER UPDATE ON knowledge BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO knowledge_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TABLE knowledge_links (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('supports','contradicts','supersedes','relates','derived_from')),
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);
`;

export const GLOBAL_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE capabilities (
  id TEXT PRIMARY KEY,
  integration TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version TEXT,
  detail TEXT,
  limitations TEXT NOT NULL DEFAULT '[]',
  schema TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_checked_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX capabilities_integration ON capabilities(integration);
CREATE TABLE integration_health (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  version TEXT,
  checks TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT NOT NULL
);
CREATE TABLE health_history (
  id TEXT PRIMARY KEY,
  integration TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  version TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX health_history_integration ON health_history(integration, checked_at);
CREATE TABLE skills_index (
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  project_id TEXT,
  path TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  roblox_systems TEXT NOT NULL DEFAULT '[]',
  version_applicability TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (name, scope, project_id)
);
CREATE TABLE usage_observations (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX usage_observations_time ON usage_observations(provider_id, observed_at);
${KNOWLEDGE_SQL}
`,
  },
];

export const PROJECT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  verification TEXT NOT NULL DEFAULT '[]',
  required_skills TEXT NOT NULL DEFAULT '[]',
  required_knowledge TEXT NOT NULL DEFAULT '[]',
  tools TEXT NOT NULL DEFAULT '[]',
  files TEXT NOT NULL DEFAULT '[]',
  roblox_systems TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  result TEXT,
  failure_summary TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  sort_order REAL NOT NULL DEFAULT 0
);
CREATE INDEX tasks_status ON tasks(status);
CREATE INDEX tasks_parent ON tasks(parent_id);
CREATE TABLE task_deps (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE TABLE task_evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  passed INTEGER,
  data TEXT,
  path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX task_evidence_task ON task_evidence(task_id);
CREATE TABLE task_failures (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT,
  attempt INTEGER NOT NULL,
  stage TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  context_path TEXT,
  context_tokens_est INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  num_turns INTEGER NOT NULL DEFAULT 0,
  result_summary TEXT,
  result_data TEXT,
  error TEXT,
  provider_session_id TEXT
);
CREATE INDEX runs_task ON runs(task_id);
CREATE INDEX runs_status ON runs(status);
CREATE TABLE run_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX run_messages_run ON run_messages(run_id, seq);
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  task_id TEXT,
  role TEXT,
  provider_id TEXT,
  source TEXT NOT NULL,
  tool TEXT NOT NULL,
  capability TEXT,
  args TEXT,
  result TEXT,
  status TEXT NOT NULL,
  error TEXT,
  duration_ms INTEGER,
  started_at TEXT NOT NULL,
  files_changed TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX tool_calls_run ON tool_calls(run_id);
CREATE INDEX tool_calls_task ON tool_calls(task_id);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  run_id TEXT,
  task_id TEXT,
  role TEXT
);
CREATE INDEX events_ts ON events(ts);
CREATE INDEX events_task ON events(task_id);
CREATE TABLE research_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  conclusion TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE research_sources (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  authority TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  retrieved_at TEXT NOT NULL
);
CREATE TABLE research_claims (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES research_sessions(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES research_sources(id) ON DELETE SET NULL,
  claim TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'unverified',
  notes TEXT,
  knowledge_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  decision TEXT NOT NULL,
  consequences TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE spec_sections (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE architecture_nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  data TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE architecture_edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT,
  PRIMARY KEY (from_id, to_id, kind)
);
CREATE TABLE tests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  spec TEXT NOT NULL,
  task_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_status TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE test_results (
  id TEXT PRIMARY KEY,
  test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  run_id TEXT,
  task_id TEXT,
  status TEXT NOT NULL,
  output TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX test_results_test ON test_results(test_id, created_at);
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  snapshot_path TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE escalations (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  response TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  roblox_asset_id TEXT,
  path TEXT,
  preview_path TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE project_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
${KNOWLEDGE_SQL}
`,
  },
  {
    version: 2,
    name: 'asset-library',
    sql: `
ALTER TABLE assets ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE assets ADD COLUMN instance_paths TEXT NOT NULL DEFAULT '[]';
ALTER TABLE assets ADD COLUMN usage_tag TEXT;
ALTER TABLE assets ADD COLUMN analysis TEXT;
ALTER TABLE assets ADD COLUMN analyzed_at TEXT;
CREATE INDEX assets_roblox_id ON assets(roblox_asset_id);
CREATE TABLE asset_events (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX asset_events_asset ON asset_events(asset_id, created_at);
`,
  },
  {
    version: 3,
    name: 'chat-and-live-plans',
    sql: `
ALTER TABLE tasks ADD COLUMN plan_key TEXT;
CREATE INDEX tasks_plan_key ON tasks(parent_id, plan_key);
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX chat_messages_time ON chat_messages(created_at);
`,
  },
  {
    version: 4,
    name: 'resume-verification',
    sql: `
ALTER TABLE tasks ADD COLUMN resume_run_id TEXT;
`,
  },
  {
    version: 5,
    name: 'continued-sessions',
    sql: `
ALTER TABLE runs ADD COLUMN continues_run_id TEXT;
`,
  },
  {
    version: 6,
    name: 'run-app-version',
    sql: `
ALTER TABLE runs ADD COLUMN app_version TEXT;
`,
  },
  {
    version: 7,
    name: 'chat-channels',
    sql: `
ALTER TABLE chat_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'director';
CREATE INDEX chat_messages_channel ON chat_messages(channel, created_at);
`,
  },
  {
    version: 8,
    name: 'test-retirement',
    // A retired test is disabled with a record of why, who and when (its task was cancelled, an agent or the
    // user retired it, or it was quarantined after a repair failed). Re-enabling clears the record.
    sql: `
ALTER TABLE tests ADD COLUMN retired_reason TEXT;
ALTER TABLE tests ADD COLUMN retired_at TEXT;
ALTER TABLE tests ADD COLUMN retired_by TEXT;
`,
  },
  {
    version: 9,
    name: 'soft-dependencies',
    // A dependent starts when its dependency's work exists (tasks.landed_at: the agent finished, checks and review
    // still to come) unless the dependency is strict (task_deps.strict: it needs the dependency done).
    sql: `
ALTER TABLE tasks ADD COLUMN landed_at TEXT;
ALTER TABLE task_deps ADD COLUMN strict INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    version: 10,
    name: 'long-run-indexes',
    // What the window asks over and over on a long build read whole tables: the runs list sorted by start time, the
    // "can Studio draw again" look at screenshot calls (every tick while tasks wait for a visual check), evidence by
    // time, a run's timeline. On a 180 MB project these were full scans.
    sql: `
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
CREATE INDEX IF NOT EXISTS tool_calls_tool_time ON tool_calls(tool, started_at);
CREATE INDEX IF NOT EXISTS task_evidence_time ON task_evidence(created_at);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
`,
  },
  {
    version: 11,
    name: 'cost-entries',
    // What a build cost beyond its runs (core/costs/build-cost.ts): the small fixed-model calls a project makes through
    // AgentRunner.quick (plain words, the thumbnail judge) were counted in the account's usage and nowhere in the
    // project. source: the role that made the call; label: what it was for.
    sql: `
CREATE TABLE IF NOT EXISTS cost_entries (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  cost_usd REAL NOT NULL DEFAULT 0,
  task_id TEXT
);
CREATE INDEX IF NOT EXISTS cost_entries_at ON cost_entries(at);
`,
  },
];

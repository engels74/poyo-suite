import type { Migration } from './types';

export const cleanupOperationsMigration: Migration = {
  version: 2,
  name: 'durable local cleanup attempts',
  sql: `
CREATE TABLE cleanup_previews (
  token TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES cleanup_policies(id),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('local_file', 'local_metadata', 'local_both')),
  policy_hash TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE cleanup_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES cleanup_actions(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN ('started', 'complete', 'failed', 'skipped')),
  safe_result_json TEXT CHECK (safe_result_json IS NULL OR json_valid(safe_result_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (action_id, attempt)
);

CREATE INDEX idx_cleanup_attempts_action
  ON cleanup_attempts(action_id, attempt DESC);

CREATE INDEX idx_cleanup_previews_created
  ON cleanup_previews(created_at DESC);
`
};

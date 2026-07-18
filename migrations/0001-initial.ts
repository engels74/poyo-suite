import type { Migration } from './types';

export const initialMigration: Migration = {
  version: 1,
  name: 'initial durable studio schema',
  sql: `
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_version INTEGER NOT NULL CHECK (value_version >= 1),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL
);

CREATE TABLE secret_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_source TEXT NOT NULL CHECK (active_source IN ('environment', 'local', 'none')),
  status TEXT NOT NULL CHECK (status IN ('configured', 'missing', 'unavailable', 'error')),
  store_kind TEXT NOT NULL CHECK (store_kind IN ('environment', 'os', 'file', 'unavailable')),
  last_connectivity_at TEXT,
  last_connectivity_status TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE registry_versions (
  version TEXT PRIMARY KEY,
  source_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('current', 'stale', 'invalid', 'experimental'))
);

CREATE TABLE registry_entries (
  registry_version TEXT NOT NULL REFERENCES registry_versions(version) ON DELETE CASCADE,
  entry_key TEXT NOT NULL,
  public_model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  modality TEXT NOT NULL CHECK (modality IN ('image', 'video')),
  workflow TEXT NOT NULL,
  status TEXT NOT NULL,
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  limitations_json TEXT NOT NULL CHECK (json_valid(limitations_json)),
  PRIMARY KEY (registry_version, entry_key)
);

CREATE TABLE registry_audits (
  audit_id TEXT PRIMARY KEY,
  old_version TEXT REFERENCES registry_versions(version),
  new_version TEXT REFERENCES registry_versions(version),
  result TEXT NOT NULL,
  report_json TEXT NOT NULL CHECK (json_valid(report_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  registry_version TEXT,
  entry_key TEXT,
  workflow TEXT NOT NULL,
  public_model_id TEXT NOT NULL,
  local_phase TEXT NOT NULL CHECK (local_phase IN (
    'queued', 'validating', 'uploading', 'submission_prepared', 'submitting',
    'monitoring', 'downloading', 'complete', 'requires_attention'
  )),
  remote_status_raw TEXT,
  remote_status TEXT NOT NULL DEFAULT 'unknown' CHECK (remote_status IN (
    'unknown', 'not_started', 'running', 'finished', 'failed'
  )),
  failure_domain TEXT NOT NULL DEFAULT 'none' CHECK (failure_domain IN (
    'none', 'validation', 'upload', 'submission', 'poll', 'remote_generation',
    'download', 'cleanup', 'filesystem', 'database', 'live_update', 'registry'
  )),
  attention_code TEXT,
  poyo_task_id TEXT UNIQUE,
  progress REAL CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  guided_request_json TEXT NOT NULL CHECK (json_valid(guided_request_json)),
  actual_payload_json TEXT CHECK (actual_payload_json IS NULL OR json_valid(actual_payload_json)),
  expert_diff_json TEXT CHECK (expert_diff_json IS NULL OR json_valid(expert_diff_json)),
  estimated_credits REAL CHECK (estimated_credits IS NULL OR estimated_credits >= 0),
  actual_credits REAL CHECK (actual_credits IS NULL OR actual_credits >= 0),
  prompt_text TEXT,
  search_text TEXT,
  correlation_id TEXT NOT NULL,
  retry_of_job_id TEXT REFERENCES jobs(id),
  next_poll_at TEXT,
  last_polled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (registry_version, entry_key)
    REFERENCES registry_entries(registry_version, entry_key)
);

CREATE TABLE submission_intents (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  request_fingerprint TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'sending', 'acknowledged', 'unknown', 'rejected'
  )),
  transmit_claim_token TEXT,
  transmit_claim_owner TEXT,
  claimed_at TEXT,
  lease_expires_at TEXT,
  transport_evidence_json TEXT CHECK (
    transport_evidence_json IS NULL OR json_valid(transport_evidence_json)
  ),
  poyo_task_id TEXT,
  prepared_at TEXT NOT NULL,
  sent_at TEXT,
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE work_claims (
  work_type TEXT NOT NULL CHECK (work_type IN ('poll', 'download', 'cleanup')),
  work_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  PRIMARY KEY (work_type, work_id)
);

CREATE TABLE job_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  local_phase TEXT NOT NULL,
  remote_status_raw TEXT,
  remote_status TEXT NOT NULL,
  failure_domain TEXT NOT NULL,
  progress REAL,
  safe_payload_json TEXT CHECK (safe_payload_json IS NULL OR json_valid(safe_payload_json)),
  observed_at TEXT NOT NULL
);

CREATE TABLE managed_sources (
  id TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  checksum TEXT NOT NULL,
  signature TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  availability TEXT NOT NULL DEFAULT 'available' CHECK (
    availability IN ('available', 'missing', 'deleted')
  ),
  created_at TEXT NOT NULL,
  last_verified_at TEXT,
  missing_at TEXT,
  deleted_at TEXT
);

CREATE TABLE job_inputs (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  input_order INTEGER NOT NULL CHECK (input_order >= 0),
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
  local_reference TEXT,
  source_url TEXT,
  upload_url TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  checksum TEXT,
  availability TEXT NOT NULL DEFAULT 'available',
  managed_source_id TEXT REFERENCES managed_sources(id) ON DELETE SET NULL,
  PRIMARY KEY (job_id, role, input_order)
);

CREATE TABLE job_outputs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  output_order INTEGER NOT NULL CHECK (output_order >= 0),
  media_kind TEXT NOT NULL CHECK (media_kind IN ('image', 'video')),
  remote_url TEXT,
  remote_expires_at TEXT,
  remote_metadata_json TEXT CHECK (
    remote_metadata_json IS NULL OR json_valid(remote_metadata_json)
  ),
  local_path TEXT,
  content_type TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  checksum TEXT,
  signature TEXT,
  aspect_ratio TEXT,
  download_state TEXT NOT NULL DEFAULT 'pending' CHECK (download_state IN (
    'pending', 'downloading', 'verified', 'failed', 'expired', 'deleted'
  )),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at TEXT NOT NULL,
  verified_at TEXT,
  deleted_at TEXT,
  pixel_width INTEGER CHECK (pixel_width IS NULL OR pixel_width > 0),
  pixel_height INTEGER CHECK (pixel_height IS NULL OR pixel_height > 0),
  UNIQUE (job_id, output_order)
);

CREATE TABLE download_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  output_id TEXT NOT NULL REFERENCES job_outputs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN ('started', 'verified', 'failed', 'expired')),
  bytes_received INTEGER NOT NULL DEFAULT 0 CHECK (bytes_received >= 0),
  safe_error_json TEXT CHECK (safe_error_json IS NULL OR json_valid(safe_error_json)),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (output_id, attempt)
);

CREATE TABLE balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT,
  credits REAL NOT NULL CHECK (credits >= 0),
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  registry_version TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  workflow TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  values_version INTEGER NOT NULL CHECK (values_version >= 1),
  values_json TEXT NOT NULL CHECK (json_valid(values_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE model_preferences (
  entry_key TEXT PRIMARY KEY,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  favorited_at TEXT,
  last_used_at TEXT
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE job_tags (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, tag_id)
);

CREATE TABLE cleanup_policies (
  id TEXT PRIMARY KEY,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE cleanup_actions (
  id TEXT PRIMARY KEY,
  policy_id TEXT REFERENCES cleanup_policies(id),
  action_kind TEXT NOT NULL CHECK (action_kind IN ('local_file', 'local_metadata', 'local_both')),
  target_id TEXT NOT NULL,
  preview_version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('previewed', 'scheduled', 'executing', 'complete', 'failed', 'cancelled')),
  due_at TEXT,
  safe_result_json TEXT CHECK (safe_result_json IS NULL OR json_valid(safe_result_json)),
  created_at TEXT NOT NULL,
  executed_at TEXT
);

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

CREATE INDEX idx_registry_entries_selector
  ON registry_entries(provider, modality, workflow, status);
CREATE INDEX idx_jobs_lifecycle ON jobs(local_phase, next_poll_at, updated_at);
CREATE INDEX idx_jobs_model_workflow_date ON jobs(public_model_id, workflow, created_at DESC);
CREATE INDEX idx_jobs_library_search ON jobs(prompt_text, search_text, created_at DESC);
CREATE INDEX idx_jobs_retry ON jobs(retry_of_job_id);
CREATE UNIQUE INDEX idx_jobs_poyo_task ON jobs(poyo_task_id) WHERE poyo_task_id IS NOT NULL;
CREATE INDEX idx_submission_intents_state ON submission_intents(state, lease_expires_at);
CREATE INDEX idx_work_claims_expiry ON work_claims(work_type, expires_at);
CREATE INDEX idx_job_events_job_cursor ON job_events(job_id, event_id);
CREATE INDEX idx_job_inputs_kind ON job_inputs(media_kind, job_id);
CREATE INDEX idx_job_inputs_managed_source ON job_inputs(managed_source_id, job_id);
CREATE INDEX idx_job_outputs_library
  ON job_outputs(media_kind, download_state, favorite, created_at DESC);
CREATE INDEX idx_job_outputs_job ON job_outputs(job_id, output_order);
CREATE INDEX idx_download_attempts_status ON download_attempts(status, started_at);
CREATE INDEX idx_balance_snapshots_date ON balance_snapshots(fetched_at DESC);
CREATE INDEX idx_presets_model_workflow ON presets(entry_key, workflow, updated_at DESC);
CREATE INDEX idx_model_preferences_recent ON model_preferences(favorite, last_used_at DESC);
CREATE INDEX idx_job_tags_tag ON job_tags(tag_id, job_id);
CREATE INDEX idx_cleanup_actions_due ON cleanup_actions(state, due_at);
CREATE INDEX idx_cleanup_attempts_action
  ON cleanup_attempts(action_id, attempt DESC);
CREATE INDEX idx_cleanup_previews_created
  ON cleanup_previews(created_at DESC);
CREATE INDEX idx_managed_sources_retention
  ON managed_sources(availability, created_at, id);
`
};

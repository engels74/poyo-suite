import type { Database } from 'bun:sqlite';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { inTransaction } from './database';

export const PERSISTED_PATH_INVENTORY = [
  'job_outputs.local_path',
  'job_inputs.local_reference',
  'app_settings.storage.outputDirectory',
  'app_settings.storage.previousRoots[]',
  'cleanup_actions.safe_result_json..localPath',
  'cleanup_attempts.safe_result_json..localPath'
] as const;

export const PERSISTED_RELATIVE_PATH_FIELDS = ['managed_sources.relative_path'] as const;

export interface PersistedPathRebaseResult {
  changedPaths: number;
  invalidatedCleanupActions: number;
}

export interface PersistedOutputPathValues {
  current: string | null;
  historical: string[];
}

function platformPath(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.resolve(value) : resolve(value);
}

function pathIdentityKey(value: string, platform: NodeJS.Platform): string {
  const normalized = platformPath(value, platform);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function ownedRelativePath(
  root: string,
  candidate: string,
  platform: NodeJS.Platform
): string | null {
  const pathIsAbsolute = platform === 'win32' ? win32.isAbsolute : isAbsolute;
  const pathRelative = platform === 'win32' ? win32.relative : relative;
  const pathSeparator = platform === 'win32' ? win32.sep : sep;
  if (!pathIsAbsolute(candidate)) return null;
  const normalizedRoot = platformPath(root, platform);
  const normalizedCandidate = platformPath(candidate, platform);
  const value = pathRelative(normalizedRoot, normalizedCandidate);
  if (value === '') return '';
  if (value === '..' || value.startsWith(`..${pathSeparator}`) || pathIsAbsolute(value)) {
    return null;
  }
  return value;
}

export function rebasePersistedPath(
  value: string,
  sourceRoot: string,
  targetRoot: string,
  platform: NodeJS.Platform = process.platform
): string {
  const owned = ownedRelativePath(sourceRoot, value, platform);
  if (owned === null) return value;
  return platform === 'win32' ? win32.resolve(targetRoot, owned) : resolve(targetRoot, owned);
}

interface JsonRebaseResult {
  value: unknown;
  changedPaths: number;
}

function rebaseJsonLocalPaths(
  value: unknown,
  sourceRoot: string,
  targetRoot: string,
  platform: NodeJS.Platform
): JsonRebaseResult {
  if (Array.isArray(value)) {
    let changedPaths = 0;
    const rebased = value.map((entry) => {
      const result = rebaseJsonLocalPaths(entry, sourceRoot, targetRoot, platform);
      changedPaths += result.changedPaths;
      return result.value;
    });
    return { value: rebased, changedPaths };
  }
  if (!value || typeof value !== 'object') return { value, changedPaths: 0 };

  let changedPaths = 0;
  const rebased: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'localPath' && typeof nested === 'string') {
      const next = rebasePersistedPath(nested, sourceRoot, targetRoot, platform);
      if (next !== nested) changedPaths += 1;
      rebased[key] = next;
      continue;
    }
    const result = rebaseJsonLocalPaths(nested, sourceRoot, targetRoot, platform);
    changedPaths += result.changedPaths;
    rebased[key] = result.value;
  }
  return { value: rebased, changedPaths };
}

function collectJsonLocalPaths(value: unknown, paths: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonLocalPaths(entry, paths);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'localPath' && typeof nested === 'string') paths.push(nested);
    else collectJsonLocalPaths(nested, paths);
  }
}

export function listPersistedOutputPathValues(database: Database): PersistedOutputPathValues {
  const storage = database
    .query<{ value_json: string }, []>("SELECT value_json FROM app_settings WHERE key='storage'")
    .get();
  if (!storage) return { current: null, historical: [] };
  const parsed = JSON.parse(storage.value_json) as {
    outputDirectory?: unknown;
    previousRoots?: unknown;
  };
  return {
    current: typeof parsed.outputDirectory === 'string' ? parsed.outputDirectory : null,
    historical: Array.isArray(parsed.previousRoots)
      ? parsed.previousRoots.filter((value): value is string => typeof value === 'string')
      : []
  };
}

export function listPersistedPathValues(database: Database): string[] {
  const values = database
    .query<{ value: string }, []>(
      `SELECT local_path value FROM job_outputs WHERE local_path IS NOT NULL
       UNION ALL
       SELECT local_reference value FROM job_inputs WHERE local_reference IS NOT NULL`
    )
    .all()
    .map(({ value }) => value);
  const outputPaths = listPersistedOutputPathValues(database);
  if (outputPaths.current) values.push(outputPaths.current);
  values.push(...outputPaths.historical);
  for (const table of ['cleanup_actions', 'cleanup_attempts'] as const) {
    const rows = database
      .query<{ safe_result_json: string }, []>(
        `SELECT safe_result_json FROM ${table} WHERE safe_result_json IS NOT NULL`
      )
      .all();
    for (const row of rows) collectJsonLocalPaths(JSON.parse(row.safe_result_json), values);
  }
  return values;
}

function updateSimplePaths(
  database: Database,
  table: 'job_outputs' | 'job_inputs',
  idColumns: readonly string[],
  pathColumn: 'local_path' | 'local_reference',
  sourceRoot: string,
  targetRoot: string,
  platform: NodeJS.Platform
): number {
  const columns = [...idColumns, pathColumn].join(',');
  const rows = database
    .query<Record<string, string | number>, []>(
      `SELECT ${columns} FROM ${table} WHERE ${pathColumn} IS NOT NULL`
    )
    .all();
  let changed = 0;
  for (const row of rows) {
    const current = String(row[pathColumn]);
    const next = rebasePersistedPath(current, sourceRoot, targetRoot, platform);
    if (next === current) continue;
    if (table === 'job_outputs') {
      const id = row.id;
      if (typeof id !== 'string') throw new Error('Persisted output path inventory is invalid.');
      database.query(`UPDATE job_outputs SET ${pathColumn}=? WHERE id=?`).run(next, id);
    } else {
      const jobId = row.job_id;
      const role = row.role;
      const inputOrder = row.input_order;
      if (typeof jobId !== 'string' || typeof role !== 'string' || typeof inputOrder !== 'number') {
        throw new Error('Persisted input path inventory is invalid.');
      }
      database
        .query(`UPDATE job_inputs SET ${pathColumn}=? WHERE job_id=? AND role=? AND input_order=?`)
        .run(next, jobId, role, inputOrder);
    }
    changed += 1;
  }
  return changed;
}

function updateStoragePreferences(
  database: Database,
  sourceRoot: string,
  targetRoot: string,
  platform: NodeJS.Platform
): number {
  const row = database
    .query<{ value_json: string }, []>("SELECT value_json FROM app_settings WHERE key='storage'")
    .get();
  if (!row) return 0;
  const parsed = JSON.parse(row.value_json) as {
    outputDirectory?: unknown;
    previousRoots?: unknown;
    [key: string]: unknown;
  };
  let changed = 0;
  if (typeof parsed.outputDirectory === 'string') {
    const next = rebasePersistedPath(parsed.outputDirectory, sourceRoot, targetRoot, platform);
    if (next !== parsed.outputDirectory) {
      parsed.outputDirectory = next;
      changed += 1;
    }
  }
  if (Array.isArray(parsed.previousRoots)) {
    const rebased = parsed.previousRoots.map((entry) => {
      if (typeof entry !== 'string') return entry;
      const next = rebasePersistedPath(entry, sourceRoot, targetRoot, platform);
      if (next !== entry) changed += 1;
      return next;
    });
    const seen = new Set<string>();
    parsed.previousRoots = rebased.filter((entry) => {
      if (typeof entry !== 'string') return true;
      const identity = pathIdentityKey(entry, platform);
      if (seen.has(identity)) {
        changed += 1;
        return false;
      }
      seen.add(identity);
      return true;
    });
  }
  if (changed > 0) {
    database
      .query("UPDATE app_settings SET value_json=? WHERE key='storage'")
      .run(JSON.stringify(parsed));
  }
  return changed;
}

function updateCleanupJson(
  database: Database,
  sourceRoot: string,
  targetRoot: string,
  platform: NodeJS.Platform,
  now: string
): { changedPaths: number; invalidatedActions: number } {
  const actions = database
    .query<{ id: string; state: string; safe_result_json: string; executed_at: string | null }, []>(
      'SELECT id,state,safe_result_json,executed_at FROM cleanup_actions WHERE safe_result_json IS NOT NULL'
    )
    .all();
  const invalidated = new Set<string>();
  let changedPaths = 0;
  for (const action of actions) {
    const result = rebaseJsonLocalPaths(
      JSON.parse(action.safe_result_json),
      sourceRoot,
      targetRoot,
      platform
    );
    changedPaths += result.changedPaths;
    const unsafePending =
      result.changedPaths > 0 && ['previewed', 'scheduled', 'executing'].includes(action.state);
    if (unsafePending) invalidated.add(action.id);
    if (result.changedPaths > 0 || unsafePending) {
      const value = result.value as Record<string, unknown>;
      database
        .query(
          `UPDATE cleanup_actions SET state=?,due_at=NULL,safe_result_json=?,executed_at=? WHERE id=?`
        )
        .run(
          unsafePending ? 'failed' : action.state,
          JSON.stringify({
            ...value,
            ...(unsafePending
              ? { relocation: { status: 'invalidated', code: 'root_relocation' } }
              : {})
          }),
          unsafePending ? now : action.executed_at,
          action.id
        );
    }
  }

  const attempts = database
    .query<
      {
        id: number;
        action_id: string;
        status: string;
        safe_result_json: string | null;
        completed_at: string | null;
      },
      []
    >('SELECT id,action_id,status,safe_result_json,completed_at FROM cleanup_attempts')
    .all();
  for (const attempt of attempts) {
    let result: JsonRebaseResult = { value: null, changedPaths: 0 };
    if (attempt.safe_result_json) {
      result = rebaseJsonLocalPaths(
        JSON.parse(attempt.safe_result_json),
        sourceRoot,
        targetRoot,
        platform
      );
      changedPaths += result.changedPaths;
    }
    const invalidate = attempt.status === 'started' && invalidated.has(attempt.action_id);
    if (result.changedPaths > 0 || invalidate) {
      database
        .query('UPDATE cleanup_attempts SET status=?,safe_result_json=?,completed_at=? WHERE id=?')
        .run(
          invalidate ? 'failed' : attempt.status,
          JSON.stringify(
            invalidate ? { code: 'root_relocation', status: 'invalidated' } : result.value
          ),
          invalidate ? now : attempt.completed_at,
          attempt.id
        );
    }
  }
  for (const actionId of invalidated) {
    database.query("DELETE FROM work_claims WHERE work_type='cleanup' AND work_id=?").run(actionId);
  }
  return { changedPaths, invalidatedActions: invalidated.size };
}

export function rebasePersistedPaths(
  database: Database,
  sourceRoot: string,
  targetRoot: string,
  options: { platform?: NodeJS.Platform; now?: Date } = {}
): PersistedPathRebaseResult {
  const platform = options.platform ?? process.platform;
  const now = (options.now ?? new Date()).toISOString();
  return inTransaction(database, () => {
    let changedPaths = updateSimplePaths(
      database,
      'job_outputs',
      ['id'],
      'local_path',
      sourceRoot,
      targetRoot,
      platform
    );
    changedPaths += updateSimplePaths(
      database,
      'job_inputs',
      ['job_id', 'role', 'input_order'],
      'local_reference',
      sourceRoot,
      targetRoot,
      platform
    );
    changedPaths += updateStoragePreferences(database, sourceRoot, targetRoot, platform);
    const cleanup = updateCleanupJson(database, sourceRoot, targetRoot, platform, now);
    return {
      changedPaths: changedPaths + cleanup.changedPaths,
      invalidatedCleanupActions: cleanup.invalidatedActions
    };
  });
}

function jsonContainsOwnedLocalPath(
  value: unknown,
  root: string,
  platform: NodeJS.Platform
): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => jsonContainsOwnedLocalPath(entry, root, platform));
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) =>
    key === 'localPath' && typeof nested === 'string'
      ? ownedRelativePath(root, nested, platform) !== null
      : jsonContainsOwnedLocalPath(nested, root, platform)
  );
}

export function findPersistedPathsUnderRoot(
  database: Database,
  root: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const found: string[] = [];
  const output = database
    .query<{ id: string; local_path: string }, []>(
      'SELECT id,local_path FROM job_outputs WHERE local_path IS NOT NULL'
    )
    .all();
  for (const row of output) {
    if (ownedRelativePath(root, row.local_path, platform) !== null) {
      found.push(`job_outputs.local_path:${row.id}`);
    }
  }
  const inputs = database
    .query<{ job_id: string; role: string; input_order: number; local_reference: string }, []>(
      'SELECT job_id,role,input_order,local_reference FROM job_inputs WHERE local_reference IS NOT NULL'
    )
    .all();
  for (const row of inputs) {
    if (ownedRelativePath(root, row.local_reference, platform) !== null) {
      found.push(`job_inputs.local_reference:${row.job_id}:${row.role}:${row.input_order}`);
    }
  }
  const storage = database
    .query<{ value_json: string }, []>("SELECT value_json FROM app_settings WHERE key='storage'")
    .get();
  if (storage) {
    const value = JSON.parse(storage.value_json) as {
      outputDirectory?: unknown;
      previousRoots?: unknown;
    };
    if (
      typeof value.outputDirectory === 'string' &&
      ownedRelativePath(root, value.outputDirectory, platform) !== null
    ) {
      found.push('app_settings.storage.outputDirectory');
    }
    if (
      Array.isArray(value.previousRoots) &&
      value.previousRoots.some(
        (entry) => typeof entry === 'string' && ownedRelativePath(root, entry, platform) !== null
      )
    ) {
      found.push('app_settings.storage.previousRoots[]');
    }
  }
  for (const table of ['cleanup_actions', 'cleanup_attempts'] as const) {
    const rows = database
      .query<{ id: string | number; safe_result_json: string }, []>(
        `SELECT id,safe_result_json FROM ${table} WHERE safe_result_json IS NOT NULL`
      )
      .all();
    for (const row of rows) {
      if (jsonContainsOwnedLocalPath(JSON.parse(row.safe_result_json), root, platform)) {
        found.push(`${table}.safe_result_json:${row.id}`);
      }
    }
  }
  return found;
}

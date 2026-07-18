import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { migrations } from '../../../migrations';
import {
  DatabasePreflightError,
  migrateDatabase,
  migrationChecksum,
  openDatabase,
  preflightDatabase
} from '../../../src/lib/server/platform/database';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function path(): Promise<string> {
  const temporary = await createTemporaryDirectory('poyo-db-preflight-');
  cleanups.push(temporary.cleanup);
  return join(temporary.path, 'data', 'poyo-studio.sqlite');
}

async function createSchemaHistory(
  databasePath: string,
  version: number,
  identity: 'registered' | 'fixture' = 'fixture'
): Promise<void> {
  await mkdir(join(databasePath, '..'), { recursive: true });
  const database = new Database(databasePath, { create: true, strict: true });
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const registered = migrations.find((migration) => migration.version === version);
  database
    .query('INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
    .run(
      version,
      identity === 'registered' && registered ? registered.name : 'fixture',
      identity === 'registered' && registered ? migrationChecksum(registered) : 'fixture-checksum',
      '2026-07-17T00:00:00.000Z'
    );
  database.close();
}

async function createCompatibleDatabase(databasePath: string): Promise<void> {
  await mkdir(join(databasePath, '..'), { recursive: true });
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    migrateDatabase(database);
  } finally {
    database.close();
  }
}

async function mutateSchema(databasePath: string, sql: string): Promise<void> {
  const database = new Database(databasePath, { strict: true });
  try {
    database.exec(sql);
  } finally {
    database.close();
  }
}

async function snapshot(databasePath: string) {
  const details = await lstat(databasePath);
  return {
    bytes: new Uint8Array(await Bun.file(databasePath).arrayBuffer()),
    size: details.size,
    mode: details.mode,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs
  };
}

async function expectRejectedWithoutMutation(databasePath: string): Promise<void> {
  const before = await snapshot(databasePath);
  const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
  const beforeSidecars = await Promise.all(
    sidecars.map(async (path) => ({
      exists: await Bun.file(path).exists(),
      bytes: (await Bun.file(path).exists())
        ? new Uint8Array(await Bun.file(path).arrayBuffer())
        : null
    }))
  );

  await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
    code: 'database_incompatible'
  });

  expect(await snapshot(databasePath)).toEqual(before);
  expect(
    await Promise.all(
      sidecars.map(async (path) => ({
        exists: await Bun.file(path).exists(),
        bytes: (await Bun.file(path).exists())
          ? new Uint8Array(await Bun.file(path).arrayBuffer())
          : null
      }))
    )
  ).toEqual(beforeSidecars);
}

describe('read-only database bootstrap preflight', () => {
  test('does not create a missing database or its parent directory', async () => {
    const databasePath = await path();
    const parent = join(databasePath, '..');
    expect(await preflightDatabase(databasePath)).toEqual({ state: 'absent', maxVersion: null });
    expect(await Bun.file(databasePath).exists()).toBe(false);
    expect(await Bun.file(parent).exists()).toBe(false);
  });

  test('accepts the fresh-only version-1 history without creating sidecars', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    expect(await preflightDatabase(databasePath)).toEqual({ state: 'compatible', maxVersion: 1 });
    expect(await Bun.file(`${databasePath}-wal`).exists()).toBe(false);
    expect(await Bun.file(`${databasePath}-shm`).exists()).toBe(false);
    expect(await Bun.file(`${databasePath}-journal`).exists()).toBe(false);
  });

  test('accepts a clean WAL-mode database without changing residual empty-WAL sidecars', async () => {
    const databasePath = await path();
    const database = await openDatabase(databasePath);
    database.close();
    const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
    const before = await snapshot(databasePath);
    const beforeSidecars = await Promise.all(
      sidecars.map(async (sidecar) => ({
        exists: await Bun.file(sidecar).exists(),
        bytes: (await Bun.file(sidecar).exists())
          ? new Uint8Array(await Bun.file(sidecar).arrayBuffer())
          : null
      }))
    );

    await expect(preflightDatabase(databasePath)).resolves.toEqual({
      state: 'compatible',
      maxVersion: 1
    });

    expect(await snapshot(databasePath)).toEqual(before);
    expect(
      await Promise.all(
        sidecars.map(async (sidecar) => ({
          exists: await Bun.file(sidecar).exists(),
          bytes: (await Bun.file(sidecar).exists())
            ? new Uint8Array(await Bun.file(sidecar).arrayBuffer())
            : null
        }))
      )
    ).toEqual(beforeSidecars);
  });

  test('rejects exact migration rows with a missing application table without any mutation', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    await mutateSchema(databasePath, 'DROP TABLE balance_snapshots');
    await expectRejectedWithoutMutation(databasePath);
  });

  test('rejects exact migration rows with a changed index without any mutation', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    await mutateSchema(
      databasePath,
      `DROP INDEX idx_balance_snapshots_date;
       CREATE INDEX idx_balance_snapshots_date ON balance_snapshots(fetched_at ASC);`
    );
    await expectRejectedWithoutMutation(databasePath);
  });

  test('rejects exact migration rows with a changed table constraint without any mutation', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    await mutateSchema(
      databasePath,
      `ALTER TABLE model_preferences RENAME TO model_preferences_old;
       CREATE TABLE model_preferences (
         entry_key TEXT PRIMARY KEY,
         favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1, 2)),
         favorited_at TEXT,
         last_used_at TEXT
       );
       DROP TABLE model_preferences_old;
       CREATE INDEX idx_model_preferences_recent
         ON model_preferences(favorite, last_used_at DESC);`
    );
    await expectRejectedWithoutMutation(databasePath);
  });

  test('rejects exact migration rows with a changed foreign key without any mutation', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    await mutateSchema(
      databasePath,
      `PRAGMA foreign_keys = OFF;
       ALTER TABLE job_tags RENAME TO job_tags_old;
       CREATE TABLE job_tags (
         job_id TEXT NOT NULL REFERENCES jobs(id),
         tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
         PRIMARY KEY (job_id, tag_id)
       );
       DROP TABLE job_tags_old;
       CREATE INDEX idx_job_tags_tag ON job_tags(tag_id, job_id);`
    );
    await expectRejectedWithoutMutation(databasePath);
  });

  test('rejects canonical schema with foreign-key violations without any mutation', async () => {
    const databasePath = await path();
    await createCompatibleDatabase(databasePath);
    await mutateSchema(
      databasePath,
      `PRAGMA foreign_keys = OFF;
       INSERT INTO job_inputs(
         job_id, role, input_order, media_kind, metadata_json, availability
       ) VALUES ('missing-job', 'source', 0, 'image', '{}', 'available');`
    );
    await expectRejectedWithoutMutation(databasePath);
  });

  test('rejects a wrong version-1 identity without changing bytes, metadata, or sidecars', async () => {
    const databasePath = await path();
    await createSchemaHistory(databasePath, 1);
    const before = await snapshot(databasePath);
    const sidecars = [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
    const beforeSidecars = await Promise.all(sidecars.map((path) => Bun.file(path).exists()));

    await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
      code: 'database_incompatible'
    });

    expect(await snapshot(databasePath)).toEqual(before);
    expect(await Promise.all(sidecars.map((path) => Bun.file(path).exists()))).toEqual(
      beforeSidecars
    );
  });

  test('rejects a former version-4 history without changing DB metadata or creating WAL/SHM', async () => {
    const databasePath = await path();
    await createSchemaHistory(databasePath, 4);
    const before = await snapshot(databasePath);

    await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
      name: 'DatabasePreflightError',
      code: 'database_incompatible'
    });

    expect(await snapshot(databasePath)).toEqual(before);
    expect(await Bun.file(`${databasePath}-wal`).exists()).toBe(false);
    expect(await Bun.file(`${databasePath}-shm`).exists()).toBe(false);
    expect(await Bun.file(`${databasePath}-journal`).exists()).toBe(false);
  });

  test('fails closed on pending journal bytes and leaves every file unchanged', async () => {
    const databasePath = await path();
    await createSchemaHistory(databasePath, 1, 'registered');
    const walPath = `${databasePath}-wal`;
    await Bun.write(walPath, 'pending-wal-canary');
    const beforeDatabase = await snapshot(databasePath);
    const beforeWal = new Uint8Array(await Bun.file(walPath).arrayBuffer());

    await expect(preflightDatabase(databasePath)).rejects.toBeInstanceOf(DatabasePreflightError);

    expect(await snapshot(databasePath)).toEqual(beforeDatabase);
    expect(new Uint8Array(await Bun.file(walPath).arrayBuffer())).toEqual(beforeWal);
    expect(await Bun.file(`${databasePath}-shm`).exists()).toBe(false);
  });

  test('rejects unknown non-SQLite bytes without rewriting them', async () => {
    const databasePath = await path();
    await mkdir(join(databasePath, '..'), { recursive: true });
    await Bun.write(databasePath, 'not-a-sqlite-database');
    const before = await snapshot(databasePath);

    await expect(preflightDatabase(databasePath)).rejects.toMatchObject({
      code: 'database_unknown'
    });
    expect(await snapshot(databasePath)).toEqual(before);
  });
});

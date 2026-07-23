import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { migrations, type Migration } from '../../../migrations';
import {
  databaseHealth,
  migrateDatabase,
  migrationChecksum,
  openDatabase
} from '../../../src/lib/server/platform/database';
import { DATABASE_SCHEMA_VERSION } from '../../../src/lib/server/platform/version';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import preCollapseSchema from '../../fixtures/database/pre-collapse-schema-signature.json';
import { databaseSchemaSignature } from '../../helpers/database-schema-signature';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function databasePath(): Promise<string> {
  const temporary = await createTemporaryDirectory('poyo-db-');
  cleanups.push(temporary.cleanup);
  return join(temporary.path, 'studio.sqlite');
}

const expectedTables = [
  'app_settings',
  'balance_snapshots',
  'cleanup_actions',
  'cleanup_attempts',
  'cleanup_policies',
  'cleanup_previews',
  'download_attempts',
  'job_events',
  'job_inputs',
  'job_outputs',
  'job_tags',
  'jobs',
  'managed_sources',
  'model_preferences',
  'presets',
  'registry_audits',
  'registry_entries',
  'registry_versions',
  'schema_migrations',
  'secret_metadata',
  'submission_intents',
  'tags',
  'work_claims'
];

describe('database migrations', () => {
  test('DB-00 current version-1 schema matches the immutable historical signature', async () => {
    const database = await openDatabase(await databasePath());
    try {
      expect(migrations).toHaveLength(1);
      expect(migrations[0]?.version).toBe(DATABASE_SCHEMA_VERSION);
      expect(databaseSchemaSignature(database)).toEqual(preCollapseSchema.schema);
    } finally {
      database.close();
    }
  });

  test('DB-01 creates the complete schema with SQLite safety pragmas', async () => {
    const database = await openDatabase(await databasePath());
    try {
      const tables = database
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`
        )
        .all()
        .map((row) => row.name);
      const indexes = database
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name`
        )
        .all();
      const journal = database.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
      const health = databaseHealth(database);
      const inputColumns = database
        .query<{ name: string }, []>('PRAGMA table_info(job_inputs)')
        .all()
        .map((column) => column.name);
      const outputColumns = database
        .query<{ name: string }, []>('PRAGMA table_info(job_outputs)')
        .all()
        .map((column) => column.name);
      const sourceForeignKey = database
        .query<{ table: string; from: string; to: string }, []>(
          'PRAGMA foreign_key_list(job_inputs)'
        )
        .all()
        .find((foreignKey) => foreignKey.from === 'managed_source_id');

      expect(tables).toEqual(expectedTables);
      expect(indexes.length).toBeGreaterThanOrEqual(17);
      expect(inputColumns).toContain('managed_source_id');
      expect(outputColumns).toEqual(expect.arrayContaining(['pixel_width', 'pixel_height']));
      expect(sourceForeignKey).toMatchObject({ table: 'managed_sources', to: 'id' });
      expect(journal?.journal_mode).toBe('wal');
      expect(health).toEqual({
        quickCheck: 'ok',
        foreignKeys: true,
        schemaVersion: DATABASE_SCHEMA_VERSION
      });
    } finally {
      database.close();
    }
  });

  test('DB-02 reopens the current schema without duplicate work or data loss', async () => {
    const path = await databasePath();
    const first = await openDatabase(path);
    new SettingsRepository(first).set('theme', { mode: 'dark' });
    first.close();

    const reopened = await openDatabase(path);
    try {
      const applied = reopened
        .query<{ version: number; name: string; checksum: string }, []>(
          'SELECT version, name, checksum FROM schema_migrations'
        )
        .get();
      const expectedMigration = migrations[0];
      if (!expectedMigration) throw new Error('Expected the registered initial migration.');
      expect(applied).toEqual({
        version: 1,
        name: expectedMigration.name,
        checksum: migrationChecksum(expectedMigration)
      });
      expect(new SettingsRepository(reopened).get<{ mode: string }>('theme')?.value.mode).toBe(
        'dark'
      );
    } finally {
      reopened.close();
    }
  });

  test('DB-03 applies the initial schema to a zero-version fixture', async () => {
    const path = await databasePath();
    const fixture = new Database(path, { create: true, strict: true });
    fixture.exec('CREATE TABLE fixture_data(value TEXT NOT NULL);');
    fixture.query('INSERT INTO fixture_data(value) VALUES (?)').run('retained');
    fixture.close();

    const upgraded = await openDatabase(path);
    try {
      expect(
        upgraded.query<{ value: string }, []>('SELECT value FROM fixture_data').get()?.value
      ).toBe('retained');
      expect(databaseHealth(upgraded).schemaVersion).toBe(DATABASE_SCHEMA_VERSION);
    } finally {
      upgraded.close();
    }
  });

  test('DB-04 rolls back a failed migration and reports no half schema', async () => {
    const path = await databasePath();
    const database = new Database(path, { create: true, strict: true });
    database.exec('PRAGMA foreign_keys = ON;');
    const broken: Migration = {
      version: 1,
      name: 'broken migration',
      sql: 'CREATE TABLE half_applied(id INTEGER PRIMARY KEY); INVALID SQL;'
    };

    expect(() => migrateDatabase(database, [broken])).toThrow();
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'half_applied'"
        )
        .get()?.count
    ).toBe(0);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM schema_migrations').get()
        ?.count
    ).toBe(0);
    database.close();
  });

  test('rejects changed migration contents after checksum recording', async () => {
    const path = await databasePath();
    const migration: Migration = {
      version: 1,
      name: 'fixture',
      sql: 'CREATE TABLE fixture(id INTEGER PRIMARY KEY);'
    };
    const database = new Database(path, { create: true, strict: true });
    migrateDatabase(database, [migration]);
    expect(migrationChecksum(migration)).toHaveLength(64);

    expect(() =>
      migrateDatabase(database, [{ ...migration, sql: `${migration.sql} SELECT 1;` }])
    ).toThrow('checksum');
    database.close();
  });
});

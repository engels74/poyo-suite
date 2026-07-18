import { constants, Database } from 'bun:sqlite';
import { lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type AppliedMigration,
  migrations as defaultMigrations,
  type Migration
} from '../../../../migrations';
import { DATABASE_SCHEMA_VERSION } from './version';

const migrationTableSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`;

export interface OpenDatabaseOptions {
  migrations?: readonly Migration[];
  now?: () => Date;
}

export interface MigrationResult {
  currentVersion: number;
  appliedVersions: number[];
}

export class DatabasePreflightError extends Error {
  constructor(
    readonly code:
      | 'database_not_regular'
      | 'database_pending_journal'
      | 'database_unknown'
      | 'database_incompatible',
    message: string
  ) {
    super(message);
    this.name = 'DatabasePreflightError';
  }
}

export interface DatabasePreflightResult {
  state: 'absent' | 'compatible';
  maxVersion: number | null;
}

interface MigrationIdentity {
  version: number;
  name: string;
  checksum: string;
}

let defaultCanonicalSchemaSignature: string | null = null;

export function canonicalDatabaseSchemaSignature(
  registeredMigrations: readonly Migration[] = defaultMigrations,
  maximumVersion = DATABASE_SCHEMA_VERSION
): string {
  const migrations = registeredMigrations.filter(
    (migration) => migration.version <= maximumVersion
  );
  const isDefault =
    registeredMigrations === defaultMigrations && maximumVersion === DATABASE_SCHEMA_VERSION;
  if (isDefault && defaultCanonicalSchemaSignature) return defaultCanonicalSchemaSignature;

  const database = new Database(':memory:', { strict: true });
  try {
    migrateDatabase(database, migrations, () => new Date(0));
    const signature = databaseSchemaSignature(database);
    if (isDefault) defaultCanonicalSchemaSignature = signature;
    return signature;
  } finally {
    database.close();
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await lstat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function preflightDatabase(
  path: string,
  maximumVersion = DATABASE_SCHEMA_VERSION,
  registeredMigrations: readonly Migration[] = defaultMigrations
): Promise<DatabasePreflightResult> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'absent', maxVersion: null };
    }
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new DatabasePreflightError(
      'database_not_regular',
      'The selected database is not a regular file.'
    );
  }
  // A clean WAL-mode close may retain an SHM index beside an empty WAL. The SHM file contains no
  // database changes, so only journal files that can carry unapplied pages make immutable
  // inspection unsafe.
  for (const sidecar of [`${path}-wal`, `${path}-journal`]) {
    const size = await fileSize(sidecar);
    if (size !== null && size !== 0) {
      throw new DatabasePreflightError(
        'database_pending_journal',
        'The selected database has pending recovery state and cannot be inspected safely.'
      );
    }
  }

  const header = new Uint8Array(await Bun.file(path).slice(0, 16).arrayBuffer());
  const expectedHeader = new TextEncoder().encode('SQLite format 3\0');
  if (
    header.length !== expectedHeader.length ||
    header.some((value, index) => value !== expectedHeader[index])
  ) {
    throw new DatabasePreflightError(
      'database_unknown',
      'The selected database is not recognized.'
    );
  }

  const uri = `${pathToFileURL(path).href}?mode=ro&immutable=1`;
  let database: Database | undefined;
  try {
    database = new Database(
      uri,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOMUTEX
    );
    const migrationTable = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
      )
      .get()?.count;
    if (migrationTable !== 1) {
      throw new DatabasePreflightError(
        'database_unknown',
        'The selected database does not contain recognized migration metadata.'
      );
    }
    const applied = database
      .query<MigrationIdentity, []>(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
      )
      .all();
    const maxVersion = applied.at(-1)?.version;
    if (!Number.isSafeInteger(maxVersion) || maxVersion === undefined || maxVersion < 1) {
      throw new DatabasePreflightError(
        'database_unknown',
        'The selected database migration history is incomplete.'
      );
    }
    if (maxVersion > maximumVersion) {
      throw new DatabasePreflightError(
        'database_incompatible',
        `Database schema ${maxVersion} is incompatible with this fresh-only application schema.`
      );
    }
    const expected = registeredMigrations
      .filter((migration) => migration.version <= maximumVersion)
      .map((migration) => ({
        version: migration.version,
        name: migration.name,
        checksum: migrationChecksum(migration)
      }));
    if (JSON.stringify(applied) !== JSON.stringify(expected)) {
      throw new DatabasePreflightError(
        'database_incompatible',
        'The selected database migration identity does not match this fresh-only application schema.'
      );
    }
    const integrity = database.query<Record<string, string>, []>('PRAGMA integrity_check').all();
    if (
      integrity.length !== 1 ||
      Object.values(integrity[0] ?? {}).length !== 1 ||
      Object.values(integrity[0] ?? {})[0] !== 'ok'
    ) {
      throw new DatabasePreflightError(
        'database_incompatible',
        'The selected database failed its read-only integrity check.'
      );
    }
    if (database.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all().length > 0) {
      throw new DatabasePreflightError(
        'database_incompatible',
        'The selected database failed its read-only foreign-key check.'
      );
    }
    if (
      databaseSchemaSignature(database) !==
      canonicalDatabaseSchemaSignature(registeredMigrations, maximumVersion)
    ) {
      throw new DatabasePreflightError(
        'database_incompatible',
        'The selected database schema does not match the canonical application schema.'
      );
    }
    return { state: 'compatible', maxVersion };
  } catch (error) {
    if (error instanceof DatabasePreflightError) throw error;
    throw new DatabasePreflightError(
      'database_unknown',
      'The selected database could not be inspected safely.'
    );
  } finally {
    database?.close();
  }
}

export function databaseSchemaSignature(database: Database): string {
  const schema = database
    .query<{ type: string; name: string; tableName: string; sql: string | null }, []>(
      `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%'
       ORDER BY type, name, tbl_name`
    )
    .all();
  const migrations = database
    .query<MigrationIdentity, []>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version'
    )
    .all();
  return new Bun.CryptoHasher('sha256')
    .update(JSON.stringify({ schema, migrations }))
    .digest('hex');
}

export function migrationChecksum(migration: Pick<Migration, 'name' | 'sql'>): string {
  return new Bun.CryptoHasher('sha256')
    .update(`${migration.name}\n${migration.sql.trim()}\n`)
    .digest('hex');
}

function assertOrderedMigrations(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previous) {
      throw new Error('Migrations must have unique, strictly increasing positive versions.');
    }
    previous = migration.version;
  }
}

export function migrateDatabase(
  database: Database,
  migrations: readonly Migration[] = defaultMigrations,
  now: () => Date = () => new Date()
): MigrationResult {
  assertOrderedMigrations(migrations);
  database.exec(migrationTableSql);

  const applied = database
    .query<AppliedMigration, []>(
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version'
    )
    .all();
  const byVersion = new Map(applied.map((migration) => [migration.version, migration]));
  const knownVersions = new Set(migrations.map((migration) => migration.version));

  for (const recorded of applied) {
    const expected = migrations.find((migration) => migration.version === recorded.version);
    if (!expected) {
      throw new Error(`Database contains unknown migration version ${recorded.version}.`);
    }
    if (recorded.name !== expected.name || recorded.checksum !== migrationChecksum(expected)) {
      throw new Error(`Migration ${recorded.version} no longer matches its recorded checksum.`);
    }
  }

  const appliedVersions: number[] = [];
  const apply = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    migration.afterSql?.(database);
    database
      .query(
        'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)'
      )
      .run(migration.version, migration.name, migrationChecksum(migration), now().toISOString());
  });

  for (const migration of migrations) {
    if (byVersion.has(migration.version)) continue;
    apply(migration);
    appliedVersions.push(migration.version);
  }

  const currentVersion = database
    .query<{ version: number }, []>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations'
    )
    .get()?.version;

  if (currentVersion === undefined || !knownVersions.has(currentVersion)) {
    throw new Error('Database schema version could not be verified.');
  }
  if (migrations === defaultMigrations && currentVersion !== DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${currentVersion} does not match application schema ${DATABASE_SCHEMA_VERSION}.`
    );
  }

  return { currentVersion, appliedVersions };
}

export async function openDatabase(
  path: string,
  options: OpenDatabaseOptions = {}
): Promise<Database> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path, { create: true, strict: true });

  try {
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA busy_timeout = 5000;');
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA synchronous = NORMAL;');
    migrateDatabase(database, options.migrations, options.now);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function inTransaction<T>(database: Database, operation: () => T): T {
  return database.transaction(operation)();
}

export function databaseHealth(database: Database): {
  quickCheck: 'ok' | 'error';
  foreignKeys: boolean;
  schemaVersion: number;
} {
  const quickCheck = database.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
  const foreignKeys = database.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
  const schema = database
    .query<{ version: number }, []>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations'
    )
    .get();

  return {
    quickCheck: quickCheck?.quick_check === 'ok' ? 'ok' : 'error',
    foreignKeys: foreignKeys?.foreign_keys === 1,
    schemaVersion: schema?.version ?? 0
  };
}

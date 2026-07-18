import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { migrations } from '../migrations';
import { migrationChecksum, openDatabase } from '../src/lib/server/platform/database';
import { databaseSchemaSignature } from '../tests/helpers/database-schema-signature';

const repositoryRoot = resolve(import.meta.dir, '..');
const fixturePath = join(
  repositoryRoot,
  'tests',
  'fixtures',
  'database',
  'pre-collapse-schema-signature.json'
);
const legacyMigrationFiles = [
  'migrations/0001-initial.ts',
  'migrations/0002-cleanup-operations.ts',
  'migrations/0003-managed-sources.ts',
  'migrations/0004-output-dimensions.ts'
] as const;
const immutableFixtureSha256 = 'b78ed9dcbf7c03d495f07efde2c55530e78e31281cf6b4e943689a77c75af718';

async function legacySourceIntact(): Promise<boolean> {
  const versions = migrations.map((migration) => migration.version);
  const filesExist = await Promise.all(
    legacyMigrationFiles.map((file) => Bun.file(join(repositoryRoot, file)).exists())
  );
  return (
    versions.length === 4 &&
    versions.every((version, index) => version === index + 1) &&
    filesExist.every(Boolean)
  );
}

async function assertPreCollapseSource(): Promise<void> {
  if (!(await legacySourceIntact())) {
    throw new Error(
      'Refusing to generate the pre-collapse schema fixture: the registered 0001-0004 legacy chain is no longer intact. Regenerating from the collapsed migration would be tautological.'
    );
  }
}

async function assertCollapsedSchemaMatchesFixture(existing: string): Promise<void> {
  const laterFilesExist = await Promise.all(
    legacyMigrationFiles.slice(1).map((file) => Bun.file(join(repositoryRoot, file)).exists())
  );
  if (migrations.length !== 1 || migrations[0]?.version !== 1 || laterFilesExist.some(Boolean)) {
    throw new Error(
      'The legacy migration chain is absent, but the registered migration set is not the expected collapsed version-1 schema.'
    );
  }
  const hash = createHash('sha256').update(existing).digest('hex');
  if (hash !== immutableFixtureSha256) {
    throw new Error('The immutable pre-collapse schema fixture content has changed.');
  }

  const fixture = JSON.parse(existing) as {
    schema: ReturnType<typeof databaseSchemaSignature>;
  };
  const temporary = await mkdtemp(join(tmpdir(), 'poyo-collapsed-schema-'));
  const database = await openDatabase(join(temporary, 'studio.sqlite'));
  try {
    if (JSON.stringify(databaseSchemaSignature(database)) !== JSON.stringify(fixture.schema)) {
      throw new Error(
        'The collapsed version-1 migration does not match the immutable pre-collapse schema fixture.'
      );
    }
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function candidateFixture(): Promise<string> {
  await assertPreCollapseSource();
  const temporary = await mkdtemp(join(tmpdir(), 'poyo-pre-collapse-schema-'));
  const database = await openDatabase(join(temporary, 'studio.sqlite'));
  try {
    return `${JSON.stringify(
      {
        formatVersion: 1,
        source: {
          migrationFiles: legacyMigrationFiles,
          migrations: migrations.map((migration) => ({
            version: migration.version,
            name: migration.name,
            checksum: migrationChecksum(migration)
          }))
        },
        schema: databaseSchemaSignature(database)
      },
      null,
      2
    )}\n`;
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? '--check';
  if (mode !== '--check' && mode !== '--write') {
    throw new Error(
      'Usage: bun scripts/generate-pre-collapse-schema-signature.ts [--check|--write]'
    );
  }

  const fixtureExists = await Bun.file(fixturePath).exists();
  if (mode === '--write') {
    const candidate = await candidateFixture();
    if (fixtureExists) {
      const existing = await Bun.file(fixturePath).text();
      if (existing !== candidate) {
        throw new Error(
          'Refusing to overwrite the immutable pre-collapse schema fixture with different content.'
        );
      }
      console.log('Pre-collapse schema fixture already matches the intact legacy chain.');
      return;
    }
    await mkdir(dirname(fixturePath), { recursive: true });
    await Bun.write(fixturePath, candidate);
    console.log(`Wrote immutable pre-collapse schema fixture: ${fixturePath}`);
    return;
  }

  if (!fixtureExists) throw new Error(`Missing pre-collapse schema fixture: ${fixturePath}`);
  const existing = await Bun.file(fixturePath).text();
  if (await legacySourceIntact()) {
    if (existing !== (await candidateFixture())) {
      throw new Error(
        'Pre-collapse schema fixture does not match the intact legacy migration chain.'
      );
    }
    console.log('Pre-collapse schema fixture matches the intact legacy migration chain.');
    return;
  }
  await assertCollapsedSchemaMatchesFixture(existing);
  console.log('Collapsed version-1 schema matches the immutable pre-collapse schema fixture.');
}

if (import.meta.main) await main();

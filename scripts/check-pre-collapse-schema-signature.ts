import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/lib/server/platform/database';
import { databaseSchemaSignature } from '../tests/helpers/database-schema-signature';

const repositoryRoot = resolve(import.meta.dir, '..');
const fixturePath = join(
  repositoryRoot,
  'tests',
  'fixtures',
  'database',
  'pre-collapse-schema-signature.json'
);
const immutableFixtureSha256 = 'b78ed9dcbf7c03d495f07efde2c55530e78e31281cf6b4e943689a77c75af718';

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    throw new Error('Usage: bun scripts/check-pre-collapse-schema-signature.ts');
  }

  if (!(await Bun.file(fixturePath).exists())) {
    throw new Error(`Missing immutable historical schema fixture: ${fixturePath}`);
  }

  const existing = await Bun.file(fixturePath).text();
  const hash = createHash('sha256').update(existing).digest('hex');
  if (hash !== immutableFixtureSha256) {
    throw new Error('The immutable historical schema fixture content has changed.');
  }

  const fixture = JSON.parse(existing) as {
    schema: ReturnType<typeof databaseSchemaSignature>;
  };
  const temporary = await mkdtemp(join(tmpdir(), 'poyo-schema-signature-'));
  const database = await openDatabase(join(temporary, 'studio.sqlite'));
  try {
    if (JSON.stringify(databaseSchemaSignature(database)) !== JSON.stringify(fixture.schema)) {
      throw new Error(
        'The current version-1 schema does not match the immutable historical fixture.'
      );
    }
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }

  console.log('Current version-1 schema matches the immutable historical fixture.');
}

if (import.meta.main) await main();

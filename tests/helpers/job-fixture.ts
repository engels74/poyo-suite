import { join } from 'node:path';
import { JobRepository } from '../../src/lib/server/jobs/repository';
import { openDatabase } from '../../src/lib/server/platform/database';
import { createTemporaryDirectory } from './temporary-directory';

export async function createJobFixture(now = new Date('2026-07-15T12:00:00Z')) {
  const temporary = await createTemporaryDirectory('poyo-jobs-');
  const database = await openDatabase(join(temporary.path, 'studio.sqlite'));
  let current = now;
  const repository = new JobRepository(database, () => current);
  return {
    database,
    repository,
    paths: {
      media: join(temporary.path, 'media'),
      uploads: join(temporary.path, 'uploads'),
      temporary: join(temporary.path, 'tmp')
    },
    setNow(value: Date) {
      current = value;
    },
    cleanup: async () => {
      database.close();
      await temporary.cleanup();
    }
  };
}

export function createTestJob(repository: JobRepository, suffix: string = crypto.randomUUID()) {
  return repository.create({
    actionId: crypto.randomUUID(),
    workflow: 'text-to-image',
    publicModelId: 'provider/model',
    guidedRequest: { prompt: `calm coast ${suffix}` },
    normalizedPayload: { model: 'provider/model', input: { prompt: `calm coast ${suffix}` } },
    correlationId: `correlation-${suffix}`
  });
}

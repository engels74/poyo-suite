import { join } from 'node:path';
import { JobCoordinator } from '../../src/lib/server/jobs/coordinator';
import { OutputDownloader } from '../../src/lib/server/jobs/downloader';
import { JobRepository } from '../../src/lib/server/jobs/repository';
import { runtimeTestDownloadTransport } from '../../src/lib/server/jobs/runtime-settings';
import { openDatabase } from '../../src/lib/server/platform/database';
import { PoyoClient } from '../../src/lib/server/poyo/client';
import { systemClock } from '../../src/lib/server/poyo/backoff';
import { PoyoTransport } from '../../src/lib/server/poyo/transport';

const [mode, root, baseUrl] = Bun.argv.slice(2);
if (!mode || !root || !baseUrl || !['submit', 'recover'].includes(mode)) {
  throw new Error('Usage: restart-worker.ts <submit|recover> <root> <mock-base-url>');
}

const database = await openDatabase(join(root, 'studio.sqlite'));
try {
  const repository = new JobRepository(database);
  const client = new PoyoClient(
    new PoyoTransport({
      apiKey: ['sk', 'restart_suite_synthetic_123456'].join('-'),
      baseUrl,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 }
    }),
    systemClock
  );
  const coordinator = new JobCoordinator({
    repository,
    poyo: client,
    downloader: new OutputDownloader({
      repository,
      paths: { media: join(root, 'media'), temporary: join(root, 'tmp') },
      ...runtimeTestDownloadTransport({
        PLS_TEST_MODE: '1',
        PLS_TEST_POYO_BASE_URL: baseUrl
      })
    }),
    workerId: `process-${mode}`
  });

  if (mode === 'submit') {
    const job = repository.create({
      actionId: crypto.randomUUID(),
      workflow: 'text-to-image',
      publicModelId: 'flux-schnell',
      guidedRequest: { prompt: 'restart recovery fixture' },
      normalizedPayload: {
        model: 'flux-schnell',
        input: { prompt: 'restart recovery fixture' }
      }
    });
    await coordinator.submit(job.id);
    console.log(JSON.stringify({ jobId: job.id, phase: repository.get(job.id)?.localPhase }));
  } else {
    const job = repository.listActive()[0];
    if (!job) throw new Error('No active persisted job was available for recovery.');
    await coordinator.poll(job.id, true);
    await coordinator.poll(job.id, true);
    console.log(JSON.stringify({ jobId: job.id, phase: repository.get(job.id)?.localPhase }));
  }
} finally {
  database.close();
}

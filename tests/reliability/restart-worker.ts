import { join } from 'node:path';
import { JobCoordinator } from '../../src/lib/server/jobs/coordinator';
import { OutputDownloader } from '../../src/lib/server/jobs/downloader';
import { JobRepository } from '../../src/lib/server/jobs/repository';
import { runtimeTestDownloadTransport } from '../../src/lib/server/jobs/runtime-settings';
import { openDatabase } from '../../src/lib/server/platform/database';
import { PublicIpv4Service } from '../../src/lib/server/platform/public-ipv4';
import { PoyoClient } from '../../src/lib/server/poyo/client';
import { systemClock } from '../../src/lib/server/poyo/backoff';
import { PoyoTransport } from '../../src/lib/server/poyo/transport';
import { SettingsRepository } from '../../src/lib/server/settings/settings-repository';

const [mode, root, baseUrl] = Bun.argv.slice(2);
if (
  !mode ||
  !root ||
  !baseUrl ||
  !['submit', 'recover', 'enqueue-guarded', 'recover-guarded'].includes(mode)
) {
  throw new Error(
    'Usage: restart-worker.ts <submit|recover|enqueue-guarded|recover-guarded> <root> <mock-base-url>'
  );
}

const database = await openDatabase(join(root, 'studio.sqlite'));
try {
  const repository = new JobRepository(database);
  const publicIpv4 = new PublicIpv4Service({
    settings: new SettingsRepository(database),
    lookupUrl: `${baseUrl}/ip`
  });
  const client = new PoyoClient(
    new PoyoTransport({
      apiKey: ['sk', 'restart_suite_synthetic_123456'].join('-'),
      baseUrl,
      retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      beforeRequest: (operation) => publicIpv4.assertPoyoRequestAllowed(operation)
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

  if (mode === 'submit' || mode === 'enqueue-guarded') {
    if (mode === 'enqueue-guarded') {
      publicIpv4.saveSettings({ enabled: true, homeIpv4: '8.8.4.4' });
    }
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
    if (mode === 'submit') await coordinator.submit(job.id);
    const persisted = repository.get(job.id);
    console.log(
      JSON.stringify({
        jobId: job.id,
        phase: persisted?.localPhase,
        attentionCode: persisted?.attentionCode
      })
    );
  } else if (mode === 'recover-guarded') {
    const job = repository.listActive()[0];
    if (!job) throw new Error('No active persisted job was available for guarded recovery.');
    await coordinator.submit(job.id);
    const persisted = repository.get(job.id);
    console.log(
      JSON.stringify({
        jobId: job.id,
        phase: persisted?.localPhase,
        attentionCode: persisted?.attentionCode
      })
    );
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

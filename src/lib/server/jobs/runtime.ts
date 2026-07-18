import { maintenanceGate } from '../platform/maintenance-gate';
import { getPlatformServices } from '../platform/runtime';
import { createPoyoClient } from '../poyo/factory';
import { JobCoordinator, type JobPoyoGateway, JobWorker } from './coordinator';
import { OutputDownloader } from './downloader';
import { JobRepository } from './repository';
import {
  runtimeJobTimings,
  runtimeOperationsSettings,
  runtimeTestDownloadTransport
} from './runtime-settings';

export interface JobRuntime {
  repository: JobRepository;
  coordinator: JobCoordinator;
  worker: JobWorker;
}
let runtimePromise: Promise<JobRuntime> | undefined;
let stopWorker: (() => void) | undefined;

async function createRuntime(): Promise<JobRuntime> {
  const platform = await getPlatformServices();
  const timings = runtimeJobTimings(platform.environment);
  const repository = new JobRepository(platform.database);
  const createGatewayClient = () =>
    createPoyoClient({
      apiKeyManager: platform.apiKey,
      logger: platform.logger,
      environment: platform.environment
    });
  const gateway: JobPoyoGateway = {
    submit: async (request) => (await createGatewayClient()).submit(request),
    getStatus: async (id) => (await createGatewayClient()).getStatus(id),
    getBalance: async () => (await createGatewayClient()).getBalance()
  };
  const downloader = new OutputDownloader({
    repository,
    paths: platform.paths,
    logger: platform.logger,
    ...runtimeTestDownloadTransport(platform.environment)
  });
  const coordinator = new JobCoordinator({
    repository,
    poyo: gateway,
    downloader,
    runtimeSettings: () => {
      const operations = runtimeOperationsSettings(
        platform.settings.get<unknown>('operations')?.value
      );
      return {
        pollDelayMs: timings.pollDelayMs ?? operations.polling.intervalMs,
        staleAfterMs: operations.polling.staleAfterMs,
        automaticDownloads: operations.downloads.automatic
      };
    }
  });
  const runtime = {
    repository,
    coordinator,
    worker: new JobWorker(coordinator, timings.workerIntervalMs, maintenanceGate)
  };
  maintenanceGate.registerDrain('job-worker', async () => {
    stopWorker?.();
    stopWorker = undefined;
    await runtime.worker.stopAndDrain();
  });
  return runtime;
}
export function getJobRuntime(): Promise<JobRuntime> {
  runtimePromise ??= createRuntime().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}
export async function startRuntimeJobWorker(): Promise<void> {
  if (stopWorker) return;
  const runtime = await getJobRuntime();
  stopWorker = runtime.worker.start();
}
export async function stopRuntimeJobWorker(): Promise<void> {
  stopWorker?.();
  stopWorker = undefined;
  if (runtimePromise) await (await runtimePromise).worker.stopAndDrain();
}

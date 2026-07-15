export async function init(): Promise<void> {
  const { startRuntimeJobWorker } = await import('$lib/server/jobs/runtime');
  const { startRuntimeCleanupWorker } = await import('$lib/server/cleanup/runtime');
  await Promise.all([startRuntimeJobWorker(), startRuntimeCleanupWorker()]);
}

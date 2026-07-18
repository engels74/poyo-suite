import { startRuntimeCleanupWorker } from '$lib/server/cleanup/runtime';
import { startRuntimeJobWorker } from '$lib/server/jobs/runtime';
import { operationsHttpError } from '$lib/server/operations/http';
import { maintenanceGate } from '$lib/server/platform/maintenance-gate';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<{ action?: unknown }>(request, { maxBytes: 1024 });
    if (
      body.action !== 'abandon' &&
      body.action !== 'resume-transition' &&
      body.action !== 'retry-cleanup' &&
      body.action !== 'acknowledge-retained-source' &&
      body.action !== 'reauthorize-replacement'
    ) {
      return Response.json(
        {
          error: {
            code: 'invalid_conflict_action',
            message: 'A currently offered credential recovery action is required.'
          }
        },
        { status: 400 }
      );
    }
    const platform = await getPlatformServices();
    const initiator = maintenanceGate.acquireMaintenanceInitiator('http:credential-conflict');
    const lease = await maintenanceGate.upgradeToExclusiveMaintenance(initiator);
    try {
      const apiKey = await platform.apiKey.resolveTransitionConflict(body.action);
      platform.logger.resumeBeforePublication();
      await Promise.all([startRuntimeJobWorker(), startRuntimeCleanupWorker()]);
      lease.reopenBeforePublication();
      return Response.json({ apiKey }, { status: apiKey.transition ? 202 : 200 });
    } catch (error) {
      try {
        platform.logger.resumeBeforePublication();
        await Promise.all([startRuntimeJobWorker(), startRuntimeCleanupWorker()]);
        lease.reopenBeforePublication();
      } catch {
        lease.freezeUntilRestart();
      }
      throw error;
    }
  } catch (error) {
    return operationsHttpError(error);
  }
};

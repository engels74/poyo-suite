import { startRuntimeCleanupWorker } from '$lib/server/cleanup/runtime';
import { startRuntimeJobWorker } from '$lib/server/jobs/runtime';
import { operationsHttpError } from '$lib/server/operations/http';
import { maintenanceGate } from '$lib/server/platform/maintenance-gate';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<{
      backend?: unknown;
      apiKey?: unknown;
      replaceExisting?: unknown;
    }>(request, { maxBytes: 8 * 1024 });
    if (body.backend !== 'file' && body.backend !== 'os') {
      return Response.json(
        { error: { code: 'invalid_backend', message: 'A file or OS backend is required.' } },
        { status: 400 }
      );
    }
    if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
      return Response.json(
        { error: { code: 'invalid_api_key', message: 'The API key must be text.' } },
        { status: 400 }
      );
    }
    if (body.replaceExisting !== undefined && typeof body.replaceExisting !== 'boolean') {
      return Response.json(
        {
          error: {
            code: 'invalid_replacement_approval',
            message: 'Replacement approval must be true or false.'
          }
        },
        { status: 400 }
      );
    }

    const platform = await getPlatformServices();
    const initiator = maintenanceGate.acquireMaintenanceInitiator('http:credential-backend');
    const lease = await maintenanceGate.upgradeToExclusiveMaintenance(initiator);
    try {
      const apiKey = await platform.apiKey.switchBackend({
        backend: body.backend,
        ...(typeof body.apiKey === 'string' ? { secret: body.apiKey } : {}),
        ...(typeof body.replaceExisting === 'boolean'
          ? { replaceExisting: body.replaceExisting }
          : {})
      });
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

import { getPlatformServices } from '$lib/server/platform/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { operationsHttpError } from '$lib/server/operations/http';
import { OperationsSettingsService } from '$lib/server/settings/operations-settings';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  const platform = await getPlatformServices();
  const service = new OperationsSettingsService(
    platform.settings,
    platform.database,
    platform.logger
  );
  return Response.json({ settings: service.dto(platform.paths, await platform.apiKey.status()) });
};

export const PUT: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<{ operations?: unknown; localCleanup?: unknown }>(
      request,
      { maxBytes: 32 * 1024 }
    );
    const platform = await getPlatformServices();
    const service = new OperationsSettingsService(
      platform.settings,
      platform.database,
      platform.logger
    );
    service.update(body);
    return Response.json({ settings: service.dto(platform.paths, await platform.apiKey.status()) });
  } catch (error) {
    return operationsHttpError(error);
  }
};

import { getCleanupRuntime } from '$lib/server/cleanup/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { operationsHttpError } from '$lib/server/operations/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<{ token?: unknown; confirmed?: unknown }>(request, {
      maxBytes: 4 * 1024
    });
    const runtime = await getCleanupRuntime();
    const scheduled = runtime.options.service.apply(body.token, body.confirmed);
    void runtime.runOnce().catch(() => undefined);
    return Response.json(scheduled, { status: 202 });
  } catch (error) {
    return operationsHttpError(error);
  }
};

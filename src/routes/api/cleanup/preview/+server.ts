import { getCleanupRuntime } from '$lib/server/cleanup/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { operationsHttpError } from '$lib/server/operations/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<{ consequence?: unknown }>(request, {
      maxBytes: 4 * 1024
    });
    const runtime = await getCleanupRuntime();
    return Response.json({ preview: await runtime.options.service.preview(body.consequence) });
  } catch (error) {
    return operationsHttpError(error);
  }
};

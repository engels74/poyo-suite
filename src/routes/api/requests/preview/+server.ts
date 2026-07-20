import { RegistryValidationError } from '$lib/features/registry/normalize';
import { getJobRuntime } from '$lib/server/jobs/runtime';
import { readSameOriginJson, RequestSecurityError } from '$lib/server/platform/request-security';
import { getPlatformServices } from '$lib/server/platform/runtime';
import {
  normalizeEstimatedRegistryRequest,
  type RegistryPreviewRequest
} from '$lib/server/pricing/estimate-request';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await readSameOriginJson<RegistryPreviewRequest>(request, {
      maxBytes: 256 * 1024
    });
    const platform = await getPlatformServices();
    const runtime = await getJobRuntime();
    return Response.json(
      normalizeEstimatedRegistryRequest(body, platform.pricing, runtime.repository)
    );
  } catch (error) {
    if (error instanceof RequestSecurityError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status }
      );
    if (error instanceof RegistryValidationError)
      return Response.json(
        { error: { code: 'registry_validation', issues: error.issues } },
        { status: 422 }
      );
    return Response.json(
      { error: { code: 'preview_failed', message: 'The request preview could not be created.' } },
      { status: 400 }
    );
  }
};

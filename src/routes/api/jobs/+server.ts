import {
  isPaidActionId,
  JobRequestError,
  prepareJobCreateRequest
} from '$lib/server/jobs/create-request';
import { safeJobDto } from '$lib/server/jobs/events';
import { jobHttpError } from '$lib/server/jobs/http';
import { createManagedSourceResolver } from '$lib/server/jobs/managed-source-upload';
import { getJobRuntime } from '$lib/server/jobs/runtime';
import { runtimeJobCreateDelay } from '$lib/server/jobs/runtime-settings';
import { maintenanceGate } from '$lib/server/platform/maintenance-gate';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { withEstimatedJobCreateRequest } from '$lib/server/pricing/estimate-request';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  try {
    const actionId = url.searchParams.get('actionId');
    if (!isPaidActionId(actionId))
      throw new JobRequestError('invalid_action_id', 'A stable opaque action ID is required.');
    const runtime = await getJobRuntime();
    const job = runtime.repository.getByActionId(actionId);
    return job
      ? Response.json({ job: safeJobDto(job) })
      : Response.json({ error: { code: 'job_not_found' } }, { status: 404 });
  } catch (error) {
    return jobHttpError(error);
  }
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    const input = await readSameOriginJson<unknown>(request);
    const platform = await getPlatformServices();
    const createDelay = runtimeJobCreateDelay(platform.environment);
    if (createDelay) await Bun.sleep(createDelay);
    const runtime = await getJobRuntime();
    const prepared = await prepareJobCreateRequest(
      platform.database,
      input,
      createManagedSourceResolver(platform)
    );
    const estimated = withEstimatedJobCreateRequest(prepared, platform.pricing, runtime.repository);
    const job = runtime.repository.create(estimated);
    void maintenanceGate
      .trackDetached('jobs.reconcile-created', () => runtime.coordinator.reconcile(job.id))
      .catch(() => undefined);
    return Response.json({ job: safeJobDto(job) }, { status: 202 });
  } catch (error) {
    return jobHttpError(error);
  }
};

import {
  isPaidActionId,
  JobRequestError,
  prepareJobCreateRequest
} from '$lib/server/jobs/create-request';
import { safeJobDto } from '$lib/server/jobs/events';
import { jobHttpError } from '$lib/server/jobs/http';
import { getJobRuntime } from '$lib/server/jobs/runtime';
import { runtimeJobCreateDelay } from '$lib/server/jobs/runtime-settings';
import { ManagedSourceRepository } from '$lib/server/media/managed-sources';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { getPlatformServices } from '$lib/server/platform/runtime';
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
    const managedSources = new ManagedSourceRepository(platform.database, platform.paths);
    const prepared = await prepareJobCreateRequest(
      platform.database,
      input,
      (localSourceId, mediaKind) => managedSources.resolveAvailable(localSourceId, mediaKind)
    );
    const runtime = await getJobRuntime();
    const job = runtime.repository.create(prepared);
    void runtime.coordinator.reconcile(job.id).catch(() => undefined);
    return Response.json({ job: safeJobDto(job) }, { status: 202 });
  } catch (error) {
    return jobHttpError(error);
  }
};

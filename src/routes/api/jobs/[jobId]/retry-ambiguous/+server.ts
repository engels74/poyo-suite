import { JobRequestError } from '$lib/server/jobs/create-request';
import { safeJobDto } from '$lib/server/jobs/events';
import { jobHttpError } from '$lib/server/jobs/http';
import { getJobRuntime } from '$lib/server/jobs/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const body = await readSameOriginJson<{
      acknowledgeDuplicateSpendRisk: boolean;
      actionId: string;
    }>(request, { maxBytes: 1024 });
    if (body.acknowledgeDuplicateSpendRisk !== true)
      throw new JobRequestError(
        'duplicate_spend_acknowledgement_required',
        'Explicit acknowledgement of duplicate-spend risk is required.'
      );
    const runtime = await getJobRuntime();
    const job = runtime.repository.retryAmbiguous(params.jobId, body.actionId);
    void runtime.coordinator.reconcile(job.id).catch(() => undefined);
    return Response.json({ job: safeJobDto(job) }, { status: 202 });
  } catch (error) {
    return jobHttpError(error);
  }
};

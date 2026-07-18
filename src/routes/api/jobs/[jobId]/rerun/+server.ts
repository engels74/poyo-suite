import { JobRequestError } from '$lib/server/jobs/create-request';
import { safeJobDto } from '$lib/server/jobs/events';
import { jobHttpError } from '$lib/server/jobs/http';
import { createManagedSourceUploadRefresher } from '$lib/server/jobs/managed-source-upload';
import { getJobRuntime } from '$lib/server/jobs/runtime';
import { maintenanceGate } from '$lib/server/platform/maintenance-gate';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import { getPlatformServices } from '$lib/server/platform/runtime';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    const body = await readSameOriginJson<{
      acknowledgeNewPaidJob: boolean;
      actionId: string;
    }>(request, {
      maxBytes: 1024
    });
    if (body.acknowledgeNewPaidJob !== true)
      throw new JobRequestError(
        'paid_action_acknowledgement_required',
        'Explicit acknowledgement is required for a new paid job.'
      );
    const platform = await getPlatformServices();
    const runtime = await getJobRuntime();
    const job = await runtime.repository.rerunAsNew(
      params.jobId,
      body.actionId,
      createManagedSourceUploadRefresher(platform)
    );
    void maintenanceGate
      .trackDetached('jobs.reconcile-rerun', () => runtime.coordinator.reconcile(job.id))
      .catch(() => undefined);
    return Response.json({ job: safeJobDto(job) }, { status: 202 });
  } catch (error) {
    return jobHttpError(error);
  }
};

import type { StudioOutputDto } from '$lib/features/generation/contracts';
import { LibraryRepository } from '$lib/server/library/repository';
import { getJobRuntime } from '$lib/server/jobs/runtime';
import { getPlatformServices } from '$lib/server/platform/runtime';
import type { RequestHandler } from './$types';

/**
 * Verified outputs for a single job, projected to the minimal shape the studio result stage
 * needs. `mediaUrl` is only populated once an output is locally verified, so a completed job's
 * media is never shown before it is actually available on disk.
 */
export const GET: RequestHandler = async ({ params, setHeaders }) => {
  setHeaders({ 'cache-control': 'no-store' });
  const platform = await getPlatformServices();
  const runtime = await getJobRuntime();
  const detail = await new LibraryRepository(platform.database).getJobDetail(params.jobId);
  // Return JSON (matching the success shape and the sibling api/jobs job_not_found response) so the
  // studio's loadOutputs(), which always `await response.json()`s, can read a not-found error rather
  // than hitting a parse failure that erases the 404 context.
  if (!detail) return Response.json({ error: { code: 'job_not_found' } }, { status: 404 });
  const outputs: StudioOutputDto[] = detail.outputs.map((output) => ({
    outputId: output.outputId,
    mediaKind: output.mediaKind,
    mediaUrl: output.mediaUrl,
    aspectRatio: output.aspectRatio,
    pixelWidth: output.pixelWidth,
    pixelHeight: output.pixelHeight,
    fileName: output.fileName,
    downloadState: output.downloadState,
    localAvailable: output.localAvailable
  }));
  return Response.json({
    outputs,
    actualCredits: detail.actualCredits,
    taskCharge: runtime.repository.taskCharge(params.jobId)
  });
};

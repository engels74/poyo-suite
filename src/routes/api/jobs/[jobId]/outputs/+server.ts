import type { StudioOutputDto } from '$lib/features/generation/contracts';
import { LibraryRepository } from '$lib/server/library/repository';
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
  const detail = await new LibraryRepository(platform.database).getJobDetail(params.jobId);
  if (!detail) return new Response('Job not found.', { status: 404 });
  const outputs: StudioOutputDto[] = detail.outputs.map((output) => ({
    outputId: output.outputId,
    mediaKind: output.mediaKind,
    mediaUrl: output.mediaUrl,
    aspectRatio: output.aspectRatio,
    fileName: output.fileName,
    downloadState: output.downloadState,
    localAvailable: output.localAvailable
  }));
  return Response.json({ outputs, actualCredits: detail.actualCredits });
};

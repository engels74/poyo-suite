import { runNativeMediaAction } from '$lib/server/media/native-actions';
import {
  mediaActionHttpError,
  resolveVerifiedMediaOutput
} from '$lib/server/media/verified-output';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { readSameOriginJson } from '$lib/server/platform/request-security';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, params }) => {
  try {
    await readSameOriginJson<Record<string, never>>(request, { maxBytes: 1024 });
    const platform = await getPlatformServices();
    const output = await resolveVerifiedMediaOutput(
      platform.database,
      platform.paths.mediaReadRoots ?? [platform.paths.media],
      params.outputId
    );
    await runNativeMediaAction(output.path, 'open-native');
    return Response.json({ opened: true });
  } catch (error) {
    return mediaActionHttpError(error);
  }
};

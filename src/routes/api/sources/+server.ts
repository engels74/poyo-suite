import { jobHttpError } from '$lib/server/jobs/http';
import { readVerifiedManagedSourceBlob } from '$lib/server/jobs/managed-source-upload';
import { ManagedSourceRepository } from '$lib/server/media/managed-sources';
import { intakeLocalSource, neutralSourceUploadName } from '$lib/server/media/source-intake';
import { getPlatformServices } from '$lib/server/platform/runtime';
import { createPoyoClient } from '$lib/server/poyo/factory';
import { readMediaPrivacySettings } from '$lib/server/settings/media-privacy-settings';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
  let registeredSourceId: string | undefined;
  let managedSources: ManagedSourceRepository | undefined;
  try {
    const platform = await getPlatformServices();
    const source = await intakeLocalSource(request, platform.paths, {
      mediaPrivacy: readMediaPrivacySettings(platform.settings)
    });
    managedSources = new ManagedSourceRepository(platform.database, platform.paths);
    const registered = await managedSources.register(source);
    registeredSourceId = registered.id;
    const localFile = await readVerifiedManagedSourceBlob(registered);
    const client = await createPoyoClient({
      apiKeyManager: platform.apiKey,
      logger: platform.logger,
      environment: platform.environment
    });
    const uploaded = await client.upload({
      kind: 'local-file',
      file: localFile,
      mimeType: registered.mimeType,
      sizeBytes: registered.byteSize,
      mediaKind: registered.mediaKind,
      fileName: neutralSourceUploadName(registered.id, registered.mimeType)
    });
    return Response.json(
      {
        source: {
          id: registered.id,
          name: registered.originalName,
          mediaKind: registered.mediaKind,
          mimeType: registered.mimeType,
          sizeBytes: registered.byteSize,
          availability: registered.availability
        },
        upload: {
          url: uploaded.fileUrl,
          expiresAt: uploaded.expiresAt,
          fileId: uploaded.fileId
        }
      },
      { status: 201 }
    );
  } catch (error) {
    if (registeredSourceId && managedSources) {
      await managedSources.discardUnreferenced(registeredSourceId).catch(() => undefined);
    }
    return jobHttpError(error);
  }
};

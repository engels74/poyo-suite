import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { ManagedSourceRepository, type ManagedSourceRecord } from '../media/managed-sources';
import { neutralSourceUploadName } from '../media/source-intake';
import type { PlatformServices } from '../platform/runtime';
import { createPoyoClient } from '../poyo/factory';
import { POYO_STREAM_VIDEO_MAX_BYTES } from '../poyo/uploads';

export async function readVerifiedManagedSourceBlob(source: ManagedSourceRecord): Promise<Blob> {
  if (
    !Number.isSafeInteger(source.byteSize) ||
    source.byteSize <= 0 ||
    source.byteSize > POYO_STREAM_VIDEO_MAX_BYTES
  ) {
    throw new Error('The managed local source failed verification.');
  }
  const handle = await open(source.localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size !== source.byteSize) {
      throw new Error('The managed local source failed verification.');
    }
    const bytes = new Uint8Array(source.byteSize);
    const hasher = new Bun.CryptoHasher('sha256');
    let position = 0;
    while (position < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        position,
        bytes.byteLength - position,
        position
      );
      if (bytesRead <= 0) throw new Error('The managed local source failed verification.');
      hasher.update(bytes.subarray(position, position + bytesRead));
      position += bytesRead;
    }
    const signature = Array.from(bytes.subarray(0, Math.min(16, bytes.byteLength)), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    if (signature !== source.signature || hasher.digest('hex') !== source.checksum) {
      throw new Error('The managed local source failed verification.');
    }
    return new Blob([bytes], { type: source.mimeType });
  } finally {
    await handle.close();
  }
}

export function createManagedSourceResolver(platform: PlatformServices) {
  const managedSources = new ManagedSourceRepository(platform.database, platform.paths);
  let clientPromise: ReturnType<typeof createPoyoClient> | null = null;

  return async (localSourceId: string, mediaKind: 'image' | 'video', refreshUpload: boolean) => {
    const source = await managedSources.resolveAvailable(localSourceId, mediaKind);
    if (!refreshUpload) return source;
    clientPromise ??= createPoyoClient({
      apiKeyManager: platform.apiKey,
      logger: platform.logger,
      environment: platform.environment,
      publicIpv4Guard: platform.publicIpv4
    });
    const client = await clientPromise;
    const file = await readVerifiedManagedSourceBlob(source);
    const uploaded = await client.upload({
      kind: 'local-file',
      file,
      mimeType: source.mimeType,
      sizeBytes: source.byteSize,
      mediaKind: source.mediaKind,
      fileName: neutralSourceUploadName(source.id, source.mimeType)
    });
    return { ...source, url: uploaded.fileUrl };
  };
}

export function createManagedSourceUploadRefresher(platform: PlatformServices) {
  const resolve = createManagedSourceResolver(platform);
  return async (localSourceId: string, mediaKind: 'image' | 'video') => {
    const source = await resolve(localSourceId, mediaKind, true);
    if (!('url' in source) || !source.url)
      throw new Error('Managed source upload did not return a usable URL.');
    return { id: source.id, url: source.url };
  };
}

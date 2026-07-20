import type { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { renameSync, symlinkSync } from 'node:fs';
import {
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { DEFAULT_MEDIA_PRIVACY_SETTINGS } from '../../../src/lib/features/settings/media-privacy';
import type { MediaToolsReadinessDto } from '../../../src/lib/features/settings/contracts';
import { jobHttpError } from '../../../src/lib/server/jobs/http';
import { readVerifiedManagedSourceBlob } from '../../../src/lib/server/jobs/managed-source-upload';
import { syncDirectory as syncFilesystemDirectory } from '../../../src/lib/server/media/filesystem-boundary';
import { ManagedSourceRepository } from '../../../src/lib/server/media/managed-sources';
import { MediaPrerequisiteError } from '../../../src/lib/server/media/media-sanitizer';
import {
  intakeLocalSource as intakeWithPrivacy,
  neutralSourceUploadName,
  recoverSourceIntakeTemporaries,
  SourceIntakeError,
  type SourceIntakeOptions
} from '../../../src/lib/server/media/source-intake';
import { ensureAppPaths, resolveAppPaths } from '../../../src/lib/server/platform/app-paths';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];
const unsanitizedMedia = {
  ...DEFAULT_MEDIA_PRIVACY_SETTINGS,
  sanitizeLocalMedia: false
};
const imageReceipt = {
  applied: true,
  notAppliedReason: null,
  mediaKind: 'image',
  removedCategories: ['xmp'],
  preservedCategories: [],
  orientationNormalized: false
} as const;
const readyMediaTools: MediaToolsReadinessDto = {
  imageReady: true,
  videoReady: true,
  tools: [
    {
      name: 'exiftool',
      label: 'ExifTool',
      minimumVersion: '13.55',
      detectedVersion: '13.55',
      status: 'ready'
    },
    {
      name: 'imagemagick',
      label: 'ImageMagick',
      minimumVersion: '7.1',
      detectedVersion: '7.1',
      status: 'ready'
    },
    {
      name: 'ffmpeg',
      label: 'FFmpeg',
      minimumVersion: '8.1',
      detectedVersion: '8.1',
      status: 'ready'
    },
    {
      name: 'ffprobe',
      label: 'ffprobe',
      minimumVersion: '8.1',
      detectedVersion: '8.1',
      status: 'ready'
    }
  ]
};
const unavailableMediaTools: MediaToolsReadinessDto = {
  ...readyMediaTools,
  imageReady: false,
  videoReady: false,
  tools: readyMediaTools.tools.map((tool) => ({
    ...tool,
    detectedVersion: null,
    status: 'missing' as const
  }))
};

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  const temporary = await createTemporaryDirectory('poyo-source-');
  const paths = resolveAppPaths({
    environment: { PLS_APP_DATA_DIR: join(temporary.path, 'studio') }
  });
  await ensureAppPaths(paths);
  const database = await openDatabase(paths.database);
  cleanups.push(async () => {
    database.close();
    await temporary.cleanup();
  });
  return { paths, database, repository: new ManagedSourceRepository(database, paths) };
}

function intakeLocalSource(
  request: Request,
  paths: ReturnType<typeof resolveAppPaths>,
  options: SourceIntakeOptions = {}
) {
  return intakeWithPrivacy(request, paths, {
    mediaPrivacy: unsanitizedMedia,
    readiness: async () => readyMediaTools,
    ...options
  });
}

function uploadRequest(bytes: Uint8Array, type = 'image/png', origin?: string): Request {
  return uploadMediaRequest(bytes, type, 'image', origin);
}

function uploadMediaRequest(
  bytes: Uint8Array,
  type: string,
  mediaKind: 'image' | 'video',
  origin?: string
): Request {
  const form = new FormData();
  form.set('mediaKind', mediaKind);
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  form.set(
    'file',
    new File([buffer], mediaKind === 'image' ? '../unsafe-name.png' : '../unsafe-name.mp4', {
      type
    })
  );
  return new Request('http://127.0.0.1:5173/api/sources', {
    method: 'POST',
    headers: origin === undefined ? {} : { origin },
    body: form
  });
}

function chunkedMultipartRequest(body: Uint8Array, boundary: string): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < body.length; offset += 32) {
        controller.enqueue(body.slice(offset, offset + 32));
      }
      controller.close();
    }
  });
  return new Request('http://127.0.0.1:5173/api/sources', {
    method: 'POST',
    headers: {
      origin: 'http://127.0.0.1:5173',
      'content-type': `multipart/form-data; boundary=${boundary}`
    },
    body: stream,
    duplex: 'half'
  } as RequestInit & { duplex: 'half' });
}

describe('local source intake', () => {
  test('UPLOAD-00 creates neutral Poyo filenames from managed IDs and validated MIME types', () => {
    const id = 'c2cd7f71-8f80-4b22-9c18-cc2dcbbbd5bd';
    expect(neutralSourceUploadName(id, 'image/jpeg')).toBe(`${id}.jpg`);
    expect(neutralSourceUploadName(id, 'video/x-matroska')).toBe(`${id}.mkv`);
    expect(() => neutralSourceUploadName('../unsafe', 'image/png')).toThrow('identifier');
    expect(() => neutralSourceUploadName(id, 'text/plain')).toThrow('not supported');
  });

  test('UPLOAD-01 requires same origin, validates signatures and atomically retains a local source', async () => {
    const { paths, repository } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await expect(intakeLocalSource(uploadRequest(png), paths)).rejects.toMatchObject({
      code: 'origin_required',
      status: 403
    });
    await expect(
      intakeLocalSource(uploadRequest(png, 'image/png', 'https://attacker.test'), paths)
    ).rejects.toMatchObject({ code: 'origin_mismatch', status: 403 });
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    expect(source.originalName).toBe('unsafe-name.png');
    expect(source.localPath).toStartWith(await realpath(paths.uploads));
    expect((await stat(source.localPath)).size).toBe(png.byteLength);
    expect(source.checksum).toHaveLength(64);
    expect(source.signature).toStartWith('89504e47');
    expect(source.sanitization).toEqual({
      applied: false,
      notAppliedReason: 'preference-disabled',
      mediaKind: 'image',
      removedCategories: [],
      preservedCategories: [],
      orientationNormalized: null
    });
    expect(await realpath((await repository.register(source)).localPath)).toBe(source.localPath);
    expect(await realpath((await repository.resolveAvailable(source.id, 'image')).localPath)).toBe(
      source.localPath
    );
    await expect(repository.resolveAvailable('../unsafe')).rejects.toThrow('not valid');
    expect(await Array.fromAsync(new Bun.Glob('*.part').scan(paths.temporary))).toEqual([]);
  });

  test('UPLOAD-01A chooses raw paths without invoking unavailable cleanup and records why', async () => {
    const { paths } = await fixture();
    const png = await Bun.file('tests/fixtures/media/tiny.png').bytes();
    const mp4 = await Bun.file('tests/fixtures/media/tiny.mp4').bytes();
    let readinessCalls = 0;
    let sanitizerCalls = 0;
    const options: SourceIntakeOptions = {
      mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
      readiness: async () => {
        readinessCalls += 1;
        return unavailableMediaTools;
      },
      sanitizer: async () => {
        sanitizerCalls += 1;
        throw new Error('sanitizer must not run');
      }
    };

    const image = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths,
      options
    );
    const video = await intakeLocalSource(
      uploadMediaRequest(mp4, 'video/mp4', 'video', 'http://127.0.0.1:5173'),
      paths,
      options
    );

    expect(readinessCalls).toBe(2);
    expect(sanitizerCalls).toBe(0);
    expect(image.sanitization.notAppliedReason).toBe('tools-unavailable');
    expect(video.sanitization.notAppliedReason).toBe('tools-unavailable');
    expect(await Bun.file(image.localPath).bytes()).toEqual(png);
    expect(await Bun.file(video.localPath).bytes()).toEqual(mp4);
  });

  test('UPLOAD-01A2 preference-off skips both readiness and sanitizer', async () => {
    const { paths } = await fixture();
    const png = await Bun.file('tests/fixtures/media/tiny.png').bytes();
    let readinessCalls = 0;
    let sanitizerCalls = 0;
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths,
      {
        readiness: async () => {
          readinessCalls += 1;
          return readyMediaTools;
        },
        sanitizer: async () => {
          sanitizerCalls += 1;
          return imageReceipt;
        }
      }
    );
    expect(readinessCalls).toBe(0);
    expect(sanitizerCalls).toBe(0);
    expect(source.sanitization.notAppliedReason).toBe('preference-disabled');
  });

  test('UPLOAD-01A3 treats a failed capability probe as unavailable', async () => {
    const { paths } = await fixture();
    const png = await Bun.file('tests/fixtures/media/tiny.png').bytes();
    let sanitizerCalls = 0;
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths,
      {
        mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
        readiness: async () => {
          throw new Error('private probe failure');
        },
        sanitizer: async () => {
          sanitizerCalls += 1;
          return imageReceipt;
        }
      }
    );
    expect(sanitizerCalls).toBe(0);
    expect(source.sanitization.notAppliedReason).toBe('tools-unavailable');
    expect(JSON.stringify(source.sanitization)).not.toContain('private');
  });

  test('UPLOAD-01A4 selects cleanup independently for partial image and video capability', async () => {
    const { paths } = await fixture();
    const png = await Bun.file('tests/fixtures/media/tiny.png').bytes();
    const mp4 = await Bun.file('tests/fixtures/media/tiny.mp4').bytes();
    const sanitizedKinds: Array<'image' | 'video'> = [];
    const sanitizer = async (
      input: Parameters<NonNullable<SourceIntakeOptions['sanitizer']>>[0]
    ) => {
      sanitizedKinds.push(input.mediaKind);
      await writeFile(input.outputPath, await Bun.file(input.inputPath).bytes(), {
        flag: 'wx',
        mode: 0o600
      });
      return {
        applied: true,
        notAppliedReason: null,
        mediaKind: input.mediaKind,
        removedCategories: [],
        preservedCategories: [],
        orientationNormalized: input.mediaKind === 'image' ? false : null
      } as const;
    };
    const requestFor = (kind: 'image' | 'video') =>
      kind === 'image'
        ? uploadRequest(png, 'image/png', 'http://127.0.0.1:5173')
        : uploadMediaRequest(mp4, 'video/mp4', 'video', 'http://127.0.0.1:5173');
    const imageOnly = { ...readyMediaTools, videoReady: false };
    const videoOnly = { ...readyMediaTools, imageReady: false };

    const cleanedImage = await intakeLocalSource(requestFor('image'), paths, {
      mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
      readiness: async () => imageOnly,
      sanitizer
    });
    const rawVideo = await intakeLocalSource(requestFor('video'), paths, {
      mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
      readiness: async () => imageOnly,
      sanitizer
    });
    const rawImage = await intakeLocalSource(requestFor('image'), paths, {
      mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
      readiness: async () => videoOnly,
      sanitizer
    });
    const cleanedVideo = await intakeLocalSource(requestFor('video'), paths, {
      mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
      readiness: async () => videoOnly,
      sanitizer
    });

    expect(sanitizedKinds).toEqual(['image', 'video']);
    expect(cleanedImage.sanitization.applied).toBe(true);
    expect(cleanedVideo.sanitization.applied).toBe(true);
    expect(rawVideo.sanitization.notAppliedReason).toBe('tools-unavailable');
    expect(rawImage.sanitization.notAppliedReason).toBe('tools-unavailable');
  });

  test('UPLOAD-01B publishes, sizes and hashes only the sanitizer output', async () => {
    const { paths } = await fixture();
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x72, 0x61, 0x77]);
    const sanitized = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x73, 0x61, 0x66, 0x65, 0x00
    ]);
    const source = await intakeLocalSource(
      uploadRequest(raw, 'image/png', 'http://127.0.0.1:5173'),
      paths,
      {
        mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
        sanitizer: async ({ inputPath, outputPath }) => {
          expect(await Bun.file(inputPath).bytes()).toEqual(raw);
          await writeFile(outputPath, sanitized, { flag: 'wx', mode: 0o600 });
          return imageReceipt;
        }
      }
    );
    const expectedChecksum = new Bun.CryptoHasher('sha256').update(sanitized).digest('hex');
    expect(source.sizeBytes).toBe(sanitized.byteLength);
    expect(source.checksum).toBe(expectedChecksum);
    expect(await Bun.file(source.localPath).bytes()).toEqual(sanitized);
    expect(source.sanitization).toEqual(imageReceipt);
    expect(await readdir(paths.temporary)).toEqual([]);
  });

  test('UPLOAD-01B2 uses newly installed capabilities without changing saved settings', async () => {
    const { paths } = await fixture();
    const raw = await Bun.file('tests/fixtures/media/tiny.png').bytes();
    const sanitized = new Uint8Array([...raw, 0]);
    const mediaPrivacy = { ...DEFAULT_MEDIA_PRIVACY_SETTINGS };
    let ready = false;
    let sanitizerCalls = 0;
    const options: SourceIntakeOptions = {
      mediaPrivacy,
      readiness: async () => (ready ? readyMediaTools : unavailableMediaTools),
      sanitizer: async ({ outputPath }) => {
        sanitizerCalls += 1;
        await writeFile(outputPath, sanitized, { flag: 'wx', mode: 0o600 });
        return imageReceipt;
      }
    };

    const beforeInstall = await intakeLocalSource(
      uploadRequest(raw, 'image/png', 'http://127.0.0.1:5173'),
      paths,
      options
    );
    ready = true;
    const afterInstall = await intakeLocalSource(
      uploadRequest(raw, 'image/png', 'http://127.0.0.1:5173'),
      paths,
      options
    );

    expect(mediaPrivacy.sanitizeLocalMedia).toBe(true);
    expect(beforeInstall.sanitization.notAppliedReason).toBe('tools-unavailable');
    expect(afterInstall.sanitization).toEqual(imageReceipt);
    expect(sanitizerCalls).toBe(1);
  });

  test('UPLOAD-01C sanitizer and output verification failures leave no raw or published file', async () => {
    const { paths } = await fixture();
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const request = () => uploadRequest(raw, 'image/png', 'http://127.0.0.1:5173');

    await expect(
      intakeLocalSource(request(), paths, {
        mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
        sanitizer: async () => {
          throw new Error('private tool detail');
        }
      })
    ).rejects.toMatchObject({
      code: 'source_sanitization_failed',
      message: 'The local file could not be sanitized safely.',
      status: 422
    });

    await expect(
      intakeLocalSource(request(), paths, {
        mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
        sanitizer: async ({ outputPath }) => {
          await writeFile(outputPath, new TextEncoder().encode('wrong container'), {
            flag: 'wx',
            mode: 0o600
          });
          return imageReceipt;
        }
      })
    ).rejects.toMatchObject({ code: 'source_sanitization_failed', status: 422 });

    const outside = join(paths.root, 'outside.png');
    await writeFile(outside, raw, { mode: 0o644 });
    const outsideMode = (await stat(outside)).mode & 0o777;
    await expect(
      intakeLocalSource(request(), paths, {
        mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
        sanitizer: async ({ outputPath }) => {
          await symlink(outside, outputPath);
          return imageReceipt;
        }
      })
    ).rejects.toMatchObject({ code: 'source_sanitization_failed', status: 422 });
    expect((await stat(outside)).mode & 0o777).toBe(outsideMode);
    expect(await Bun.file(outside).bytes()).toEqual(raw);

    expect(await readdir(paths.temporary)).toEqual([]);
    expect(
      await Array.fromAsync(new Bun.Glob('**/*').scan({ cwd: paths.uploads, onlyFiles: true }))
    ).toEqual([]);
  });

  test('UPLOAD-01D preserves a destination collision after sanitizer output verification', async () => {
    const { paths } = await fixture();
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x72, 0x61, 0x77]);
    const sanitized = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x73, 0x61, 0x66, 0x65
    ]);
    const collision = new TextEncoder().encode('existing destination');
    let destination = '';
    let captured: unknown;

    try {
      await intakeLocalSource(uploadRequest(raw, 'image/png', 'http://127.0.0.1:5173'), paths, {
        mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
        sanitizer: async ({ inputPath, outputPath }) => {
          await writeFile(outputPath, sanitized, { flag: 'wx', mode: 0o600 });
          const id = basename(inputPath).split('.raw.')[0] as string;
          const [bucket] = await readdir(paths.uploads);
          destination = join(paths.uploads, bucket as string, `${id}.png`);
          await writeFile(destination, collision, { flag: 'wx', mode: 0o600 });
          return imageReceipt;
        }
      });
    } catch (error) {
      captured = error;
    }

    expect((captured as NodeJS.ErrnoException).code).toBe('EEXIST');
    expect(captured).not.toBeInstanceOf(SourceIntakeError);
    const response = jobHttpError(captured);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'job_request_failed',
        message: 'The job request could not be completed.'
      }
    });
    expect(await readdir(paths.temporary)).toEqual([]);
    expect(await Bun.file(destination).bytes()).toEqual(collision);
  });

  test('UPLOAD-01C2 preserves bounded prerequisite detail through cleanup and HTTP mapping', async () => {
    const { paths } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let captured: unknown;
    try {
      await intakeLocalSource(uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'), paths, {
        mediaPrivacy: { ...DEFAULT_MEDIA_PRIVACY_SETTINGS },
        sanitizer: async () => {
          throw new MediaPrerequisiteError({
            name: 'imagemagick',
            label: 'ImageMagick',
            minimumVersion: '7.1',
            detectedVersion: '7.0',
            status: 'outdated'
          });
        }
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toMatchObject({
      code: 'source_media_prerequisite_failed',
      status: 422,
      tool: { name: 'imagemagick', status: 'outdated' }
    });
    const response = jobHttpError(captured);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: 'source_media_prerequisite_failed',
        message:
          'Optional ImageMagick cleanup became unavailable, so this upload stopped safely. Found 7.0; version 7.1 or newer is supported.',
        tool: {
          name: 'imagemagick',
          label: 'ImageMagick',
          minimumVersion: '7.1',
          detectedVersion: '7.0',
          status: 'outdated'
        }
      }
    });
    expect(await readdir(paths.temporary)).toEqual([]);
  });

  test('UPLOAD-01E registration failure removes the published file before a row exists', async () => {
    const { paths, database, repository } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );

    await expect(
      repository.register({ ...source, sizeBytes: source.sizeBytes + 1 })
    ).rejects.toThrow('could not be verified');
    expect(await Bun.file(source.localPath).exists()).toBe(false);
    expect(
      database
        .query<{ id: string }, [string]>('SELECT id FROM managed_sources WHERE id=?')
        .get(source.id)
    ).toBeNull();
  });

  test('UPLOAD-01E2 pre-insert cleanup unlinks before syncing and preserves error order', async () => {
    const { paths, database } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    const events: string[] = [];
    const syncError = new Error('injected pre-insert directory sync failure');
    const repository = new ManagedSourceRepository(database, paths, undefined, {
      unlink: async (path) => {
        events.push(`unlink:${path}`);
        await unlink(path);
      },
      syncDirectory: async (path) => {
        events.push(`sync:${path}`);
        throw syncError;
      }
    });
    let captured: unknown;

    try {
      await repository.register({ ...source, sizeBytes: source.sizeBytes + 1 });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(AggregateError);
    const aggregate = captured as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message).toBe(
      'Managed source copy could not be verified.'
    );
    expect(aggregate.errors[1]).toBe(syncError);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(events).toEqual([`unlink:${source.localPath}`, `sync:${dirname(source.localPath)}`]);
    expect(await Bun.file(source.localPath).exists()).toBe(false);
    expect(
      database
        .query<{ id: string }, [string]>('SELECT id FROM managed_sources WHERE id=?')
        .get(source.id)
    ).toBeNull();
  });

  test('UPLOAD-01F invalid registration IDs do not transfer file custody', async () => {
    const { paths, database, repository } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );

    await expect(repository.register({ ...source, id: '../invalid' })).rejects.toThrow('not valid');
    expect(await Bun.file(source.localPath).bytes()).toEqual(png);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM managed_sources').get()
        ?.count
    ).toBe(0);
    await unlink(source.localPath);
  });

  test('UPLOAD-01G pre-insert cleanup refuses outside and symlink paths', async () => {
    const { paths, database, repository } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    const outside = join(paths.root, 'outside-registration.png');
    await rename(source.localPath, outside);

    await expect(repository.register({ ...source, localPath: outside })).rejects.toBeInstanceOf(
      AggregateError
    );
    expect(await Bun.file(outside).bytes()).toEqual(png);
    await symlink(outside, source.localPath);
    await expect(repository.register(source)).rejects.toBeInstanceOf(AggregateError);
    expect(await Bun.file(outside).bytes()).toEqual(png);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM managed_sources').get()
        ?.count
    ).toBe(0);
  });

  test('UPLOAD-01H ID collisions reclaim only the unregistered intake', async () => {
    const { paths, database, repository } = await fixture();
    const pngA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const pngB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
    const sourceA = await intakeLocalSource(
      uploadRequest(pngA, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    const registeredA = await repository.register(sourceA);
    const sourceB = await intakeLocalSource(
      uploadRequest(pngB, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );

    await expect(repository.register({ ...sourceB, id: sourceA.id })).rejects.toThrow();
    expect(await Bun.file(sourceB.localPath).exists()).toBe(false);
    expect(await Bun.file(sourceA.localPath).bytes()).toEqual(pngA);
    expect(repository.get(sourceA.id)).toEqual(registeredA);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM managed_sources').get()
        ?.count
    ).toBe(1);
  });

  test('UPLOAD-01I relative-path collisions preserve the existing owner and file', async () => {
    const { paths, database, repository } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    const registered = await repository.register(source);

    await expect(repository.register({ ...source, id: crypto.randomUUID() })).rejects.toThrow();
    expect(await Bun.file(source.localPath).bytes()).toEqual(png);
    expect(repository.get(source.id)).toEqual(registered);
    expect(
      database.query<{ count: number }, []>('SELECT COUNT(*) count FROM managed_sources').get()
        ?.count
    ).toBe(1);
  });

  test('UPLOAD-01J path changes expose registration and cleanup failures in stable order', async () => {
    const { paths, database } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    const outside = join(paths.root, 'outside-path-change.png');
    await writeFile(outside, png);
    const retained = `${source.localPath}.retained`;
    let changed = false;
    const databaseProxy = new Proxy(database, {
      get(target, property) {
        if (property !== 'query') return Reflect.get(target, property, target);
        return (sql: string) => {
          const statement = target.query(sql);
          if (!sql.includes('FROM managed_sources WHERE relative_path=?')) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              const value = Reflect.get(statementTarget, statementProperty, statementTarget);
              if (statementProperty !== 'get') {
                return typeof value === 'function' ? value.bind(statementTarget) : value;
              }
              return (...parameters: unknown[]) => {
                const result = Reflect.apply(value, statementTarget, parameters);
                if (!changed) {
                  changed = true;
                  renameSync(source.localPath, retained);
                  symlinkSync(outside, source.localPath);
                }
                return result;
              };
            }
          });
        };
      }
    }) as Database;
    const repository = new ManagedSourceRepository(databaseProxy, paths);
    const registrationError = new Error('Managed source copy could not be verified.');
    let captured: unknown;

    try {
      await repository.register({ ...source, sizeBytes: source.sizeBytes + 1 });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(AggregateError);
    const aggregate = captured as AggregateError;
    expect(aggregate.message).toBe('Managed source registration and cleanup failed.');
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toEqual(registrationError);
    expect(aggregate.errors[1]).toBeInstanceOf(Error);
    expect((aggregate.errors[1] as Error).message).toMatch(/non-symlink|path changed/);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(await Bun.file(outside).bytes()).toEqual(png);
    expect(await Bun.file(retained).bytes()).toEqual(png);
  });

  test('UPLOAD-01K post-insert failures discard the inserted row and its file', async () => {
    const { paths, database } = await fixture();
    class FailedGetRepository extends ManagedSourceRepository {
      override get(): null {
        return null;
      }
    }
    const repository = new FailedGetRepository(database, paths);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );

    await expect(repository.register(source)).rejects.toThrow('registration failed');
    expect(
      database
        .query<{ id: string }, [string]>('SELECT id FROM managed_sources WHERE id=?')
        .get(source.id)
    ).toBeNull();
    expect(await Bun.file(source.localPath).exists()).toBe(false);

    const normalRepository = new ManagedSourceRepository(database, paths);
    const retained = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    await normalRepository.register(retained);
    expect(await normalRepository.discardUnreferenced(retained.id)).toBe(true);
    expect(await Bun.file(retained.localPath).exists()).toBe(false);
  });

  test('UPLOAD-01L row-backed cleanup syncs after unlink and before deleting its row', async () => {
    const { paths, database, repository } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    await repository.register(source);
    const events: string[] = [];
    const syncError = new Error('injected row-backed directory sync failure');
    let syncAttempts = 0;
    const faultingRepository = new ManagedSourceRepository(database, paths, undefined, {
      unlink: async (path) => {
        events.push(`unlink:${path}`);
        await unlink(path);
      },
      syncDirectory: async (path) => {
        syncAttempts += 1;
        events.push(`sync:${path}:attempt-${syncAttempts}`);
        if (syncAttempts <= 2) throw syncError;
        await syncFilesystemDirectory(path);
      }
    });

    await expect(faultingRepository.discardUnreferenced(source.id)).rejects.toBe(syncError);
    expect(events).toEqual([
      `unlink:${source.localPath}`,
      `sync:${dirname(source.localPath)}:attempt-1`
    ]);
    expect(await Bun.file(source.localPath).exists()).toBe(false);
    expect(
      database
        .query<{ id: string }, [string]>('SELECT id FROM managed_sources WHERE id=?')
        .get(source.id)
    ).toEqual({ id: source.id });

    await expect(faultingRepository.discardUnreferenced(source.id)).rejects.toBe(syncError);
    expect(events).toEqual([
      `unlink:${source.localPath}`,
      `sync:${dirname(source.localPath)}:attempt-1`,
      `sync:${dirname(source.localPath)}:attempt-2`
    ]);
    expect(await Bun.file(source.localPath).exists()).toBe(false);
    expect(
      database
        .query<{ id: string }, [string]>('SELECT id FROM managed_sources WHERE id=?')
        .get(source.id)
    ).toEqual({ id: source.id });

    expect(await faultingRepository.discardUnreferenced(source.id)).toBe(true);
    expect(events).toEqual([
      `unlink:${source.localPath}`,
      `sync:${dirname(source.localPath)}:attempt-1`,
      `sync:${dirname(source.localPath)}:attempt-2`,
      `sync:${dirname(source.localPath)}:attempt-3`
    ]);
    expect(await Bun.file(source.localPath).exists()).toBe(false);
    expect(
      database
        .query<{ id: string }, [string]>('SELECT id FROM managed_sources WHERE id=?')
        .get(source.id)
    ).toBeNull();
  });

  test('UPLOAD-02 rejects content whose signature disagrees with its declared type', async () => {
    const { paths } = await fixture();
    const request = uploadRequest(
      new TextEncoder().encode('not an image'),
      'image/png',
      'http://127.0.0.1:5173'
    );
    await expect(intakeLocalSource(request, paths)).rejects.toThrow('signature');
    await expect(
      intakeLocalSource(
        uploadRequest(
          new Uint8Array([0, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
          'image/png',
          'http://127.0.0.1:5173'
        ),
        paths
      )
    ).rejects.toThrow('signature');
  });

  test('UPLOAD-02B bounds chunked aggregate multipart bytes before formData parsing', async () => {
    const { paths } = await fixture();
    const boundary = 'poyo-boundary';
    const body = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="mediaKind"\r\n\r\nimage\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="padding"\r\n\r\n${'x'.repeat(512)}\r\n` +
        `--${boundary}--\r\n`
    );
    const request = chunkedMultipartRequest(body, boundary);
    expect(request.headers.get('content-length')).toBeNull();
    await expect(intakeLocalSource(request, paths, { maxRequestBytes: 128 })).rejects.toMatchObject(
      { code: 'body_too_large', status: 413 }
    );
  });

  test('UPLOAD-02C rejects duplicate or unexpected multipart fields', async () => {
    const { paths } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const form = new FormData();
    form.append('mediaKind', 'image');
    form.append('mediaKind', 'image');
    form.append('file', new File([png], 'source.png', { type: 'image/png' }));
    form.append('note', 'unexpected');
    const request = new Request('http://127.0.0.1:5173/api/sources', {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:5173' },
      body: form
    });
    await expect(intakeLocalSource(request, paths)).rejects.toThrow('exactly one');
  });

  test('UPLOAD-03 reconciles missing copies and rejects a corrupted traversal path', async () => {
    const { paths, database, repository } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    await repository.register(source);
    await unlink(source.localPath);
    expect(await repository.reconcile(source.id)).toBe('missing');
    expect(repository.get(source.id)?.availability).toBe('missing');

    const outside = join(paths.root, 'outside.png');
    await writeFile(outside, png);
    database
      .query(
        "UPDATE managed_sources SET relative_path='../outside.png',availability='available' WHERE id=?"
      )
      .run(source.id);
    await expect(repository.resolveAvailable(source.id)).rejects.toThrow('no longer available');
    expect(await Bun.file(outside).exists()).toBe(true);
    expect(
      database
        .query<{ availability: string }, [string]>(
          'SELECT availability FROM managed_sources WHERE id=?'
        )
        .get(source.id)?.availability
    ).toBe('missing');
  });

  test('UPLOAD-03B Poyo upload snapshots reject same-size managed-source corruption', async () => {
    const { paths, repository } = await fixture();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9
    ]);
    const intake = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    const source = await repository.register(intake);
    expect(
      new Uint8Array(await (await readVerifiedManagedSourceBlob(source)).arrayBuffer())
    ).toEqual(png);

    const corrupted = png.slice();
    corrupted[corrupted.length - 1] = 10;
    await writeFile(source.localPath, corrupted);
    await expect(readVerifiedManagedSourceBlob(source)).rejects.toThrow('failed verification');
  });

  test('UPLOAD-04 rejects symlinked upload buckets and temporary roots without writing outside', async () => {
    const { paths } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bucket = join(paths.uploads, new Date().toISOString().slice(0, 7));
    const outsideBucket = join(paths.root, 'outside-bucket');
    await mkdir(outsideBucket);
    await symlink(outsideBucket, bucket, 'dir');
    await expect(
      intakeLocalSource(uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'), paths)
    ).rejects.toThrow('symbolic');
    expect(await readdir(outsideBucket)).toEqual([]);

    await unlink(bucket);
    const outsideTemporary = join(paths.root, 'outside-temporary');
    await mkdir(outsideTemporary);
    await rm(paths.temporary, { recursive: true });
    await symlink(outsideTemporary, paths.temporary, 'dir');
    await expect(
      intakeLocalSource(uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'), paths)
    ).rejects.toThrow('symbolic');
    expect(await readdir(outsideTemporary)).toEqual([]);
  });

  test('UPLOAD-05 parent swaps cannot satisfy reconcile or delete an outside same-size file', async () => {
    const { paths, database, repository } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    await repository.register(source);
    const bucket = dirname(source.localPath);
    const retainedBucket = `${bucket}-retained`;
    const outside = join(paths.root, 'outside-managed');
    await rename(bucket, retainedBucket);
    await mkdir(outside);
    const outsideSource = join(outside, basename(source.localPath));
    await writeFile(outsideSource, png);
    await symlink(outside, bucket, 'dir');
    const cleanupEvents: string[] = [];
    const cleanupRepository = new ManagedSourceRepository(database, paths, undefined, {
      unlink: async (path) => {
        cleanupEvents.push(`unlink:${path}`);
        await unlink(path);
      },
      syncDirectory: async (path) => {
        cleanupEvents.push(`sync:${path}`);
        await syncFilesystemDirectory(path);
      }
    });

    expect(await repository.reconcile(source.id)).toBe('missing');
    await expect(repository.resolveAvailable(source.id)).rejects.toThrow('no longer available');
    await expect(cleanupRepository.discardUnreferenced(source.id)).rejects.toThrow(
      /escapes|configured root|symbolic/
    );
    expect(await Bun.file(outsideSource).bytes()).toEqual(png);
    expect(repository.get(source.id)).not.toBeNull();
    expect(cleanupEvents).toEqual([]);

    await unlink(outsideSource);
    await expect(cleanupRepository.discardUnreferenced(source.id)).rejects.toThrow(
      /symbolic|configured root/
    );
    expect(repository.get(source.id)).not.toBeNull();
    expect(cleanupEvents).toEqual([]);
  });

  test('UPLOAD-06 canonical ancestor aliases remain valid for intake, registration and deletion', async () => {
    const temporary = await createTemporaryDirectory('poyo-source-alias-');
    const canonical = join(temporary.path, 'canonical');
    const alias = join(temporary.path, 'alias');
    await mkdir(canonical);
    await symlink(canonical, alias, 'dir');
    const paths = resolveAppPaths({
      environment: { PLS_APP_DATA_DIR: join(alias, 'studio') }
    });
    await ensureAppPaths(paths);
    const database = await openDatabase(paths.database);
    cleanups.push(async () => {
      database.close();
      await temporary.cleanup();
    });
    const syncedDirectories: string[] = [];
    const repository = new ManagedSourceRepository(database, paths, undefined, {
      unlink,
      syncDirectory: async (path) => {
        syncedDirectories.push(path);
        await syncFilesystemDirectory(path);
      }
    });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    const registered = await repository.register(source);
    const expectedCanonicalParent = await realpath(dirname(registered.localPath));
    expect(await realpath(registered.localPath)).toBe(await realpath(source.localPath));
    expect((await repository.resolveAvailable(source.id)).availability).toBe('available');
    expect(await repository.discardUnreferenced(source.id)).toBe(true);
    expect(syncedDirectories).toEqual([expectedCanonicalParent]);
    expect(await Bun.file(source.localPath).exists()).toBe(false);
    expect(repository.get(source.id)).toBeNull();
  });

  test('UPLOAD-07 restart recovery removes only orphaned intake temporaries without following links', async () => {
    const { paths } = await fixture();
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    const third = crypto.randomUUID();
    const fourth = crypto.randomUUID();
    await writeFile(join(paths.temporary, `${first}.raw.png`), raw, { mode: 0o600 });
    await writeFile(join(paths.temporary, `${second}.sanitized.png`), raw, { mode: 0o600 });
    await writeFile(join(paths.temporary, `${fourth}.oriented.jpg`), raw, { mode: 0o600 });
    const outside = join(paths.root, 'outside-recovery.png');
    await writeFile(outside, raw, { mode: 0o600 });
    await symlink(outside, join(paths.temporary, `${third}.raw.png`));
    await writeFile(join(paths.temporary, 'unrelated.part'), raw, { mode: 0o600 });

    const matchingDirectory = join(paths.temporary, `${crypto.randomUUID()}.raw.png`);
    const sentinel = join(matchingDirectory, 'sentinel');
    await mkdir(matchingDirectory);
    await writeFile(sentinel, raw, { mode: 0o600 });

    expect(await recoverSourceIntakeTemporaries(paths)).toBe(4);
    expect((await readdir(paths.temporary)).sort()).toEqual([
      basename(matchingDirectory),
      'unrelated.part'
    ]);
    expect(await Bun.file(sentinel).bytes()).toEqual(raw);
    expect(await Bun.file(outside).bytes()).toEqual(raw);
    expect(await recoverSourceIntakeTemporaries(paths)).toBe(0);
  });

  test('UPLOAD-07B ignores ENOENT races without counting or syncing', async () => {
    const { paths } = await fixture();
    const name = `${crypto.randomUUID()}.raw.png`;
    const target = join(paths.temporary, name);
    await writeFile(target, 'temporary');
    const entries = await readdir(paths.temporary, { withFileTypes: true });
    let syncCalls = 0;

    expect(
      await recoverSourceIntakeTemporaries(paths, {
        readDirectory: async () => entries,
        unlink: async () => {
          const error = new Error('gone') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        },
        syncDirectory: async () => {
          syncCalls += 1;
        }
      })
    ).toBe(0);
    expect(syncCalls).toBe(0);
  });

  test('UPLOAD-07C exposes a file-to-directory swap without recursive deletion or sync', async () => {
    const { paths } = await fixture();
    const name = `${crypto.randomUUID()}.raw.png`;
    const target = join(paths.temporary, name);
    await writeFile(target, 'temporary');
    const entries = await readdir(paths.temporary, { withFileTypes: true });
    let syncCalls = 0;

    await expect(
      recoverSourceIntakeTemporaries(paths, {
        readDirectory: async () => entries,
        unlink: async (path) => {
          await unlink(path);
          await mkdir(path);
          await unlink(path);
        },
        syncDirectory: async () => {
          syncCalls += 1;
        }
      })
    ).rejects.toBeInstanceOf(Error);
    expect(await stat(target).then((details) => details.isDirectory())).toBe(true);
    expect(syncCalls).toBe(0);
  });

  test('UPLOAD-07D exposes directory sync failure after a successful unlink', async () => {
    const { paths } = await fixture();
    const name = `${crypto.randomUUID()}.raw.png`;
    const target = join(paths.temporary, name);
    await writeFile(target, 'temporary');
    const entries = await readdir(paths.temporary, { withFileTypes: true });
    const syncError = new Error('injected recovery directory sync failure');

    await expect(
      recoverSourceIntakeTemporaries(paths, {
        readDirectory: async () => entries,
        unlink,
        syncDirectory: async () => {
          throw syncError;
        }
      })
    ).rejects.toBe(syncError);
    expect(await Bun.file(target).exists()).toBe(false);
  });
});

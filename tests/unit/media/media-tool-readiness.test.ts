import { describe, expect, test } from 'bun:test';
import {
  mediaKindSanitizationReady,
  mediaSanitizationCapabilityState
} from '../../../src/lib/features/settings/media-privacy';
import {
  assertMediaToolsReady,
  MediaPrerequisiteError,
  probeMediaTools,
  runMediaProbeCommand,
  type MediaCommandRunner
} from '../../../src/lib/server/media/media-sanitizer';
import { MediaToolReadinessService } from '../../../src/lib/server/media/media-tool-readiness';

const outputByTool = {
  exiftool: '13.55',
  magick: 'Version: ImageMagick 7.1.2-27 Q16-HDRI',
  ffmpeg: 'ffmpeg version 8.1.2 Copyright',
  ffprobe: 'ffprobe version 8.1.2 Copyright'
} as const;

function runnerWith(overrides: Partial<Record<keyof typeof outputByTool, string | Error>> = {}) {
  const calls: Array<{ cmd: string[]; timeoutMs?: number; maxBufferBytes?: number }> = [];
  const runner: MediaCommandRunner = async (command) => {
    calls.push(command);
    const executable = command.cmd[0] as keyof typeof outputByTool;
    const value = overrides[executable] ?? outputByTool[executable];
    if (value instanceof Error) throw value;
    return {
      stdout: new TextEncoder().encode(value),
      stderr: new TextEncoder().encode('private diagnostic')
    };
  };
  return { calls, runner };
}

describe('media tool readiness', () => {
  test.each([
    ['exiftool', 'exiftool', '13.54', 'outdated', '13.54'],
    ['exiftool', 'exiftool', '13.55', 'ready', '13.55'],
    ['exiftool', 'exiftool', '14.0', 'ready', '14.0'],
    ['imagemagick', 'magick', 'Version: ImageMagick 7.0.11-5 Q16', 'outdated', '7.0.11'],
    ['imagemagick', 'magick', 'Version: ImageMagick 7.1.0-62 Q16', 'ready', '7.1.0'],
    ['imagemagick', 'magick', 'Version: ImageMagick 8.0.0 Q16', 'ready', '8.0.0'],
    ['ffmpeg', 'ffmpeg', 'ffmpeg version 8.0.1 Copyright', 'outdated', '8.0.1'],
    ['ffmpeg', 'ffmpeg', 'ffmpeg version 8.1 Copyright', 'ready', '8.1'],
    ['ffmpeg', 'ffmpeg', 'ffmpeg version n8.0.1 Copyright', 'outdated', '8.0.1'],
    ['ffmpeg', 'ffmpeg', 'ffmpeg version n8.1.2 Copyright', 'ready', '8.1.2'],
    ['ffmpeg', 'ffmpeg', 'ffmpeg version n8.1.2-29-g1234 Copyright', 'ready', '8.1.2'],
    ['ffmpeg', 'ffmpeg', 'ffmpeg version 9.0-static Copyright', 'ready', '9.0'],
    ['ffmpeg', 'ffmpeg', 'ffmpeg version N-125705-g1234 Copyright', 'error', null],
    ['ffmpeg', 'ffmpeg', 'ffmpeg version git-2026-07-20-1234 Copyright', 'error', null],
    ['ffprobe', 'ffprobe', 'ffprobe version 8.0 Copyright', 'outdated', '8.0'],
    ['ffprobe', 'ffprobe', 'ffprobe version 8.1.2 Copyright', 'ready', '8.1.2'],
    ['ffprobe', 'ffprobe', 'ffprobe version n8.0.1 Copyright', 'outdated', '8.0.1'],
    ['ffprobe', 'ffprobe', 'ffprobe version n8.1.2 Copyright', 'ready', '8.1.2'],
    ['ffprobe', 'ffprobe', 'ffprobe version n8.1.2-29-g1234 Copyright', 'ready', '8.1.2'],
    ['ffprobe', 'ffprobe', 'ffprobe version 9.0-static Copyright', 'ready', '9.0'],
    ['ffprobe', 'ffprobe', 'ffprobe version N-125705-g1234 Copyright', 'error', null],
    ['ffprobe', 'ffprobe', 'ffprobe version git-2026-07-20-1234 Copyright', 'error', null]
  ] as const)(
    'classifies %s version output',
    async (tool, executable, output, status, detectedVersion) => {
      const { runner } = runnerWith({ [executable]: output });
      const readiness = await probeMediaTools(runner);
      expect(readiness.tools.find((candidate) => candidate.name === tool)).toMatchObject({
        status,
        detectedVersion
      });
    }
  );

  test.each([
    ['exiftool', 'exiftool'],
    ['imagemagick', 'magick'],
    ['ffmpeg', 'ffmpeg'],
    ['ffprobe', 'ffprobe']
  ] as const)(
    'classifies missing and unverifiable %s without leaking output',
    async (tool, executable) => {
      const missing = Object.assign(new Error('private missing path'), { code: 'ENOENT' });
      const missingReadiness = await probeMediaTools(runnerWith({ [executable]: missing }).runner);
      expect(missingReadiness.tools.find((candidate) => candidate.name === tool)).toMatchObject({
        status: 'missing',
        detectedVersion: null
      });

      for (const failure of [
        new Error('private failure'),
        Object.assign(new Error('private timeout'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('private overflow'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        }),
        'not a version'
      ]) {
        const result = await probeMediaTools(runnerWith({ [executable]: failure }).runner);
        const serialized = JSON.stringify(result);
        expect(result.tools.find((candidate) => candidate.name === tool)).toMatchObject({
          status: 'error',
          detectedVersion: null
        });
        expect(serialized).not.toContain('private');
        expect(serialized).not.toContain('not a version');
      }
    }
  );

  test('uses short bounded no-shell probes and computes modality readiness independently', async () => {
    const { calls, runner } = runnerWith({ ffmpeg: 'ffmpeg version 8.0 Copyright' });
    const readiness = await probeMediaTools(runner);
    expect(readiness.imageReady).toBe(true);
    expect(readiness.videoReady).toBe(false);
    expect(calls.map((call) => call.cmd)).toEqual([
      ['exiftool', '-ver'],
      ['magick', '-version'],
      ['ffmpeg', '-version'],
      ['ffprobe', '-version']
    ]);
    for (const call of calls) {
      expect(call.timeoutMs).toBe(3_000);
      expect(call.maxBufferBytes).toBe(64 * 1024);
    }
  });

  test('selects image and video capabilities independently', async () => {
    const imageOnly = await probeMediaTools(
      runnerWith({ ffmpeg: 'ffmpeg version 8.0 Copyright' }).runner
    );
    expect(mediaKindSanitizationReady(imageOnly, 'image')).toBe(true);
    expect(mediaKindSanitizationReady(imageOnly, 'video')).toBe(false);
    expect(mediaSanitizationCapabilityState(imageOnly)).toBe('partial');

    const videoOnly = await probeMediaTools(
      runnerWith({ magick: 'Version: ImageMagick 7.0.11 Q16' }).runner
    );
    expect(mediaKindSanitizationReady(videoOnly, 'image')).toBe(false);
    expect(mediaKindSanitizationReady(videoOnly, 'video')).toBe(true);
    expect(mediaSanitizationCapabilityState(videoOnly)).toBe('partial');

    expect(mediaSanitizationCapabilityState(await probeMediaTools(runnerWith().runner))).toBe(
      'available'
    );
    expect(
      mediaSanitizationCapabilityState(
        await probeMediaTools(
          runnerWith({
            exiftool: Object.assign(new Error('missing'), { code: 'ENOENT' })
          }).runner
        )
      )
    ).toBe('unavailable');
  });

  test('accepts version output above 16 KiB while preserving the 64 KiB probe bound', async () => {
    const acceptedBytes = 32 * 1024;
    const versionLine = 'ffmpeg version 8.1.2 Copyright\n';
    const result = await runMediaProbeCommand({
      cmd: [
        'bun',
        '-e',
        `const prefix = ${JSON.stringify(versionLine)}; process.stdout.write(prefix + 'x'.repeat(${acceptedBytes} - Buffer.byteLength(prefix)))`
      ]
    });
    expect(result.stdout.byteLength).toBe(acceptedBytes);
    expect(new TextDecoder().decode(result.stdout)).toStartWith(versionLine);

    await expect(
      runMediaProbeCommand({
        cmd: ['bun', '-e', `process.stdout.write('x'.repeat(${64 * 1024 + 1}))`]
      })
    ).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
  });

  test('blocks only affected protected media with a bounded prerequisite error', async () => {
    const { runner } = runnerWith({ ffprobe: 'ffprobe version 8.0 Copyright' });
    await expect(assertMediaToolsReady('image', runner)).resolves.toBeUndefined();
    await expect(assertMediaToolsReady('video', runner)).rejects.toMatchObject({
      name: 'MediaPrerequisiteError',
      code: 'media_prerequisite_failed',
      tool: {
        name: 'ffprobe',
        status: 'outdated',
        detectedVersion: '8.0',
        minimumVersion: '8.1'
      }
    });
    try {
      await assertMediaToolsReady('video', runner);
    } catch (error) {
      expect(error).toBeInstanceOf(MediaPrerequisiteError);
      expect((error as Error).message).not.toContain('private');
    }

    await expect(
      assertMediaToolsReady('video', runnerWith({ ffmpeg: 'not a version' }).runner)
    ).rejects.toMatchObject({
      message:
        'Optional FFmpeg cleanup could not be verified after it started, so this upload stopped safely.'
    });
  });
});

describe('media tool readiness cache', () => {
  test('fresh readiness bypasses the cache and updates later page reads', async () => {
    const first = await probeMediaTools(runnerWith().runner);
    const second = await probeMediaTools(
      runnerWith({ magick: 'Version: ImageMagick 7.0.11 Q16' }).runner
    );
    let calls = 0;
    const service = new MediaToolReadinessService({
      probe: async () => (calls++ === 0 ? first : second)
    });

    expect(await service.getReadiness()).toEqual(first);
    expect(await service.getReadiness()).toEqual(first);
    expect(calls).toBe(1);
    expect(await service.refreshReadiness()).toEqual(second);
    expect(calls).toBe(2);
    expect(await service.getReadiness()).toEqual(second);
  });

  test('caches for 30 seconds, collapses concurrent probes, and refreshes after expiry', async () => {
    let now = 100;
    let calls = 0;
    let resolveProbe: ((value: Awaited<ReturnType<typeof probeMediaTools>>) => void) | undefined;
    const ready = await probeMediaTools(runnerWith().runner);
    const service = new MediaToolReadinessService({
      now: () => now,
      probe: () => {
        calls += 1;
        return new Promise((resolve) => {
          resolveProbe = resolve;
        });
      }
    });

    const first = service.getReadiness();
    const concurrent = service.getReadiness();
    expect(calls).toBe(1);
    resolveProbe?.(ready);
    expect(await first).toEqual(ready);
    expect(await concurrent).toEqual(ready);
    expect(await service.getReadiness()).toEqual(ready);
    expect(calls).toBe(1);

    now += 30_001;
    const refreshed = service.getReadiness();
    expect(calls).toBe(2);
    resolveProbe?.(ready);
    expect(await refreshed).toEqual(ready);
  });

  test('evicts a thrown probe so the next caller retries', async () => {
    let calls = 0;
    const ready = await probeMediaTools(runnerWith().runner);
    const service = new MediaToolReadinessService({
      probe: async () => {
        calls += 1;
        if (calls === 1) throw new Error('probe unavailable');
        return ready;
      }
    });
    await expect(service.getReadiness()).rejects.toThrow('probe unavailable');
    await expect(service.getReadiness()).resolves.toEqual(ready);
    expect(calls).toBe(2);
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaPrivacySettings } from '../../../src/lib/features/settings/contracts';
import {
  createMediaSanitizer,
  MediaSanitizationError,
  runMediaCommand,
  sanitizeMedia
} from '../../../src/lib/server/media/media-sanitizer';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const defaults: MediaPrivacySettings = {
  sanitizeLocalMedia: true,
  removeExif: true,
  removeIptc: true,
  removeXmp: true,
  removePhotoshop8bim: true,
  removeColorProfile: false
};

async function temporary() {
  const directory = await createTemporaryDirectory('poyo-media-sanitizer-');
  cleanups.push(directory.cleanup);
  return directory.path;
}

function command(cmd: string[]): Uint8Array {
  const result = Bun.spawnSync({ cmd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return result.stdout;
}

function minimalIccProfile(): Uint8Array {
  const profile = new Uint8Array(132);
  const view = new DataView(profile.buffer);
  view.setUint32(0, profile.byteLength);
  profile.set(new TextEncoder().encode('appl'), 4);
  view.setUint32(8, 0x04300000);
  profile.set(new TextEncoder().encode('mntrRGB XYZ '), 12);
  view.setUint16(24, 2026);
  view.setUint16(26, 7);
  view.setUint16(28, 19);
  profile.set(new TextEncoder().encode('acspAPPL'), 36);
  profile.set(new TextEncoder().encode('Poyo synthetic ICC'), 80);
  view.setUint32(128, 0);
  return profile;
}

async function imageFixture(path: string, profilePath: string): Promise<void> {
  command(['magick', '-size', '12x7', 'xc:#8040c0', path]);
  await writeFile(profilePath, minimalIccProfile(), { mode: 0o600 });
  command([
    'exiftool',
    '-overwrite_original',
    '-Make=Poyo Camera',
    '-Model=Poyo Synthetic Model',
    '-SerialNumber=synthetic-serial',
    '-Artist=Private Author',
    '-Copyright=Synthetic copyright',
    '-ImageDescription=Synthetic private description',
    '-DateTimeOriginal=2026:07:19 01:02:03',
    '-GPSLatitude=55.6761',
    '-GPSLatitudeRef=N',
    '-GPSLongitude=12.5683',
    '-GPSLongitudeRef=E',
    '-XMP-dc:Creator=Private Author',
    '-IPTC:Keywords=private-keyword',
    '-Photoshop:CopyrightFlag=true',
    '-Photoshop:URL=https://invalid.example/private-edit',
    `-ICC_Profile<=${profilePath}`,
    path
  ]);
}

const imageFormats = [
  ['JPEG', 'image/jpeg', '.jpg'],
  ['PNG', 'image/png', '.png'],
  ['GIF', 'image/gif', '.gif'],
  ['WebP', 'image/webp', '.webp']
] as const;

const videoFormats = [
  ['MP4', 'video/mp4', '.mp4', 'mp4', 'mpeg4', 'aac'],
  ['MOV', 'video/quicktime', '.mov', 'mov', 'mpeg4', 'aac'],
  ['AVI', 'video/x-msvideo', '.avi', 'avi', 'mpeg4', 'pcm_s16le'],
  ['WebM', 'video/webm', '.webm', 'webm', 'vp9', 'opus'],
  ['Matroska', 'video/x-matroska', '.mkv', 'matroska', 'mpeg4', 'pcm_s16le']
] as const;

function videoFixture(
  path: string,
  muxer: (typeof videoFormats)[number][3],
  videoCodec: (typeof videoFormats)[number][4],
  audioCodec: (typeof videoFormats)[number][5]
): void {
  const codecArguments =
    videoCodec === 'vp9'
      ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus']
      : ['-c:v', videoCodec, '-c:a', audioCodec];
  command([
    'ffmpeg',
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=32x24:rate=10:duration=0.5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.5',
    ...codecArguments,
    '-color_range',
    'tv',
    '-colorspace',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_primaries',
    'bt709',
    '-metadata',
    'title=Private title',
    '-metadata',
    'location=55.6+12.5/',
    '-f',
    muxer,
    '-y',
    path
  ]);
}

describe('media command runner', () => {
  test('captures bounded output without a shell', async () => {
    const result = await runMediaCommand({
      cmd: ['bun', '-e', 'process.stdout.write("runner-ok")'],
      timeoutMs: 1_000,
      maxBufferBytes: 128
    });
    expect(new TextDecoder().decode(result.stdout)).toBe('runner-ok');
  });

  test.each([
    ['missing executable', ['poyo-definitely-missing-executable'], 1_000, 128],
    ['nonzero exit', ['bun', '-e', 'process.exit(7)'], 1_000, 128],
    ['timeout', ['bun', '-e', 'await Bun.sleep(500)'], 10, 128],
    ['output overflow', ['bun', '-e', 'process.stdout.write("x".repeat(4096))'], 1_000, 32]
  ])('returns one safe error for %s', async (_name, cmd, timeoutMs, maxBufferBytes) => {
    await expect(runMediaCommand({ cmd, timeoutMs, maxBufferBytes })).rejects.toEqual(
      new MediaSanitizationError()
    );
  });
});

describe('sanitizer output custody', () => {
  test('refuses pre-existing files, symlinks, and directories without invoking tools', async () => {
    const root = await temporary();
    const inputPath = join(root, 'input.png');
    const input = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(inputPath, input);
    const runnerCalls: string[][] = [];
    const sanitizer = createMediaSanitizer(async (mediaCommand) => {
      runnerCalls.push(mediaCommand.cmd);
      throw new Error('runner must not be called');
    });

    const existingFile = join(root, 'existing-file.png');
    const existingBytes = new TextEncoder().encode('existing output');
    await writeFile(existingFile, existingBytes);

    const symlinkTarget = join(root, 'symlink-target.png');
    const existingSymlink = join(root, 'existing-symlink.png');
    const targetBytes = new TextEncoder().encode('symlink target');
    await writeFile(symlinkTarget, targetBytes);
    await symlink(symlinkTarget, existingSymlink);

    const existingDirectory = join(root, 'existing-directory.png');
    const sentinel = join(existingDirectory, 'sentinel');
    const sentinelBytes = new TextEncoder().encode('directory sentinel');
    await mkdir(existingDirectory);
    await writeFile(sentinel, sentinelBytes);

    for (const outputPath of [existingFile, existingSymlink, existingDirectory]) {
      await expect(
        sanitizer({
          inputPath,
          outputPath,
          mimeType: 'image/png',
          mediaKind: 'image',
          settings: defaults,
          maxOutputBytes: 1024 * 1024
        })
      ).rejects.toBeInstanceOf(MediaSanitizationError);
    }

    expect(runnerCalls).toEqual([]);
    expect(await Bun.file(existingFile).bytes()).toEqual(existingBytes);
    expect(await readlink(existingSymlink)).toBe(symlinkTarget);
    expect(await Bun.file(symlinkTarget).bytes()).toEqual(targetBytes);
    expect(await Bun.file(sentinel).bytes()).toEqual(sentinelBytes);
  });

  test('fails safely when output-path inspection raises a non-ENOENT error', async () => {
    const root = await temporary();
    const inputPath = join(root, 'input.png');
    const regularParent = join(root, 'regular-parent');
    const parentBytes = new TextEncoder().encode('not a directory');
    await writeFile(inputPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await writeFile(regularParent, parentBytes);
    let runnerCalls = 0;
    const sanitizer = createMediaSanitizer(async () => {
      runnerCalls += 1;
      throw new Error('runner must not be called');
    });

    await expect(
      sanitizer({
        inputPath,
        outputPath: join(regularParent, 'output.png'),
        mimeType: 'image/png',
        mediaKind: 'image',
        settings: defaults,
        maxOutputBytes: 1024 * 1024
      })
    ).rejects.toBeInstanceOf(MediaSanitizationError);

    expect(runnerCalls).toBe(0);
    expect(await Bun.file(regularParent).bytes()).toEqual(parentBytes);
  });
});

describe('still image sanitization', () => {
  test.each(imageFormats)('sanitizes accepted %s input', async (_name, mimeType, extension) => {
    const root = await temporary();
    const inputPath = join(root, `input${extension}`);
    const outputPath = join(root, `output${extension}`);
    const color = mimeType === 'image/png' || mimeType === 'image/webp' ? '#3478c080' : '#3478c0';
    command(['magick', '-size', '9x6', `xc:${color}`, inputPath]);
    command(['exiftool', '-overwrite_original', '-XMP-dc:Creator=Private Author', inputPath]);

    await sanitizeMedia({
      inputPath,
      outputPath,
      mimeType,
      mediaKind: 'image',
      settings: defaults,
      maxOutputBytes: 1024 * 1024
    });

    expect(
      new TextDecoder().decode(command(['magick', 'identify', '-format', '%wx%h', outputPath]))
    ).toBe('9x6');
    expect(
      new TextDecoder().decode(command(['exiftool', '-s3', '-XMP-dc:Creator', outputPath])).trim()
    ).toBe('');
    if (mimeType === 'image/png' || mimeType === 'image/webp') {
      expect(
        new TextDecoder().decode(
          command(['magick', 'identify', '-format', '%[channels]', outputPath])
        )
      ).toContain('a');
    }
  });

  test.each(imageFormats)(
    'preserves the embedded ICC payload byte-for-byte for %s',
    async (_name, mimeType, extension) => {
      const root = await temporary();
      const inputPath = join(root, `profiled${extension}`);
      const outputPath = join(root, `output${extension}`);
      const profilePath = join(root, 'synthetic.icc');
      command(['magick', '-size', '7x5', 'xc:#8040c0', inputPath]);
      await writeFile(profilePath, minimalIccProfile(), { mode: 0o600 });
      command(['exiftool', '-overwrite_original', `-ICC_Profile<=${profilePath}`, inputPath]);

      const receipt = await sanitizeMedia({
        inputPath,
        outputPath,
        mimeType,
        mediaKind: 'image',
        settings: defaults,
        maxOutputBytes: 1024 * 1024
      });

      expect(command(['exiftool', '-b', '-ICC_Profile', outputPath])).toEqual(
        await readFile(profilePath)
      );
      expect(receipt.removedCategories).toEqual([]);
      expect(receipt.preservedCategories).toEqual(['color-profile']);
    }
  );

  test('removes selected metadata and preserves the ICC payload exactly', async () => {
    const root = await temporary();
    const inputPath = join(root, 'input.jpg');
    const outputPath = join(root, 'output.jpg');
    const profilePath = join(root, 'synthetic.icc');
    await imageFixture(inputPath, profilePath);
    const sourceTags = new TextDecoder().decode(
      command([
        'exiftool',
        '-s3',
        '-Make',
        '-Model',
        '-SerialNumber',
        '-DateTimeOriginal',
        '-GPSLatitude',
        '-Artist',
        '-XMP-dc:Creator',
        '-IPTC:Keywords',
        '-Photoshop:CopyrightFlag',
        '-Photoshop:URL',
        inputPath
      ])
    );
    for (const expected of [
      'Poyo Camera',
      'Poyo Synthetic Model',
      'synthetic-serial',
      '2026:07:19 01:02:03',
      'Private Author',
      'private-keyword',
      'True',
      'https://invalid.example/private-edit'
    ]) {
      expect(sourceTags).toContain(expected);
    }

    const receipt = await sanitizeMedia({
      inputPath,
      outputPath,
      mimeType: 'image/jpeg',
      mediaKind: 'image',
      settings: defaults,
      maxOutputBytes: 1024 * 1024
    });

    expect(receipt).toEqual({
      applied: true,
      mediaKind: 'image',
      removedCategories: ['exif', 'iptc', 'xmp', 'photoshop-8bim'],
      preservedCategories: ['color-profile'],
      orientationNormalized: false
    });

    const tags = new TextDecoder().decode(
      command([
        'exiftool',
        '-s3',
        '-Make',
        '-Model',
        '-SerialNumber',
        '-Artist',
        '-Copyright',
        '-ImageDescription',
        '-DateTimeOriginal',
        '-GPSLatitude',
        '-XMP-dc:Creator',
        '-IPTC:Keywords',
        '-Photoshop:CopyrightFlag',
        '-Photoshop:URL',
        outputPath
      ])
    );
    expect(tags.trim()).toBe('');
    expect(command(['exiftool', '-b', '-ICC_Profile', outputPath])).toEqual(
      await readFile(profilePath)
    );
  });

  test('removes ICC data when requested and never invents a missing profile', async () => {
    const root = await temporary();
    const profilePath = join(root, 'synthetic.icc');
    for (const name of ['profiled', 'unprofiled']) {
      const inputPath = join(root, `${name}.jpg`);
      const outputPath = join(root, `${name}-output.jpg`);
      if (name === 'profiled') await imageFixture(inputPath, profilePath);
      else command(['magick', '-size', '6x4', 'xc:red', inputPath]);
      const receipt = await sanitizeMedia({
        inputPath,
        outputPath,
        mimeType: 'image/jpeg',
        mediaKind: 'image',
        settings: { ...defaults, removeColorProfile: true },
        maxOutputBytes: 1024 * 1024
      });
      expect(command(['exiftool', '-b', '-ICC_Profile', outputPath]).byteLength).toBe(0);
      expect(receipt.removedCategories).toEqual(
        name === 'profiled' ? ['exif', 'iptc', 'xmp', 'photoshop-8bim', 'color-profile'] : []
      );
      expect(receipt.preservedCategories).toEqual([]);
    }
  });

  test('preserves a disabled metadata category while removing the others', async () => {
    const root = await temporary();
    const inputPath = join(root, 'input.jpg');
    const outputPath = join(root, 'output.jpg');
    const profilePath = join(root, 'synthetic.icc');
    await imageFixture(inputPath, profilePath);

    const receipt = await sanitizeMedia({
      inputPath,
      outputPath,
      mimeType: 'image/jpeg',
      mediaKind: 'image',
      settings: { ...defaults, removeXmp: false },
      maxOutputBytes: 1024 * 1024
    });

    expect(receipt.removedCategories).toEqual(['exif', 'iptc', 'photoshop-8bim']);
    expect(receipt.preservedCategories).toEqual(['xmp', 'color-profile']);

    expect(
      new TextDecoder().decode(command(['exiftool', '-s3', '-XMP-dc:Creator', outputPath])).trim()
    ).toBe('Private Author');
    expect(
      new TextDecoder()
        .decode(command(['exiftool', '-s3', '-Make', '-IPTC:Keywords', outputPath]))
        .trim()
    ).toBe('');
  });

  test('normalizes a rotated single-frame image and rejects oriented animation', async () => {
    const root = await temporary();
    const inputPath = join(root, 'rotated.jpg');
    const outputPath = join(root, 'rotated-output.jpg');
    command([
      'magick',
      '-size',
      '10x4',
      'xc:red',
      '-fill',
      'blue',
      '-draw',
      'rectangle 5,0 9,3',
      inputPath
    ]);
    command(['exiftool', '-overwrite_original', '-Orientation#=6', inputPath]);

    const receipt = await sanitizeMedia({
      inputPath,
      outputPath,
      mimeType: 'image/jpeg',
      mediaKind: 'image',
      settings: defaults,
      maxOutputBytes: 1024 * 1024
    });
    expect(receipt.orientationNormalized).toBe(true);
    expect(
      new TextDecoder().decode(command(['magick', 'identify', '-format', '%wx%h', outputPath]))
    ).toBe('4x10');
    expect(
      new TextDecoder().decode(command(['exiftool', '-s3', '-Orientation', outputPath])).trim()
    ).toBe('');
    expect(
      new TextDecoder().decode(
        command([
          'magick',
          outputPath,
          '-format',
          '%[fx:p{1,1}.r>p{1,1}.b]|%[fx:p{1,8}.b>p{1,8}.r]',
          'info:'
        ])
      )
    ).toBe('1|1');

    const animationPath = join(root, 'rotated.gif');
    command([
      'magick',
      '-delay',
      '10',
      '-size',
      '4x2',
      'xc:red',
      '-size',
      '4x2',
      'xc:blue',
      '-loop',
      '0',
      animationPath
    ]);
    command(['exiftool', '-overwrite_original', '-Orientation#=6', animationPath]);
    await expect(
      sanitizeMedia({
        inputPath: animationPath,
        outputPath: join(root, 'animation-output.gif'),
        mimeType: 'image/gif',
        mediaKind: 'image',
        settings: defaults,
        maxOutputBytes: 1024 * 1024
      })
    ).rejects.toBeInstanceOf(MediaSanitizationError);

    const cleanAnimationPath = join(root, 'clean-animation.gif');
    const cleanAnimationOutput = join(root, 'clean-animation-output.gif');
    command([
      'magick',
      '-delay',
      '10',
      '-size',
      '4x2',
      'xc:red',
      '-size',
      '4x2',
      'xc:blue',
      '-loop',
      '0',
      cleanAnimationPath
    ]);
    await sanitizeMedia({
      inputPath: cleanAnimationPath,
      outputPath: cleanAnimationOutput,
      mimeType: 'image/gif',
      mediaKind: 'image',
      settings: defaults,
      maxOutputBytes: 1024 * 1024
    });
    expect(
      new TextDecoder().decode(
        command(['magick', 'identify', '-format', '%T\n', cleanAnimationOutput])
      )
    ).toBe('10\n10\n');
  });

  test('removes an oversized candidate on verification failure', async () => {
    const root = await temporary();
    const inputPath = join(root, 'input.png');
    const outputPath = join(root, 'output.png');
    command(['magick', '-size', '8x8', 'xc:green', inputPath]);
    await expect(
      sanitizeMedia({
        inputPath,
        outputPath,
        mimeType: 'image/png',
        mediaKind: 'image',
        settings: defaults,
        maxOutputBytes: 1
      })
    ).rejects.toBeInstanceOf(MediaSanitizationError);
    expect(await Bun.file(outputPath).exists()).toBe(false);
  });

  test.each([
    ['byte 6', 6, 7, 0x0a],
    ['byte 7', 7, 6, 0x1a]
  ] as const)(
    'rejects a PNG with corrupt signature %s',
    async (_name, byteIndex, otherIndex, otherByte) => {
      const root = await temporary();
      const inputPath = join(root, `input-${byteIndex}.png`);
      const outputPath = join(root, `output-${byteIndex}.png`);
      command(['magick', '-size', '8x8', 'xc:green', inputPath]);
      let mutationHookRan = false;
      let outputWriteCompleted = false;
      let postWriteCommandReached = false;
      const sanitizer = createMediaSanitizer(async (mediaCommand) => {
        const outputArgumentIndex = mediaCommand.cmd.indexOf('-o');
        const isOutputWrite =
          mediaCommand.cmd[0] === 'exiftool' &&
          outputArgumentIndex >= 0 &&
          mediaCommand.cmd[outputArgumentIndex + 1] === outputPath;
        if (outputWriteCompleted && !isOutputWrite) postWriteCommandReached = true;

        const result = await runMediaCommand(mediaCommand);
        if (isOutputWrite) {
          const bytes = await readFile(outputPath);
          expect(bytes.byteLength).toBeGreaterThan(7);
          expect(bytes[otherIndex]).toBe(otherByte);
          bytes[byteIndex] = 0;
          await writeFile(outputPath, bytes);
          mutationHookRan = true;
          outputWriteCompleted = true;
        }
        return result;
      });

      await expect(
        sanitizer({
          inputPath,
          outputPath,
          mimeType: 'image/png',
          mediaKind: 'image',
          settings: defaults,
          maxOutputBytes: 1024 * 1024
        })
      ).rejects.toBeInstanceOf(MediaSanitizationError);
      expect(mutationHookRan).toBe(true);
      expect(outputWriteCompleted).toBe(true);
      expect(postWriteCommandReached).toBe(false);
      expect(await Bun.file(outputPath).exists()).toBe(false);
      expect(await Bun.file(inputPath).exists()).toBe(true);
    }
  );
});

describe('video sanitization', () => {
  test.each(videoFormats)(
    'stream-copies accepted %s streams while removing container tags',
    async (_name, mimeType, extension, muxer, videoCodec, audioCodec) => {
      const root = await temporary();
      const inputPath = join(root, `input${extension}`);
      const outputPath = join(root, `output${extension}`);
      videoFixture(inputPath, muxer, videoCodec, audioCodec);

      const receipt = await sanitizeMedia({
        inputPath,
        outputPath,
        mimeType,
        mediaKind: 'video',
        settings: defaults,
        maxOutputBytes: 4 * 1024 * 1024
      });

      expect(receipt).toMatchObject({
        applied: true,
        mediaKind: 'video',
        removedCategories: ['container-tags'],
        orientationNormalized: null
      });

      const beforeProbe = JSON.parse(
        new TextDecoder().decode(
          command([
            'ffprobe',
            '-v',
            'error',
            '-show_streams',
            '-show_format',
            '-of',
            'json',
            inputPath
          ])
        )
      ) as {
        streams: Array<Record<string, unknown>>;
        format: { duration?: string; tags?: Record<string, string> };
      };
      const probe = JSON.parse(
        new TextDecoder().decode(
          command([
            'ffprobe',
            '-v',
            'error',
            '-show_streams',
            '-show_format',
            '-of',
            'json',
            outputPath
          ])
        )
      ) as {
        streams: Array<Record<string, unknown> & { codec_name: string }>;
        format: { duration?: string; tags?: Record<string, string> };
      };
      expect(probe.streams.map((stream) => stream.codec_name)).toEqual([videoCodec, audioCodec]);
      for (const key of [
        'width',
        'height',
        'pix_fmt',
        'color_range',
        'color_space',
        'color_transfer',
        'color_primaries',
        'side_data_list'
      ]) {
        expect(probe.streams[0]?.[key]).toEqual(beforeProbe.streams[0]?.[key]);
      }
      for (const key of ['sample_rate', 'channels', 'time_base']) {
        expect(probe.streams[1]?.[key]).toEqual(beforeProbe.streams[1]?.[key]);
      }
      expect(probe.format.duration).toBe(beforeProbe.format.duration);
      expect(probe.format.tags?.title).toBeUndefined();
      expect(probe.format.tags?.location).toBeUndefined();
    }
  );

  test('preserves a disabled video metadata category after the metadata-free remux', async () => {
    const root = await temporary();
    const inputPath = join(root, 'input.mp4');
    const outputPath = join(root, 'output.mp4');
    videoFixture(inputPath, 'mp4', 'mpeg4', 'aac');
    command(['exiftool', '-overwrite_original', '-XMP-dc:Creator=Private Video Author', inputPath]);

    const receipt = await sanitizeMedia({
      inputPath,
      outputPath,
      mimeType: 'video/mp4',
      mediaKind: 'video',
      settings: { ...defaults, removeXmp: false },
      maxOutputBytes: 4 * 1024 * 1024
    });

    expect(receipt.removedCategories).toContain('container-tags');
    expect(receipt.preservedCategories).toEqual(['xmp']);

    expect(
      new TextDecoder().decode(command(['exiftool', '-s3', '-XMP-dc:Creator', outputPath])).trim()
    ).toBe('Private Video Author');
    expect(
      new TextDecoder()
        .decode(command(['exiftool', '-s3', '-Title', '-Location', outputPath]))
        .trim()
    ).toBe('');
  });

  test('rejects versioned Lavf build metadata after the bitexact remux', async () => {
    const root = await temporary();
    const inputPath = join(root, 'input.mp4');
    const outputPath = join(root, 'output.mp4');
    videoFixture(inputPath, 'mp4', 'mpeg4', 'aac');
    let modifiedPostRemuxProbe = false;
    const sanitizer = createMediaSanitizer(async (mediaCommand) => {
      const result = await runMediaCommand(mediaCommand);
      if (
        mediaCommand.cmd[0] === 'ffprobe' &&
        mediaCommand.cmd.at(-1) === outputPath &&
        (await Bun.file(outputPath).exists())
      ) {
        const probe = JSON.parse(new TextDecoder().decode(result.stdout)) as {
          format?: { tags?: Record<string, string> };
        };
        probe.format ??= {};
        probe.format.tags ??= {};
        probe.format.tags.encoder = 'Lavf62.3.100';
        modifiedPostRemuxProbe = true;
        return { ...result, stdout: new TextEncoder().encode(JSON.stringify(probe)) };
      }
      return result;
    });

    await expect(
      sanitizer({
        inputPath,
        outputPath,
        mimeType: 'video/mp4',
        mediaKind: 'video',
        settings: defaults,
        maxOutputBytes: 4 * 1024 * 1024
      })
    ).rejects.toBeInstanceOf(MediaSanitizationError);
    expect(modifiedPostRemuxProbe).toBe(true);
    expect(await Bun.file(outputPath).exists()).toBe(false);
  });
});

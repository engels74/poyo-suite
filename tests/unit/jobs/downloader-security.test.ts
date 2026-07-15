import { afterEach, describe, expect, test } from 'bun:test';
import { exists, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OutputDownloader } from '../../../src/lib/server/jobs/downloader';
import {
  runtimeTestDownloadTransport,
  TEST_MEDIA_ORIGIN
} from '../../../src/lib/server/jobs/runtime-settings';
import type { PoyoStatusResult } from '../../../src/lib/server/poyo/types';
import { createJobFixture, createTestJob } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
const publicDns = async () => [{ address: '93.184.216.34', family: 4 as const }];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function readyOutput(
  fixture: Awaited<ReturnType<typeof createJobFixture>>,
  suffix: string,
  options: {
    url?: string;
    mediaKind?: 'image' | 'video';
    contentType?: string | null;
    fileName?: string | null;
  } = {}
) {
  const job = createTestJob(fixture.repository, suffix);
  const claim = fixture.repository.claimSubmission(job.id, 'security-setup', 1_000);
  if (!claim) throw new Error('Submission claim failed.');
  fixture.repository.markSubmissionTransmitted(job.id, claim.token);
  fixture.repository.acknowledgeSubmission(job.id, claim.token, {
    taskId: `task-${suffix}`,
    statusRaw: 'not_started',
    status: 'not_started',
    createdTime: 'now'
  });
  const mediaKind = options.mediaKind ?? 'image';
  if (mediaKind === 'video') {
    fixture.database.query("UPDATE jobs SET workflow='text-to-video' WHERE id=?").run(job.id);
  }
  const status: PoyoStatusResult = {
    taskId: `task-${suffix}`,
    statusRaw: 'finished',
    status: 'finished',
    creditsAmount: 1,
    files: [
      {
        url: options.url ?? 'https://media.example/result.png',
        fileType: mediaKind,
        label: null,
        format: mediaKind === 'image' ? 'png' : 'mp4',
        contentType: options.contentType ?? null,
        fileName: options.fileName ?? null,
        fileSize: null
      }
    ],
    createdTime: 'now',
    progress: 100,
    errorMessage: null
  };
  fixture.repository.applyStatus(job.id, status, 1_000);
  const output = fixture.repository.outputs(job.id)[0];
  if (!output) throw new Error('Output fixture was not created.');
  return { job, output };
}

describe('output downloader security boundaries', () => {
  test('SEC-DL-00 fixture transport is unavailable outside guarded loopback test mode', async () => {
    expect(runtimeTestDownloadTransport({})).toEqual({});
    expect(() =>
      runtimeTestDownloadTransport({ PLS_TEST_POYO_BASE_URL: 'http://127.0.0.1:4311' })
    ).toThrow('PLS_TEST_MODE=1');
    const transport = runtimeTestDownloadTransport({
      PLS_TEST_MODE: '1',
      PLS_TEST_POYO_BASE_URL: 'http://127.0.0.1:4311'
    });
    if (!('resolveHost' in transport) || !transport.resolveHost || !transport.fetch) {
      throw new Error('Expected guarded fixture transport.');
    }
    expect(await transport.resolveHost(new URL(TEST_MEDIA_ORIGIN).hostname)).toEqual([
      { address: '93.184.216.34', family: 4 }
    ]);
    await expect(transport.resolveHost('attacker.example')).rejects.toThrow('fixture media host');
    await expect(transport.fetch('https://attacker.example/output.png')).rejects.toThrow(
      'fixture media origin'
    );
  });

  test('SEC-DL-01 blocks direct, encoded, numeric, credentialed and unsafe DNS targets before fetch', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const { output } = readyOutput(fixture, 'ssrf');
    let fetches = 0;
    const resolutions: Record<string, Array<{ address: string; family: 4 | 6 }>> = {
      'private.example': [{ address: '10.0.0.8', family: 4 }],
      'mixed.example': [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 }
      ],
      'empty.example': [],
      'unknown.example': [{ address: 'not-an-address', family: 4 }],
      'ipv6-private.example': [{ address: 'fd00::1', family: 6 }]
    };
    const downloader = new OutputDownloader({
      repository: fixture.repository,
      paths: fixture.paths,
      resolveHost: async (hostname) => resolutions[hostname] ?? publicDns(),
      fetch: async () => {
        fetches += 1;
        return new Response();
      }
    });
    const forbidden = [
      'file:///etc/passwd',
      'https://user:secret@media.example/result.png',
      'http://127.0.0.1/internal',
      'http://127.1/internal',
      'http://2130706433/internal',
      'http://0x7f000001/internal',
      'http://0177.0.0.1/internal',
      'http://%31%32%37.0.0.1/internal',
      'http://[::1]/internal',
      'http://[::ffff:127.0.0.1]/internal',
      'http://[fe80::1]/internal',
      'http://[ff02::1]/internal',
      'https://private.example/result.png',
      'https://mixed.example/result.png',
      'https://empty.example/result.png',
      'https://unknown.example/result.png',
      'https://ipv6-private.example/result.png'
    ];

    for (const url of forbidden) {
      fixture.database.query('UPDATE job_outputs SET remote_url=? WHERE id=?').run(url, output.id);
      await expect(downloader.download(output.id)).rejects.toThrow();
    }
    expect(fetches).toBe(0);
  });

  test('SEC-DL-02 refuses redirects without following a provider-controlled Location', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const { output } = readyOutput(fixture, 'redirect');
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const downloader = new OutputDownloader({
      repository: fixture.repository,
      paths: fixture.paths,
      resolveHost: async () => [{ address: '2606:4700::1111', family: 6 }],
      fetch: async (input, init) => {
        requests.push({ url: String(input), redirect: init?.redirect });
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1:65535/internal' }
        });
      }
    });

    await expect(downloader.download(output.id)).rejects.toThrow('redirect');
    expect(requests).toEqual([{ url: 'https://media.example/result.png', redirect: 'manual' }]);
  });

  test('MEDIA-DL-01 rejects unknown, generic, mismatched and non-media response bytes', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const cases = [
      {
        suffix: 'html-missing',
        mediaKind: 'image' as const,
        metadataType: null,
        responseType: null,
        bytes: new TextEncoder().encode('<html>not media</html>')
      },
      {
        suffix: 'html-generic',
        mediaKind: 'image' as const,
        metadataType: null,
        responseType: 'application/octet-stream',
        bytes: new TextEncoder().encode('<html>not media</html>')
      },
      {
        suffix: 'text-declared',
        mediaKind: 'image' as const,
        metadataType: null,
        responseType: 'text/html',
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      },
      {
        suffix: 'random',
        mediaKind: 'video' as const,
        metadataType: null,
        responseType: null,
        bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      },
      {
        suffix: 'kind-mismatch',
        mediaKind: 'image' as const,
        metadataType: null,
        responseType: 'video/mp4',
        bytes: new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
      },
      {
        suffix: 'mime-mismatch',
        mediaKind: 'image' as const,
        metadataType: 'image/png',
        responseType: 'image/jpeg',
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3])
      }
    ];

    for (const entry of cases) {
      const { output } = readyOutput(fixture, entry.suffix, {
        mediaKind: entry.mediaKind,
        contentType: entry.metadataType
      });
      const downloader = new OutputDownloader({
        repository: fixture.repository,
        paths: fixture.paths,
        resolveHost: publicDns,
        fetch: async () =>
          new Response(
            entry.bytes,
            entry.responseType ? { headers: { 'content-type': entry.responseType } } : {}
          )
      });
      await expect(downloader.download(output.id)).rejects.toThrow();
      expect(fixture.repository.output(output.id)).toMatchObject({
        downloadState: 'failed',
        localPath: null
      });
    }
  });

  test('MEDIA-DL-02 derives a supported MIME from signature when metadata is absent or generic', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const [suffix, responseType] of [
      ['missing', null],
      ['generic', 'application/octet-stream']
    ] as const) {
      const { output } = readyOutput(fixture, `detect-${suffix}`, {
        contentType: null,
        fileName: null
      });
      const verified = await new OutputDownloader({
        repository: fixture.repository,
        paths: fixture.paths,
        resolveHost: publicDns,
        fetch: async () =>
          new Response(png, responseType ? { headers: { 'content-type': responseType } } : {})
      }).download(output.id);
      expect(verified).toMatchObject({ downloadState: 'verified', contentType: 'image/png' });
      expect(verified.localPath).toEndWith('.png');
      expect(verified.localPath && (await exists(verified.localPath))).toBe(true);
    }

    const video = await Bun.file('tests/fixtures/media/tiny.mp4').bytes();
    const { output } = readyOutput(fixture, 'detect-video', {
      mediaKind: 'video',
      contentType: null,
      fileName: null
    });
    const verified = await new OutputDownloader({
      repository: fixture.repository,
      paths: fixture.paths,
      resolveHost: publicDns,
      fetch: async () => new Response(video)
    }).download(output.id);
    expect(verified).toMatchObject({ downloadState: 'verified', contentType: 'video/mp4' });
    expect(verified.localPath).toEndWith('.mp4');
  });

  test('MEDIA-DL-03 refuses symlinked parents and destination leaf collisions', async () => {
    const fixture = await createJobFixture();
    cleanups.push(fixture.cleanup);
    const { job, output } = readyOutput(fixture, 'symlink');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const outside = join(dirname(fixture.paths.media), 'outside');
    await mkdir(fixture.paths.media, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(fixture.paths.media, job.id), 'dir');
    let fetches = 0;
    const downloader = new OutputDownloader({
      repository: fixture.repository,
      paths: fixture.paths,
      resolveHost: publicDns,
      fetch: async () => {
        fetches += 1;
        return new Response(png, { headers: { 'content-type': 'image/png' } });
      }
    });

    await expect(downloader.download(output.id)).rejects.toThrow('symbolic');
    expect(fetches).toBe(0);
    expect(await Bun.file(join(outside, `0-${output.id.slice(0, 8)}-result.png`)).exists()).toBe(
      false
    );

    await unlink(join(fixture.paths.media, job.id));
    const directory = join(fixture.paths.media, job.id);
    await mkdir(directory, { mode: 0o700 });
    const outsideFile = join(outside, 'sentinel.png');
    await writeFile(outsideFile, 'sentinel');
    const destination = join(directory, `0-${output.id.slice(0, 8)}-result.png`);
    await symlink(outsideFile, destination);
    await expect(downloader.download(output.id)).rejects.toThrow('already exists');
    expect(await readFile(outsideFile, 'utf8')).toBe('sentinel');
  });
});

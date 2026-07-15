import { afterEach, describe, expect, test } from 'bun:test';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JobRepository } from '../../../src/lib/server/jobs/repository';
import { ManagedSourceRepository } from '../../../src/lib/server/media/managed-sources';
import { intakeLocalSource } from '../../../src/lib/server/media/source-intake';
import { ensureAppPaths, resolveAppPaths } from '../../../src/lib/server/platform/app-paths';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { createTestJob } from '../../helpers/job-fixture';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  const temporary = await createTemporaryDirectory('poyo-source-');
  const paths = resolveAppPaths({
    environment: { PLS_APP_DATA_DIR: join(temporary.path, 'studio') },
    homeDirectory: temporary.path
  });
  await ensureAppPaths(paths);
  const database = await openDatabase(paths.database);
  cleanups.push(async () => {
    database.close();
    await temporary.cleanup();
  });
  return { paths, database, repository: new ManagedSourceRepository(database, paths) };
}

function uploadRequest(bytes: Uint8Array, type = 'image/png', origin?: string): Request {
  const form = new FormData();
  form.set('mediaKind', 'image');
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  form.set('file', new File([buffer], '../unsafe-name.png', { type }));
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
    expect(source.localPath).toStartWith(paths.uploads);
    expect((await stat(source.localPath)).size).toBe(png.byteLength);
    expect(source.checksum).toHaveLength(64);
    expect(source.signature).toStartWith('89504e47');
    expect((await repository.register(source)).localPath).toBe(source.localPath);
    expect((await repository.resolveAvailable(source.id, 'image')).localPath).toBe(
      source.localPath
    );
    await expect(repository.resolveAvailable('../unsafe')).rejects.toThrow('not valid');
    expect(await Array.fromAsync(new Bun.Glob('*.part').scan(paths.temporary))).toEqual([]);
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

  test('UPLOAD-04 adopts a version-two local reference once without retaining its absolute path', async () => {
    const { paths, database, repository } = await fixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const source = await intakeLocalSource(
      uploadRequest(png, 'image/png', 'http://127.0.0.1:5173'),
      paths
    );
    const job = createTestJob(new JobRepository(database), 'legacy-source');
    database
      .query(
        `INSERT INTO job_inputs(job_id,role,input_order,media_kind,local_reference,upload_url,metadata_json,availability)
         VALUES (?, 'source-image', 0, 'image', ?, 'https://poyo.test/source.png', ?, 'available')`
      )
      .run(job.id, source.localPath, JSON.stringify({ name: source.originalName }));

    expect(await repository.adoptLegacyReferences()).toBe(1);
    expect(await repository.adoptLegacyReferences()).toBe(0);
    expect(await repository.resolveAvailable(source.id)).toMatchObject({
      id: source.id,
      checksum: source.checksum,
      byteSize: png.byteLength,
      availability: 'available'
    });
    expect(
      database
        .query<{ local_reference: string | null; managed_source_id: string | null }, [string]>(
          'SELECT local_reference,managed_source_id FROM job_inputs WHERE job_id=?'
        )
        .get(job.id)
    ).toEqual({ local_reference: null, managed_source_id: source.id });
  });
});

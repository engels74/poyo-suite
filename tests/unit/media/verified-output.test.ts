import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  resolveVerifiedMediaOutput,
  serveVerifiedMediaOutput
} from '../../../src/lib/server/media/verified-output';
import { createJobFixture, createTestJob } from '../../helpers/job-fixture';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

async function outputFixture() {
  const fixture = await createJobFixture();
  cleanups.push(fixture.cleanup);
  const job = createTestJob(fixture.repository, 'verified-output');
  const outputId = crypto.randomUUID();
  fixture.database
    .query(
      `INSERT INTO job_outputs(id,job_id,output_order,media_kind,download_state,created_at)
       VALUES (?,?,0,'image','pending',?)`
    )
    .run(outputId, job.id, '2026-07-15T12:00:00.000Z');
  return { fixture, outputId };
}

describe('verified media output boundary', () => {
  test('resolves only a verified output ID inside a managed media root', async () => {
    const { fixture, outputId } = await outputFixture();
    const path = join(fixture.paths.media, 'job', 'result.png');
    await mkdir(join(fixture.paths.media, 'job'), { recursive: true });
    await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

    await expect(
      resolveVerifiedMediaOutput(fixture.database, fixture.paths.media, outputId)
    ).rejects.toThrow('not available locally');
    fixture.database
      .query(
        "UPDATE job_outputs SET local_path=?,content_type='image/png',download_state='verified' WHERE id=?"
      )
      .run(path, outputId);
    const resolved = await resolveVerifiedMediaOutput(
      fixture.database,
      fixture.paths.media,
      outputId
    );
    expect(resolved).toMatchObject({ outputId, fileName: 'result.png', contentType: 'image/png' });
    expect(resolved.path).toBe(await realpath(path));
  });

  test('rejects missing and outside-root files without exposing their paths', async () => {
    const { fixture, outputId } = await outputFixture();
    const outside = join(dirname(fixture.paths.media), 'private.png');
    await writeFile(outside, 'private');
    fixture.database
      .query("UPDATE job_outputs SET local_path=?,download_state='verified' WHERE id=?")
      .run(outside, outputId);
    let caught: Error | null = null;
    try {
      await resolveVerifiedMediaOutput(fixture.database, fixture.paths.media, outputId);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe('This output is not available locally.');
    expect(caught?.message).not.toContain(outside);
  });

  test('serves an attachment with a safe filename and rejects cross-site reads', async () => {
    const { fixture, outputId } = await outputFixture();
    const path = join(fixture.paths.media, 'job', 'result portrait.png');
    await mkdir(join(fixture.paths.media, 'job'), { recursive: true });
    await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    fixture.database
      .query(
        "UPDATE job_outputs SET local_path=?,content_type='image/png',download_state='verified' WHERE id=?"
      )
      .run(path, outputId);

    const response = await serveVerifiedMediaOutput(
      new Request(`http://127.0.0.1/api/media/${outputId}/download`),
      fixture.database,
      fixture.paths.media,
      outputId,
      { attachment: true }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('attachment;');
    expect(response.headers.get('content-disposition')).toContain('result%20portrait.png');
    expect(response.headers.get('cache-control')).toBe('private, no-store');

    const rejected = await serveVerifiedMediaOutput(
      new Request(`http://127.0.0.1/api/media/${outputId}`, {
        headers: { 'sec-fetch-site': 'cross-site' }
      }),
      fixture.database,
      fixture.paths.media,
      outputId
    );
    expect(rejected.status).toBe(403);
  });
});

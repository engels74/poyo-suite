import { expect, test } from 'bun:test';
import {
  requestPinnedDownload,
  resolveDownloadTarget
} from '../../src/lib/server/jobs/download-egress';

const enabled = Bun.env.PLS_RUN_PUBLIC_DOWNLOAD_TEST === '1';

test.skipIf(!enabled)(
  'optional unauthenticated public HTTP(S) pinned transport probe',
  async () => {
    for (const url of ['http://example.com/', 'https://example.com/']) {
      const response = await requestPinnedDownload(await resolveDownloadTarget(url), {
        connectTimeoutMs: 10_000,
        headerTimeoutMs: 10_000
      });
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(400);
      await response.body?.cancel();
    }
  }
);

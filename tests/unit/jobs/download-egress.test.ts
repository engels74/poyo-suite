import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type RequestListener, type RequestOptions } from 'node:http';
import type { Socket } from 'node:net';
import {
  createPinnedLookup,
  type DownloadTarget,
  requestPinnedDownload,
  resolveDownloadTarget
} from '../../../src/lib/server/jobs/download-egress';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixtureServer(handler: RequestListener): Promise<number> {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind.');
  return address.port;
}

function publicTarget(port: number): DownloadTarget {
  return {
    url: new URL(`http://media.fixture.example:${port}/output.png?token=fixture`),
    hostname: 'media.fixture.example',
    addresses: [{ address: '93.184.216.34', family: 4 }]
  };
}

function localFixtureLookup(): NonNullable<RequestOptions['lookup']> {
  return (_hostname, options, callback) => {
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address: '127.0.0.1', family: 4 }]);
      return;
    }
    callback(null, '127.0.0.1', 4);
  };
}

describe('production pinned download transport', () => {
  test('SEC-DL-04 pins lookup to exactly one prevalidated address and supports mapped public IPv4', async () => {
    const target = publicTarget(443);
    const lookup = createPinnedLookup(target);
    const selected = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup(target.hostname, { all: false }, (error, address, family) => {
        if (error) reject(error);
        else if (typeof address !== 'string') reject(new Error('Expected one pinned address.'));
        else if (family !== 4 && family !== 6) reject(new Error('Expected a pinned IP family.'));
        else resolve({ address, family });
      });
    });
    expect(selected).toEqual({ address: '93.184.216.34', family: 4 });
    await expect(
      new Promise((resolve, reject) => {
        lookup('attacker.example', { all: false }, (error, address) =>
          error ? reject(error) : resolve(address)
        );
      })
    ).rejects.toThrow('unexpected host');

    expect(
      await resolveDownloadTarget('https://mapped.example/output.png', async () => [
        { address: '::ffff:5db8:d822', family: 6 }
      ])
    ).toMatchObject({ addresses: [{ address: '93.184.216.34', family: 4 }] });
    await expect(
      resolveDownloadTarget('https://mapped-private.example/output.png', async () => [
        { address: '::ffff:127.0.0.1', family: 6 }
      ])
    ).rejects.toThrow('not public');
  });

  test('SEC-DL-05 real Bun node:http path accepts a controlled public-looking pinned mapping', async () => {
    const port = await fixtureServer((request, response) => {
      expect(request.headers.host).toBe(`media.fixture.example:${port}`);
      expect(request.headers.connection).toBe('close');
      expect(request.url).toBe('/output.png?token=fixture');
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });
    const response = await requestPinnedDownload(publicTarget(port), {
      connectTimeoutMs: 250,
      headerTimeoutMs: 250,
      lookup: localFixtureLookup()
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });

  test('MEDIA-DL-04 bounds stalled connections and response headers', async () => {
    await expect(
      requestPinnedDownload(publicTarget(443), {
        connectTimeoutMs: 20,
        headerTimeoutMs: 100,
        lookup: () => undefined
      })
    ).rejects.toThrow('connection/header deadline');

    const port = await fixtureServer(() => undefined);
    await expect(
      requestPinnedDownload(publicTarget(port), {
        connectTimeoutMs: 100,
        headerTimeoutMs: 20,
        lookup: localFixtureLookup()
      })
    ).rejects.toThrow('connection/header deadline');
  });
});

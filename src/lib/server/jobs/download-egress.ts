import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

export interface DownloadAddress {
  address: string;
  family: 4 | 6;
}

export type DownloadHostResolver = (hostname: string) => Promise<readonly DownloadAddress[]>;

export interface DownloadTarget {
  url: URL;
  hostname: string;
  addresses: readonly DownloadAddress[];
}

export interface PinnedDownloadRequestOptions {
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  headerTimeoutMs?: number;
  /** Controlled test seam; production callers must use the default pinned lookup. */
  lookup?: RequestOptions['lookup'];
}

const forbiddenAddresses = new BlockList();

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  forbiddenAddresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20]
] as const) {
  forbiddenAddresses.addSubnet(network, prefix, 'ipv6');
}

function normalizedHostname(value: string): string {
  return value
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function mappedIpv4(address: string): string | null {
  const normalized = address.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(normalized)?.[1];
  if (dotted && isIP(dotted) === 4) return dotted;
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (!hexadecimal) return null;
  const high = Number.parseInt(hexadecimal[1] ?? '', 16);
  const low = Number.parseInt(hexadecimal[2] ?? '', 16);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function normalizedAddress(value: DownloadAddress): DownloadAddress {
  const mapped = value.family === 6 ? mappedIpv4(value.address) : null;
  return mapped ? { address: mapped, family: 4 } : value;
}

export function isPublicDownloadAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !forbiddenAddresses.check(address, 'ipv4');
  if (family !== 6) return false;
  const firstHextet = Number.parseInt(address.split(':', 1)[0] ?? '', 16);
  if (!Number.isFinite(firstHextet) || firstHextet < 0x2000 || firstHextet > 0x3fff) return false;
  return !forbiddenAddresses.check(address, 'ipv6');
}

async function systemResolveHost(hostname: string): Promise<readonly DownloadAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => {
    if (family !== 4 && family !== 6) throw new Error('Unsupported DNS address family.');
    return { address, family };
  });
}

export async function resolveDownloadTarget(
  input: string,
  resolveHost: DownloadHostResolver = systemResolveHost
): Promise<DownloadTarget> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Remote output URL is not permitted.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    !url.hostname ||
    url.href.length > 8_192
  ) {
    throw new Error('Remote output URL is not permitted.');
  }

  const hostname = normalizedHostname(url.hostname);
  const literalFamily = isIP(hostname);
  let addresses: readonly DownloadAddress[];
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await resolveHost(hostname);
  } catch {
    throw new Error('Remote output host could not be resolved safely.');
  }
  const normalizedAddresses = addresses.map(normalizedAddress);
  if (
    normalizedAddresses.length === 0 ||
    normalizedAddresses.some(
      ({ address, family }) =>
        (family !== 4 && family !== 6) ||
        isIP(address) !== family ||
        !isPublicDownloadAddress(address)
    )
  ) {
    throw new Error('Remote output address is not public.');
  }
  return { url, hostname, addresses: normalizedAddresses };
}

function responseHeaders(source: import('node:http').IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < source.rawHeaders.length; index += 2) {
    const name = source.rawHeaders[index];
    const value = source.rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
  return headers;
}

export function createPinnedLookup(target: DownloadTarget): NonNullable<RequestOptions['lookup']> {
  const pinned = target.addresses[0];
  if (!pinned || !isPublicDownloadAddress(pinned.address)) {
    throw new Error('Remote output address is not public.');
  }
  return (hostname, options, callback) => {
    if (normalizedHostname(hostname) !== target.hostname) {
      callback(
        new Error('Pinned lookup received an unexpected host.'),
        pinned.address,
        pinned.family
      );
      return;
    }
    if (typeof options === 'object' && options.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : fallback;
}

export function requestPinnedDownload(
  target: DownloadTarget,
  options: PinnedDownloadRequestOptions = {}
): Promise<Response> {
  const pinned = target.addresses[0];
  if (!pinned || !isPublicDownloadAddress(pinned.address)) {
    return Promise.reject(new Error('Remote output address is not public.'));
  }
  const connectTimeoutMs = positiveTimeout(options.connectTimeoutMs, 30_000);
  const headerTimeoutMs = positiveTimeout(options.headerTimeoutMs, 30_000);
  // A custom lookup supplies exactly the already-validated address and disables family selection.
  // No second system DNS query or socket.remoteAddress support is required from Bun.
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectionTimer);
      callback();
    };
    const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: target.url.protocol,
        hostname: target.hostname,
        family: pinned.family,
        lookup: options.lookup ?? createPinnedLookup(target),
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'GET',
        agent: false,
        ...(isIP(target.hostname) ? {} : { servername: target.hostname }),
        rejectUnauthorized: true,
        maxHeaderSize: 16 * 1024,
        signal: options.signal,
        headers: {
          accept: 'image/*, video/*',
          'accept-encoding': 'identity',
          connection: 'close',
          host: target.url.host,
          'user-agent': 'Poyo-Local-Studio/0.1'
        }
      },
      (incoming) => {
        const status = incoming.statusCode ?? 502;
        const noBody = status === 204 || status === 205 || status === 304;
        finish(() =>
          resolve(
            new Response(
              noBody ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>),
              { status, headers: responseHeaders(incoming) }
            )
          )
        );
      }
    );
    const connectionTimer = setTimeout(
      () => {
        const error = new Error('Remote output connection/header deadline exceeded.');
        finish(() => {
          request.destroy(error);
          reject(error);
        });
      },
      Math.min(connectTimeoutMs, headerTimeoutMs)
    );
    connectionTimer.unref();
    request.once('error', (error) => finish(() => reject(error)));
    request.end();
  });
}

import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
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
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address, family }) =>
        (family !== 4 && family !== 6) ||
        isIP(address) !== family ||
        !isPublicDownloadAddress(address)
    )
  ) {
    throw new Error('Remote output address is not public.');
  }
  return { url, hostname, addresses };
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

export function requestPinnedDownload(target: DownloadTarget): Promise<Response> {
  const pinned = target.addresses[0];
  if (!pinned || !isPublicDownloadAddress(pinned.address)) {
    return Promise.reject(new Error('Remote output address is not public.'));
  }
  // The socket connects to the validated IP directly while Host/SNI retain the original host.
  // This prevents a second DNS lookup; residual trust is limited to the OS resolver result and
  // Bun's node:http(s) compatibility because Poyo documents no stable output-host allowlist.
  return new Promise((resolve, reject) => {
    const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(
      {
        protocol: target.url.protocol,
        hostname: pinned.address,
        family: pinned.family,
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'GET',
        agent: false,
        servername: isIP(target.hostname) ? undefined : target.hostname,
        rejectUnauthorized: true,
        headers: {
          accept: 'image/*, video/*',
          'accept-encoding': 'identity',
          host: target.url.host,
          'user-agent': 'Poyo-Local-Studio/0.1'
        }
      },
      (incoming) => {
        const remoteAddress = incoming.socket.remoteAddress;
        if (!remoteAddress || !isPublicDownloadAddress(remoteAddress)) {
          incoming.destroy(new Error('Remote output connection address is not public.'));
          reject(new Error('Remote output connection address is not public.'));
          return;
        }
        const status = incoming.statusCode ?? 502;
        const noBody = status === 204 || status === 205 || status === 304;
        resolve(
          new Response(
            noBody ? null : (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>),
            { status, headers: responseHeaders(incoming) }
          )
        );
      }
    );
    request.once('error', reject);
    request.end();
  });
}

export interface PublicIpv4GuardSettings {
  enabled: boolean;
  homeIpv4: string | null;
}

export type PublicIpv4StatusState =
  | 'guard-disabled'
  | 'protected'
  | 'blocked'
  | 'unavailable'
  | 'misconfigured';

export interface PublicIpv4StatusDto {
  state: PublicIpv4StatusState;
  currentIpv4: string | null;
  checkedAt: string | null;
  availability: 'available' | 'unavailable';
}

export const DEFAULT_PUBLIC_IPV4_GUARD_SETTINGS: PublicIpv4GuardSettings = {
  enabled: false,
  homeIpv4: null
};

export class PublicIpv4ValidationError extends Error {
  readonly code = 'public_ipv4_guard_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'PublicIpv4ValidationError';
  }
}

type Cidr = readonly [network: number, prefix: number];

const GLOBALLY_REACHABLE_SPECIAL_RANGES: readonly Cidr[] = [
  [0xc0000009, 32],
  [0xc000000a, 32],
  [0xc01fc400, 24],
  [0xc034c100, 24],
  [0xc0af3000, 24]
];

const NON_PUBLIC_RANGES: readonly Cidr[] = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4]
];

function inCidr(value: number, [network, prefix]: Cidr): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (network & mask) >>> 0;
}

export function parsePublicIpv4(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PublicIpv4ValidationError('Enter a public IPv4 address in dotted-decimal form.');
  }
  const candidate = value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  const parts = candidate.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))) {
    throw new PublicIpv4ValidationError(
      'Enter four decimal octets without signs, shorthand, or leading zeroes.'
    );
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    throw new PublicIpv4ValidationError('Each IPv4 octet must be between 0 and 255.');
  }
  const numeric = octets.reduce((address, octet) => ((address << 8) | octet) >>> 0, 0);
  if (
    !GLOBALLY_REACHABLE_SPECIAL_RANGES.some((range) => inCidr(numeric, range)) &&
    NON_PUBLIC_RANGES.some((range) => inCidr(numeric, range))
  ) {
    throw new PublicIpv4ValidationError(
      'Use a globally routable public IPv4 address, not a private or special-use address.'
    );
  }
  return octets.join('.');
}

export function normalizePublicIpv4GuardSettings(value: unknown): PublicIpv4GuardSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_PUBLIC_IPV4_GUARD_SETTINGS };
  }
  const input = value as { enabled?: unknown; homeIpv4?: unknown };
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new PublicIpv4ValidationError('The IP guard enable setting must be true or false.');
  }
  const homeIpv4 =
    input.homeIpv4 === null || input.homeIpv4 === undefined || input.homeIpv4 === ''
      ? null
      : parsePublicIpv4(input.homeIpv4);
  const enabled = input.enabled === true;
  if (enabled && !homeIpv4) {
    throw new PublicIpv4ValidationError('Save a valid home public IPv4 before enabling the guard.');
  }
  return { enabled, homeIpv4 };
}

export function parsePublicIpv4GuardSettings(value: unknown): PublicIpv4GuardSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PublicIpv4ValidationError('Public IPv4 guard settings must be an object.');
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !Object.hasOwn(value, 'enabled') || !Object.hasOwn(value, 'homeIpv4')) {
    throw new PublicIpv4ValidationError('Provide exactly the enabled and homeIpv4 guard settings.');
  }
  const input = value as { enabled: unknown; homeIpv4: unknown };
  if (typeof input.enabled !== 'boolean') {
    throw new PublicIpv4ValidationError('The IP guard enable setting must be true or false.');
  }
  const homeIpv4 = input.homeIpv4 === null ? null : parsePublicIpv4(input.homeIpv4);
  if (input.enabled && !homeIpv4) {
    throw new PublicIpv4ValidationError('Save a valid home public IPv4 before enabling the guard.');
  }
  return { enabled: input.enabled, homeIpv4 };
}

export function publicIpv4Status(
  settings: PublicIpv4GuardSettings,
  observation: { currentIpv4: string | null; checkedAt: string | null }
): PublicIpv4StatusDto {
  if (!observation.currentIpv4) {
    return {
      state: 'unavailable',
      currentIpv4: null,
      checkedAt: observation.checkedAt,
      availability: 'unavailable'
    };
  }
  return {
    state: !settings.enabled
      ? 'guard-disabled'
      : observation.currentIpv4 === settings.homeIpv4
        ? 'blocked'
        : 'protected',
    currentIpv4: observation.currentIpv4,
    checkedAt: observation.checkedAt,
    availability: 'available'
  };
}

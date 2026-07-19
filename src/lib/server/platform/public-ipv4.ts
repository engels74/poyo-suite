import {
  DEFAULT_PUBLIC_IPV4_GUARD_SETTINGS,
  normalizePublicIpv4GuardSettings,
  parsePublicIpv4,
  parsePublicIpv4GuardSettings,
  publicIpv4Status,
  type PublicIpv4GuardSettings,
  type PublicIpv4StatusDto
} from '../../features/settings/public-ipv4-guard';
import { publicIpv4GuardError } from '../poyo/errors';
import type { PoyoOperation } from '../poyo/types';
import type { SettingsRepository } from '../settings/settings-repository';

export const PUBLIC_IPV4_LOOKUP_URL = 'https://api.ipify.org';
export const PUBLIC_IPV4_LOOKUP_TIMEOUT_MS = 2_000;
export const PUBLIC_IPV4_MAX_RESPONSE_BYTES = 64;
export const PUBLIC_IPV4_SUCCESS_TTL_MS = 60_000;
export const PUBLIC_IPV4_FAILURE_TTL_MS = 10_000;
export const PUBLIC_IPV4_MAX_ENFORCEMENT_AGE_MS = 60_000;

export const PUBLIC_IPV4_GUARD_SETTING_KEY = 'public-ipv4-guard';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type CachedObservation =
  | { kind: 'success'; ipv4: string; checkedAtMs: number; expiresAtMs: number }
  | { kind: 'failure'; checkedAtMs: number; expiresAtMs: number };
type GuardConfiguration =
  | { kind: 'valid'; settings: PublicIpv4GuardSettings }
  | { kind: 'misconfigured'; settings: PublicIpv4GuardSettings };

export interface PublicIpv4ServiceOptions {
  settings: SettingsRepository;
  environment?: Record<string, string | undefined>;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  successTtlMs?: number;
  failureTtlMs?: number;
  maxEnforcementAgeMs?: number;
  lookupUrl?: string;
}

export function runtimePublicIpv4LookupUrl(
  environment: Record<string, string | undefined>
): string {
  const configured = environment.PLS_TEST_PUBLIC_IPV4_URL?.trim();
  if (!configured) return PUBLIC_IPV4_LOOKUP_URL;
  if (environment.PLS_TEST_MODE !== '1') {
    throw new Error('PLS_TEST_PUBLIC_IPV4_URL is available only when PLS_TEST_MODE=1.');
  }
  const url = new URL(configured);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '::1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/ip' ||
    url.search ||
    url.hash
  ) {
    throw new Error('The test public IPv4 URL must be the loopback HTTP /ip fixture.');
  }
  return url.href;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('Public IPv4 response exceeded its local limit.');
    }
  }
  if (!response.body) throw new Error('Public IPv4 response was empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('Public IPv4 response exceeded its local limit.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export class PublicIpv4Service {
  private readonly fetchImplementation: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly maxEnforcementAgeMs: number;
  private readonly lookupUrl: string;
  private cache: CachedObservation | null = null;
  private inFlight: Promise<CachedObservation> | null = null;

  constructor(private readonly options: PublicIpv4ServiceOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? PUBLIC_IPV4_LOOKUP_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? PUBLIC_IPV4_MAX_RESPONSE_BYTES;
    this.successTtlMs = options.successTtlMs ?? PUBLIC_IPV4_SUCCESS_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? PUBLIC_IPV4_FAILURE_TTL_MS;
    this.maxEnforcementAgeMs = options.maxEnforcementAgeMs ?? PUBLIC_IPV4_MAX_ENFORCEMENT_AGE_MS;
    this.lookupUrl = options.lookupUrl ?? runtimePublicIpv4LookupUrl(options.environment ?? {});
  }

  private readConfiguration(): GuardConfiguration {
    let stored: { value: unknown } | null;
    try {
      stored = this.options.settings.get<unknown>(PUBLIC_IPV4_GUARD_SETTING_KEY);
    } catch {
      return { kind: 'misconfigured', settings: { enabled: true, homeIpv4: null } };
    }
    if (!stored) return { kind: 'valid', settings: { ...DEFAULT_PUBLIC_IPV4_GUARD_SETTINGS } };
    try {
      return { kind: 'valid', settings: normalizePublicIpv4GuardSettings(stored.value) };
    } catch {
      const claimsEnabled =
        Boolean(stored.value) &&
        typeof stored.value === 'object' &&
        !Array.isArray(stored.value) &&
        (stored.value as { enabled?: unknown }).enabled === true;
      return claimsEnabled
        ? { kind: 'misconfigured', settings: { enabled: true, homeIpv4: null } }
        : { kind: 'valid', settings: { ...DEFAULT_PUBLIC_IPV4_GUARD_SETTINGS } };
    }
  }

  readSettings(): PublicIpv4GuardSettings {
    return this.readConfiguration().settings;
  }

  saveSettings(value: unknown): PublicIpv4GuardSettings {
    const settings = parsePublicIpv4GuardSettings(value);
    this.options.settings.set(PUBLIC_IPV4_GUARD_SETTING_KEY, settings);
    return settings;
  }

  private async performLookup(): Promise<CachedObservation> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Public IPv4 lookup timed out.', 'TimeoutError')),
      this.timeoutMs
    );
    try {
      const response = await this.fetchImplementation(this.lookupUrl, {
        method: 'GET',
        headers: { Accept: 'text/plain' },
        credentials: 'omit',
        redirect: 'manual',
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error('Public IPv4 provider was unavailable.');
      }
      const ipv4 = parsePublicIpv4(await readBoundedText(response, this.maxResponseBytes));
      const checkedAtMs = this.now();
      return {
        kind: 'success',
        ipv4,
        checkedAtMs,
        expiresAtMs: checkedAtMs + this.successTtlMs
      };
    } catch {
      const checkedAtMs = this.now();
      return { kind: 'failure', checkedAtMs, expiresAtMs: checkedAtMs + this.failureTtlMs };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async observe(refresh: boolean, enforcement: boolean): Promise<CachedObservation> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    const current = this.cache;
    const enforcementFresh =
      current?.kind === 'success' && now - current.checkedAtMs <= this.maxEnforcementAgeMs;
    if (
      !refresh &&
      current &&
      current.expiresAtMs >= now &&
      (!enforcement || current.kind === 'failure' || enforcementFresh)
    ) {
      return current;
    }
    this.inFlight = this.performLookup().then((result) => {
      this.cache = result;
      return result;
    });
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async status(options: { refresh?: boolean } = {}): Promise<PublicIpv4StatusDto> {
    const configuration = this.readConfiguration();
    if (configuration.kind === 'misconfigured') {
      return {
        state: 'misconfigured',
        currentIpv4: null,
        checkedAt: null,
        availability: 'unavailable'
      };
    }
    const observation = await this.observe(options.refresh === true, false);
    return publicIpv4Status(configuration.settings, {
      currentIpv4: observation.kind === 'success' ? observation.ipv4 : null,
      checkedAt: new Date(observation.checkedAtMs).toISOString()
    });
  }

  async assertPoyoRequestAllowed(operation: PoyoOperation): Promise<void> {
    const configuration = this.readConfiguration();
    if (configuration.kind === 'misconfigured') {
      throw publicIpv4GuardError(operation, 'misconfigured');
    }
    const settings = configuration.settings;
    if (!settings.enabled) return;
    const observation = await this.observe(false, true);
    if (observation.kind !== 'success') {
      throw publicIpv4GuardError(operation, 'unavailable');
    }
    if (observation.ipv4 === settings.homeIpv4) {
      throw publicIpv4GuardError(operation, 'match');
    }
  }
}

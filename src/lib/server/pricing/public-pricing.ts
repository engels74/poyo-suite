import {
  MAX_PUBLIC_PRICING_TIERS,
  PRICING_SIGNATURE_VERSION,
  type PricingSnapshotView,
  PUBLIC_PRICING_SNAPSHOT_VERSION,
  type PublishedPricingSnapshot,
  type PublishedPricingTier
} from '../../features/pricing/contracts';
import {
  normalizePublicPricingInventory,
  type PublicPricingInventory
} from '../../features/pricing/inventory';
import { IMAGE_REGISTRY_VERSION } from '../../features/registry/image-registry';
import { VIDEO_REGISTRY_VERSION } from '../../features/registry/video-registry';
import type { MaintenanceGate } from '../platform/maintenance-gate';
import type { StoredSetting } from '../settings/settings-repository';

export const PUBLIC_PRICING_URL = 'https://poyo.ai/pricing' as const;
export const PUBLIC_PRICING_SETTING_KEY = 'public-pricing';
export const PUBLIC_PRICING_SETTING_VERSION = 1;
export const PUBLIC_PRICING_TTL_MS = 24 * 60 * 60 * 1_000;
export const PUBLIC_PRICING_TIMEOUT_MS = 4_000;
export const PUBLIC_PRICING_MAX_RESPONSE_BYTES = 1024 * 1024;
export const PUBLIC_PRICING_MAX_REDIRECTS = 2;
export const PUBLIC_PRICING_BACKOFF_BASE_MS = 5 * 60 * 1_000;
export const PUBLIC_PRICING_BACKOFF_MAX_MS = 6 * 60 * 60 * 1_000;
export const PUBLIC_PRICING_USER_AGENT = 'Poyo-Local-Studio/0.1 pricing-cache';

export type PricingRefreshFailureCategory =
  | 'admission-refused'
  | 'timeout'
  | 'network'
  | 'http'
  | 'redirect'
  | 'oversize'
  | 'parse'
  | 'schema'
  | 'empty-inventory'
  | 'write-refused'
  | 'refresh-rejected';

interface PublicPricingValidators {
  etag: string | null;
  lastModified: string | null;
}

interface StoredPublicPricingState {
  schemaVersion: typeof PUBLIC_PRICING_SETTING_VERSION;
  snapshot: PublishedPricingSnapshot | null;
  validators: PublicPricingValidators;
  failureCount: number;
  nextAttemptAt: string | null;
  lastFailureCategory: PricingRefreshFailureCategory | null;
}

interface SettingsStore {
  get<T>(key: string): StoredSetting<T> | null;
  set<T>(key: string, value: T, version?: number, now?: Date): StoredSetting<T>;
}

interface PricingMaintenanceGate {
  trackDetached<T>(label: string, operation: () => Promise<T>): Promise<T>;
  withWriterPermit<T>(label: string, operation: () => Promise<T>): Promise<T>;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PublicPricingServiceOptions {
  settings: SettingsStore;
  gate: Pick<MaintenanceGate, 'trackDetached' | 'withWriterPermit'> | PricingMaintenanceGate;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  ttlMs?: number;
  reportFailure?: (category: PricingRefreshFailureCategory) => Promise<void> | void;
}

class PricingRefreshError extends Error {
  constructor(readonly category: PricingRefreshFailureCategory) {
    super(`Published pricing refresh failed: ${category}.`);
    this.name = 'PricingRefreshError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedHeader(value: string | null, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validFailureCategory(value: unknown): value is PricingRefreshFailureCategory {
  return (
    value === 'admission-refused' ||
    value === 'timeout' ||
    value === 'network' ||
    value === 'http' ||
    value === 'redirect' ||
    value === 'oversize' ||
    value === 'parse' ||
    value === 'schema' ||
    value === 'empty-inventory' ||
    value === 'write-refused' ||
    value === 'refresh-rejected'
  );
}

function validTier(value: unknown): value is PublishedPricingTier {
  if (!isRecord(value) || !isRecord(value.dimensions)) return false;
  const dimensions = value.dimensions;
  const validDimensions =
    Object.keys(dimensions).every((key) =>
      ['duration', 'hasAudio', 'mode', 'quality', 'resolution'].includes(key)
    ) &&
    (dimensions.duration === undefined ||
      (Number.isSafeInteger(dimensions.duration) &&
        (dimensions.duration as number) > 0 &&
        (dimensions.duration as number) <= 3_600)) &&
    (dimensions.hasAudio === undefined || typeof dimensions.hasAudio === 'boolean') &&
    (dimensions.mode === undefined ||
      (typeof dimensions.mode === 'string' && dimensions.mode.length <= 64)) &&
    (dimensions.quality === undefined ||
      (typeof dimensions.quality === 'string' && dimensions.quality.length <= 32)) &&
    (dimensions.resolution === undefined ||
      (typeof dimensions.resolution === 'string' && dimensions.resolution.length <= 32));
  return (
    typeof value.signature === 'string' &&
    value.signature.length <= 512 &&
    typeof value.registryVersion === 'string' &&
    value.registryVersion.length <= 64 &&
    typeof value.modelId === 'string' &&
    value.modelId.length <= 128 &&
    (value.mediaKind === 'image' || value.mediaKind === 'video') &&
    typeof value.workflow === 'string' &&
    (value.unit === 'per-output' || value.unit === 'per-second') &&
    typeof value.creditsPerUnit === 'number' &&
    Number.isFinite(value.creditsPerUnit) &&
    value.creditsPerUnit >= 0 &&
    value.creditsPerUnit <= 1_000_000 &&
    validDimensions
  );
}

function validSnapshot(value: unknown): value is PublishedPricingSnapshot {
  if (!isRecord(value) || !isRecord(value.registryVersions) || !isRecord(value.source))
    return false;
  return (
    value.version === PUBLIC_PRICING_SNAPSHOT_VERSION &&
    value.signatureVersion === PRICING_SIGNATURE_VERSION &&
    typeof value.pricingHash === 'string' &&
    /^[a-f0-9]{64}$/.test(value.pricingHash) &&
    value.registryVersions.image === IMAGE_REGISTRY_VERSION &&
    value.registryVersions.video === VIDEO_REGISTRY_VERSION &&
    value.source.kind === 'published' &&
    value.source.url === PUBLIC_PRICING_URL &&
    validTimestamp(value.source.verifiedAt) &&
    validTimestamp(value.source.expiresAt) &&
    Array.isArray(value.tiers) &&
    value.tiers.length > 0 &&
    value.tiers.length <= MAX_PUBLIC_PRICING_TIERS &&
    value.tiers.every(validTier) &&
    pricingHash(value.tiers as PublishedPricingTier[]) === value.pricingHash
  );
}

function emptyState(): StoredPublicPricingState {
  return {
    schemaVersion: PUBLIC_PRICING_SETTING_VERSION,
    snapshot: null,
    validators: { etag: null, lastModified: null },
    failureCount: 0,
    nextAttemptAt: null,
    lastFailureCategory: null
  };
}

function parseStoredState(setting: StoredSetting<unknown> | null): StoredPublicPricingState {
  if (!setting || setting.version !== PUBLIC_PRICING_SETTING_VERSION || !isRecord(setting.value)) {
    return emptyState();
  }
  const value = setting.value;
  if (
    value.schemaVersion !== PUBLIC_PRICING_SETTING_VERSION ||
    !isRecord(value.validators) ||
    !Number.isSafeInteger(value.failureCount) ||
    (value.failureCount as number) < 0 ||
    (value.failureCount as number) > 32 ||
    (value.nextAttemptAt !== null && !validTimestamp(value.nextAttemptAt)) ||
    (value.lastFailureCategory !== null && !validFailureCategory(value.lastFailureCategory)) ||
    (value.snapshot !== null && !validSnapshot(value.snapshot))
  ) {
    return emptyState();
  }
  return {
    schemaVersion: PUBLIC_PRICING_SETTING_VERSION,
    snapshot: value.snapshot as PublishedPricingSnapshot | null,
    validators: {
      etag: boundedHeader(value.validators.etag as string | null, 256),
      lastModified: boundedHeader(value.validators.lastModified as string | null, 128)
    },
    failureCount: value.failureCount as number,
    nextAttemptAt: value.nextAttemptAt as string | null,
    lastFailureCategory: value.lastFailureCategory as PricingRefreshFailureCategory | null
  };
}

function balancedJsonEnd(
  source: string,
  start: number,
  open: string,
  close: string
): number | null {
  if (source[start] !== open) return null;
  let depth = 0;
  let string = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (string) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"') string = true;
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function isJsonWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\n' || character === '\r' || character === '\t';
}

function decodedNextChunks(html: string): string {
  const marker = 'self.__next_f.push(';
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const markerIndex = html.indexOf(marker, cursor);
    if (markerIndex < 0) break;
    const arrayStart = markerIndex + marker.length;
    const arrayEnd = balancedJsonEnd(html, arrayStart, '[', ']');
    if (arrayEnd === null) break;
    const encoded = html.slice(arrayStart, arrayEnd);
    cursor = arrayEnd;
    try {
      const parsed = JSON.parse(encoded);
      if (Array.isArray(parsed) && typeof parsed[1] === 'string') chunks.push(parsed[1]);
    } catch {
      // Only JSON-compatible Next data chunks are accepted.
    }
  }
  if (chunks.length === 0) throw new PricingRefreshError('parse');
  return chunks.join('');
}

function extractModels(decoded: string): unknown {
  let cursor = 0;
  while (cursor < decoded.length) {
    const key = decoded.indexOf('"models"', cursor);
    if (key < 0) break;
    let separator = key + 8;
    while (isJsonWhitespace(decoded[separator])) separator += 1;
    if (decoded[separator] !== ':') {
      cursor = separator;
      continue;
    }
    let start = separator + 1;
    while (isJsonWhitespace(decoded[start])) start += 1;
    if (decoded[start] === '[') {
      const arrayEnd = balancedJsonEnd(decoded, start, '[', ']');
      if (arrayEnd === null) break;
      try {
        const parsed = JSON.parse(decoded.slice(start, arrayEnd));
        if (
          Array.isArray(parsed) &&
          parsed.some(
            (entry) => isRecord(entry) && (entry.category === 'Image' || entry.category === 'Video')
          )
        ) {
          return parsed;
        }
      } catch {
        // A failed balanced candidate is skipped as one unit so parsing stays single-pass.
      }
      cursor = arrayEnd;
      continue;
    }
    cursor = start + 1;
  }
  throw new PricingRefreshError('parse');
}

export function parsePublicPricingHtml(html: string): PublicPricingInventory {
  if (new TextEncoder().encode(html).byteLength > PUBLIC_PRICING_MAX_RESPONSE_BYTES) {
    throw new PricingRefreshError('oversize');
  }
  try {
    return normalizePublicPricingInventory(extractModels(decodedNextChunks(html)));
  } catch (error) {
    if (error instanceof PricingRefreshError) throw error;
    throw new PricingRefreshError('schema');
  }
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const header = response.headers.get('content-length');
  if (header !== null) {
    const declared = Number(header);
    if (!Number.isSafeInteger(declared) || declared < 0) throw new PricingRefreshError('schema');
    if (declared > maxBytes) {
      await cancelBody(response);
      throw new PricingRefreshError('oversize');
    }
  }
  if (!response.body) throw new PricingRefreshError('parse');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PricingRefreshError('oversize');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function fixedPricingUrl(value: string | URL): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.host !== 'poyo.ai' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new PricingRefreshError('redirect');
  }
  return url;
}

function pricingHash(tiers: PublishedPricingTier[]): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(tiers)).digest('hex');
}

function retryDelay(failureCount: number): number {
  return Math.min(
    PUBLIC_PRICING_BACKOFF_MAX_MS,
    PUBLIC_PRICING_BACKOFF_BASE_MS * 2 ** Math.max(0, failureCount - 1)
  );
}

export class PublicPricingService {
  private readonly fetchImplementation: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly ttlMs: number;
  private inFlight: Promise<void> | null = null;
  private memoryFailureCount = 0;
  private memoryNextAttemptAt = 0;

  constructor(private readonly options: PublicPricingServiceOptions) {
    this.fetchImplementation = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? PUBLIC_PRICING_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? PUBLIC_PRICING_MAX_RESPONSE_BYTES;
    this.ttlMs = options.ttlMs ?? PUBLIC_PRICING_TTL_MS;
  }

  private report(category: PricingRefreshFailureCategory): void {
    try {
      const reported = this.options.reportFailure?.(category);
      if (reported) void Promise.resolve(reported).catch(() => undefined);
    } catch {
      // Diagnostics availability cannot affect cache behavior.
    }
  }

  private readState(): StoredPublicPricingState {
    try {
      return parseStoredState(this.options.settings.get<unknown>(PUBLIC_PRICING_SETTING_KEY));
    } catch {
      return emptyState();
    }
  }

  private async writeState(state: StoredPublicPricingState): Promise<boolean> {
    try {
      await this.options.gate.withWriterPermit('pricing.cache.write', async () => {
        this.options.settings.set(
          PUBLIC_PRICING_SETTING_KEY,
          state,
          PUBLIC_PRICING_SETTING_VERSION,
          new Date(this.now())
        );
      });
      return true;
    } catch {
      this.report('write-refused');
      return false;
    }
  }

  private shouldRefresh(state: StoredPublicPricingState): boolean {
    const now = this.now();
    const expiresAt = state.snapshot ? Date.parse(state.snapshot.source.expiresAt) : 0;
    const nextAttemptAt = state.nextAttemptAt ? Date.parse(state.nextAttemptAt) : 0;
    return now >= expiresAt && now >= nextAttemptAt && now >= this.memoryNextAttemptAt;
  }

  current(): PricingSnapshotView {
    const state = this.readState();
    const fresh = Boolean(
      state.snapshot && this.now() < Date.parse(state.snapshot.source.expiresAt)
    );
    const view: PricingSnapshotView = {
      snapshot: state.snapshot,
      freshness: fresh ? 'fresh' : 'stale',
      availability: state.snapshot ? 'available' : 'unavailable'
    };
    if (!fresh && this.shouldRefresh(state)) this.schedule(state);
    return view;
  }

  private schedule(state: StoredPublicPricingState, force = false): void {
    if (this.inFlight || (!force && !this.shouldRefresh(state))) return;
    let tracked: Promise<void>;
    try {
      tracked = this.options.gate.trackDetached('pricing.refresh', () =>
        this.performRefresh(state)
      );
    } catch {
      this.memoryFailureCount = Math.min(32, Math.max(1, this.memoryFailureCount + 1));
      this.memoryNextAttemptAt = this.now() + retryDelay(this.memoryFailureCount);
      this.report('admission-refused');
      return;
    }
    this.inFlight = tracked;
    void tracked.then(
      () => {
        if (this.inFlight === tracked) this.inFlight = null;
      },
      () => {
        if (this.inFlight === tracked) this.inFlight = null;
        this.report('refresh-rejected');
      }
    );
  }

  async refreshForTest(options: { force?: boolean } = {}): Promise<void> {
    const state = this.readState();
    this.schedule(state, options.force ?? true);
    await this.inFlight?.catch(() => undefined);
  }

  private async fetchResponse(
    validators: PublicPricingValidators,
    signal: AbortSignal
  ): Promise<Response> {
    let url = fixedPricingUrl(PUBLIC_PRICING_URL);
    for (let redirectCount = 0; ; redirectCount += 1) {
      let response: Response;
      try {
        response = await this.fetchImplementation(url, {
          method: 'GET',
          headers: {
            Accept: 'text/html',
            'User-Agent': PUBLIC_PRICING_USER_AGENT,
            ...(validators.etag ? { 'If-None-Match': validators.etag } : {}),
            ...(validators.lastModified ? { 'If-Modified-Since': validators.lastModified } : {})
          },
          credentials: 'omit',
          redirect: 'manual',
          signal
        });
      } catch {
        if (signal.aborted) throw new PricingRefreshError('timeout');
        throw new PricingRefreshError('network');
      }
      if (response.status < 300 || response.status >= 400 || response.status === 304) {
        return response;
      }
      if (redirectCount >= PUBLIC_PRICING_MAX_REDIRECTS) {
        await cancelBody(response);
        throw new PricingRefreshError('redirect');
      }
      const location = response.headers.get('location');
      if (!location) {
        await cancelBody(response);
        throw new PricingRefreshError('redirect');
      }
      await cancelBody(response);
      try {
        url = fixedPricingUrl(new URL(location, url));
      } catch {
        throw new PricingRefreshError('redirect');
      }
    }
  }

  private async refreshedState(state: StoredPublicPricingState): Promise<StoredPublicPricingState> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Published pricing timed out.', 'TimeoutError')),
      this.timeoutMs
    );
    try {
      const response = await this.fetchResponse(
        state.snapshot ? state.validators : { etag: null, lastModified: null },
        controller.signal
      );
      const verifiedAtMs = this.now();
      const responseValidators = {
        etag: boundedHeader(response.headers.get('etag'), 256),
        lastModified: boundedHeader(response.headers.get('last-modified'), 128)
      };
      if (response.status === 304) {
        if (!state.snapshot) throw new PricingRefreshError('http');
        return {
          schemaVersion: PUBLIC_PRICING_SETTING_VERSION,
          snapshot: {
            ...state.snapshot,
            source: {
              ...state.snapshot.source,
              verifiedAt: new Date(verifiedAtMs).toISOString(),
              expiresAt: new Date(verifiedAtMs + this.ttlMs).toISOString()
            }
          },
          validators: {
            etag: responseValidators.etag ?? state.validators.etag,
            lastModified: responseValidators.lastModified ?? state.validators.lastModified
          },
          failureCount: 0,
          nextAttemptAt: null,
          lastFailureCategory: null
        };
      }
      if (!response.ok) {
        await cancelBody(response);
        throw new PricingRefreshError('http');
      }
      const inventory = parsePublicPricingHtml(
        await readBoundedText(response, this.maxResponseBytes)
      );
      if (inventory.tiers.length === 0) throw new PricingRefreshError('empty-inventory');
      const snapshot: PublishedPricingSnapshot = {
        version: PUBLIC_PRICING_SNAPSHOT_VERSION,
        signatureVersion: PRICING_SIGNATURE_VERSION,
        pricingHash: pricingHash(inventory.tiers),
        registryVersions: {
          image: IMAGE_REGISTRY_VERSION,
          video: VIDEO_REGISTRY_VERSION
        },
        source: {
          kind: 'published',
          url: PUBLIC_PRICING_URL,
          verifiedAt: new Date(verifiedAtMs).toISOString(),
          expiresAt: new Date(verifiedAtMs + this.ttlMs).toISOString()
        },
        tiers: inventory.tiers
      };
      return {
        schemaVersion: PUBLIC_PRICING_SETTING_VERSION,
        snapshot,
        validators: responseValidators,
        failureCount: 0,
        nextAttemptAt: null,
        lastFailureCategory: null
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async persistFailure(
    state: StoredPublicPricingState,
    category: PricingRefreshFailureCategory
  ): Promise<void> {
    const current = this.readState();
    const failureCount = Math.min(32, Math.max(current.failureCount, state.failureCount) + 1);
    const nextAttemptAtMs = this.now() + retryDelay(failureCount);
    const failureState: StoredPublicPricingState = {
      ...current,
      failureCount,
      nextAttemptAt: new Date(nextAttemptAtMs).toISOString(),
      lastFailureCategory: category
    };
    if (await this.writeState(failureState)) {
      this.memoryFailureCount = 0;
      this.memoryNextAttemptAt = 0;
    } else {
      this.memoryFailureCount = failureCount;
      this.memoryNextAttemptAt = nextAttemptAtMs;
    }
    this.report(category);
  }

  private async performRefresh(state: StoredPublicPricingState): Promise<void> {
    try {
      const refreshed = await this.refreshedState(state);
      if (await this.writeState(refreshed)) {
        this.memoryFailureCount = 0;
        this.memoryNextAttemptAt = 0;
      } else {
        this.memoryFailureCount = Math.min(32, Math.max(1, this.memoryFailureCount + 1));
        this.memoryNextAttemptAt = this.now() + retryDelay(this.memoryFailureCount);
      }
    } catch (error) {
      const category = error instanceof PricingRefreshError ? error.category : 'refresh-rejected';
      await this.persistFailure(state, category);
    }
  }
}

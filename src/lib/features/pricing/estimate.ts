import {
  PRICING_SIGNATURE_VERSION,
  type Estimate,
  type PricingDimensions,
  type PricingUnit,
  type PricingWorkflow,
  type PublishedPricingSnapshot,
  type TaskCharge
} from './contracts';

export const OBSERVED_MEDIAN_MIN_SAMPLES = 3;
export const OBSERVED_MEDIAN_MAX_SAMPLES = 25;

const dimensionKeys = [
  'duration',
  'hasAudio',
  'mode',
  'quality',
  'quantity',
  'resolution'
] as const;

function normalizeString(value: string): string {
  return value.trim().toLowerCase();
}

function canonicalDimensionValue(
  key: (typeof dimensionKeys)[number],
  value: PricingDimensions[typeof key]
): string {
  if (typeof value === 'string') return normalizeString(value);
  return String(value);
}

export function buildPricingSignature(input: {
  registryVersion: string;
  modelId: string;
  workflow: PricingWorkflow;
  dimensions?: PricingDimensions;
  unit: PricingUnit;
}): string {
  const parts: Array<[string, string]> = [
    ['version', PRICING_SIGNATURE_VERSION],
    ['registry', input.registryVersion],
    ['model', input.modelId],
    ['workflow', input.workflow],
    ['unit', input.unit]
  ];
  for (const key of dimensionKeys) {
    const value = input.dimensions?.[key];
    if (value !== undefined) parts.push([key, canonicalDimensionValue(key, value)]);
  }
  return parts.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('|');
}

export function isPricingSignature(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return false;
  const segments = value.split('|');
  if (segments.length < 5 || segments.length > 5 + dimensionKeys.length) return false;
  const pairs: Array<[string, string]> = [];
  try {
    for (const segment of segments) {
      const separator = segment.indexOf('=');
      if (separator <= 0 || separator === segment.length - 1) return false;
      const key = segment.slice(0, separator);
      const encoded = segment.slice(separator + 1);
      const decoded = decodeURIComponent(encoded);
      if (encodeURIComponent(decoded) !== encoded) return false;
      pairs.push([key, decoded]);
    }
  } catch {
    return false;
  }
  const required = ['version', 'registry', 'model', 'workflow', 'unit'];
  if (required.some((key, index) => pairs[index]?.[0] !== key)) return false;
  if (pairs[0]?.[1] !== PRICING_SIGNATURE_VERSION) return false;
  if (!['per-output', 'per-second'].includes(pairs[4]?.[1] ?? '')) return false;
  const dimensionOrder = pairs
    .slice(required.length)
    .map(([key]) => dimensionKeys.indexOf(key as (typeof dimensionKeys)[number]));
  if (
    dimensionOrder.some(
      (index, position) => index < 0 || index <= (dimensionOrder[position - 1] ?? -1)
    )
  ) {
    return false;
  }
  const allowed = new Set([...required, ...dimensionKeys]);
  const seen = new Set<string>();
  return pairs.every(([key, decoded]) => {
    if (!allowed.has(key) || seen.has(key) || decoded.length === 0 || decoded.length > 512) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function requestDimension(input: Record<string, unknown>, key: keyof PricingDimensions): unknown {
  if (key === 'hasAudio')
    return input.hasAudio ?? input.has_audio ?? input.sound ?? input.generate_audio;
  if (key === 'quantity') return input.quantity ?? input.n;
  return input[key];
}

function matchesDimensions(
  tierDimensions: PricingDimensions,
  input: Record<string, unknown>
): boolean {
  for (const key of dimensionKeys) {
    const expected = tierDimensions[key];
    if (expected === undefined) continue;
    const actual = requestDimension(input, key);
    if (typeof expected === 'string') {
      if (typeof actual !== 'string' || normalizeString(actual) !== normalizeString(expected)) {
        return false;
      }
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function boundedPositive(value: unknown, fallback?: number): number | null {
  const resolved = value === undefined ? fallback : value;
  return typeof resolved === 'number' &&
    Number.isFinite(resolved) &&
    resolved > 0 &&
    resolved <= 10_000
    ? resolved
    : null;
}

export function unavailablePublishedEstimate(
  snapshot: PublishedPricingSnapshot | null,
  now: number
): Estimate {
  const expiresAt = snapshot?.source.expiresAt ?? null;
  return {
    classification: 'estimate',
    credits: null,
    signature: null,
    basis: null,
    provenance: 'published',
    sourceVerifiedAt: snapshot?.source.verifiedAt ?? null,
    expiresAt,
    freshness: expiresAt !== null && now < Date.parse(expiresAt) ? 'fresh' : 'stale',
    availability: 'unavailable'
  };
}

export function estimatePublishedCredits(input: {
  snapshot: PublishedPricingSnapshot | null;
  registryVersion: string;
  modelId: string;
  workflow: PricingWorkflow;
  normalizedInput: Record<string, unknown>;
  quantity?: number;
  now?: number;
}): Estimate {
  const now = input.now ?? Date.now();
  const snapshot = input.snapshot;
  if (!snapshot) return unavailablePublishedEstimate(null, now);
  const matches = snapshot.tiers.filter(
    (tier) =>
      tier.registryVersion === input.registryVersion &&
      tier.modelId === input.modelId &&
      tier.workflow === input.workflow &&
      matchesDimensions(tier.dimensions, input.normalizedInput)
  );
  if (matches.length !== 1) return unavailablePublishedEstimate(snapshot, now);

  const tier = matches[0];
  if (!tier || !Number.isFinite(tier.creditsPerUnit) || tier.creditsPerUnit < 0) {
    return unavailablePublishedEstimate(snapshot, now);
  }
  const requestQuantity = boundedPositive(input.quantity, 1);
  const baseUnits =
    tier.unit === 'per-second'
      ? boundedPositive(input.normalizedInput.duration)
      : boundedPositive(input.normalizedInput.n, 1);
  if (requestQuantity === null || baseUnits === null) {
    return unavailablePublishedEstimate(snapshot, now);
  }
  const units = baseUnits * requestQuantity;
  const credits = Math.round(tier.creditsPerUnit * units * 1_000_000) / 1_000_000;
  if (!Number.isFinite(credits) || credits < 0 || credits > 1_000_000_000) {
    return unavailablePublishedEstimate(snapshot, now);
  }
  return {
    classification: 'estimate',
    credits,
    signature: buildPricingSignature({
      registryVersion: tier.registryVersion,
      modelId: tier.modelId,
      workflow: tier.workflow,
      dimensions: {
        ...tier.dimensions,
        ...(tier.unit === 'per-second'
          ? {
              duration: baseUnits,
              ...(input.quantity === undefined ? {} : { quantity: requestQuantity })
            }
          : { quantity: units })
      },
      unit: tier.unit
    }),
    basis: { unit: tier.unit, creditsPerUnit: tier.creditsPerUnit, units },
    provenance: 'published',
    sourceVerifiedAt: snapshot.source.verifiedAt,
    expiresAt: snapshot.source.expiresAt,
    freshness: now < Date.parse(snapshot.source.expiresAt) ? 'fresh' : 'stale',
    availability: 'available'
  };
}

export interface ObservedChargeSample {
  signature: string;
  signatureVersion: string;
  registryVersion: string;
  pricingHash: string;
  observedAt: string;
  charge: TaskCharge;
}

export function boundedObservedMedian(
  samples: readonly ObservedChargeSample[],
  group: {
    signature: string;
    signatureVersion: string;
    registryVersion: string;
    pricingHash: string;
  },
  options: { minSamples?: number; maxSamples?: number } = {}
): number | null {
  const minimum = options.minSamples ?? OBSERVED_MEDIAN_MIN_SAMPLES;
  const maximum = Math.min(
    options.maxSamples ?? OBSERVED_MEDIAN_MAX_SAMPLES,
    OBSERVED_MEDIAN_MAX_SAMPLES
  );
  if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > maximum) return null;
  if (!Number.isSafeInteger(maximum) || maximum < 1) return null;

  const eligible = samples
    .filter(
      (sample) =>
        sample.signature === group.signature &&
        sample.signatureVersion === group.signatureVersion &&
        sample.registryVersion === group.registryVersion &&
        sample.pricingHash === group.pricingHash &&
        sample.charge.classification === 'task-charge' &&
        sample.charge.source === 'poyo-task' &&
        (sample.charge.terminalStatus === 'finished' ||
          sample.charge.terminalStatus === 'failed' ||
          sample.charge.terminalStatus === 'cancelled') &&
        Number.isFinite(sample.charge.credits) &&
        sample.charge.credits >= 0 &&
        Number.isFinite(Date.parse(sample.observedAt)) &&
        Number.isFinite(Date.parse(sample.charge.settledAt))
    )
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))
    .slice(0, maximum)
    .map((sample) => sample.charge.credits)
    .sort((left, right) => left - right);
  if (eligible.length < minimum) return null;
  const middle = Math.floor(eligible.length / 2);
  const median =
    eligible.length % 2 === 1
      ? eligible[middle]
      : ((eligible[middle - 1] ?? 0) + (eligible[middle] ?? 0)) / 2;
  return median === undefined ? null : median;
}

export function estimateObservedMedian(
  published: Estimate,
  samples: readonly ObservedChargeSample[],
  group: {
    signature: string;
    signatureVersion: string;
    registryVersion: string;
    pricingHash: string;
  },
  options: { minSamples?: number; maxSamples?: number } = {}
): Estimate {
  if (published.availability === 'unavailable' || !published.basis) return published;
  const credits = boundedObservedMedian(samples, group, options);
  if (credits === null) return published;
  return {
    ...published,
    classification: 'estimate',
    credits,
    basis: {
      ...published.basis,
      creditsPerUnit: credits / published.basis.units
    },
    provenance: 'observed'
  };
}

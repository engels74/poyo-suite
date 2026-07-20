import { IMAGE_REGISTRY_ENTRIES, IMAGE_REGISTRY_VERSION } from '../registry/image-registry';
import { VIDEO_REGISTRY_ENTRIES, VIDEO_REGISTRY_VERSION } from '../registry/video-registry';
import type { ImageRegistryEntry, VideoRegistryEntry } from '../registry/types';
import {
  MAX_PUBLIC_PRICING_TIERS,
  type PricingDimensions,
  type PricingUnit,
  type PricingWorkflow,
  type PublishedPricingTier
} from './contracts';
import { buildPricingSignature } from './estimate';

export type UnsupportedPricingReason =
  | 'invalid-row'
  | 'no-registry-model'
  | 'unsupported-workflow-dimension'
  | 'unknown-unit'
  | 'missing-discriminator'
  | 'multiple-compatible-tiers';

export interface UnsupportedPricingRow {
  modelId: string | null;
  reason: UnsupportedPricingReason;
}

export interface PublicPricingInventory {
  tiers: PublishedPricingTier[];
  unsupported: UnsupportedPricingRow[];
  publicRowCount: number;
  inconsistentUsdRows: number;
}

type RegistryEntry = ImageRegistryEntry | VideoRegistryEntry;

const MAX_PUBLIC_GROUPS = 128;
const MAX_PUBLIC_ROWS = 512;
const baseTierKeys = new Set([
  'comparisonPriceUSD',
  'comparisonSource',
  'credits',
  'description',
  'model',
  'priceUSD',
  'spec',
  'unit'
]);
const dimensionKeys = new Set(['duration', 'hasAudio', 'mode', 'quality', 'resolution']);
const entriesByModel = new Map<string, RegistryEntry[]>();

for (const entry of [...IMAGE_REGISTRY_ENTRIES, ...VIDEO_REGISTRY_ENTRIES]) {
  if (entry.status !== 'current') continue;
  const entries = entriesByModel.get(entry.publicModelId) ?? [];
  entries.push(entry);
  entriesByModel.set(entry.publicModelId, entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max = 128): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function normalizeUnit(value: unknown): PricingUnit | null {
  if (value === 'per second') return 'per-second';
  if (value === 'per generation' || value === 'per image' || value === 'per video') {
    return 'per-output';
  }
  return null;
}

function matchesEnum(value: string, allowed: readonly string[]): boolean {
  const normalized = value.toLowerCase();
  return allowed.some((candidate) => candidate.toLowerCase() === normalized);
}

function durationAllowed(entry: RegistryEntry, duration: number): boolean {
  if (entry.output.mediaKind !== 'video' || entry.output.durations === null) return false;
  if (Array.isArray(entry.output.durations)) return entry.output.durations.includes(duration);
  const range = entry.output.durations as { min: number; max: number };
  return duration >= range.min && duration <= range.max;
}

function stringDimensionAllowed(
  entry: RegistryEntry,
  key: 'resolution' | 'quality' | 'mode',
  value: string
): boolean {
  if (key === 'resolution') {
    if (entry.output.mediaKind !== 'video') {
      const field = entry.fields.find((candidate) => candidate.key === 'resolution');
      return Boolean(field?.enum && matchesEnum(value, field.enum));
    }
    return Boolean(entry.output.resolutions && matchesEnum(value, entry.output.resolutions));
  }
  const field = entry.fields.find((candidate) => candidate.key === key);
  return Boolean(field?.enum && matchesEnum(value, field.enum));
}

function resolveEntry(
  entries: RegistryEntry[],
  row: Record<string, unknown>
): { entry: RegistryEntry; workflow: PricingWorkflow; modeDiscriminator: boolean } | null {
  const workflows = [...new Set(entries.map((entry) => entry.workflow))];
  if (workflows.length === 1 && entries[0]) {
    return { entry: entries[0], workflow: entries[0].workflow, modeDiscriminator: false };
  }
  const mode = boundedString(row.mode, 64);
  if (!mode) return null;
  const matches = entries.filter((entry) => entry.workflow === mode);
  return matches.length === 1 && matches[0]
    ? { entry: matches[0], workflow: matches[0].workflow, modeDiscriminator: true }
    : null;
}

function normalizeDimensions(
  row: Record<string, unknown>,
  entry: RegistryEntry,
  modeDiscriminator: boolean
): PricingDimensions | null {
  const dimensions: PricingDimensions = {};
  for (const key of Object.keys(row)) {
    if (!baseTierKeys.has(key) && !dimensionKeys.has(key)) return null;
  }
  if (row.resolution !== undefined) {
    const resolution = boundedString(row.resolution, 32);
    if (!resolution || !stringDimensionAllowed(entry, 'resolution', resolution)) return null;
    dimensions.resolution = resolution.toLowerCase();
  }
  if (row.duration !== undefined) {
    if (!Number.isSafeInteger(row.duration) || (row.duration as number) <= 0) return null;
    if (!durationAllowed(entry, row.duration as number)) return null;
    dimensions.duration = row.duration as number;
  }
  if (row.quality !== undefined) {
    const quality = boundedString(row.quality, 32);
    if (!quality || !stringDimensionAllowed(entry, 'quality', quality)) return null;
    dimensions.quality = quality.toLowerCase();
  }
  if (row.mode !== undefined && !modeDiscriminator) {
    const mode = boundedString(row.mode, 64);
    if (!mode || !stringDimensionAllowed(entry, 'mode', mode)) return null;
    dimensions.mode = mode.toLowerCase();
  }
  if (row.hasAudio !== undefined) {
    if (typeof row.hasAudio !== 'boolean' || entry.output.mediaKind !== 'video') return null;
    if (entry.output.audio === 'none') return null;
    dimensions.hasAudio = row.hasAudio;
  }
  return dimensions;
}

function registryVersion(entry: RegistryEntry): string {
  return entry.output.mediaKind === 'image' ? IMAGE_REGISTRY_VERSION : VIDEO_REGISTRY_VERSION;
}

export function normalizePublicPricingInventory(models: unknown): PublicPricingInventory {
  if (!Array.isArray(models) || models.length === 0 || models.length > MAX_PUBLIC_GROUPS) {
    throw new Error('Published pricing models were outside the supported bounds.');
  }
  const provisional: Array<{
    tier?: PublishedPricingTier;
    unsupported?: UnsupportedPricingRow;
  }> = [];
  let publicRowCount = 0;
  let inconsistentUsdRows = 0;

  for (const group of models) {
    if (!isRecord(group) || (group.category !== 'Image' && group.category !== 'Video')) continue;
    if (!Array.isArray(group.pricingTiers)) {
      throw new Error('Published image/video pricing rows were malformed.');
    }
    for (const value of group.pricingTiers) {
      publicRowCount += 1;
      if (publicRowCount > MAX_PUBLIC_ROWS) {
        throw new Error('Published image/video pricing inventory exceeded the supported bound.');
      }
      if (!isRecord(value)) {
        provisional.push({ unsupported: { modelId: null, reason: 'invalid-row' } });
        continue;
      }
      const modelId = boundedString(value.model);
      const credits = value.credits;
      if (
        !modelId ||
        typeof credits !== 'number' ||
        !Number.isFinite(credits) ||
        credits < 0 ||
        credits > 1_000_000
      ) {
        provisional.push({ unsupported: { modelId, reason: 'invalid-row' } });
        continue;
      }
      const entries = entriesByModel.get(modelId);
      if (!entries?.length) {
        provisional.push({ unsupported: { modelId, reason: 'no-registry-model' } });
        continue;
      }
      const unit = normalizeUnit(value.unit);
      if (!unit) {
        provisional.push({ unsupported: { modelId, reason: 'unknown-unit' } });
        continue;
      }
      const resolved = resolveEntry(entries, value);
      if (!resolved) {
        provisional.push({ unsupported: { modelId, reason: 'missing-discriminator' } });
        continue;
      }
      const expectedMediaKind = group.category === 'Image' ? 'image' : 'video';
      if (resolved.entry.output.mediaKind !== expectedMediaKind) {
        provisional.push({ unsupported: { modelId, reason: 'unsupported-workflow-dimension' } });
        continue;
      }
      const dimensions = normalizeDimensions(value, resolved.entry, resolved.modeDiscriminator);
      if (!dimensions) {
        provisional.push({ unsupported: { modelId, reason: 'unsupported-workflow-dimension' } });
        continue;
      }
      if (
        typeof value.priceUSD === 'number' &&
        Number.isFinite(value.priceUSD) &&
        value.priceUSD >= 0 &&
        Math.abs(value.priceUSD * 200 - credits) > 0.000_001
      ) {
        inconsistentUsdRows += 1;
      }
      const version = registryVersion(resolved.entry);
      provisional.push({
        tier: {
          signature: buildPricingSignature({
            registryVersion: version,
            modelId,
            workflow: resolved.workflow,
            dimensions,
            unit
          }),
          registryVersion: version,
          modelId,
          mediaKind: resolved.entry.output.mediaKind,
          workflow: resolved.workflow,
          dimensions,
          unit,
          creditsPerUnit: credits
        }
      });
    }
  }

  const signatureCounts = new Map<string, number>();
  for (const item of provisional) {
    if (item.tier) {
      signatureCounts.set(item.tier.signature, (signatureCounts.get(item.tier.signature) ?? 0) + 1);
    }
  }
  const tiers: PublishedPricingTier[] = [];
  const unsupported: UnsupportedPricingRow[] = [];
  for (const item of provisional) {
    if (item.unsupported) {
      unsupported.push(item.unsupported);
      continue;
    }
    if (!item.tier) continue;
    if ((signatureCounts.get(item.tier.signature) ?? 0) > 1) {
      unsupported.push({ modelId: item.tier.modelId, reason: 'multiple-compatible-tiers' });
    } else {
      tiers.push(item.tier);
    }
  }
  tiers.sort((left, right) => left.signature.localeCompare(right.signature));
  if (tiers.length > MAX_PUBLIC_PRICING_TIERS) {
    throw new Error('Allowlisted published pricing inventory exceeded the supported bound.');
  }
  return { tiers, unsupported, publicRowCount, inconsistentUsdRows };
}

import type { ImageWorkflow, VideoWorkflow } from '../registry/types';

export const PRICING_SIGNATURE_VERSION = 'pricing-signature-v1';
export const PUBLIC_PRICING_SNAPSHOT_VERSION = 1;
export const MAX_PUBLIC_PRICING_TIERS = 256;

export type PricingWorkflow = ImageWorkflow | VideoWorkflow;
export type PricingUnit = 'per-output' | 'per-second';
export type EstimateProvenance = 'published' | 'observed' | 'blend';
export type EstimateFreshness = 'fresh' | 'stale';
export type EstimateAvailability = 'available' | 'unavailable';

export interface PricingDimensions {
  resolution?: string;
  duration?: number;
  quality?: string;
  mode?: string;
  hasAudio?: boolean;
  quantity?: number;
}

export interface PublishedPricingTier {
  signature: string;
  registryVersion: string;
  modelId: string;
  mediaKind: 'image' | 'video';
  workflow: PricingWorkflow;
  dimensions: PricingDimensions;
  unit: PricingUnit;
  creditsPerUnit: number;
}

export interface PublishedPricingSnapshot {
  version: typeof PUBLIC_PRICING_SNAPSHOT_VERSION;
  signatureVersion: typeof PRICING_SIGNATURE_VERSION;
  pricingHash: string;
  registryVersions: {
    image: string;
    video: string;
  };
  source: {
    kind: 'published';
    url: 'https://poyo.ai/pricing';
    verifiedAt: string;
    expiresAt: string;
  };
  tiers: PublishedPricingTier[];
}

export interface PricingBasis {
  unit: PricingUnit;
  creditsPerUnit: number;
  units: number;
}

export interface Estimate {
  classification: 'estimate';
  credits: number | null;
  signature: string | null;
  basis: PricingBasis | null;
  provenance: EstimateProvenance;
  sourceVerifiedAt: string | null;
  expiresAt: string | null;
  freshness: EstimateFreshness;
  availability: EstimateAvailability;
}

export interface EstimateEnvelope {
  signatureVersion: typeof PRICING_SIGNATURE_VERSION;
  signature: string | null;
  registryVersion: string | null;
  pricingHash: string | null;
  basis: PricingBasis | null;
  provenance: EstimateProvenance;
  sourceVerifiedAt: string | null;
  credits: number | null;
}

export interface TaskCharge {
  classification: 'task-charge';
  credits: number;
  source: 'poyo-task';
  terminalStatus: 'finished' | 'failed' | 'cancelled';
  settledAt: string;
}

export interface OutstandingSpendProjection {
  classification: 'estimate';
  credits: number | null;
  actionCount: number;
  availability: EstimateAvailability;
}

export interface PricingSnapshotView {
  snapshot: PublishedPricingSnapshot | null;
  freshness: EstimateFreshness;
  availability: EstimateAvailability;
}

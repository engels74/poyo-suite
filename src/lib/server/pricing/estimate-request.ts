import {
  type Estimate,
  type EstimateEnvelope,
  PRICING_SIGNATURE_VERSION,
  type PricingSnapshotView,
  type PublishedPricingSnapshot
} from '../../features/pricing/contracts';
import {
  estimateObservedMedian,
  estimatePublishedCredits,
  type ObservedChargeSample,
  unavailablePublishedEstimate
} from '../../features/pricing/estimate';
import {
  IMAGE_REGISTRY_ENTRIES,
  IMAGE_REGISTRY_VERSION
} from '../../features/registry/image-registry';
import { normalizeRegistryRequest } from '../../features/registry/normalize-registry';
import type {
  ExpertOverride,
  GuidedImageRequest,
  GuidedVideoRequest,
  NormalizedPreview
} from '../../features/registry/types';
import {
  VIDEO_REGISTRY_ENTRIES,
  VIDEO_REGISTRY_VERSION
} from '../../features/registry/video-registry';
import type { CreateJobRequest } from '../jobs/types';

export type RegistryPreviewRequest = {
  entryKey: string;
  values: GuidedImageRequest | GuidedVideoRequest;
  expertOverrides?: ExpertOverride[];
};

type PricingSnapshotReader = { current(): PricingSnapshotView };

export type ObservedChargeReader = {
  observedChargeSamples(group: {
    signature: string;
    signatureVersion: string;
    registryVersion: string;
    pricingHash: string;
  }): ObservedChargeSample[];
};

type NormalizedRegistryEstimateInput = {
  snapshot: PublishedPricingSnapshot | null;
  observations?: ObservedChargeReader;
  entryKey: string;
  normalizedRequest: { model: string; input: Record<string, unknown> };
  now?: number;
};

function registryPricingTarget(entryKey: string) {
  const imageEntry = IMAGE_REGISTRY_ENTRIES.find(
    (entry) => entry.key === entryKey && entry.status === 'current'
  );
  const videoEntry = imageEntry
    ? undefined
    : VIDEO_REGISTRY_ENTRIES.find((entry) => entry.key === entryKey && entry.status === 'current');
  const entry = imageEntry ?? videoEntry;
  return entry
    ? {
        entry,
        registryVersion: imageEntry ? IMAGE_REGISTRY_VERSION : VIDEO_REGISTRY_VERSION
      }
    : null;
}

export function estimateNormalizedRegistryRequestWithEnvelope(
  input: NormalizedRegistryEstimateInput
): { estimate: Estimate; envelope: EstimateEnvelope } {
  const now = input.now ?? Date.now();
  const target = registryPricingTarget(input.entryKey);
  const published =
    target && target.entry.publicModelId === input.normalizedRequest.model
      ? estimatePublishedCredits({
          snapshot: input.snapshot,
          registryVersion: target.registryVersion,
          modelId: input.normalizedRequest.model,
          workflow: target.entry.workflow,
          normalizedInput: input.normalizedRequest.input,
          now
        })
      : unavailablePublishedEstimate(input.snapshot, now);
  const estimate =
    target &&
    input.snapshot &&
    published.availability === 'available' &&
    published.signature &&
    input.observations
      ? estimateObservedMedian(
          published,
          input.observations.observedChargeSamples({
            signature: published.signature,
            signatureVersion: input.snapshot.signatureVersion,
            registryVersion: target.registryVersion,
            pricingHash: input.snapshot.pricingHash
          }),
          {
            signature: published.signature,
            signatureVersion: input.snapshot.signatureVersion,
            registryVersion: target.registryVersion,
            pricingHash: input.snapshot.pricingHash
          }
        )
      : published;
  return {
    estimate,
    envelope: {
      signatureVersion: input.snapshot?.signatureVersion ?? PRICING_SIGNATURE_VERSION,
      signature: estimate.signature,
      registryVersion: target?.registryVersion ?? null,
      pricingHash: input.snapshot?.pricingHash ?? null,
      basis: estimate.basis,
      provenance: estimate.provenance,
      sourceVerifiedAt: estimate.sourceVerifiedAt,
      credits: estimate.credits
    }
  };
}

export function estimateNormalizedRegistryRequest(
  input: NormalizedRegistryEstimateInput
): Estimate {
  return estimateNormalizedRegistryRequestWithEnvelope(input).estimate;
}

export function normalizeEstimatedRegistryRequest(
  input: RegistryPreviewRequest,
  pricing: PricingSnapshotReader,
  observations?: ObservedChargeReader
): NormalizedPreview & { estimate: Estimate } {
  const preview = normalizeRegistryRequest(
    input.entryKey,
    input.values,
    input.expertOverrides ?? []
  );
  const estimate = estimateNormalizedRegistryRequest({
    snapshot: pricing.current().snapshot,
    ...(observations ? { observations } : {}),
    entryKey: input.entryKey,
    normalizedRequest: preview.request
  });
  return { ...preview, estimate };
}

export function withEstimatedJobCreateRequest(
  request: CreateJobRequest,
  pricing: PricingSnapshotReader,
  observations?: ObservedChargeReader
): CreateJobRequest {
  const { estimate, envelope } = estimateNormalizedRegistryRequestWithEnvelope({
    snapshot: pricing.current().snapshot,
    ...(observations ? { observations } : {}),
    entryKey: request.entryKey ?? '',
    normalizedRequest: request.normalizedPayload
  });
  return { ...request, estimatedCredits: estimate.credits, estimateEnvelope: envelope };
}

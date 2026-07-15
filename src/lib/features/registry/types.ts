import type { PoyoSubmitRequest } from '../../server/poyo/types';

export type ImageWorkflow = 'text-to-image' | 'image-to-image' | 'image-edit';
export type RegistryStatus = 'current' | 'experimental' | 'legacy' | 'unindexed';
export type FieldLevel = 'essential' | 'common' | 'advanced' | 'expert';
export type FieldKind =
  | 'text'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'string-list'
  | 'dimensions'
  | 'elements';
export interface FieldDefinition {
  key: string;
  apiKey: string;
  kind: FieldKind;
  level: FieldLevel;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  enum?: readonly string[];
  description?: string;
}
export interface InputRole {
  role: 'reference' | 'mask';
  required: boolean;
  min: number;
  max: number | null;
  mediaKind: 'image';
  formats: readonly string[];
}
export interface RegistryProvenance {
  pageSlug: string;
  markdownUrl: string;
  jsonStatus: 'available' | 'missing' | 'incomplete';
  sourceHash: string;
  verifiedAt: string;
  manualDecision?: string;
}
export interface ImageRegistryEntry {
  key: string;
  provider: string;
  family: string;
  displayName: string;
  publicModelId: string;
  workflow: ImageWorkflow;
  status: RegistryStatus;
  inputRoles: readonly InputRole[];
  output: {
    mediaKind: 'image';
    formats: readonly string[];
    counts: readonly number[] | null;
    customSize: boolean;
    seed: boolean;
    safetyChecker: boolean;
  };
  fields: readonly FieldDefinition[];
  ui: {
    form: 'guided-image';
    fieldOrder: readonly string[];
  };
  validation: {
    conditionalRules: readonly string[];
    customDimensions?: {
      divisor?: number;
      maxEdge?: number;
      minPixels?: number;
      maxPixels?: number;
      maxAspectRatio?: number;
    };
  };
  payload: {
    adapter: 'image-input-v1';
    dimensionsEncoding?: 'object' | 'width-x-height-string';
  };
  response: {
    normalizer: 'poyo-task-image-v1';
    mediaKind: 'image';
  };
  limitations: readonly string[];
  provenance: RegistryProvenance;
}
export interface GuidedImageRequest {
  prompt?: string;
  imageUrls?: string[];
  maskUrl?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: string;
  width?: number;
  height?: number;
  n?: number;
  outputFormat?: string;
  seed?: number;
  enableSafetyChecker?: boolean;
  quality?: string;
  elements?: unknown[];
  googleSearch?: boolean;
  webSearch?: boolean;
  syncMode?: boolean;
}
export interface ExpertOverride {
  key: string;
  value: unknown;
}
export interface NormalizedPreview {
  request: PoyoSubmitRequest;
  guidedInput: Record<string, unknown>;
  expertDiff: Array<{ key: string; status: 'verified' | 'unverified'; value: unknown }>;
  warnings: string[];
}
export interface RegistryManifest {
  version: string;
  verifiedAt: string;
  pageCount: number;
  publicIdCount: number;
  entries: readonly ImageRegistryEntry[];
  sourceHash: string;
  manifestHash: string;
}
export interface RegistryAuditRecord {
  key: string;
  publicModelIds: readonly string[];
  status: 'legacy' | 'unindexed';
  sourceUrl: string;
  reason: string;
}

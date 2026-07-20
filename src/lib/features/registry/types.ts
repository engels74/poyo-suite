import type { PoyoSubmitRequest } from '../../server/poyo/types';
import type { Estimate } from '../pricing/contracts';

export type ImageWorkflow = 'text-to-image' | 'image-to-image' | 'image-edit';
export type VideoWorkflow =
  | 'text-to-video'
  | 'image-to-video'
  | 'frame-to-video'
  | 'reference-to-video'
  | 'video-to-video'
  | 'video-edit'
  | 'motion-control'
  | 'character-animation'
  | 'character-replacement'
  | 'multi-shot-video'
  | 'image-fusion-video'
  | 'avatar-video';
export type RegistryStatus =
  | 'current'
  | 'experimental'
  | 'legacy'
  | 'unindexed'
  | 'excluded-initial-scope';
export type FieldLevel = 'essential' | 'common' | 'advanced' | 'expert';
export type FieldKind =
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'string-list'
  | 'dimensions'
  | 'elements'
  | 'object-list';
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
  role:
    | 'reference'
    | 'mask'
    | 'image'
    | 'start-frame'
    | 'end-frame'
    | 'reference-image'
    | 'source-video'
    | 'reference-video'
    | 'reference-audio'
    | 'audio'
    | 'element-image';
  required: boolean;
  min: number;
  max: number | null;
  mediaKind: 'image' | 'video' | 'audio';
  formats: readonly string[];
  requestKey?: keyof GuidedVideoRequest;
  apiKey?: string;
}
export interface RegistryProvenance {
  pageSlug: string;
  markdownUrl: string;
  markdownSha256: string;
  jsonUrl: string;
  jsonStatus: 'available' | 'unavailable' | 'contradictory' | 'unstructured';
  jsonSha256: string;
  sourceManifestVersion: string;
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
export interface VideoRegistryEntry {
  key: string;
  provider: string;
  family: string;
  displayName: string;
  publicModelId: string;
  workflow: VideoWorkflow;
  status: RegistryStatus;
  inputRoles: readonly InputRole[];
  output: {
    mediaKind: 'video';
    formats: readonly string[];
    durations: readonly number[] | { min: number; max: number } | null;
    resolutions: readonly string[] | null;
    aspectRatios: readonly string[] | null;
    seed: boolean;
    safetyChecker: boolean;
    audio: 'none' | 'boolean-sound' | 'boolean-generate' | 'string-setting';
  };
  fields: readonly FieldDefinition[];
  ui: {
    form: 'guided-video';
    fieldOrder: readonly string[];
  };
  validation: {
    conditionalRules: readonly string[];
  };
  payload: {
    adapter: 'video-input-v1';
    fixedInput?: Readonly<Record<string, unknown>>;
  };
  response: {
    normalizer: 'poyo-task-video-v1';
    mediaKind: 'video';
  };
  limitations: readonly string[];
  provenance: RegistryProvenance;
}
export interface GuidedVideoRequest {
  prompt?: string;
  negativePrompt?: string;
  imageUrls?: string[];
  startImageUrl?: string;
  endImageUrl?: string;
  referenceImageUrls?: string[];
  videoUrls?: string[];
  videoUrl?: string;
  referenceVideoUrls?: string[];
  referenceAudioUrls?: string[];
  audioUrl?: string;
  elementImageUrls?: string[];
  aspectRatio?: string;
  resolution?: string;
  duration?: number;
  seed?: number;
  enableSafetyChecker?: boolean;
  cfgScale?: number;
  promptOptimizer?: boolean;
  mode?: string;
  sound?: boolean;
  generateAudio?: boolean;
  fixedLens?: boolean;
  audioSetting?: string;
  audio?: string;
  characterOrientation?: string;
  referenceVideoDuration?: number;
  sourceVideoDuration?: number;
  multiShots?: boolean;
  multiPrompt?: Array<{ prompt: string; duration: number }>;
  elements?: unknown[];
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
  estimate?: Estimate;
}
export interface RegistryManifest<TEntry = ImageRegistryEntry> {
  version: string;
  verifiedAt: string;
  pageCount: number;
  publicIdCount: number;
  entries: readonly TEntry[];
  sourceCorpusHash: string;
  manifestHash: string;
}
export interface RegistryAuditRecord {
  key: string;
  publicModelIds: readonly string[];
  status: 'legacy' | 'unindexed';
  sourceUrl: string;
  reason: string;
}

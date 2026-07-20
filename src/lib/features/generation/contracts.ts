import type { PresetRecord } from '../presets/types';
import type { OutstandingSpendProjection, TaskCharge } from '../pricing/contracts';
import type { ImageRegistryEntry, VideoRegistryEntry } from '../registry/types';

export type StudioEntry = ImageRegistryEntry | VideoRegistryEntry;

export interface StudioModelPreference {
  entryKey: string;
  favorite: boolean;
  favoritedAt: string | null;
  lastUsedAt: string | null;
}

export interface StudioBalanceSnapshot {
  email: string | null;
  credits: number;
  source: string;
  fetchedAt: string;
}

export interface StudioApiKeyStatus {
  source: 'environment' | 'local' | 'none';
  status: 'configured' | 'missing' | 'unavailable' | 'error';
  storeKind: 'environment' | 'file' | 'unavailable';
  onboardingAvailable: boolean;
  environmentManaged: boolean;
  updatedAt: string | null;
}

export interface StudioRoleInput {
  id: string;
  role: string;
  source: 'remote' | 'uploaded';
  url: string;
  name: string;
  mediaKind: 'image' | 'video' | 'audio';
  localSourceId?: string;
  sizeBytes?: number;
  expiresAt?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  metadataProbe?: 'measured' | 'unavailable';
}

export interface StudioLoadData {
  modality: 'image' | 'video';
  entries: StudioEntry[];
  preferences: StudioModelPreference[];
  balance: StudioBalanceSnapshot | null;
  outstandingProjection: OutstandingSpendProjection;
  apiKey: StudioApiKeyStatus;
  preset: PresetRecord | null;
}

export interface StudioPreviewError {
  code: string;
  message?: string;
  issues?: string[];
}

export interface StudioOutputDto {
  outputId: string;
  mediaKind: 'image' | 'video';
  mediaUrl: string | null;
  aspectRatio: string | null;
  pixelWidth: number | null;
  pixelHeight: number | null;
  fileName: string | null;
  downloadState: string;
  localAvailable: boolean;
}

export interface StudioJobDto {
  id: string;
  workflow: string;
  publicModelId: string;
  localPhase: string;
  remoteStatus: string;
  failureDomain: string;
  attentionCode: string | null;
  ipGuardReason?: 'match' | 'unavailable' | 'misconfigured' | null;
  poyoTaskId: string | null;
  progress: number | null;
  estimatedCredits: number | null;
  actualCredits: number | null;
  taskCharge?: TaskCharge | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

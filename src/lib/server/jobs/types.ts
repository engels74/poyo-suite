import type { PoyoSubmitRequest } from '../poyo/types';
import type { EstimateEnvelope } from '../../features/pricing/contracts';

export type LocalPhase =
  | 'queued'
  | 'validating'
  | 'uploading'
  | 'submission_prepared'
  | 'submitting'
  | 'monitoring'
  | 'downloading'
  | 'complete'
  | 'requires_attention';
export type RemoteStatus = 'unknown' | 'not_started' | 'running' | 'finished' | 'failed';
export type FailureDomain =
  | 'none'
  | 'validation'
  | 'upload'
  | 'submission'
  | 'poll'
  | 'remote_generation'
  | 'download'
  | 'cleanup'
  | 'filesystem'
  | 'database'
  | 'live_update'
  | 'registry';
export type WorkType = 'poll' | 'download' | 'cleanup';

export interface PublicCreateJobInput {
  role: string;
  mediaKind: 'image' | 'video';
  source: 'remote' | 'uploaded';
  url: string;
  localSourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateJobInput extends PublicCreateJobInput {
  managedSourceId?: string;
}

export interface CreateJobActionRequest {
  actionId: string;
  entryKey: string;
  values: Record<string, unknown>;
  expertOverrides?: Array<{ key: string; value: unknown }>;
  inputs?: PublicCreateJobInput[];
}

export interface CreateJobRequest {
  actionId: string;
  entryKey?: string;
  workflow: string;
  publicModelId: string;
  guidedRequest: Record<string, unknown>;
  normalizedPayload: PoyoSubmitRequest;
  prompt?: string;
  estimatedCredits?: number | null;
  estimateEnvelope?: EstimateEnvelope;
  correlationId?: string;
  retryOfJobId?: string;
  expertDiff?: Array<{ key: string; value: unknown; status?: string }>;
  inputs?: CreateJobInput[];
  expectedMediaKind?: 'image' | 'video';
  expectedOutputCount?: number;
}

export interface JobRecord {
  id: string;
  registryVersion: string | null;
  entryKey: string | null;
  workflow: string;
  publicModelId: string;
  localPhase: LocalPhase;
  remoteStatusRaw: string | null;
  remoteStatus: RemoteStatus;
  failureDomain: FailureDomain;
  attentionCode: string | null;
  poyoTaskId: string | null;
  progress: number | null;
  guidedRequest: Record<string, unknown>;
  normalizedPayload: PoyoSubmitRequest;
  estimatedCredits: number | null;
  actualCredits: number | null;
  correlationId: string;
  retryOfJobId: string | null;
  nextPollAt: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  expertDiff: Array<{ key: string; value: unknown; status?: string }>;
}

export interface SubmissionClaim {
  jobId: string;
  actionId: string;
  owner: string;
  token: string;
  payload: PoyoSubmitRequest;
}

export interface WorkClaim {
  workType: WorkType;
  workId: string;
  owner: string;
  token: string;
  attempt: number;
  expiresAt: string;
}

export interface JobEvent {
  eventId: number;
  jobId: string;
  eventType: string;
  localPhase: LocalPhase;
  remoteStatusRaw: string | null;
  remoteStatus: RemoteStatus;
  failureDomain: FailureDomain;
  progress: number | null;
  payload: Record<string, unknown> | null;
  observedAt: string;
}

export interface OutputRecord {
  id: string;
  jobId: string;
  outputOrder: number;
  mediaKind: 'image' | 'video';
  remoteUrl: string | null;
  remoteExpiresAt: string | null;
  remoteMetadata: Record<string, unknown> | null;
  localPath: string | null;
  contentType: string | null;
  byteSize: number | null;
  checksum: string | null;
  signature: string | null;
  aspectRatio: string | null;
  pixelWidth: number | null;
  pixelHeight: number | null;
  downloadState: 'pending' | 'downloading' | 'verified' | 'failed' | 'expired' | 'deleted';
  favorite: boolean;
  pinned: boolean;
  verifiedAt: string | null;
  deletedAt: string | null;
}

export interface JobSnapshot {
  watermark: number;
  jobs: JobRecord[];
}

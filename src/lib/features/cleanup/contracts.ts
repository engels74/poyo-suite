export type CleanupConsequence = 'file' | 'metadata' | 'both';
export type CleanupPolicyMode = 'never' | 'age' | 'total-size' | 'min-free-space';

export interface CleanupExclusions {
  favorites: boolean;
  pinned: boolean;
  tags: string[];
}

export interface LocalCleanupPolicy {
  mode: CleanupPolicyMode;
  olderThanDays: number | null;
  maxBytes: number | null;
  minFreeBytes: number | null;
  exclusions: CleanupExclusions;
}

export interface CleanupCandidateDto {
  outputId: string;
  jobId: string;
  fileName: string;
  mediaKind: 'image' | 'video';
  bytes: number;
  createdAt: string;
  reasons: Array<'age' | 'storage-limit' | 'free-space'>;
}

export interface CleanupPreviewDto {
  token: string;
  policy: LocalCleanupPolicy;
  consequence: CleanupConsequence;
  candidates: CleanupCandidateDto[];
  totalBytes: number;
  createdAt: string;
  requiresConfirmation: true;
}

export interface RemoteCleanupCapabilityDto {
  available: false;
  verifiedAt: '2026-07-15';
  reason: string;
  documentedEndpoints: [];
}

export const REMOTE_CLEANUP_CAPABILITY: RemoteCleanupCapabilityDto = {
  available: false,
  verifiedAt: '2026-07-15',
  reason: 'Poyo has no documented task, upload, or generated-file deletion endpoint.',
  documentedEndpoints: []
};

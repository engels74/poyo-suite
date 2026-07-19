import type { StudioJobDto } from './contracts';

export type StudioSessionJobs = Record<string, StudioJobDto>;
export type StudioResultCandidateState = 'loading' | 'viewable' | 'empty' | 'transient';
export type StudioResultCandidateStates = Record<string, StudioResultCandidateState>;

export interface StudioJobEventUpdate {
  jobId: string;
  localPhase: string;
  remoteStatus: string;
  failureDomain: string;
  progress: number | null;
  observedAt: string;
  attentionCode?: string | null;
  ipGuardReason?: 'match' | 'unavailable' | 'misconfigured' | null;
}

export function mergeStudioJobEventAttention(
  current: Pick<StudioJobDto, 'attentionCode' | 'ipGuardReason'>,
  update: Pick<StudioJobEventUpdate, 'attentionCode' | 'ipGuardReason'>
): Pick<StudioJobDto, 'attentionCode' | 'ipGuardReason'> {
  return {
    attentionCode: Object.hasOwn(update, 'attentionCode')
      ? (update.attentionCode ?? null)
      : current.attentionCode,
    ipGuardReason: Object.hasOwn(update, 'ipGuardReason')
      ? (update.ipGuardReason ?? null)
      : (current.ipGuardReason ?? null)
  };
}

function timestamp(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function isTerminal(job: StudioJobDto): boolean {
  return job.localPhase === 'complete' || job.remoteStatus === 'failed';
}

export function mergeStudioSessionJob(
  current: StudioJobDto | undefined,
  incoming: StudioJobDto
): StudioJobDto {
  if (!current) return incoming;
  const currentUpdatedAt = timestamp(current.updatedAt);
  const incomingUpdatedAt = timestamp(incoming.updatedAt);
  if (incomingUpdatedAt < currentUpdatedAt) return current;
  if (isTerminal(current) && !isTerminal(incoming)) return current;
  return incomingUpdatedAt === currentUpdatedAt ? { ...current, ...incoming } : incoming;
}

export function upsertStudioSessionJob(
  jobs: StudioSessionJobs,
  incoming: StudioJobDto
): StudioSessionJobs {
  const merged = mergeStudioSessionJob(jobs[incoming.id], incoming);
  return merged === jobs[incoming.id] ? jobs : { ...jobs, [incoming.id]: merged };
}

export function applyStudioJobEvent(
  jobs: StudioSessionJobs,
  update: StudioJobEventUpdate
): StudioSessionJobs {
  const current = jobs[update.jobId];
  if (!current) return jobs;
  return upsertStudioSessionJob(jobs, {
    ...current,
    localPhase: update.localPhase,
    remoteStatus: update.remoteStatus,
    failureDomain: update.failureDomain,
    ...mergeStudioJobEventAttention(current, update),
    progress: update.progress,
    updatedAt: update.observedAt,
    completedAt:
      update.localPhase === 'complete' && update.remoteStatus !== 'failed'
        ? (current.completedAt ?? update.observedAt)
        : current.completedAt
  });
}

export function mergeKnownStudioSnapshot(
  jobs: StudioSessionJobs,
  snapshot: readonly StudioJobDto[]
): StudioSessionJobs {
  let next = jobs;
  for (const job of snapshot) {
    if (!jobs[job.id]) continue;
    next = upsertStudioSessionJob(next, job);
  }
  return next;
}

export function compareStudioJobRecency(left: StudioJobDto, right: StudioJobDto): number {
  const completedDifference =
    timestamp(left.completedAt ?? left.updatedAt) - timestamp(right.completedAt ?? right.updatedAt);
  return completedDifference || left.id.localeCompare(right.id);
}

export function successfulStudioJobsByRecency(jobs: StudioSessionJobs): StudioJobDto[] {
  return Object.values(jobs)
    .filter((job) => job.localPhase === 'complete' && job.remoteStatus !== 'failed')
    .toSorted((left, right) => compareStudioJobRecency(right, left));
}

export function latestSuccessfulStudioJob(jobs: StudioSessionJobs): StudioJobDto | null {
  return successfulStudioJobsByRecency(jobs)[0] ?? null;
}

export function nextStudioResultCandidate(
  jobs: StudioSessionJobs,
  states: StudioResultCandidateStates
): StudioJobDto | null {
  if (Object.values(states).includes('loading')) return null;
  return successfulStudioJobsByRecency(jobs).find((job) => states[job.id] === undefined) ?? null;
}

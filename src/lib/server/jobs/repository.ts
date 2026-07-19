import type { Database } from 'bun:sqlite';
import { DatabaseRepository } from '../platform/repository';
import type { PoyoStatusResult, PoyoSubmitResult } from '../poyo/types';
import { isPaidActionId, JobRequestError } from './create-request';
import { packDurableJobEventPayload } from './event-attention';
import type {
  CreateJobRequest,
  FailureDomain,
  JobEvent,
  JobRecord,
  JobSnapshot,
  LocalPhase,
  OutputRecord,
  RemoteStatus,
  SubmissionClaim,
  WorkClaim,
  WorkType
} from './types';

type JobRow = {
  id: string;
  registry_version: string | null;
  entry_key: string | null;
  workflow: string;
  public_model_id: string;
  local_phase: LocalPhase;
  remote_status_raw: string | null;
  remote_status: RemoteStatus;
  failure_domain: FailureDomain;
  attention_code: string | null;
  poyo_task_id: string | null;
  progress: number | null;
  guided_request_json: string;
  actual_payload_json: string;
  estimated_credits: number | null;
  actual_credits: number | null;
  correlation_id: string;
  retry_of_job_id: string | null;
  next_poll_at: string | null;
  last_polled_at: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  expert_diff_json: string | null;
};
type IntentRow = {
  job_id: string;
  state: string;
  transmit_claim_token: string | null;
  transmit_claim_owner: string | null;
  lease_expires_at: string | null;
  actual_payload_json: string;
};
type ActionRow = {
  job_id: string;
  payload_hash: string;
};
type InputRow = {
  role: string;
  media_kind: 'image' | 'video';
  source_url: string | null;
  upload_url: string | null;
  metadata_json: string;
  managed_source_id: string | null;
};
type ClaimRow = {
  work_type: WorkType;
  work_id: string;
  owner: string;
  token: string;
  expires_at: string;
  attempt: number;
};
type EventRow = {
  event_id: number;
  job_id: string;
  event_type: string;
  local_phase: LocalPhase;
  remote_status_raw: string | null;
  remote_status: RemoteStatus;
  failure_domain: FailureDomain;
  progress: number | null;
  safe_payload_json: string | null;
  observed_at: string;
};
type OutputRow = {
  id: string;
  job_id: string;
  output_order: number;
  media_kind: 'image' | 'video';
  remote_url: string | null;
  remote_expires_at: string | null;
  remote_metadata_json: string | null;
  local_path: string | null;
  content_type: string | null;
  byte_size: number | null;
  checksum: string | null;
  signature: string | null;
  aspect_ratio: string | null;
  pixel_width: number | null;
  pixel_height: number | null;
  download_state: OutputRecord['downloadState'];
  favorite: number;
  pinned: number;
  verified_at: string | null;
  deleted_at: string | null;
};
type RefreshManagedSource = (
  managedSourceId: string,
  mediaKind: 'image' | 'video'
) => Promise<{ id: string; url: string }>;

const transitions: Record<LocalPhase, readonly LocalPhase[]> = {
  queued: ['validating', 'submission_prepared', 'requires_attention'],
  validating: ['uploading', 'submission_prepared', 'requires_attention'],
  uploading: ['submission_prepared', 'requires_attention'],
  submission_prepared: ['submitting', 'requires_attention'],
  submitting: ['monitoring', 'requires_attention'],
  monitoring: ['monitoring', 'downloading', 'complete', 'requires_attention'],
  downloading: ['downloading', 'complete', 'requires_attention'],
  complete: [],
  requires_attention: ['monitoring', 'downloading', 'complete', 'requires_attention']
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}
function hash(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function replacePayloadUrls(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replacePayloadUrls(item, replacements));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, replacePayloadUrls(item, replacements)])
  );
}
function assertSafeRequest(value: unknown): void {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    throw new Error('Generation request is not JSON serializable.');
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(assertSafeRequest);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:api.?key|authorization|cookie|credential|password|secret|token)/i.test(key))
      throw new Error('Generation requests cannot contain credential fields.');
    assertSafeRequest(entry);
  }
}
function mapJob(row: JobRow): JobRecord {
  return {
    id: row.id,
    registryVersion: row.registry_version,
    entryKey: row.entry_key,
    workflow: row.workflow,
    publicModelId: row.public_model_id,
    localPhase: row.local_phase,
    remoteStatusRaw: row.remote_status_raw,
    remoteStatus: row.remote_status,
    failureDomain: row.failure_domain,
    attentionCode: row.attention_code,
    poyoTaskId: row.poyo_task_id,
    progress: row.progress,
    guidedRequest: JSON.parse(row.guided_request_json),
    normalizedPayload: JSON.parse(row.actual_payload_json),
    estimatedCredits: row.estimated_credits,
    actualCredits: row.actual_credits,
    correlationId: row.correlation_id,
    retryOfJobId: row.retry_of_job_id,
    nextPollAt: row.next_poll_at,
    lastPolledAt: row.last_polled_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    expertDiff: row.expert_diff_json ? JSON.parse(row.expert_diff_json) : []
  };
}
function mapEvent(row: EventRow): JobEvent {
  return {
    eventId: row.event_id,
    jobId: row.job_id,
    eventType: row.event_type,
    localPhase: row.local_phase,
    remoteStatusRaw: row.remote_status_raw,
    remoteStatus: row.remote_status,
    failureDomain: row.failure_domain,
    progress: row.progress,
    payload: row.safe_payload_json ? JSON.parse(row.safe_payload_json) : null,
    observedAt: row.observed_at
  };
}
function mapOutput(row: OutputRow): OutputRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    outputOrder: row.output_order,
    mediaKind: row.media_kind,
    remoteUrl: row.remote_url,
    remoteExpiresAt: row.remote_expires_at,
    remoteMetadata: row.remote_metadata_json ? JSON.parse(row.remote_metadata_json) : null,
    localPath: row.local_path,
    contentType: row.content_type,
    byteSize: row.byte_size,
    checksum: row.checksum,
    signature: row.signature,
    aspectRatio: row.aspect_ratio,
    pixelWidth: row.pixel_width,
    pixelHeight: row.pixel_height,
    downloadState: row.download_state,
    favorite: row.favorite === 1,
    pinned: row.pinned === 1,
    verifiedAt: row.verified_at,
    deletedAt: row.deleted_at
  };
}

export class JobRepository extends DatabaseRepository {
  constructor(
    database: Database,
    private readonly now: () => Date = () => new Date()
  ) {
    super(database);
  }
  private timestamp(): string {
    return this.now().toISOString();
  }
  private requireJob(id: string): JobRecord {
    const job = this.get(id);
    if (!job) throw new Error('Job not found.');
    return job;
  }
  private append(
    job: JobRecord,
    eventType: string,
    payload: Record<string, unknown> | null = null
  ): number {
    return Number(
      this.database
        .query(
          `INSERT INTO job_events(job_id,event_type,local_phase,remote_status_raw,remote_status,failure_domain,progress,safe_payload_json,observed_at) VALUES (?,?,?,?,?,?,?,?,?)`
        )
        .run(
          job.id,
          eventType,
          job.localPhase,
          job.remoteStatusRaw,
          job.remoteStatus,
          job.failureDomain,
          job.progress,
          JSON.stringify(packDurableJobEventPayload(payload, job.attentionCode)),
          this.timestamp()
        ).lastInsertRowid
    );
  }
  create(request: CreateJobRequest): JobRecord {
    if (!isPaidActionId(request.actionId))
      throw new JobRequestError('invalid_action_id', 'A stable opaque action ID is required.');
    if (!request.workflow?.trim() || !request.publicModelId?.trim())
      throw new Error('Workflow and public model ID are required.');
    if (!request.normalizedPayload?.model?.trim() || !request.normalizedPayload.input)
      throw new Error('A normalized Poyo payload is required.');
    if (request.estimatedCredits !== undefined && request.estimatedCredits < 0)
      throw new Error('Estimated credits cannot be negative.');
    assertSafeRequest(request.guidedRequest);
    assertSafeRequest(request.normalizedPayload);
    assertSafeRequest(request.expertDiff ?? []);
    assertSafeRequest(request.inputs ?? []);
    return this.transaction(() => {
      const payload = canonical(request.normalizedPayload);
      const immutableHash = hash(
        canonical({
          entryKey: request.entryKey ?? null,
          workflow: request.workflow,
          publicModelId: request.publicModelId,
          guidedRequest: request.guidedRequest,
          normalizedPayload: request.normalizedPayload,
          estimatedCredits: request.estimatedCredits ?? null,
          correlationId: request.correlationId ?? null,
          retryOfJobId: request.retryOfJobId ?? null,
          expertDiff: request.expertDiff ?? [],
          inputs: request.inputs ?? [],
          expectedMediaKind: request.expectedMediaKind ?? null,
          expectedOutputCount: request.expectedOutputCount ?? null
        })
      );
      const existing = this.database
        .query<ActionRow, [string]>(
          'SELECT job_id,payload_hash FROM submission_intents WHERE request_fingerprint=?'
        )
        .get(request.actionId);
      if (existing) {
        if (existing.payload_hash !== immutableHash)
          throw new JobRequestError(
            'paid_action_conflict',
            'This paid action ID is already bound to a different immutable request.',
            409
          );
        return this.requireJob(existing.job_id);
      }
      const id = crypto.randomUUID();
      const now = this.timestamp();
      const registry = request.entryKey
        ? this.database
            .query<
              {
                registry_version: string;
                workflow: string;
                public_model_id: string;
                modality: 'image' | 'video';
              },
              [string]
            >(
              "SELECT registry_version,workflow,public_model_id,modality FROM registry_entries WHERE entry_key=? AND status='current' ORDER BY registry_version DESC LIMIT 1"
            )
            .get(request.entryKey)
        : null;
      if (request.entryKey && !registry) throw new Error('Registry entry is unavailable.');
      if (
        registry &&
        (registry.workflow !== request.workflow ||
          registry.public_model_id !== request.publicModelId ||
          (request.expectedMediaKind && registry.modality !== request.expectedMediaKind))
      )
        throw new JobRequestError(
          'registry_request_mismatch',
          'The prepared request does not match its registry entry.',
          409
        );
      this.database
        .query(
          `INSERT INTO jobs(id,registry_version,entry_key,workflow,public_model_id,local_phase,guided_request_json,actual_payload_json,expert_diff_json,estimated_credits,prompt_text,search_text,correlation_id,retry_of_job_id,created_at,updated_at) VALUES (?,?,?,?,?,'submission_prepared',?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          registry?.registry_version ?? null,
          request.entryKey ?? null,
          request.workflow,
          request.publicModelId,
          canonical(request.guidedRequest),
          payload,
          request.expertDiff?.length ? canonical(request.expertDiff) : null,
          request.estimatedCredits ?? null,
          request.prompt ?? null,
          `${request.prompt ?? ''} ${request.publicModelId}`,
          request.correlationId ?? crypto.randomUUID(),
          request.retryOfJobId ?? null,
          now,
          now
        );
      for (const [inputOrder, input] of (request.inputs ?? []).entries()) {
        if (input.mediaKind !== 'image' && input.mediaKind !== 'video') continue;
        const managedSource = input.managedSourceId
          ? this.database
              .query<{ media_kind: 'image' | 'video'; availability: string }, [string]>(
                'SELECT media_kind,availability FROM managed_sources WHERE id=?'
              )
              .get(input.managedSourceId)
          : null;
        if (input.managedSourceId && !managedSource) {
          throw new Error('Managed local source was not found.');
        }
        if (
          managedSource &&
          (managedSource.availability !== 'available' ||
            managedSource.media_kind !== input.mediaKind)
        ) {
          throw new Error('Managed local source is not available for this input role.');
        }
        this.database
          .query(
            `INSERT INTO job_inputs(job_id,role,input_order,media_kind,local_reference,source_url,upload_url,metadata_json,availability,managed_source_id)
             VALUES (?,?,?,?,NULL,?,?,?,'available',?)`
          )
          .run(
            id,
            input.role,
            inputOrder,
            input.mediaKind,
            input.source === 'remote' ? input.url : null,
            input.source === 'uploaded' ? input.url : null,
            JSON.stringify(input.metadata ?? {}),
            input.source === 'uploaded' ? (input.managedSourceId ?? null) : null
          );
      }
      this.database
        .query(
          `INSERT INTO submission_intents(job_id,request_fingerprint,payload_hash,state,prepared_at,updated_at) VALUES (?,?,?,'prepared',?,?)`
        )
        .run(id, request.actionId, immutableHash, now, now);
      const job = this.get(id);
      if (!job) throw new Error('Created job was not found.');
      this.append(job, 'job.created');
      return job;
    });
  }
  private inputsFor(jobId: string): NonNullable<CreateJobRequest['inputs']> {
    return this.database
      .query<InputRow, [string]>(
        'SELECT role,media_kind,source_url,upload_url,metadata_json,managed_source_id FROM job_inputs WHERE job_id=? ORDER BY input_order'
      )
      .all(jobId)
      .map((input) => ({
        role: input.role,
        mediaKind: input.media_kind,
        source: input.upload_url ? ('uploaded' as const) : ('remote' as const),
        url: input.upload_url ?? input.source_url ?? '',
        metadata: JSON.parse(input.metadata_json),
        ...(input.managed_source_id ? { managedSourceId: input.managed_source_id } : {})
      }));
  }
  private existingRetry(jobId: string, actionId: string): JobRecord | null {
    if (!isPaidActionId(actionId))
      throw new JobRequestError('invalid_action_id', 'A stable opaque action ID is required.');
    const existing = this.getByActionId(actionId);
    if (!existing) return null;
    if (existing.retryOfJobId !== jobId)
      throw new JobRequestError(
        'action_id_conflict',
        'This paid action ID is already associated with another request.',
        409
      );
    return existing;
  }
  private async createRefreshedRetry(
    job: JobRecord,
    actionId: string,
    refreshManagedSource: RefreshManagedSource
  ): Promise<JobRecord> {
    const existing = this.existingRetry(job.id, actionId);
    if (existing) return existing;
    const replacements = new Map<string, string>();
    const inputs = await Promise.all(
      this.inputsFor(job.id).map(async (input) => {
        if (input.source !== 'uploaded') return input;
        if (!input.managedSourceId)
          throw new JobRequestError(
            'rerun_source_requires_review',
            'This historical upload is no longer safely reusable. Open it in studio and select the source again.',
            409
          );
        const refreshed = await refreshManagedSource(input.managedSourceId, input.mediaKind);
        if (refreshed.id !== input.managedSourceId)
          throw new Error('Managed source refresh returned an unexpected identifier.');
        replacements.set(input.url, refreshed.url);
        return { ...input, url: refreshed.url };
      })
    );
    const replay = this.existingRetry(job.id, actionId);
    if (replay) return replay;
    return this.create({
      actionId,
      ...(job.entryKey ? { entryKey: job.entryKey } : {}),
      workflow: job.workflow,
      publicModelId: job.publicModelId,
      guidedRequest: job.guidedRequest,
      normalizedPayload: replacePayloadUrls(
        job.normalizedPayload,
        replacements
      ) as JobRecord['normalizedPayload'],
      ...(typeof job.guidedRequest.prompt === 'string' ? { prompt: job.guidedRequest.prompt } : {}),
      ...(job.estimatedCredits === null ? {} : { estimatedCredits: job.estimatedCredits }),
      retryOfJobId: job.id,
      expertDiff: job.expertDiff,
      inputs
    });
  }
  async retryAmbiguous(
    jobId: string,
    actionId: string,
    refreshManagedSource: RefreshManagedSource
  ): Promise<JobRecord> {
    const job = this.get(jobId);
    if (job?.attentionCode !== 'submission_unknown')
      throw new Error('Only ambiguous submissions may be explicitly retried.');
    return this.createRefreshedRetry(job, actionId, refreshManagedSource);
  }
  async rerunAsNew(
    jobId: string,
    actionId: string,
    refreshManagedSource: RefreshManagedSource
  ): Promise<JobRecord> {
    const job = this.get(jobId);
    if (!job) throw new Error('Job not found.');
    if (job.attentionCode === 'submission_unknown')
      throw new Error('An ambiguous paid submission cannot be run again from its history record.');
    return this.createRefreshedRetry(job, actionId, refreshManagedSource);
  }
  getByActionId(actionId: string): JobRecord | null {
    const row = this.database
      .query<{ job_id: string }, [string]>(
        'SELECT job_id FROM submission_intents WHERE request_fingerprint=?'
      )
      .get(actionId);
    return row ? this.get(row.job_id) : null;
  }
  get(id: string): JobRecord | null {
    const row = this.database.query<JobRow, [string]>('SELECT * FROM jobs WHERE id=?').get(id);
    return row ? mapJob(row) : null;
  }
  listActive(): JobRecord[] {
    return this.database
      .query<JobRow, []>(
        "SELECT * FROM jobs WHERE local_phase NOT IN ('complete') ORDER BY created_at"
      )
      .all()
      .map(mapJob);
  }
  list(): JobRecord[] {
    return this.database
      .query<JobRow, []>('SELECT * FROM jobs ORDER BY created_at DESC')
      .all()
      .map(mapJob);
  }
  transition(
    id: string,
    phase: LocalPhase,
    domain: FailureDomain = 'none',
    attention: string | null = null,
    eventType = 'job.transition',
    payload: Record<string, unknown> | null = null
  ): JobRecord {
    return this.transaction(() => {
      const current = this.get(id);
      if (!current) throw new Error('Job not found.');
      if (current.localPhase !== phase && !transitions[current.localPhase].includes(phase))
        throw new Error(`Invalid job transition ${current.localPhase} -> ${phase}.`);
      const now = this.timestamp();
      this.database
        .query(
          "UPDATE jobs SET local_phase=?,failure_domain=?,attention_code=?,updated_at=?,completed_at=CASE WHEN ?='complete' THEN ? ELSE completed_at END WHERE id=?"
        )
        .run(phase, domain, attention, now, phase, now, id);
      const job = this.requireJob(id);
      this.append(job, eventType, payload);
      return job;
    });
  }
  claimSubmission(jobId: string, owner: string, leaseMs: number): SubmissionClaim | null {
    return this.transaction(() => {
      const now = this.timestamp();
      const intent = this.database
        .query<IntentRow, [string]>(
          `SELECT i.*,j.actual_payload_json FROM submission_intents i JOIN jobs j ON j.id=i.job_id WHERE i.job_id=?`
        )
        .get(jobId);
      if (!intent) throw new Error('Submission intent not found.');
      if (intent.state === 'sending' && intent.lease_expires_at && intent.lease_expires_at <= now) {
        this.markSubmissionUnknownInternal(
          jobId,
          intent.transmit_claim_token,
          'submission claim expired'
        );
        return null;
      }
      if (intent.state !== 'prepared') return null;
      const token = crypto.randomUUID();
      const expires = new Date(this.now().getTime() + leaseMs).toISOString();
      const changed = this.database
        .query(
          `UPDATE submission_intents SET state='sending',transmit_claim_token=?,transmit_claim_owner=?,claimed_at=?,lease_expires_at=?,updated_at=? WHERE job_id=? AND state='prepared'`
        )
        .run(token, owner, now, expires, now, jobId).changes;
      if (!changed) return null;
      this.transition(jobId, 'submitting', 'none', null, 'submission.claimed');
      return { jobId, owner, token, payload: JSON.parse(intent.actual_payload_json) };
    });
  }
  markSubmissionTransmitted(jobId: string, token: string): boolean {
    const now = this.timestamp();
    return (
      this.database
        .query(
          `UPDATE submission_intents SET sent_at=?,transport_evidence_json=?,updated_at=? WHERE job_id=? AND state='sending' AND transmit_claim_token=?`
        )
        .run(now, JSON.stringify({ possibleTransmit: true }), now, jobId, token).changes === 1
    );
  }
  releaseUntransmitted(jobId: string, token: string): boolean {
    return this.transaction(() => {
      const changed =
        this.database
          .query(
            `UPDATE submission_intents SET state='prepared',transmit_claim_token=NULL,transmit_claim_owner=NULL,claimed_at=NULL,lease_expires_at=NULL,updated_at=? WHERE job_id=? AND state='sending' AND transmit_claim_token=? AND sent_at IS NULL`
          )
          .run(this.timestamp(), jobId, token).changes === 1;
      if (changed)
        this.transition(jobId, 'submission_prepared', 'none', null, 'submission.released');
      return changed;
    });
  }
  private markSubmissionUnknownInternal(
    jobId: string,
    token: string | null,
    evidence: string
  ): void {
    const now = this.timestamp();
    this.database
      .query(
        `UPDATE submission_intents SET state='unknown',transport_evidence_json=?,resolved_at=?,updated_at=? WHERE job_id=? AND state='sending' AND (? IS NULL OR transmit_claim_token=?)`
      )
      .run(JSON.stringify({ ambiguous: true, evidence }), now, now, jobId, token, token);
    this.transition(
      jobId,
      'requires_attention',
      'submission',
      'submission_unknown',
      'submission.unknown'
    );
  }
  markSubmissionUnknown(jobId: string, token: string, evidence: string): void {
    this.transaction(() => this.markSubmissionUnknownInternal(jobId, token, evidence));
  }
  acknowledgeSubmission(jobId: string, token: string, result: PoyoSubmitResult): boolean {
    return this.transaction(() => {
      const now = this.timestamp();
      const changed =
        this.database
          .query(
            `UPDATE submission_intents SET state='acknowledged',poyo_task_id=?,resolved_at=?,updated_at=? WHERE job_id=? AND state='sending' AND transmit_claim_token=?`
          )
          .run(result.taskId, now, now, jobId, token).changes === 1;
      if (!changed) return false;
      this.database
        .query(
          `UPDATE jobs SET poyo_task_id=?,remote_status_raw=?,remote_status=?,local_phase='monitoring',failure_domain='none',attention_code=NULL,next_poll_at=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=?`
        )
        .run(
          result.taskId,
          result.statusRaw,
          result.status,
          new Date(this.now().getTime() + 1000).toISOString(),
          now,
          now,
          jobId
        );
      this.append(this.requireJob(jobId), 'submission.acknowledged');
      return true;
    });
  }
  rejectSubmission(jobId: string, token: string, code: string): void {
    this.transaction(() => {
      const now = this.timestamp();
      this.database
        .query(
          `UPDATE submission_intents SET state='rejected',resolved_at=?,updated_at=? WHERE job_id=? AND state='sending' AND transmit_claim_token=?`
        )
        .run(now, now, jobId, token);
      this.transition(jobId, 'requires_attention', 'submission', code, 'submission.rejected');
    });
  }
  rejectUntransmittedPolicy(jobId: string, token: string, code: string): boolean {
    return this.transaction(() => {
      const now = this.timestamp();
      const changed =
        this.database
          .query(
            `UPDATE submission_intents SET state='rejected',resolved_at=?,updated_at=? WHERE job_id=? AND state='sending' AND transmit_claim_token=? AND sent_at IS NULL`
          )
          .run(now, now, jobId, token).changes === 1;
      if (!changed) return false;
      this.transition(
        jobId,
        'requires_attention',
        'submission',
        code,
        'submission.policy_blocked',
        { code }
      );
      return true;
    });
  }
  claimWork(type: WorkType, id: string, owner: string, leaseMs: number): WorkClaim | null {
    return this.transaction(() => {
      const now = this.timestamp();
      const row = this.database
        .query<ClaimRow, [WorkType, string]>(
          'SELECT * FROM work_claims WHERE work_type=? AND work_id=?'
        )
        .get(type, id);
      if (row && row.expires_at > now) return null;
      const token = crypto.randomUUID();
      const expiry = new Date(this.now().getTime() + leaseMs).toISOString();
      const attempt = (row?.attempt ?? 0) + 1;
      if (row)
        this.database
          .query(
            `UPDATE work_claims SET owner=?,token=?,acquired_at=?,expires_at=?,attempt=? WHERE work_type=? AND work_id=? AND expires_at<=?`
          )
          .run(owner, token, now, expiry, attempt, type, id, now);
      else
        this.database
          .query(
            `INSERT INTO work_claims(work_type,work_id,owner,token,acquired_at,expires_at,attempt) VALUES (?,?,?,?,?,?,?)`
          )
          .run(type, id, owner, token, now, expiry, attempt);
      const held = this.database
        .query<ClaimRow, [WorkType, string]>(
          'SELECT * FROM work_claims WHERE work_type=? AND work_id=?'
        )
        .get(type, id);
      return held?.token === token
        ? { workType: type, workId: id, owner, token, attempt, expiresAt: expiry }
        : null;
    });
  }
  releaseWork(claim: WorkClaim): boolean {
    return (
      this.database
        .query('DELETE FROM work_claims WHERE work_type=? AND work_id=? AND owner=? AND token=?')
        .run(claim.workType, claim.workId, claim.owner, claim.token).changes === 1
    );
  }
  renewWork(claim: WorkClaim, leaseMs: number): WorkClaim | null {
    return this.transaction(() => {
      const now = this.timestamp();
      const expiresAt = new Date(this.now().getTime() + leaseMs).toISOString();
      const renewed = this.database
        .query(
          `UPDATE work_claims SET expires_at=?
           WHERE work_type=? AND work_id=? AND owner=? AND token=? AND expires_at>?`
        )
        .run(expiresAt, claim.workType, claim.workId, claim.owner, claim.token, now).changes;
      return renewed === 1 ? { ...claim, expiresAt } : null;
    });
  }
  ownsWork(claim: WorkClaim): boolean {
    return Boolean(
      this.database
        .query<{ held: number }, [WorkType, string, string, string, string]>(
          `SELECT 1 held FROM work_claims
           WHERE work_type=? AND work_id=? AND owner=? AND token=? AND expires_at>?`
        )
        .get(claim.workType, claim.workId, claim.owner, claim.token, this.timestamp())?.held
    );
  }
  applyStatus(jobId: string, status: PoyoStatusResult, pollDelayMs: number): JobRecord {
    return this.transaction(() => {
      const current = this.get(jobId);
      if (!current) throw new Error('Job not found.');
      const terminal = current.remoteStatus === 'finished' || current.remoteStatus === 'failed';
      if (terminal) return current;
      const nextStatus = status.status;
      const nextTerminal = nextStatus === 'finished' || nextStatus === 'failed';
      const progress =
        status.progress === null
          ? current.progress
          : Math.max(current.progress ?? 0, status.progress);
      // Never regress a locally-complete job. A late or manual poll must not move a job whose
      // outputs already downloaded and verified back to downloading, or re-flag it as malformed.
      const alreadyComplete = current.localPhase === 'complete';
      const malformed =
        !alreadyComplete && nextStatus === 'finished'
          ? this.outputSetProblem(current, status)
          : null;
      const phase = alreadyComplete
        ? 'complete'
        : malformed
          ? 'requires_attention'
          : nextStatus === 'finished'
            ? 'downloading'
            : nextStatus === 'failed'
              ? 'complete'
              : 'monitoring';
      const domain = alreadyComplete
        ? current.failureDomain
        : nextStatus === 'failed' || malformed
          ? 'remote_generation'
          : 'none';
      const attentionCode = alreadyComplete
        ? current.attentionCode
        : malformed
          ? 'malformed_output_set'
          : null;
      // Preserve the settled charge on an already-complete job. A late or manual poll can carry a
      // different credits_amount (including 0 for a not-yet-charged mid-run status); overwriting it
      // would regress the recorded charge behind the "Charged X credits" UX.
      const credits = alreadyComplete ? current.actualCredits : status.creditsAmount;
      const now = this.timestamp();
      const changed =
        current.localPhase !== phase ||
        current.remoteStatusRaw !== status.statusRaw ||
        current.remoteStatus !== nextStatus ||
        current.failureDomain !== domain ||
        current.attentionCode !== attentionCode ||
        current.progress !== progress ||
        current.actualCredits !== credits;
      this.database
        .query(
          `UPDATE jobs SET local_phase=?,remote_status_raw=?,remote_status=?,failure_domain=?,attention_code=?,progress=?,actual_credits=?,last_polled_at=?,next_poll_at=?,updated_at=?,completed_at=CASE WHEN ?='complete' AND completed_at IS NULL THEN ? ELSE completed_at END WHERE id=?`
        )
        .run(
          phase,
          status.statusRaw,
          nextStatus,
          domain,
          attentionCode,
          progress,
          credits,
          now,
          nextTerminal ? null : new Date(this.now().getTime() + pollDelayMs).toISOString(),
          changed ? now : current.updatedAt,
          phase,
          now,
          jobId
        );
      const job = this.requireJob(jobId);
      if (changed) this.append(job, 'status.observed', { observedProgress: status.progress });
      if (malformed)
        this.append(job, 'output_set.malformed', {
          reason: malformed,
          observedCount: status.files.length
        });
      else if (!alreadyComplete && nextStatus === 'finished') this.upsertOutputs(jobId, status);
      return job;
    });
  }
  recordPollFailure(jobId: string, code: string, stale = false): JobRecord {
    return this.transaction(() => {
      const current = this.get(jobId);
      if (!current) throw new Error('Job not found.');
      if (
        current.localPhase === 'complete' ||
        current.remoteStatus === 'finished' ||
        current.remoteStatus === 'failed'
      ) {
        this.append(current, 'poll.failed', { code, ignoredAfterTerminal: true });
        return current;
      }
      const phase = stale ? 'requires_attention' : current.localPhase;
      const now = this.timestamp();
      const failures =
        this.database
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) count FROM job_events WHERE job_id=? AND event_type='poll.failed'"
          )
          .get(jobId)?.count ?? 0;
      const nextPoll = new Date(
        this.now().getTime() + Math.min(60_000, 1000 * 2 ** Math.min(6, failures))
      ).toISOString();
      this.database
        .query(
          `UPDATE jobs SET local_phase=?,failure_domain='poll',attention_code=?,next_poll_at=?,updated_at=? WHERE id=?`
        )
        .run(phase, stale ? 'stale' : code, nextPoll, now, jobId);
      const job = this.requireJob(jobId);
      this.append(job, 'poll.failed', { code });
      return job;
    });
  }
  recordPollBlocked(jobId: string, code: string): JobRecord {
    return this.transaction(() => {
      const current = this.get(jobId);
      if (!current) throw new Error('Job not found.');
      if (!current.poyoTaskId)
        throw new Error('Cannot record a poll policy block without an acknowledged Poyo task.');
      if (current.localPhase === 'complete' || current.remoteStatus === 'finished') return current;
      const now = this.timestamp();
      this.database
        .query(
          `UPDATE jobs SET local_phase='requires_attention',failure_domain='poll',attention_code=?,next_poll_at=NULL,updated_at=? WHERE id=?`
        )
        .run(code, now, jobId);
      const job = this.requireJob(jobId);
      this.append(job, 'poll.policy_blocked', { code });
      return job;
    });
  }
  private outputExpectations(job: JobRecord): {
    mediaKind: 'image' | 'video';
    count: number;
  } {
    const registry = job.entryKey
      ? this.database
          .query<{ modality: 'image' | 'video' }, [string, string]>(
            'SELECT modality FROM registry_entries WHERE registry_version=? AND entry_key=?'
          )
          .get(job.registryVersion ?? '', job.entryKey)
      : null;
    const mediaKind = registry?.modality ?? (job.workflow.includes('video') ? 'video' : 'image');
    const requestedCount = job.guidedRequest.n;
    const count =
      mediaKind === 'image' &&
      typeof requestedCount === 'number' &&
      Number.isSafeInteger(requestedCount) &&
      requestedCount > 0
        ? requestedCount
        : 1;
    return { mediaKind, count };
  }
  private outputSetProblem(job: JobRecord, status: PoyoStatusResult): string | null {
    const expected = this.outputExpectations(job);
    if (status.files.length !== expected.count)
      return status.files.length < expected.count ? 'missing_outputs' : 'excess_outputs';
    const urls = new Set<string>();
    for (const file of status.files) {
      if (file.fileType !== expected.mediaKind) return 'unsupported_output_media';
      if (!file.url.trim()) return 'missing_output_url';
      if (urls.has(file.url)) return 'duplicate_output_url';
      urls.add(file.url);
    }
    return null;
  }
  private markMalformedOutputSet(jobId: string, reason: string, observedCount: number): JobRecord {
    const now = this.timestamp();
    this.database
      .query(
        `UPDATE jobs SET local_phase='requires_attention',failure_domain='remote_generation',attention_code='malformed_output_set',updated_at=? WHERE id=?`
      )
      .run(now, jobId);
    const job = this.requireJob(jobId);
    this.append(job, 'output_set.malformed', { reason, observedCount });
    return job;
  }
  private upsertOutputs(jobId: string, status: PoyoStatusResult): void {
    const now = this.timestamp();
    status.files.forEach((file, index) => {
      const kind = file.fileType as 'image' | 'video';
      this.database
        .query(
          `INSERT INTO job_outputs(id,job_id,output_order,media_kind,remote_url,remote_metadata_json,content_type,byte_size,download_state,created_at) VALUES (?,?,?,?,?,?,?,?, 'pending',?) ON CONFLICT(job_id,output_order) DO UPDATE SET remote_url=excluded.remote_url,remote_metadata_json=excluded.remote_metadata_json,content_type=excluded.content_type,byte_size=COALESCE(excluded.byte_size,job_outputs.byte_size)`
        )
        .run(
          crypto.randomUUID(),
          jobId,
          index,
          kind,
          file.url,
          JSON.stringify(file),
          file.contentType,
          file.fileSize,
          now
        );
    });
  }
  outputs(jobId: string): OutputRecord[] {
    return this.database
      .query<OutputRow, [string]>('SELECT * FROM job_outputs WHERE job_id=? ORDER BY output_order')
      .all(jobId)
      .map(mapOutput);
  }
  output(id: string): OutputRecord | null {
    const row = this.database
      .query<OutputRow, [string]>('SELECT * FROM job_outputs WHERE id=?')
      .get(id);
    return row ? mapOutput(row) : null;
  }
  startDownload(id: string): number {
    return this.transaction(() => {
      const output = this.output(id);
      if (!output) throw new Error('Output not found.');
      const n =
        (this.database
          .query<{ n: number }, [string]>(
            'SELECT COUNT(*) n FROM download_attempts WHERE output_id=?'
          )
          .get(id)?.n ?? 0) + 1;
      const now = this.timestamp();
      this.database
        .query(
          `INSERT INTO download_attempts(output_id,attempt,status,started_at) VALUES (?,?,'started',?)`
        )
        .run(id, n, now);
      this.database.query(`UPDATE job_outputs SET download_state='downloading' WHERE id=?`).run(id);
      this.append(this.requireJob(output.jobId), 'download.started', { outputId: id, attempt: n });
      return n;
    });
  }
  verifyDownload(
    id: string,
    attempt: number,
    data: {
      path: string;
      size: number;
      checksum: string;
      signature: string;
      contentType: string | null;
      pixelWidth?: number | null;
      pixelHeight?: number | null;
      aspectRatio?: string | null;
    },
    claim?: WorkClaim
  ): boolean {
    return this.transaction(() => {
      if (claim && !this.ownsWork(claim)) return false;
      const output = this.output(id);
      if (!output) throw new Error('Output not found.');
      const now = this.timestamp();
      this.database
        .query(
          `UPDATE download_attempts SET status='verified',bytes_received=?,completed_at=? WHERE output_id=? AND attempt=?`
        )
        .run(data.size, now, id, attempt);
      this.database
        .query(
          `UPDATE job_outputs SET download_state='verified',local_path=?,byte_size=?,checksum=?,signature=?,content_type=COALESCE(?,content_type),pixel_width=COALESCE(?,pixel_width),pixel_height=COALESCE(?,pixel_height),aspect_ratio=COALESCE(?,aspect_ratio),verified_at=? WHERE id=?`
        )
        .run(
          data.path,
          data.size,
          data.checksum,
          data.signature,
          data.contentType,
          data.pixelWidth ?? null,
          data.pixelHeight ?? null,
          data.aspectRatio ?? null,
          now,
          id
        );
      this.append(this.requireJob(output.jobId), 'download.verified', { outputId: id });
      return true;
    });
  }
  failDownload(
    id: string,
    attempt: number,
    error: Record<string, unknown>,
    expired = false,
    claim?: WorkClaim
  ): boolean {
    return this.transaction(() => {
      if (claim && !this.ownsWork(claim)) return false;
      const now = this.timestamp(),
        state = expired ? 'expired' : 'failed';
      this.database
        .query(
          `UPDATE download_attempts SET status=?,safe_error_json=?,completed_at=? WHERE output_id=? AND attempt=?`
        )
        .run(state, JSON.stringify(error), now, id, attempt);
      const changed = this.database
        .query(`UPDATE job_outputs SET download_state=? WHERE id=? AND download_state!='verified'`)
        .run(state, id).changes;
      if (changed === 0) return false;
      const output = this.output(id);
      if (output) {
        const job = this.requireJob(output.jobId);
        this.database
          .query(
            `UPDATE jobs SET failure_domain='download',attention_code='download_failed',updated_at=? WHERE id=?`
          )
          .run(now, job.id);
        this.database
          .query(`UPDATE jobs SET local_phase='requires_attention' WHERE id=?`)
          .run(job.id);
        this.append(this.requireJob(job.id), 'download.failed', { outputId: id });
      }
      return true;
    });
  }
  finishIfDownloaded(jobId: string): JobRecord {
    return this.transaction(() => {
      const job = this.requireJob(jobId);
      const expected = this.outputExpectations(job);
      const counts = this.database
        .query<{ total: number; verified: number }, [string]>(
          `SELECT COUNT(*) total,SUM(CASE WHEN download_state='verified' THEN 1 ELSE 0 END) verified FROM job_outputs WHERE job_id=?`
        )
        .get(jobId) ?? { total: 0, verified: 0 };
      if (counts.total !== expected.count)
        return this.markMalformedOutputSet(jobId, 'stored_output_count_mismatch', counts.total);
      return counts.verified === expected.count
        ? this.transition(jobId, 'complete', 'none', null, 'job.complete')
        : job;
    });
  }
  recordBalance(email: string, credits: number, source: string): void {
    this.database
      .query('INSERT INTO balance_snapshots(email,credits,source,fetched_at) VALUES (?,?,?,?)')
      .run(email, credits, source, this.timestamp());
  }
  eventsAfter(id: number, limit = 500): JobEvent[] {
    return this.database
      .query<EventRow, [number, number]>(
        'SELECT * FROM job_events WHERE event_id>? ORDER BY event_id LIMIT ?'
      )
      .all(id, Math.min(500, Math.max(1, limit)))
      .map(mapEvent);
  }
  eventBounds(): { min: number; max: number } {
    const row = this.database
      .query<{ min: number | null; max: number | null }, []>(
        'SELECT MIN(event_id) min,MAX(event_id) max FROM job_events'
      )
      .get();
    return { min: row?.min ?? 0, max: row?.max ?? 0 };
  }
  snapshot(): JobSnapshot {
    return this.transaction(() => ({ watermark: this.eventBounds().max, jobs: this.list() }));
  }
}

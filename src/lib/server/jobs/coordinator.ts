import { type MaintenanceGate, maintenanceGate } from '../platform/maintenance-gate';
import { PoyoError } from '../poyo/errors';
import type {
  PoyoBalanceResult,
  PoyoRequestOptions,
  PoyoStatusResult,
  PoyoSubmitRequest,
  PoyoSubmitResult
} from '../poyo/types';
import type { OutputDownloader } from './downloader';
import type { JobRepository } from './repository';
import type { JobRecord, WorkClaim } from './types';

const SUBMISSION_CLAIM_LOST_BEFORE_DISPATCH = 'submission_claim_lost_before_dispatch';
const COST_BALANCE_TIMEOUT_MS = 2_500;

export interface JobPoyoGateway {
  submit(request: PoyoSubmitRequest, options?: PoyoRequestOptions): Promise<PoyoSubmitResult>;
  getStatus(taskId: string): Promise<PoyoStatusResult>;
  getBalance(options?: PoyoRequestOptions): Promise<PoyoBalanceResult>;
}
export interface JobRuntimeSettings {
  pollDelayMs: number;
  staleAfterMs: number;
  automaticDownloads: boolean;
}
export interface JobCoordinatorOptions {
  repository: JobRepository;
  poyo: JobPoyoGateway;
  downloader: OutputDownloader;
  workerId?: string;
  submissionLeaseMs?: number;
  workLeaseMs?: number;
  pollDelayMs?: number;
  staleAfterMs?: number;
  automaticDownloads?: boolean;
  runtimeSettings?: () => JobRuntimeSettings;
  now?: () => Date;
}
export class JobCoordinator {
  readonly workerId: string;
  private readonly now;
  private readonly submissionLeaseMs;
  private readonly workLeaseMs;
  private readonly pollDelayMs;
  private readonly staleAfterMs;
  private readonly automaticDownloads;
  private submissionTail: Promise<void> = Promise.resolve();
  constructor(private readonly options: JobCoordinatorOptions) {
    this.workerId = options.workerId ?? crypto.randomUUID();
    this.now = options.now ?? (() => new Date());
    this.submissionLeaseMs = options.submissionLeaseMs ?? 60_000;
    this.workLeaseMs = options.workLeaseMs ?? 60_000;
    this.pollDelayMs = options.pollDelayMs ?? 10_000;
    this.staleAfterMs = options.staleAfterMs ?? 15 * 60_000;
    this.automaticDownloads = options.automaticDownloads ?? true;
  }
  private settings(): JobRuntimeSettings {
    return (
      this.options.runtimeSettings?.() ?? {
        pollDelayMs: this.pollDelayMs,
        staleAfterMs: this.staleAfterMs,
        automaticDownloads: this.automaticDownloads
      }
    );
  }
  private requireJob(jobId: string): JobRecord {
    const job = this.options.repository.get(jobId);
    if (!job) throw new Error('Job not found.');
    return job;
  }
  private async withDownloadLease<T>(
    claim: WorkClaim,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    let current = claim;
    const heartbeat = () => {
      try {
        const renewed = this.options.repository.renewWork(current, this.workLeaseMs);
        if (renewed) current = renewed;
        else controller.abort(new Error('Download work lease ownership was lost.'));
      } catch (error) {
        controller.abort(error);
      }
    };
    const interval = setInterval(
      heartbeat,
      Math.max(1, Math.min(20_000, Math.floor(this.workLeaseMs / 3)))
    );
    interval.unref();
    try {
      return await operation(controller.signal);
    } finally {
      clearInterval(interval);
    }
  }
  async refreshBalance(source: string): Promise<void> {
    try {
      const balance = await this.options.poyo.getBalance();
      this.options.repository.recordBalance(balance.email, balance.creditsAmount, source);
    } catch {}
  }
  private async sampleCostBalance(
    jobId: string,
    actionId: string,
    phase: 'before' | 'after'
  ): Promise<void> {
    if (!this.options.repository.beginCostBalanceSample(jobId, actionId, phase)) return;
    try {
      const balance = await this.options.poyo.getBalance({ timeoutMs: COST_BALANCE_TIMEOUT_MS });
      if (!this.options.repository.recordCostBalanceSample(jobId, actionId, phase, balance)) {
        this.options.repository.recordCostBalanceFailure(jobId, actionId, phase);
      }
    } catch {
      this.options.repository.recordCostBalanceFailure(jobId, actionId, phase);
    }
  }
  private async withSubmissionSlot<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.submissionTail;
    let release = (): void => undefined;
    this.submissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
  async submit(jobId: string): Promise<JobRecord> {
    return this.withSubmissionSlot(() => this.submitAtQueueHead(jobId));
  }
  private async submitAtQueueHead(jobId: string): Promise<JobRecord> {
    const claim = this.options.repository.claimSubmission(
      jobId,
      this.workerId,
      this.submissionLeaseMs
    );
    if (!claim) return this.requireJob(jobId);
    try {
      const result = await this.options.poyo.submit(claim.payload, {
        beforeDispatch: async () => {
          await this.sampleCostBalance(jobId, claim.actionId, 'before');
          if (!this.options.repository.markSubmissionTransmitted(jobId, claim.token)) {
            throw new PoyoError({
              category: 'submission',
              technicalCode: SUBMISSION_CLAIM_LOST_BEFORE_DISPATCH,
              message: 'Submission claim ownership was lost before dispatch.',
              retryable: false,
              operation: 'submit'
            });
          }
        }
      });
      this.options.repository.acknowledgeSubmission(jobId, claim.token, result);
      return this.requireJob(jobId);
    } catch (error) {
      if (
        error instanceof PoyoError &&
        error.technicalCode === SUBMISSION_CLAIM_LOST_BEFORE_DISPATCH
      ) {
        return this.requireJob(jobId);
      }
      if (error instanceof PoyoError && error.category === 'policy') {
        const rejected = this.options.repository.rejectUntransmittedPolicy(
          jobId,
          claim.token,
          error.technicalCode
        );
        if (!rejected) {
          this.options.repository.markSubmissionUnknown(jobId, claim.token, error.technicalCode);
        }
      } else if (
        error instanceof PoyoError &&
        !['network', 'provider', 'rate_limit'].includes(error.category)
      )
        this.options.repository.rejectSubmission(jobId, claim.token, error.technicalCode);
      else
        this.options.repository.markSubmissionUnknown(
          jobId,
          claim.token,
          error instanceof PoyoError ? error.technicalCode : 'transport_unknown'
        );
      return this.requireJob(jobId);
    }
  }
  async poll(jobId: string, manual = false): Promise<JobRecord> {
    const job = this.options.repository.get(jobId);
    if (!job?.poyoTaskId) return this.requireJob(jobId);
    const claim = this.options.repository.claimWork('poll', jobId, this.workerId, this.workLeaseMs);
    if (!claim) return job;
    try {
      const settings = this.settings();
      const status = await this.options.poyo.getStatus(job.poyoTaskId);
      const updated = this.options.repository.applyStatus(jobId, status, settings.pollDelayMs);
      const wasTerminal = job.remoteStatus === 'finished' || job.remoteStatus === 'failed';
      const isTerminal = updated.remoteStatus === 'finished' || updated.remoteStatus === 'failed';
      if (!wasTerminal && isTerminal) {
        const actionId = this.options.repository.paidActionId(jobId);
        if (actionId) await this.sampleCostBalance(jobId, actionId, 'after');
      }
      if (updated.remoteStatus === 'finished') {
        if (settings.automaticDownloads) await this.downloadPending(jobId);
      }
      return updated;
    } catch (error) {
      if (error instanceof PoyoError && error.category === 'policy') {
        return this.options.repository.recordPollBlocked(jobId, error.technicalCode);
      }
      const age = this.now().getTime() - Date.parse(job.lastPolledAt ?? job.createdAt);
      return this.options.repository.recordPollFailure(
        jobId,
        error instanceof PoyoError ? error.technicalCode : 'poll_error',
        !manual && age > this.settings().staleAfterMs
      );
    } finally {
      this.options.repository.releaseWork(claim);
    }
  }
  async downloadPending(jobId: string): Promise<void> {
    for (const output of this.options.repository
      .outputs(jobId)
      .filter((item) => item.downloadState !== 'verified')) {
      const claim = this.options.repository.claimWork(
        'download',
        output.id,
        this.workerId,
        this.workLeaseMs
      );
      if (!claim) continue;
      try {
        await this.withDownloadLease(claim, (signal) =>
          this.options.downloader.download(output.id, { signal, workClaim: claim })
        );
      } catch {
      } finally {
        this.options.repository.releaseWork(claim);
      }
    }
    this.options.repository.finishIfDownloaded(jobId);
  }
  async retryDownload(outputId: string): Promise<void> {
    const output = this.options.repository.output(outputId);
    if (!output) throw new Error('Output not found.');
    const claim = this.options.repository.claimWork(
      'download',
      output.id,
      this.workerId,
      this.workLeaseMs
    );
    if (!claim) return;
    try {
      await this.withDownloadLease(claim, (signal) =>
        this.options.downloader.download(output.id, { signal, workClaim: claim })
      );
      this.options.repository.finishIfDownloaded(output.jobId);
    } finally {
      this.options.repository.releaseWork(claim);
    }
  }
  async reconcile(jobId: string): Promise<JobRecord> {
    const job = this.options.repository.get(jobId);
    if (!job) throw new Error('Job not found.');
    if (job.localPhase === 'submission_prepared' || job.localPhase === 'submitting')
      return this.submit(jobId);
    if (
      job.poyoTaskId &&
      (job.localPhase === 'monitoring' ||
        (job.localPhase === 'requires_attention' && job.attentionCode === 'stale'))
    ) {
      if (!job.nextPollAt || Date.parse(job.nextPollAt) <= this.now().getTime())
        return this.poll(jobId);
    }
    if (job.localPhase === 'downloading') {
      if (this.settings().automaticDownloads) await this.downloadPending(jobId);
      return this.requireJob(jobId);
    }
    return job;
  }
  async recoverOnce(): Promise<void> {
    for (const job of this.options.repository.listActive())
      await this.reconcile(job.id).catch(() => undefined);
  }
}

export interface JobRecoveryCoordinator {
  recoverOnce(): Promise<void>;
}

export class JobWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<Promise<void>>();
  constructor(
    private readonly coordinator: JobRecoveryCoordinator,
    private readonly intervalMs = 1000,
    private readonly gate: MaintenanceGate = maintenanceGate
  ) {}
  async tick(): Promise<void> {
    await this.gate.withWriterPermit('job-worker.tick', () => this.coordinator.recoverOnce());
  }
  private scheduleTick(): void {
    const running = this.tick()
      .catch(() => undefined)
      .finally(() => this.inFlight.delete(running));
    this.inFlight.add(running);
  }
  start(): () => void {
    if (!this.timer) {
      this.scheduleTick();
      this.timer = setInterval(() => this.scheduleTick(), this.intervalMs);
      this.timer.unref?.();
    }
    return () => this.stop();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }
}

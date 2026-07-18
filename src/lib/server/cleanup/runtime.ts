import { type MaintenanceGate, maintenanceGate } from '../platform/maintenance-gate';
import { CleanupRepository } from './repository';
import { CleanupService } from './service';

export const DEFAULT_CLEANUP_INTERVAL_MS = 15 * 60_000;
export const MIN_CLEANUP_INTERVAL_MS = 60_000;
export const MAX_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;

export type CleanupSchedule = (run: () => Promise<void>, intervalMs: number) => () => void;

export interface CleanupRuntimeOptions {
  repository: CleanupRepository;
  service: CleanupService;
  owner?: string;
  leaseMs?: number;
  intervalMs?: number;
  schedule?: CleanupSchedule;
  gate?: MaintenanceGate;
}

function cleanupIntervalMs(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= MIN_CLEANUP_INTERVAL_MS &&
    parsed <= MAX_CLEANUP_INTERVAL_MS
    ? parsed
    : DEFAULT_CLEANUP_INTERVAL_MS;
}

const scheduleInterval: CleanupSchedule = (run, intervalMs) => {
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

export class CleanupRuntime {
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly intervalMs: number;
  private cancelSchedule: (() => void) | null = null;
  private running = false;
  private currentRun: Promise<number> | null = null;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;

  constructor(readonly options: CleanupRuntimeOptions) {
    this.owner = options.owner ?? `cleanup-worker-${crypto.randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.intervalMs = cleanupIntervalMs(options.intervalMs);
  }

  async runOnce(maxActions = 100): Promise<number> {
    if (this.currentRun) return 0;
    const gate = this.options.gate ?? maintenanceGate;
    const run = gate
      .withWriterPermit('cleanup.runOnce', async () => {
        this.running = true;
        let completed = 0;
        try {
          this.options.repository.reconcileExpiredClaims();
          let policyError: unknown;
          try {
            await this.options.service.scheduleEnabledPolicy();
          } catch (error) {
            policyError = error;
          }
          for (let index = 0; index < maxActions; index += 1) {
            const claim = this.options.repository.claimNext(this.owner, this.leaseMs);
            if (!claim) break;
            await this.options.service.execute(claim).catch(() => undefined);
            completed += 1;
          }
          this.lastRunAt = new Date().toISOString();
          this.lastError = policyError === undefined ? null : errorName(policyError);
          return completed;
        } catch (error) {
          this.lastError = errorName(error);
          throw error;
        } finally {
          this.running = false;
        }
      })
      .finally(() => {
        this.currentRun = null;
      });
    this.currentRun = run;
    return run;
  }

  start(): () => void {
    if (!this.cancelSchedule) {
      const run = async () => {
        await this.runOnce().catch(() => undefined);
      };
      this.cancelSchedule = (this.options.schedule ?? scheduleInterval)(run, this.intervalMs);
      void run();
    }
    return () => this.stop();
  }

  stop(): void {
    this.cancelSchedule?.();
    this.cancelSchedule = null;
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    if (this.currentRun) await this.currentRun.catch(() => undefined);
  }

  diagnostics() {
    return {
      running: this.running,
      scheduled: this.cancelSchedule !== null,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      actions: this.options.repository.actionCounts()
    };
  }
}

let runtimePromise: Promise<CleanupRuntime> | undefined;
let stopRuntime: (() => void) | undefined;

export async function getCleanupRuntime(): Promise<CleanupRuntime> {
  const { getPlatformServices } = await import('../platform/runtime');
  runtimePromise ??= getPlatformServices()
    .then((platform) => {
      const repository = new CleanupRepository(platform.database);
      const runtime = new CleanupRuntime({
        repository,
        service: new CleanupService({ repository, paths: platform.paths }),
        intervalMs: cleanupIntervalMs(Bun.env.PLS_CLEANUP_INTERVAL_MS),
        gate: maintenanceGate
      });
      maintenanceGate.registerDrain('cleanup-worker', async () => {
        stopRuntime?.();
        stopRuntime = undefined;
        await runtime.stopAndDrain();
      });
      return runtime;
    })
    .catch((error) => {
      runtimePromise = undefined;
      throw error;
    });
  return runtimePromise;
}

export async function startRuntimeCleanupWorker(): Promise<void> {
  if (stopRuntime) return;
  stopRuntime = (await getCleanupRuntime()).start();
}

export async function stopRuntimeCleanupWorker(): Promise<void> {
  stopRuntime?.();
  stopRuntime = undefined;
  if (runtimePromise) await (await runtimePromise).stopAndDrain();
}

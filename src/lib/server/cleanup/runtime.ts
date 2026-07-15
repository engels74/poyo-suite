import { CleanupRepository } from './repository';
import { CleanupService } from './service';

export interface CleanupRuntimeOptions {
  repository: CleanupRepository;
  service: CleanupService;
  owner?: string;
  leaseMs?: number;
  intervalMs?: number;
}

export class CleanupRuntime {
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;

  constructor(readonly options: CleanupRuntimeOptions) {
    this.owner = options.owner ?? `cleanup-worker-${crypto.randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.intervalMs = options.intervalMs ?? 30_000;
  }

  async runOnce(maxActions = 100): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let completed = 0;
    try {
      this.options.repository.reconcileExpiredClaims();
      for (let index = 0; index < maxActions; index += 1) {
        const claim = this.options.repository.claimNext(this.owner, this.leaseMs);
        if (!claim) break;
        await this.options.service.execute(claim).catch(() => undefined);
        completed += 1;
      }
      this.lastRunAt = new Date().toISOString();
      this.lastError = null;
      return completed;
    } catch (error) {
      this.lastError = error instanceof Error ? error.name : 'Error';
      throw error;
    } finally {
      this.running = false;
    }
  }

  start(): () => void {
    if (!this.timer) {
      void this.runOnce().catch(() => undefined);
      this.timer = setInterval(() => void this.runOnce().catch(() => undefined), this.intervalMs);
      this.timer.unref?.();
    }
    return () => this.stop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  diagnostics() {
    return {
      running: this.running,
      scheduled: this.timer !== null,
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
      return new CleanupRuntime({
        repository,
        service: new CleanupService({ repository, paths: platform.paths })
      });
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

export function stopRuntimeCleanupWorker(): void {
  stopRuntime?.();
  stopRuntime = undefined;
}

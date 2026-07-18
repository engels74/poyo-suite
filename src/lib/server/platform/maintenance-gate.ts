export class MaintenanceUnavailableError extends Error {
  constructor() {
    super('Local mutation is unavailable while storage maintenance is in progress.');
    this.name = 'MaintenanceUnavailableError';
  }
}

const READ_ONLY_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requestRequiresWriterPermit(method: string, routeId?: string | null): boolean {
  if (
    method.toUpperCase() === 'POST' &&
    (routeId === '/api/settings/storage-root' ||
      routeId === '/api/settings/credential-backend' ||
      routeId === '/api/settings/credential-backend/conflict')
  ) {
    return false;
  }
  return !READ_ONLY_HTTP_METHODS.has(method.toUpperCase());
}

export interface WriterPermit {
  readonly kind: 'writer';
  readonly label: string;
  release(): void;
}

export interface MaintenanceInitiatorPermit {
  readonly kind: 'maintenance-initiator';
  readonly label: string;
  release(): void;
}

export interface ExclusiveMaintenanceLease {
  readonly kind: 'exclusive-maintenance';
  readonly label: string;
  reopenBeforePublication(): void;
  freezeUntilRestart(): void;
}

interface PermitRecord {
  kind: 'writer' | 'maintenance-initiator';
  active: boolean;
}

export class MaintenanceGate {
  private admission: 'open' | 'closed' | 'frozen' = 'open';
  private readonly permits = new WeakMap<object, PermitRecord>();
  private readonly activePermits = new Set<object>();
  private readonly drainWaiters = new Set<() => void>();
  private readonly drainHooks = new Map<string, () => Promise<void>>();
  private readonly detachedTasks = new Set<Promise<unknown>>();
  private exclusive = false;
  private writerGeneration = 0;

  private acquire<T extends WriterPermit | MaintenanceInitiatorPermit>(
    kind: PermitRecord['kind'],
    label: string
  ): T {
    if (this.admission !== 'open' || this.exclusive) throw new MaintenanceUnavailableError();
    const permit = {
      kind,
      label,
      release: () => this.releasePermit(permit)
    } as T;
    this.permits.set(permit, { kind, active: true });
    this.activePermits.add(permit);
    this.writerGeneration += 1;
    return permit;
  }

  acquireWriter(label: string): WriterPermit {
    return this.acquire<WriterPermit>('writer', label);
  }

  acquireMaintenanceInitiator(label: string): MaintenanceInitiatorPermit {
    return this.acquire<MaintenanceInitiatorPermit>('maintenance-initiator', label);
  }

  private releasePermit(permit: object): void {
    const record = this.permits.get(permit);
    if (!record?.active) throw new Error('Writer permit has already been released or upgraded.');
    record.active = false;
    this.activePermits.delete(permit);
    this.writerGeneration += 1;
    this.notifyDrained();
  }

  private notifyDrained(): void {
    if (this.activePermits.size !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private async awaitWriterDrain(): Promise<void> {
    if (this.activePermits.size === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  private async awaitDetachedDrain(): Promise<void> {
    while (this.detachedTasks.size > 0) {
      await Promise.allSettled([...this.detachedTasks]);
    }
  }

  registerDrain(name: string, drain: () => Promise<void>): () => void {
    if (this.drainHooks.has(name))
      throw new Error(`Maintenance drain ${name} is already registered.`);
    this.drainHooks.set(name, drain);
    return () => {
      if (this.drainHooks.get(name) === drain) this.drainHooks.delete(name);
    };
  }

  trackDetached<T>(_label: string, operation: () => Promise<T>): Promise<T> {
    if (this.admission !== 'open') {
      throw new MaintenanceUnavailableError();
    }
    const tracked = Promise.resolve()
      .then(operation)
      .finally(() => this.detachedTasks.delete(tracked));
    this.detachedTasks.add(tracked);
    return tracked;
  }

  async upgradeToExclusiveMaintenance(
    permit: MaintenanceInitiatorPermit
  ): Promise<ExclusiveMaintenanceLease> {
    const record = this.permits.get(permit);
    if (!record?.active || record.kind !== 'maintenance-initiator') {
      throw new Error('Only an active maintenance-initiator permit can be upgraded.');
    }
    if (this.admission !== 'open' || this.exclusive) {
      this.releasePermit(permit);
      throw new MaintenanceUnavailableError();
    }

    this.admission = 'closed';
    this.exclusive = true;
    this.releasePermit(permit);

    try {
      await this.awaitWriterDrain();
      await this.awaitDetachedDrain();
      for (const drain of this.drainHooks.values()) await drain();
      await this.awaitDetachedDrain();
    } catch (error) {
      this.admission = 'frozen';
      this.exclusive = false;
      throw error;
    }

    let active = true;
    const assertActive = () => {
      if (!active) throw new Error('Exclusive maintenance lease has already been finalized.');
    };
    return {
      kind: 'exclusive-maintenance',
      label: permit.label,
      reopenBeforePublication: () => {
        assertActive();
        active = false;
        this.exclusive = false;
        this.admission = 'open';
        this.writerGeneration += 1;
      },
      freezeUntilRestart: () => {
        assertActive();
        active = false;
        this.exclusive = false;
        this.admission = 'frozen';
        this.writerGeneration += 1;
      }
    };
  }

  async withWriterPermit<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const permit = this.acquireWriter(label);
    try {
      return await operation();
    } finally {
      permit.release();
    }
  }

  status(): {
    admission: 'open' | 'closed' | 'frozen';
    activeWriters: number;
    detachedTasks: number;
    writerGeneration: number;
  } {
    return {
      admission: this.admission,
      activeWriters: this.activePermits.size,
      detachedTasks: this.detachedTasks.size,
      writerGeneration: this.writerGeneration
    };
  }
}

export const maintenanceGate = new MaintenanceGate();

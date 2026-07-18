export interface HealthDto {
  status: 'ok' | 'degraded';
  checkedAt: string;
  application: {
    version: string;
    databaseSchemaVersion: number;
    registrySchemaVersion: number;
  };
  network: {
    defaultHost: '127.0.0.1';
    loopbackOnlyByDefault: true;
  };
  database: {
    status: 'ok' | 'error';
    foreignKeys: boolean;
    schemaVersion: number;
  };
  apiKey: {
    source: 'environment' | 'local' | 'none';
    status: 'configured' | 'missing' | 'unavailable' | 'error';
    storeKind: 'environment' | 'os' | 'file' | 'unavailable';
    onboardingAvailable: boolean;
    environmentManaged: boolean;
  };
  logging: {
    status: 'ok' | 'degraded';
    separateErrorFile: boolean;
    files: number;
    bytes: number;
    lastRotationError: { name: string; message: string } | null;
    rotation: {
      separateErrorFile: boolean;
      maxBytes: number;
      maxAgeMs: number;
      retentionAgeMs: number;
      maxRotatedFiles: number;
    };
  };
}

export interface OperationsDiagnosticsDto {
  health: HealthDto;
  connectivity: { checkedAt: string | null; status: string | null };
  storage: import('../library/contracts').StorageStatisticsDto;
  cleanup: {
    running: boolean;
    scheduled: boolean;
    lastRunAt: string | null;
    lastError: string | null;
    actions: Record<string, number>;
  };
  remoteCleanup: import('../cleanup/contracts').RemoteCleanupCapabilityDto;
  registry: Array<{ version: string; verified_at: string; status: string }>;
  settings: {
    polling: { intervalMs: number; staleAfterMs: number };
    downloads: { automatic: boolean };
    theme: { defaultMode: 'light' | 'dark' | 'system' };
    logs: HealthDto['logging']['rotation'];
    storageSource: 'environment' | 'project-default' | 'platform-selected';
  };
  logging: HealthDto['logging'];
}

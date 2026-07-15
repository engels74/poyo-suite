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

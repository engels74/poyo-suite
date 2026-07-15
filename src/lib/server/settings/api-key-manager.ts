import type {
  ApiKeySource,
  ApiKeyStatus,
  SecretMetadata,
  SecretMetadataRepository,
  SecretStoreKind
} from './secret-metadata-repository';
import type { SecretStore } from './secret-store';

export interface ApiKeyStatusDto {
  source: ApiKeySource;
  status: ApiKeyStatus;
  storeKind: SecretStoreKind;
  onboardingAvailable: boolean;
  environmentManaged: boolean;
  updatedAt: string | null;
}

export interface ResolvedApiKey {
  key: string | null;
  status: ApiKeyStatusDto;
}

export interface ApiKeyManagerOptions {
  environment: Record<string, string | undefined>;
  secretStore: SecretStore;
  metadataRepository: SecretMetadataRepository;
  now?: () => Date;
}

export class EnvironmentKeyActiveError extends Error {
  constructor() {
    super('The environment-provided Poyo API key is authoritative and cannot be overridden.');
    this.name = 'EnvironmentKeyActiveError';
  }
}

function environmentKey(environment: Record<string, string | undefined>): string | null {
  const value = environment.POYO_API_KEY?.trim();
  return value || null;
}

export class ApiKeyManager {
  private readonly now: () => Date;

  constructor(private readonly options: ApiKeyManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private persistStatus(
    source: ApiKeySource,
    status: ApiKeyStatus,
    storeKind: SecretStoreKind
  ): SecretMetadata {
    const previous = this.options.metadataRepository.get();
    return this.options.metadataRepository.save(
      {
        activeSource: source,
        status,
        storeKind,
        lastConnectivityAt: previous?.lastConnectivityAt ?? null,
        lastConnectivityStatus: previous?.lastConnectivityStatus ?? null
      },
      this.now()
    );
  }

  private dto(metadata: SecretMetadata): ApiKeyStatusDto {
    return {
      source: metadata.activeSource,
      status: metadata.status,
      storeKind: metadata.storeKind,
      onboardingAvailable:
        metadata.activeSource !== 'environment' && metadata.status !== 'unavailable',
      environmentManaged: metadata.activeSource === 'environment',
      updatedAt: metadata.updatedAt
    };
  }

  async resolve(): Promise<ResolvedApiKey> {
    const fromEnvironment = environmentKey(this.options.environment);
    if (fromEnvironment) {
      const metadata = this.persistStatus('environment', 'configured', 'environment');
      return { key: fromEnvironment, status: this.dto(metadata) };
    }

    try {
      const fromStore = await this.options.secretStore.get();
      const metadata = this.persistStatus(
        fromStore ? 'local' : 'none',
        fromStore ? 'configured' : 'missing',
        this.options.secretStore.kind
      );
      return { key: fromStore, status: this.dto(metadata) };
    } catch {
      const metadata = this.persistStatus('none', 'unavailable', 'unavailable');
      return { key: null, status: this.dto(metadata) };
    }
  }

  async status(): Promise<ApiKeyStatusDto> {
    return (await this.resolve()).status;
  }

  recordConnectivity(status: 'ok' | 'failed'): void {
    const previous = this.options.metadataRepository.get();
    if (!previous) return;
    this.options.metadataRepository.save(
      {
        activeSource: previous.activeSource,
        status: previous.status,
        storeKind: previous.storeKind,
        lastConnectivityAt: this.now().toISOString(),
        lastConnectivityStatus: status
      },
      this.now()
    );
  }

  connectivityStatus(): { checkedAt: string | null; status: string | null } {
    const metadata = this.options.metadataRepository.get();
    return {
      checkedAt: metadata?.lastConnectivityAt ?? null,
      status: metadata?.lastConnectivityStatus ?? null
    };
  }

  async setLocal(secret: string): Promise<ApiKeyStatusDto> {
    if (environmentKey(this.options.environment)) throw new EnvironmentKeyActiveError();
    const value = secret.trim();
    if (!value || value.length > 4096) throw new Error('API key is empty or too large.');

    await this.options.secretStore.set(value);
    return this.dto(this.persistStatus('local', 'configured', this.options.secretStore.kind));
  }

  async removeLocal(): Promise<ApiKeyStatusDto> {
    try {
      await this.options.secretStore.delete();
    } catch {
      if (!environmentKey(this.options.environment)) {
        return this.dto(this.persistStatus('none', 'unavailable', 'unavailable'));
      }
    }

    const fromEnvironment = environmentKey(this.options.environment);
    return this.dto(
      this.persistStatus(
        fromEnvironment ? 'environment' : 'none',
        fromEnvironment ? 'configured' : 'missing',
        fromEnvironment ? 'environment' : this.options.secretStore.kind
      )
    );
  }
}

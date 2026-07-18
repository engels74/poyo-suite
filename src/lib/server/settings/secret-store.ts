import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppPaths } from '../platform/app-paths';

const service = 'ai.poyo.local-studio';
const name = 'poyo-api-key';

export type SecretStoreRuntimeKind = 'os' | 'file' | 'unavailable';

export interface SecretStore {
  readonly kind: SecretStoreRuntimeKind;
  checkAvailability(): Promise<boolean>;
  get(): Promise<string | null>;
  set(secret: string): Promise<void>;
  delete(): Promise<boolean>;
}

export interface BunSecretsApi {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}

export interface CredentialSecretStores {
  file: SecretStore;
  os: SecretStore;
}

export class SecretStoreUnavailableError extends Error {
  constructor(message = 'Secure local credential storage is unavailable.') {
    super(message);
    this.name = 'SecretStoreUnavailableError';
  }
}

export function detectBunSecrets(): BunSecretsApi | null {
  const candidate = (Bun as unknown as { secrets?: BunSecretsApi }).secrets;
  if (
    !candidate ||
    typeof candidate.get !== 'function' ||
    typeof candidate.set !== 'function' ||
    typeof candidate.delete !== 'function'
  ) {
    return null;
  }
  return candidate;
}

/**
 * Bun's macOS credential implementation delegates to the Security framework. Some non-interactive
 * command surfaces return only a prompt glyph instead of a credential or a useful error. Treat
 * that output as unavailable rather than accepting it as an API key.
 */
export function parseMacOsSecuritySecretOutput(output: string | null): string | null {
  if (output === null) return null;
  const value = output.trim();
  if (!value || /^[∙•·]+$/u.test(value)) {
    throw new SecretStoreUnavailableError();
  }
  return value;
}

export class OsSecretStore implements SecretStore {
  readonly kind = 'os' as const;

  constructor(private readonly api: BunSecretsApi) {}

  async checkAvailability(): Promise<boolean> {
    try {
      const value = await this.api.get({ service, name });
      if (value !== null) parseMacOsSecuritySecretOutput(value);
      return true;
    } catch {
      return false;
    }
  }

  async get(): Promise<string | null> {
    return parseMacOsSecuritySecretOutput(await this.api.get({ service, name }));
  }

  set(secret: string): Promise<void> {
    return this.api.set({ service, name, value: secret });
  }

  delete(): Promise<boolean> {
    return this.api.delete({ service, name });
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SecretStoreUnavailableError('Local secret directory is not a regular directory.');
  }
  if ((info.mode & 0o077) !== 0) {
    throw new SecretStoreUnavailableError('Local secret directory permissions are not private.');
  }
}

async function assertPrivateFile(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SecretStoreUnavailableError('Local secret is not a regular file.');
  }
  if ((info.mode & 0o077) !== 0) {
    throw new SecretStoreUnavailableError('Local secret file permissions are not private.');
  }
}

async function pathDetails(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export type PermissionFileSecretStoreCheckpoint =
  | 'directory-created'
  | 'parent-directory-synced'
  | 'temporary-opened'
  | 'temporary-written'
  | 'temporary-synced'
  | 'target-renamed'
  | 'directory-synced'
  | 'target-deleted'
  | 'delete-directory-synced';

export interface PermissionFileSecretStoreOptions {
  checkpoint?: (checkpoint: PermissionFileSecretStoreCheckpoint) => void | Promise<void>;
}

export class PermissionFileSecretStore implements SecretStore {
  readonly kind = 'file' as const;
  private readonly filePath: string;

  constructor(
    private readonly directory: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly options: PermissionFileSecretStoreOptions = {}
  ) {
    this.filePath = join(directory, name);
  }

  private async ensureDirectory(): Promise<void> {
    if (this.platform === 'win32') {
      throw new SecretStoreUnavailableError(
        'Permission-file fallback is unavailable on Windows without operating-system credentials.'
      );
    }

    const existing = await pathDetails(this.directory);
    if (existing) {
      await assertPrivateDirectory(this.directory);
      return;
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await assertPrivateDirectory(this.directory);
    await this.options.checkpoint?.('directory-created');
    await syncDirectory(dirname(this.directory));
    await this.options.checkpoint?.('parent-directory-synced');
  }

  async checkAvailability(): Promise<boolean> {
    try {
      await this.ensureDirectory();
      return true;
    } catch {
      return false;
    }
  }

  async get(): Promise<string | null> {
    if (this.platform === 'win32') {
      throw new SecretStoreUnavailableError(
        'Permission-file fallback is unavailable on Windows without operating-system credentials.'
      );
    }
    const directory = await pathDetails(this.directory);
    if (!directory) return null;
    await assertPrivateDirectory(this.directory);
    if (!(await pathDetails(this.filePath))) return null;
    await assertPrivateFile(this.filePath);
    const value = await Bun.file(this.filePath).text();
    return value || null;
  }

  async set(secret: string): Promise<void> {
    if (!secret) throw new Error('API key cannot be empty.');
    await this.ensureDirectory();
    if (await Bun.file(this.filePath).exists()) await assertPrivateFile(this.filePath);

    const temporaryPath = join(this.directory, `.${name}.${Bun.randomUUIDv7()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600
      );
      await this.options.checkpoint?.('temporary-opened');
      await handle.writeFile(secret, 'utf8');
      await handle.chmod(0o600);
      await this.options.checkpoint?.('temporary-written');
      await handle.sync();
      await this.options.checkpoint?.('temporary-synced');
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
      await this.options.checkpoint?.('target-renamed');
      await assertPrivateFile(this.filePath);
      await syncDirectory(this.directory);
      await this.options.checkpoint?.('directory-synced');
    } finally {
      await handle?.close();
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async delete(): Promise<boolean> {
    if (this.platform === 'win32') {
      throw new SecretStoreUnavailableError(
        'Permission-file fallback is unavailable on Windows without operating-system credentials.'
      );
    }
    const directory = await pathDetails(this.directory);
    if (!directory) return false;
    await assertPrivateDirectory(this.directory);
    if (!(await pathDetails(this.filePath))) return false;
    await assertPrivateFile(this.filePath);
    await unlink(this.filePath);
    await this.options.checkpoint?.('target-deleted');
    await syncDirectory(this.directory);
    await this.options.checkpoint?.('delete-directory-synced');
    return true;
  }
}

export class UnavailableSecretStore implements SecretStore {
  readonly kind = 'unavailable' as const;

  checkAvailability(): Promise<boolean> {
    return Promise.resolve(false);
  }

  get(): Promise<string | null> {
    return Promise.reject(new SecretStoreUnavailableError());
  }

  set(): Promise<void> {
    return Promise.reject(new SecretStoreUnavailableError());
  }

  delete(): Promise<boolean> {
    return Promise.reject(new SecretStoreUnavailableError());
  }
}

export interface CreateSecretStoreOptions {
  paths: Pick<AppPaths, 'secrets'>;
  platform?: NodeJS.Platform;
  bunSecrets?: BunSecretsApi | null;
}

export function createCredentialSecretStores(
  options: CreateSecretStoreOptions
): CredentialSecretStores {
  const platform = options.platform ?? process.platform;
  const bunSecrets = options.bunSecrets === undefined ? detectBunSecrets() : options.bunSecrets;
  return {
    file: new PermissionFileSecretStore(options.paths.secrets, platform),
    os: bunSecrets ? new OsSecretStore(bunSecrets) : new UnavailableSecretStore()
  };
}

export async function createPreferredSecretStore(
  options: CreateSecretStoreOptions
): Promise<SecretStore> {
  return createCredentialSecretStores(options).file;
}

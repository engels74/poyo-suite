import { afterEach, describe, expect, test } from 'bun:test';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ApiKeyManager,
  CredentialBackendError,
  EnvironmentKeyActiveError
} from '../../../src/lib/server/settings/api-key-manager';
import {
  CredentialStateError,
  CredentialStateRepository,
  type CredentialTransitionPhase
} from '../../../src/lib/server/settings/credential-state';
import { SecretMetadataRepository } from '../../../src/lib/server/settings/secret-metadata-repository';
import {
  PermissionFileSecretStore,
  type SecretStore
} from '../../../src/lib/server/settings/secret-store';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { MaintenanceGate } from '../../../src/lib/server/platform/maintenance-gate';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

class MemorySecretStore implements SecretStore {
  getCalls = 0;
  setCalls = 0;
  deleteCalls = 0;
  unavailable = false;
  failDelete = false;
  corruptWrites = false;
  setBarrier: Promise<void> | null = null;
  getBarrier: Promise<void> | null = null;
  failGetCalls = new Set<number>();
  afterGet: ((value: string | null, call: number) => void) | null = null;

  constructor(
    readonly kind: 'file' | 'os',
    public value: string | null = null
  ) {}

  checkAvailability(): Promise<boolean> {
    return Promise.resolve(!this.unavailable);
  }

  async get(): Promise<string | null> {
    this.getCalls += 1;
    if (this.unavailable) throw new Error('store unavailable');
    if (this.failGetCalls.has(this.getCalls)) throw new Error('injected read failure');
    await this.getBarrier;
    const value = this.value;
    this.afterGet?.(value, this.getCalls);
    return value;
  }

  async set(secret: string): Promise<void> {
    this.setCalls += 1;
    if (this.unavailable) throw new Error('store unavailable');
    await this.setBarrier;
    this.value = this.corruptWrites ? 'corrupted-destination-value' : secret;
  }

  delete(): Promise<boolean> {
    this.deleteCalls += 1;
    if (this.failDelete) return Promise.reject(new Error('delete unavailable'));
    const existed = this.value !== null;
    this.value = null;
    return Promise.resolve(existed);
  }
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup<
  FileStore extends SecretStore = MemorySecretStore,
  OsStore extends SecretStore = MemorySecretStore
>(
  options: {
    environment?: Record<string, string | undefined>;
    file?: FileStore;
    os?: OsStore;
    gate?: MaintenanceGate;
  } = {}
) {
  const temporary = await createTemporaryDirectory('poyo-credential-transition-');
  cleanups.push(temporary.cleanup);
  const path = join(temporary.path, 'studio.sqlite');
  const database = await openDatabase(path);
  cleanups.push(() => database.close());
  const settings = new SettingsRepository(database);
  const file = (options.file ?? new MemorySecretStore('file')) as FileStore;
  const os = (options.os ?? new MemorySecretStore('os')) as OsStore;
  const manager = new ApiKeyManager({
    environment: options.environment ?? {},
    secretStores: { file, os },
    metadataRepository: new SecretMetadataRepository(database),
    settingsRepository: settings,
    ...(options.gate ? { mutationGate: options.gate } : {}),
    now: () => new Date('2026-07-17T10:00:00.000Z')
  });
  return {
    database,
    file,
    manager,
    os,
    path,
    settings,
    state: new CredentialStateRepository(settings),
    rebuild: () =>
      new ApiKeyManager({
        environment: options.environment ?? {},
        secretStores: { file, os },
        metadataRepository: new SecretMetadataRepository(database),
        settingsRepository: settings,
        ...(options.gate ? { mutationGate: options.gate } : {}),
        now: () => new Date('2026-07-17T10:00:00.000Z')
      })
  };
}

function totalChanges(database: Awaited<ReturnType<typeof openDatabase>>): number {
  return database.query<{ count: number }, []>('SELECT total_changes() count').get()?.count ?? 0;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

describe('explicit credential backend authority', () => {
  test('defaults durably to file and never probes a stale unselected OS value', async () => {
    const fixture = await setup({ os: new MemorySecretStore('os', 'stale-os-value') });
    await fixture.manager.initialize();
    const status = await fixture.manager.status();

    expect(status).toMatchObject({
      selectedBackend: 'file',
      storeKind: 'file',
      status: 'missing',
      backendAvailability: { file: 'available', os: 'unchecked' }
    });
    expect(fixture.os.getCalls).toBe(0);
    expect(fixture.state.get()).toEqual({ selectedBackend: 'file', transition: null });
  });

  test('fails closed on corrupt durable backend authority instead of reselecting by availability', async () => {
    const fixture = await setup({ os: new MemorySecretStore('os', 'stale-os-value') });
    fixture.settings.set('local-access-storage', {
      selectedBackend: 'unknown',
      transition: null
    });

    await expect(fixture.manager.initialize()).rejects.toBeInstanceOf(CredentialStateError);
    expect(fixture.os.getCalls).toBe(0);
    expect(fixture.file.getCalls).toBe(0);
  });

  test('rejects an unknown credential-state version before store calls or further SQLite writes', async () => {
    const fixture = await setup();
    fixture.settings.set('local-access-storage', { selectedBackend: 'file', transition: null }, 2);
    const before = fixture.settings.get<unknown>('local-access-storage');
    const changes = totalChanges(fixture.database);

    await expect(fixture.manager.initialize()).rejects.toBeInstanceOf(CredentialStateError);

    expect(fixture.file.getCalls + fixture.file.setCalls + fixture.file.deleteCalls).toBe(0);
    expect(fixture.os.getCalls + fixture.os.setCalls + fixture.os.deleteCalls).toBe(0);
    expect(fixture.settings.get<unknown>('local-access-storage')).toEqual(before);
    expect(totalChanges(fixture.database)).toBe(changes);
  });

  test('rejects unexpected replacement authority fields before store calls', async () => {
    const fixture = await setup();
    fixture.settings.set('local-access-storage', {
      selectedBackend: 'file',
      transition: {
        id: 'replace-approved-without-proof',
        sourceBackend: 'file',
        targetBackend: 'os',
        phase: 'intent',
        targetOwnership: 'replace-approved',
        unexpectedProof: '0'.repeat(64)
      }
    });
    const before = fixture.settings.get<unknown>('local-access-storage');
    const changes = totalChanges(fixture.database);

    await expect(fixture.manager.initialize()).rejects.toBeInstanceOf(CredentialStateError);

    expect(fixture.file.getCalls + fixture.file.setCalls + fixture.file.deleteCalls).toBe(0);
    expect(fixture.os.getCalls + fixture.os.setCalls + fixture.os.deleteCalls).toBe(0);
    expect(fixture.settings.get<unknown>('local-access-storage')).toEqual(before);
    expect(totalChanges(fixture.database)).toBe(changes);
  });

  test('moves file to OS and back only after destination readback, then deletes the source', async () => {
    const key = 'sk-test_move_between_backends_123456';
    const fixture = await setup({ file: new MemorySecretStore('file', key) });
    await fixture.manager.initialize();

    expect(await fixture.manager.switchBackend({ backend: 'os' })).toMatchObject({
      selectedBackend: 'os',
      source: 'local',
      status: 'configured'
    });
    expect(fixture.file.value).toBeNull();
    expect(fixture.os.value).toBe(key);
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'os',
      transition: { phase: 'complete' }
    });

    await fixture.manager.switchBackend({ backend: 'file' });
    expect(fixture.file.value).toBe(key);
    expect(fixture.os.value).toBeNull();
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'file',
      transition: { phase: 'complete' }
    });
  });

  test('requires explicit approval before replacing a different destination value', async () => {
    const source = 'sk-test_authoritative_source_123456';
    const stale = 'sk-test_stale_destination_123456';
    const fixture = await setup({
      file: new MemorySecretStore('file', source),
      os: new MemorySecretStore('os', stale)
    });
    await fixture.manager.initialize();

    await expect(fixture.manager.switchBackend({ backend: 'os' })).rejects.toMatchObject({
      code: 'replacement_required'
    });
    expect(fixture.file.value).toBe(source);
    expect(fixture.os.value).toBe(stale);

    await fixture.manager.switchBackend({ backend: 'os', replaceExisting: true });
    expect(fixture.file.value).toBeNull();
    expect(fixture.os.value).toBe(source);
  });

  test('boots with a safe conflict and abandons stale replacement intent without mutating either copy', async () => {
    const source = 'sk-test_replace_restart_source_123456';
    const approvedTarget = 'sk-test_replace_restart_approved_123456';
    const independentlyChanged = 'sk-test_replace_restart_changed_123456';
    const fixture = await setup({
      file: new MemorySecretStore('file', source),
      os: new MemorySecretStore('os', approvedTarget)
    });
    fixture.state.save({
      selectedBackend: 'file',
      transition: {
        id: 'replace-approved-restart',
        sourceBackend: 'file',
        targetBackend: 'os',
        phase: 'intent',
        targetOwnership: 'replace-approved'
      }
    });
    fixture.os.value = independentlyChanged;
    const setCalls = fixture.os.setCalls;
    const deleteCalls = fixture.os.deleteCalls;

    const restarted = fixture.rebuild();
    await restarted.initialize();
    expect(await restarted.status()).toMatchObject({
      selectedBackend: 'file',
      transition: {
        phase: 'intent',
        conflict: 'replacement-authorization-required'
      },
      localMutationAvailable: false
    });
    expect(fixture.file.value).toBe(source);
    expect(fixture.os.value).toBe(independentlyChanged);
    expect(fixture.os.setCalls).toBe(setCalls);
    expect(fixture.os.deleteCalls).toBe(deleteCalls);
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'file',
      transition: { phase: 'intent', targetOwnership: 'replace-approved' }
    });

    expect(await restarted.resolveTransitionConflict('abandon')).toMatchObject({
      selectedBackend: 'file',
      transition: null
    });
    expect(fixture.file.value).toBe(source);
    expect(fixture.os.value).toBe(independentlyChanged);
    expect(fixture.os.setCalls).toBe(setCalls);
    expect(fixture.os.deleteCalls).toBe(deleteCalls);
    expect(fixture.state.get()).toEqual({ selectedBackend: 'file', transition: null });
  });

  test('re-authorizes a conflicted replacement only against a fresh destination observation', async () => {
    const source = 'sk-test_reauthorize_source_123456';
    const independentlyChanged = 'sk-test_reauthorize_changed_123456';
    const fixture = await setup({
      file: new MemorySecretStore('file', source),
      os: new MemorySecretStore('os', independentlyChanged)
    });
    fixture.state.save({
      selectedBackend: 'file',
      transition: {
        id: 'replace-approved-reauthorize',
        sourceBackend: 'file',
        targetBackend: 'os',
        phase: 'intent',
        targetOwnership: 'replace-approved'
      }
    });
    const restarted = fixture.rebuild();
    await restarted.initialize();

    expect(await restarted.resolveTransitionConflict('reauthorize-replacement')).toMatchObject({
      selectedBackend: 'os',
      transition: null,
      status: 'configured'
    });
    expect(fixture.file.value).toBeNull();
    expect(fixture.os.value).toBe(source);
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'os',
      transition: { phase: 'complete' }
    });
  });

  test('retains both copies when the destination changes during fresh conflict re-authorization', async () => {
    const source = 'sk-test_reauthorize_race_source_123456';
    const firstChanged = 'sk-test_reauthorize_race_first_123456';
    const changedAgain = 'sk-test_reauthorize_race_second_123456';
    const os = new MemorySecretStore('os', firstChanged);
    const fixture = await setup({ file: new MemorySecretStore('file', source), os });
    fixture.state.save({
      selectedBackend: 'file',
      transition: {
        id: 'replace-approved-reauthorize-race',
        sourceBackend: 'file',
        targetBackend: 'os',
        phase: 'intent',
        targetOwnership: 'replace-approved'
      }
    });
    const restarted = fixture.rebuild();
    await restarted.initialize();
    os.afterGet = (_value, call) => {
      if (call === 4) os.value = changedAgain;
    };

    await expect(
      restarted.resolveTransitionConflict('reauthorize-replacement')
    ).rejects.toMatchObject({ code: 'transition_conflict' });
    expect(fixture.file.value).toBe(source);
    expect(os.value).toBe(changedAgain);
    expect(os.setCalls).toBe(0);
    expect(os.deleteCalls).toBe(0);
    expect(fixture.state.get()).toEqual({ selectedBackend: 'file', transition: null });
  });

  test('reobserves a replace-approved target immediately before writing and preserves a changed value', async () => {
    const source = 'sk-test_live_replace_source_123456';
    const approvedTarget = 'sk-test_live_replace_approved_123456';
    const independentlyChanged = 'sk-test_live_replace_changed_123456';
    const os = new MemorySecretStore('os', approvedTarget);
    os.afterGet = (_value, call) => {
      if (call === 1) os.value = independentlyChanged;
    };
    const fixture = await setup({ file: new MemorySecretStore('file', source), os });
    await fixture.manager.initialize();

    await expect(
      fixture.manager.switchBackend({ backend: 'os', replaceExisting: true })
    ).rejects.toMatchObject({ code: 'transition_conflict' });

    expect(fixture.file.value).toBe(source);
    expect(os.value).toBe(independentlyChanged);
    expect(os.setCalls).toBe(0);
    expect(os.deleteCalls).toBe(0);
    expect(fixture.state.get()).toEqual({ selectedBackend: 'file', transition: null });
  });

  test('recognizes an equal preexisting duplicate without rewriting or deleting the target', async () => {
    const key = 'same-same-same';
    const os = new MemorySecretStore('os', key);
    const fixture = await setup({ file: new MemorySecretStore('file', key), os });
    await fixture.manager.initialize();

    await fixture.manager.switchBackend({ backend: 'os' });
    expect(os.setCalls).toBe(0);
    expect(os.deleteCalls).toBe(0);
    expect(os.value).toBe(key);
    expect(fixture.file.value).toBeNull();
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'os',
      transition: { targetOwnership: 'preexisting-equal', phase: 'complete' }
    });
  });

  test('requires a newly submitted key for empty-source OS opt-in and never adopts stale OS data', async () => {
    const stale = 'sk-test_stale_os_not_adopted_123456';
    const submitted = 'sk-test_new_explicit_os_value_123456';
    const fixture = await setup({ os: new MemorySecretStore('os', stale) });
    await fixture.manager.initialize();

    await expect(fixture.manager.switchBackend({ backend: 'os' })).rejects.toMatchObject({
      code: 'credential_required'
    });
    expect(fixture.state.get().selectedBackend).toBe('file');
    expect(fixture.os.value).toBe(stale);

    await fixture.manager.switchBackend({
      backend: 'os',
      secret: submitted,
      replaceExisting: true
    });
    expect(fixture.state.get().selectedBackend).toBe('os');
    expect(fixture.os.value).toBe(submitted);
  });

  test('never deletes a stale file destination without a replacement credential', async () => {
    const stale = 'sk-test_stale_file_not_deleted_123456';
    const submitted = 'sk-test_new_explicit_file_value_123456';
    const fixture = await setup({ file: new MemorySecretStore('file', stale) });
    fixture.state.save({ selectedBackend: 'os', transition: null });
    await fixture.manager.initialize();

    await expect(fixture.manager.switchBackend({ backend: 'file' })).rejects.toMatchObject({
      code: 'replacement_required'
    });
    expect(fixture.state.get()).toEqual({ selectedBackend: 'os', transition: null });
    expect(fixture.file.value).toBe(stale);
    expect(fixture.file.setCalls).toBe(0);
    expect(fixture.file.deleteCalls).toBe(0);

    await expect(
      fixture.manager.switchBackend({ backend: 'file', replaceExisting: true })
    ).rejects.toMatchObject({ code: 'credential_required' });
    expect(fixture.state.get()).toEqual({ selectedBackend: 'os', transition: null });
    expect(fixture.file.value).toBe(stale);
    expect(fixture.file.setCalls).toBe(0);
    expect(fixture.file.deleteCalls).toBe(0);

    await fixture.manager.switchBackend({
      backend: 'file',
      secret: submitted,
      replaceExisting: true
    });
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'file',
      transition: { phase: 'complete' }
    });
    expect(fixture.file.value).toBe(submitted);
    expect(fixture.file.setCalls).toBe(1);
    expect(fixture.file.deleteCalls).toBe(0);
  });

  test('selects an empty file backend only when its destination is absent', async () => {
    const fixture = await setup();
    fixture.state.save({ selectedBackend: 'os', transition: null });
    await fixture.manager.initialize();

    expect(await fixture.manager.switchBackend({ backend: 'file' })).toMatchObject({
      selectedBackend: 'file',
      status: 'missing'
    });
    expect(fixture.state.get()).toEqual({ selectedBackend: 'file', transition: null });
    expect(fixture.file.value).toBeNull();
    expect(fixture.file.setCalls).toBe(0);
    expect(fixture.file.deleteCalls).toBe(0);
  });

  test('never deletes the source when destination verification fails', async () => {
    const source = 'sk-test_verify_before_delete_123456';
    const os = new MemorySecretStore('os');
    os.corruptWrites = true;
    const fixture = await setup({ file: new MemorySecretStore('file', source), os });
    await fixture.manager.initialize();

    await expect(fixture.manager.switchBackend({ backend: 'os' })).rejects.toBeInstanceOf(
      CredentialBackendError
    );
    expect(fixture.file.value).toBe(source);
    expect(fixture.file.deleteCalls).toBe(0);
    expect(fixture.os.value).toBe('corrupted-destination-value');
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'file',
      transition: { phase: 'rollback-cleanup-pending' }
    });
  });

  test('retains source authority when a permission-file target is not durably published', async () => {
    const temporary = await createTemporaryDirectory('poyo-credential-target-fsync-');
    cleanups.push(temporary.cleanup);
    const source = new MemorySecretStore('os', 'sk-test_target_fsync_source_123456');
    const target = new PermissionFileSecretStore(join(temporary.path, 'os-target'), 'linux', {
      checkpoint: (checkpoint) => {
        if (checkpoint === 'parent-directory-synced') {
          throw new Error('injected target parent directory fsync');
        }
      }
    });
    const fixture = await setup({ file: target, os: source });
    fixture.state.save({ selectedBackend: 'os', transition: null });
    await fixture.manager.initialize();

    await expect(fixture.manager.switchBackend({ backend: 'file' })).rejects.toThrow(
      'requested credential backend is unavailable'
    );
    expect(source.value).toBe('sk-test_target_fsync_source_123456');
    expect(source.deleteCalls).toBe(0);
    expect(await target.get()).toBeNull();
    expect(fixture.state.get()).toEqual({ selectedBackend: 'os', transition: null });
  });

  test('does not record completion before permission-file source deletion is durable', async () => {
    const temporary = await createTemporaryDirectory('poyo-credential-delete-fsync-');
    cleanups.push(temporary.cleanup);
    const directory = join(temporary.path, 'file-source');
    const key = 'sk-test_delete_fsync_source_123456';
    await new PermissionFileSecretStore(directory, 'linux').set(key);
    const source = new PermissionFileSecretStore(directory, 'linux', {
      checkpoint: (checkpoint) => {
        if (checkpoint === 'target-deleted') throw new Error('injected source delete fsync');
      }
    });
    const target = new MemorySecretStore('os');
    const fixture = await setup({ file: source, os: target });
    await fixture.manager.initialize();

    const status = await fixture.manager.switchBackend({ backend: 'os' });
    expect(status).toMatchObject({
      selectedBackend: 'os',
      transition: { phase: 'target-authoritative-cleanup-source' }
    });
    expect(target.value).toBe(key);
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'os',
      transition: { phase: 'target-authoritative-cleanup-source' }
    });

    const restarted = fixture.rebuild();
    const sourceDeleteCalls = source instanceof MemorySecretStore ? source.deleteCalls : 0;
    await restarted.initialize();
    expect(await restarted.status()).toMatchObject({
      transition: {
        phase: 'target-authoritative-cleanup-source',
        conflict: 'authoritative-cleanup-required',
        actions: expect.arrayContaining(['retry-cleanup'])
      }
    });
    if (source instanceof MemorySecretStore) expect(source.deleteCalls).toBe(sourceDeleteCalls);
    await restarted.resolveTransitionConflict('retry-cleanup');
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'os',
      transition: { phase: 'complete' }
    });
    expect(target.value).toBe(key);
  });

  test('persists and resumes rollback cleanup when transition-owned target deletion fails', async () => {
    const source = 'sk-test_rollback_cleanup_resume_123456';
    const os = new MemorySecretStore('os');
    os.failGetCalls.add(2);
    os.failDelete = true;
    const fixture = await setup({ file: new MemorySecretStore('file', source), os });
    await fixture.manager.initialize();

    await expect(fixture.manager.switchBackend({ backend: 'os' })).rejects.toBeDefined();
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'file',
      transition: { phase: 'rollback-cleanup-pending', targetOwnership: 'absent' }
    });
    expect(fixture.file.value).toBe(source);

    os.failDelete = false;
    const restarted = fixture.rebuild();
    const deleteCalls = os.deleteCalls;
    await restarted.initialize();
    expect(os.deleteCalls).toBe(deleteCalls);
    expect(await restarted.status()).toMatchObject({
      transition: {
        conflict: 'rollback-cleanup-required',
        actions: expect.arrayContaining(['retry-cleanup'])
      }
    });
    await restarted.resolveTransitionConflict('retry-cleanup');
    expect(fixture.state.get()).toEqual({ selectedBackend: 'file', transition: null });
    expect(fixture.os.value).toBeNull();
    expect(fixture.file.value).toBe(source);
  });

  test('fails safely when an explicitly requested OS backend is unsupported', async () => {
    const os = new MemorySecretStore('os');
    os.unavailable = true;
    const fixture = await setup({
      file: new MemorySecretStore('file', 'sk-test_source_123456'),
      os
    });
    await fixture.manager.initialize();

    await expect(fixture.manager.switchBackend({ backend: 'os' })).rejects.toMatchObject({
      code: 'backend_unavailable'
    });
    expect(fixture.state.get()).toEqual({ selectedBackend: 'file', transition: null });
    expect(fixture.file.value).toBe('sk-test_source_123456');
    expect(os.setCalls).toBe(0);
  });

  test('commits target authority before retryable source cleanup and never reverts it', async () => {
    const key = 'sk-test_cleanup_resume_123456';
    const file = new MemorySecretStore('file', key);
    file.failDelete = true;
    const fixture = await setup({ file });
    await fixture.manager.initialize();

    const status = await fixture.manager.switchBackend({ backend: 'os' });
    expect(status.selectedBackend).toBe('os');
    expect(status.transition?.phase).toBe('target-authoritative-cleanup-source');
    expect(file.value).toBe(key);
    expect(fixture.os.value).toBe(key);

    file.failDelete = false;
    const restarted = fixture.rebuild();
    const deleteCalls = file.deleteCalls;
    await restarted.initialize();
    expect(file.deleteCalls).toBe(deleteCalls);
    expect(await restarted.status()).toMatchObject({
      selectedBackend: 'os',
      transition: {
        conflict: 'authoritative-cleanup-required',
        actions: expect.arrayContaining(['retry-cleanup'])
      }
    });
    await restarted.resolveTransitionConflict('retry-cleanup');
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'os',
      transition: { phase: 'complete' }
    });
    expect(file.value).toBeNull();
    expect(fixture.os.value).toBe(key);
  });

  test('recovers every forward crash phase and a kill after target write from durable intent', async () => {
    const phases: CredentialTransitionPhase[] = [
      'intent',
      'target-written',
      'target-verified',
      'target-authoritative-cleanup-source'
    ];

    for (const phase of phases) {
      const key = `sk-test_restart_${phase}_123456`;
      const file = new MemorySecretStore('file', key);
      const os = new MemorySecretStore('os', phase === 'intent' ? key : key);
      const fixture = await setup({ file, os });
      fixture.state.save({
        selectedBackend: phase === 'target-authoritative-cleanup-source' ? 'os' : 'file',
        transition: {
          id: `transition-${phase}`,
          sourceBackend: 'file',
          targetBackend: 'os',
          phase,
          targetOwnership: 'absent'
        }
      });

      const restarted = fixture.rebuild();
      const sourceDeleteCalls = file.deleteCalls;
      const targetSetCalls = os.setCalls;
      await restarted.initialize();
      expect(file.deleteCalls).toBe(sourceDeleteCalls);
      expect(os.setCalls).toBe(targetSetCalls);
      expect(await restarted.status()).toMatchObject({
        transition: {
          actions: expect.arrayContaining([
            phase === 'target-authoritative-cleanup-source' ? 'retry-cleanup' : 'resume-transition'
          ])
        }
      });
      await restarted.resolveTransitionConflict(
        phase === 'target-authoritative-cleanup-source' ? 'retry-cleanup' : 'resume-transition'
      );
      expect(fixture.state.get()).toMatchObject({
        selectedBackend: 'os',
        transition: { phase: 'complete' }
      });
      expect(file.value).toBeNull();
      expect(os.value).toBe(key);
    }
  });

  test('retains a source-less submitted target after restart when ownership cannot be proven', async () => {
    const submitted = 'sk-test_submitted_before_crash_123456';
    const fixture = await setup({ os: new MemorySecretStore('os', submitted) });
    fixture.state.save({
      selectedBackend: 'file',
      transition: {
        id: 'submitted-target-write-crash',
        sourceBackend: 'file',
        targetBackend: 'os',
        phase: 'intent',
        targetOwnership: 'absent'
      }
    });

    const restarted = fixture.rebuild();
    const targetSetCalls = fixture.os.setCalls;
    const targetDeleteCalls = fixture.os.deleteCalls;
    await restarted.initialize();
    expect(await restarted.status()).toMatchObject({
      selectedBackend: 'file',
      transition: {
        phase: 'intent',
        conflict: 'pre-authority-ownership-unverified',
        actions: ['abandon']
      },
      localMutationAvailable: false
    });
    expect(fixture.os.setCalls).toBe(targetSetCalls);
    expect(fixture.os.deleteCalls).toBe(targetDeleteCalls);
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'file',
      transition: { phase: 'intent' }
    });
    expect(fixture.file.value).toBeNull();
    expect(fixture.os.value).toBe(submitted);
    await restarted.resolveTransitionConflict('abandon');
    expect(fixture.file.value).toBeNull();
    expect(fixture.os.value).toBe(submitted);
  });

  test('recovers rollback cleanup without adopting its target and treats complete as idempotent', async () => {
    const key = 'sk-test_rollback_recovery_123456';
    const fixture = await setup({
      file: new MemorySecretStore('file', key),
      os: new MemorySecretStore('os', key)
    });
    fixture.state.save({
      selectedBackend: 'file',
      transition: {
        id: 'rollback-transition',
        sourceBackend: 'file',
        targetBackend: 'os',
        phase: 'rollback-cleanup-pending',
        targetOwnership: 'absent'
      }
    });

    const restarted = fixture.rebuild();
    const deleteCalls = fixture.os.deleteCalls;
    await restarted.initialize();
    expect(fixture.os.deleteCalls).toBe(deleteCalls);
    await restarted.resolveTransitionConflict('retry-cleanup');
    expect(fixture.state.get()).toEqual({ selectedBackend: 'file', transition: null });
    expect(fixture.file.value).toBe(key);
    expect(fixture.os.value).toBeNull();

    fixture.os.value = key;
    fixture.file.value = null;
    fixture.state.save({
      selectedBackend: 'os',
      transition: {
        id: 'complete-transition',
        sourceBackend: 'file',
        targetBackend: 'os',
        phase: 'complete',
        targetOwnership: 'absent'
      }
    });
    await fixture.rebuild().initialize();
    expect(fixture.os.value).toBe(key);
    expect(fixture.state.get().transition?.phase).toBe('complete');
  });

  test('retains a changed rollback target and surfaces a transition conflict after restart', async () => {
    const source = 'sk-test_rollback_source_123456';
    const changed = 'sk-test_changed_target_123456';
    const fixture = await setup({
      file: new MemorySecretStore('file', source),
      os: new MemorySecretStore('os', changed)
    });
    fixture.state.save({
      selectedBackend: 'file',
      transition: {
        id: 'changed-rollback-target',
        sourceBackend: 'file',
        targetBackend: 'os',
        phase: 'rollback-cleanup-pending',
        targetOwnership: 'absent'
      }
    });

    const restarted = fixture.rebuild();
    const deleteCalls = fixture.os.deleteCalls;
    await restarted.initialize();
    expect(await restarted.status()).toMatchObject({
      selectedBackend: 'file',
      transition: {
        phase: 'rollback-cleanup-pending',
        conflict: 'rollback-ownership-unverified',
        actions: ['abandon']
      },
      localMutationAvailable: false
    });
    expect(fixture.os.value).toBe(changed);
    expect(fixture.os.deleteCalls).toBe(deleteCalls);
    expect(fixture.state.get()).toMatchObject({
      selectedBackend: 'file',
      transition: { phase: 'rollback-cleanup-pending' }
    });
    await restarted.resolveTransitionConflict('abandon');
    expect(fixture.file.value).toBe(source);
    expect(fixture.os.value).toBe(changed);
    expect(fixture.os.deleteCalls).toBe(deleteCalls);
  });

  test('acknowledges and repairs target-authoritative cleanup without changing authority implicitly', async () => {
    const retainedSource = 'sk-test_retained_authoritative_source_123456';
    const authoritativeTarget = 'sk-test_authoritative_target_123456';
    const fixture = await setup({
      file: new MemorySecretStore('file', retainedSource),
      os: new MemorySecretStore('os', authoritativeTarget)
    });
    fixture.state.save({
      selectedBackend: 'os',
      transition: {
        id: 'authoritative-source-retained',
        sourceBackend: 'file',
        targetBackend: 'os',
        phase: 'target-authoritative-cleanup-source',
        targetOwnership: 'absent'
      }
    });

    const restarted = fixture.rebuild();
    const sourceDeleteCalls = fixture.file.deleteCalls;
    const targetSetCalls = fixture.os.setCalls;
    await restarted.initialize();
    expect(await restarted.status()).toMatchObject({
      selectedBackend: 'os',
      status: 'configured',
      transition: {
        conflict: 'authoritative-source-retained',
        actions: expect.arrayContaining(['acknowledge-retained-source', 'retry-cleanup'])
      },
      localMutationAvailable: false
    });
    expect(fixture.file.deleteCalls).toBe(sourceDeleteCalls);
    expect(fixture.os.setCalls).toBe(targetSetCalls);

    expect(await restarted.resolveTransitionConflict('acknowledge-retained-source')).toMatchObject({
      selectedBackend: 'os',
      transition: {
        phase: 'target-authoritative-source-retained',
        conflict: 'authoritative-source-retained',
        actions: ['retry-cleanup']
      }
    });
    expect(fixture.file.value).toBe(retainedSource);
    expect(fixture.os.value).toBe(authoritativeTarget);
    expect(fixture.file.deleteCalls).toBe(sourceDeleteCalls);
    expect(fixture.os.setCalls).toBe(targetSetCalls);

    fixture.file.value = authoritativeTarget;
    expect(await restarted.resolveTransitionConflict('retry-cleanup')).toMatchObject({
      selectedBackend: 'os',
      transition: null,
      status: 'configured'
    });
    expect(fixture.file.value).toBeNull();
    expect(fixture.os.value).toBe(authoritativeTarget);
  });

  test('environment authority prevents all local mutation without probing either backend', async () => {
    const environmentKey = 'sk-test_environment_authority_123456';
    const fixture = await setup({ environment: { POYO_API_KEY: environmentKey } });
    await fixture.manager.initialize();

    expect(await fixture.manager.resolve()).toMatchObject({
      key: environmentKey,
      status: {
        source: 'environment',
        environmentManaged: true,
        localMutationAvailable: false,
        selectedBackend: 'file'
      }
    });
    expect(fixture.file.getCalls).toBe(0);
    expect(fixture.os.getCalls).toBe(0);
    await expect(fixture.manager.setLocal('sk-test_other_123456')).rejects.toBeInstanceOf(
      EnvironmentKeyActiveError
    );
    await expect(fixture.manager.removeLocal()).rejects.toBeInstanceOf(EnvironmentKeyActiveError);
    await expect(
      fixture.manager.switchBackend({ backend: 'os', secret: 'test-test-test' })
    ).rejects.toBeInstanceOf(EnvironmentKeyActiveError);
  });

  test('serializes resolution behind a backend switch and performs zero Poyo requests', async () => {
    const key = 'sk-test_concurrent_switch_123456';
    const fixture = await setup({ file: new MemorySecretStore('file', key) });
    await fixture.manager.initialize();
    let releaseSet!: () => void;
    fixture.os.setBarrier = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });

    const switching = fixture.manager.switchBackend({ backend: 'os' });
    await Bun.sleep(0);
    const resolving = fixture.manager.resolve();
    let resolved = false;
    void resolving.then(() => {
      resolved = true;
    });
    await Bun.sleep(5);
    expect(resolved).toBe(false);
    releaseSet();

    expect((await switching).selectedBackend).toBe('os');
    expect(await resolving).toMatchObject({ key, status: { selectedBackend: 'os' } });
    expect(fixture.file.value).toBeNull();
    expect(fixture.os.value).toBe(key);
    const poyoRequests = 0;
    expect(poyoRequests).toBe(0);
  });

  test('holds a writer permit until credential status persistence has completed', async () => {
    const gate = new MaintenanceGate();
    const file = new MemorySecretStore('file');
    let releaseGet!: () => void;
    file.getBarrier = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const fixture = await setup({ file, gate });
    await fixture.manager.initialize();

    const resolving = fixture.manager.resolve();
    await Bun.sleep(0);
    expect(gate.status().activeWriters).toBe(1);
    const upgrading = gate.upgradeToExclusiveMaintenance(
      gate.acquireMaintenanceInitiator('credential-switch')
    );
    let upgraded = false;
    void upgrading.then(() => {
      upgraded = true;
    });
    await Bun.sleep(5);
    expect(upgraded).toBe(false);

    releaseGet();
    await resolving;
    const lease = await upgrading;
    expect(gate.status().activeWriters).toBe(0);
    lease.reopenBeforePublication();
  });

  test('serves read-only credential status while frozen without metadata or store mutation', async () => {
    const gate = new MaintenanceGate();
    const key = 'sk-test_frozen_status_123456';
    const fixture = await setup({ file: new MemorySecretStore('file', key), gate });
    await fixture.manager.initialize();
    const metadataRows = () =>
      fixture.database
        .query<{ count: number }, []>('SELECT COUNT(*) count FROM secret_metadata')
        .get()?.count ?? 0;
    const beforeChanges = totalChanges(fixture.database);
    const lease = await gate.upgradeToExclusiveMaintenance(
      gate.acquireMaintenanceInitiator('freeze-status')
    );
    lease.freezeUntilRestart();

    const status = await fixture.manager.status();

    expect(status).toMatchObject({
      status: 'configured',
      selectedBackend: 'file',
      localMutationAvailable: false,
      onboardingAvailable: false
    });
    expect(metadataRows()).toBe(0);
    expect(totalChanges(fixture.database)).toBe(beforeChanges);
    expect(fixture.file.setCalls).toBe(0);
    expect(fixture.file.deleteCalls).toBe(0);
    expect(fixture.os.getCalls).toBe(0);
  });

  test('serves a cold frozen file status without creating the credential directory', async () => {
    const temporary = await createTemporaryDirectory('poyo-credential-frozen-cold-');
    cleanups.push(temporary.cleanup);
    const directory = join(temporary.path, 'absent-secrets');
    const gate = new MaintenanceGate();
    const fixture = await setup({
      file: new PermissionFileSecretStore(directory, 'linux'),
      os: new MemorySecretStore('os'),
      gate
    });
    await fixture.manager.initialize();
    const beforeChanges = totalChanges(fixture.database);
    const lease = await gate.upgradeToExclusiveMaintenance(
      gate.acquireMaintenanceInitiator('freeze-cold-status')
    );
    lease.freezeUntilRestart();

    expect(await fixture.manager.status()).toMatchObject({
      status: 'missing',
      selectedBackend: 'file',
      localMutationAvailable: false
    });
    expect(await pathExists(directory)).toBe(false);
    expect(totalChanges(fixture.database)).toBe(beforeChanges);
  });

  test('persists or exposes no raw or SHA-family credential canaries', async () => {
    const sentinel = 'sk-test_transition_database_canary_123456789';
    const replaced = 'sk-test_transition_replaced_canary_987654321';
    const fixture = await setup({
      file: new MemorySecretStore('file', sentinel),
      os: new MemorySecretStore('os', replaced)
    });
    await fixture.manager.initialize();
    const status = await fixture.manager.switchBackend({
      backend: 'os',
      replaceExisting: true
    });
    fixture.database.query('PRAGMA wal_checkpoint(TRUNCATE)').run();

    const stateJson = JSON.stringify(fixture.state.get());
    const statusJson = JSON.stringify(status);
    const bytes = new TextDecoder().decode(await Bun.file(fixture.path).arrayBuffer());
    const forbidden = [sentinel, replaced].flatMap((secret) => [
      secret,
      ...(['sha1', 'sha256', 'sha384', 'sha512'] as const).map((algorithm) =>
        new Bun.CryptoHasher(algorithm).update(secret).digest('hex')
      )
    ]);
    for (const canary of forbidden) {
      expect(`${stateJson}\n${statusJson}\n${bytes}`).not.toContain(canary);
    }
    expect(stateJson).not.toContain('poyo-api-key');
    expect(statusJson).not.toContain('poyo-api-key');

    fixture.file.value = 'different-source';
    fixture.os.value = 'different-target';
    fixture.state.save({
      selectedBackend: 'os',
      transition: {
        id: 'safe-error-transition',
        sourceBackend: 'file',
        targetBackend: 'os',
        phase: 'target-authoritative-cleanup-source',
        targetOwnership: 'absent'
      }
    });
    const restarted = fixture.rebuild();
    await restarted.initialize();
    const conflictStatus = JSON.stringify(await restarted.status());
    expect(conflictStatus).toContain('authoritative-source-retained');
    for (const secret of ['different-source', 'different-target']) {
      expect(conflictStatus).not.toContain(secret);
      for (const algorithm of ['sha1', 'sha256', 'sha384', 'sha512'] as const) {
        expect(conflictStatus).not.toContain(
          new Bun.CryptoHasher(algorithm).update(secret).digest('hex')
        );
      }
    }
    expect(conflictStatus).not.toContain('poyo-api-key');
  });
});

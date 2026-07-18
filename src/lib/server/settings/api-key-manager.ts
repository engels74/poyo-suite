import { timingSafeEqual } from 'node:crypto';
import type { MaintenanceGate } from '../platform/maintenance-gate';
import {
  CredentialStateRepository,
  type CredentialBackend,
  type CredentialState,
  type CredentialTargetOwnership,
  type CredentialTransition
} from './credential-state';
import type {
  ApiKeySource,
  ApiKeyStatus,
  SecretMetadata,
  SecretMetadataRepository,
  SecretStoreKind
} from './secret-metadata-repository';
import {
  type CredentialSecretStores,
  type SecretStore,
  UnavailableSecretStore
} from './secret-store';
import type { SettingsRepository } from './settings-repository';

export type CredentialBackendAvailability = 'available' | 'unavailable' | 'unchecked';

export interface ApiKeyStatusDto {
  source: ApiKeySource;
  status: ApiKeyStatus;
  storeKind: SecretStoreKind;
  selectedBackend: CredentialBackend;
  backendAvailability: Record<CredentialBackend, CredentialBackendAvailability>;
  transition: {
    sourceBackend: CredentialBackend;
    targetBackend: CredentialBackend;
    phase: CredentialTransition['phase'];
    conflict: CredentialConflictReason | null;
    actions: CredentialConflictAction[];
  } | null;
  onboardingAvailable: boolean;
  environmentManaged: boolean;
  localMutationAvailable: boolean;
  updatedAt: string | null;
}

export interface ResolvedApiKey {
  key: string | null;
  status: ApiKeyStatusDto;
}

export interface ApiKeyManagerOptions {
  environment: Record<string, string | undefined>;
  metadataRepository: SecretMetadataRepository;
  /** Runtime construction supplies both stores and durable settings authority. */
  secretStores?: CredentialSecretStores;
  settingsRepository?: SettingsRepository;
  mutationGate?: Pick<MaintenanceGate, 'status' | 'withWriterPermit'>;
  /** Compatibility seam for isolated store/manager unit tests. */
  secretStore?: SecretStore;
  now?: () => Date;
}

export interface SwitchCredentialBackendInput {
  backend: CredentialBackend;
  secret?: string;
  replaceExisting?: boolean;
}

export type CredentialConflictAction =
  | 'abandon'
  | 'resume-transition'
  | 'retry-cleanup'
  | 'acknowledge-retained-source'
  | 'reauthorize-replacement';

export type CredentialConflictReason =
  | 'pre-authority-recovery-required'
  | 'pre-authority-ownership-unverified'
  | 'replacement-authorization-required'
  | 'rollback-cleanup-required'
  | 'rollback-ownership-unverified'
  | 'authoritative-cleanup-required'
  | 'authoritative-target-unavailable'
  | 'authoritative-source-retained'
  | 'backend-observation-unavailable';

interface CredentialConflict {
  transitionId: string;
  reason: CredentialConflictReason;
  actions: CredentialConflictAction[];
}

export class EnvironmentKeyActiveError extends Error {
  constructor() {
    super('The environment-provided Poyo API key is authoritative and cannot be overridden.');
    this.name = 'EnvironmentKeyActiveError';
  }
}

export class CredentialBackendError extends Error {
  constructor(
    readonly code:
      | 'backend_unavailable'
      | 'replacement_required'
      | 'credential_required'
      | 'transition_busy'
      | 'transition_conflict'
      | 'transition_not_conflicted'
      | 'verification_failed',
    message: string
  ) {
    super(message);
    this.name = 'CredentialBackendError';
  }
}

interface StateAuthority {
  get(): CredentialState;
  initialize(): CredentialState;
  save(state: CredentialState): CredentialState;
}

type StatusMetadata = Omit<SecretMetadata, 'updatedAt'> & { updatedAt: string | null };

class MemoryStateAuthority implements StateAuthority {
  constructor(private state: CredentialState) {}

  get(): CredentialState {
    return structuredClone(this.state);
  }

  initialize(): CredentialState {
    return this.get();
  }

  save(state: CredentialState): CredentialState {
    this.state = structuredClone(state);
    return this.get();
  }
}

function environmentKey(environment: Record<string, string | undefined>): string | null {
  const value = environment.POYO_API_KEY?.trim();
  return value || null;
}

function secretsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validateSecret(secret: string | undefined): string | null {
  if (secret === undefined) return null;
  const value = secret.trim();
  if (!value || value.length > 4096) throw new Error('API key is empty or too large.');
  return value;
}

function transitionDto(
  transition: CredentialTransition | null,
  conflict: CredentialConflict | null
): ApiKeyStatusDto['transition'] {
  if (!transition || transition.phase === 'complete') return null;
  return {
    sourceBackend: transition.sourceBackend,
    targetBackend: transition.targetBackend,
    phase: transition.phase,
    conflict: transition.id === conflict?.transitionId ? conflict.reason : null,
    actions: transition.id === conflict?.transitionId ? [...conflict.actions] : []
  };
}

export class ApiKeyManager {
  private readonly now: () => Date;
  private readonly stores: CredentialSecretStores;
  private readonly state: StateAuthority;
  private transitionConflict: CredentialConflict | null = null;
  private queue = Promise.resolve();

  constructor(private readonly options: ApiKeyManagerOptions) {
    this.now = options.now ?? (() => new Date());
    if (options.secretStores && options.settingsRepository) {
      this.stores = options.secretStores;
      this.state = new CredentialStateRepository(options.settingsRepository);
      return;
    }
    if (!options.secretStore) {
      throw new Error('Credential stores and settings authority are required.');
    }
    const unavailable = new UnavailableSecretStore();
    this.stores = {
      file: options.secretStore.kind === 'file' ? options.secretStore : unavailable,
      os: options.secretStore.kind === 'os' ? options.secretStore : unavailable
    };
    this.state = new MemoryStateAuthority({
      selectedBackend: options.secretStore.kind === 'os' ? 'os' : 'file',
      transition: null
    });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private store(backend: CredentialBackend): SecretStore {
    return this.stores[backend];
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

  private dto(
    metadata: StatusMetadata,
    state: CredentialState,
    selectedAvailability: CredentialBackendAvailability
  ): ApiKeyStatusDto {
    const otherBackend = state.selectedBackend === 'file' ? 'os' : 'file';
    const hasConflict = Boolean(
      state.transition &&
        this.transitionConflict &&
        state.transition.id === this.transitionConflict.transitionId
    );
    return {
      source: metadata.activeSource,
      status: metadata.status,
      storeKind: metadata.storeKind,
      selectedBackend: state.selectedBackend,
      backendAvailability: {
        [state.selectedBackend]: selectedAvailability,
        [otherBackend]:
          this.store(otherBackend).kind === 'unavailable' ? 'unavailable' : 'unchecked'
      } as Record<CredentialBackend, CredentialBackendAvailability>,
      transition: transitionDto(state.transition, this.transitionConflict),
      onboardingAvailable:
        metadata.activeSource !== 'environment' &&
        metadata.status !== 'unavailable' &&
        !hasConflict &&
        this.mutationAdmissionOpen(),
      environmentManaged: metadata.activeSource === 'environment',
      localMutationAvailable:
        metadata.activeSource !== 'environment' && !hasConflict && this.mutationAdmissionOpen(),
      updatedAt: metadata.updatedAt
    };
  }

  private mutationAdmissionOpen(): boolean {
    return !this.options.mutationGate || this.options.mutationGate.status().admission === 'open';
  }

  private observedMetadata(
    source: ApiKeySource,
    status: ApiKeyStatus,
    storeKind: SecretStoreKind
  ): StatusMetadata {
    const previous = this.options.metadataRepository.get();
    return {
      activeSource: source,
      status,
      storeKind,
      lastConnectivityAt: previous?.lastConnectivityAt ?? null,
      lastConnectivityStatus: previous?.lastConnectivityStatus ?? null,
      updatedAt: previous?.updatedAt ?? null
    };
  }

  private async statusUnlocked(): Promise<ApiKeyStatusDto> {
    const state = this.state.get();
    if (environmentKey(this.options.environment)) {
      return this.dto(
        this.observedMetadata('environment', 'configured', 'environment'),
        state,
        'unchecked'
      );
    }
    if (state.transition && state.transition.phase !== 'complete') {
      await this.observeTransitionUnlocked(state.transition);
    }
    try {
      const fromStore = await this.store(state.selectedBackend).get();
      return this.dto(
        this.observedMetadata(
          fromStore ? 'local' : 'none',
          fromStore ? 'configured' : 'missing',
          state.selectedBackend
        ),
        state,
        'available'
      );
    } catch {
      return this.dto(
        this.observedMetadata('none', 'unavailable', state.selectedBackend),
        state,
        'unavailable'
      );
    }
  }

  private async resolveUnlocked(): Promise<ResolvedApiKey> {
    const state = this.state.get();
    const fromEnvironment = environmentKey(this.options.environment);
    if (fromEnvironment) {
      const metadata = this.persistStatus('environment', 'configured', 'environment');
      return { key: fromEnvironment, status: this.dto(metadata, state, 'unchecked') };
    }

    try {
      const fromStore = await this.store(state.selectedBackend).get();
      const metadata = this.persistStatus(
        fromStore ? 'local' : 'none',
        fromStore ? 'configured' : 'missing',
        state.selectedBackend
      );
      return { key: fromStore, status: this.dto(metadata, state, 'available') };
    } catch {
      const metadata = this.persistStatus('none', 'unavailable', state.selectedBackend);
      return { key: null, status: this.dto(metadata, state, 'unavailable') };
    }
  }

  private saveTransition(
    selectedBackend: CredentialBackend,
    transition: CredentialTransition
  ): CredentialState {
    return this.state.save({ selectedBackend, transition });
  }

  private clearTransition(selectedBackend: CredentialBackend): void {
    this.state.save({ selectedBackend, transition: null });
    this.transitionConflict = null;
  }

  private setTransitionConflict(
    transition: CredentialTransition,
    reason: CredentialConflictReason,
    actions: CredentialConflictAction[]
  ): void {
    this.transitionConflict = { transitionId: transition.id, reason, actions };
  }

  private async observeTransitionUnlocked(transition: CredentialTransition): Promise<void> {
    if (transition.phase === 'complete') {
      this.transitionConflict = null;
      return;
    }

    let source: string | null;
    let target: string | null;
    try {
      [source, target] = await Promise.all([
        this.store(transition.sourceBackend).get(),
        this.store(transition.targetBackend).get()
      ]);
    } catch {
      const actions: CredentialConflictAction[] =
        transition.phase === 'target-authoritative-cleanup-source' ||
        transition.phase === 'target-authoritative-source-retained'
          ? ['retry-cleanup']
          : ['abandon'];
      this.setTransitionConflict(transition, 'backend-observation-unavailable', actions);
      return;
    }

    const equal = source !== null && target !== null && secretsEqual(source, target);
    if (
      transition.phase === 'target-authoritative-cleanup-source' ||
      transition.phase === 'target-authoritative-source-retained'
    ) {
      const reason: CredentialConflictReason =
        target === null
          ? 'authoritative-target-unavailable'
          : source !== null && !equal
            ? 'authoritative-source-retained'
            : transition.phase === 'target-authoritative-source-retained' && source !== null
              ? 'authoritative-source-retained'
              : 'authoritative-cleanup-required';
      const actions: CredentialConflictAction[] = ['retry-cleanup'];
      if (transition.phase === 'target-authoritative-cleanup-source' && source !== null) {
        actions.unshift('acknowledge-retained-source');
      }
      this.setTransitionConflict(transition, reason, actions);
      return;
    }

    if (transition.phase === 'rollback-cleanup-pending') {
      this.setTransitionConflict(
        transition,
        target === null || equal ? 'rollback-cleanup-required' : 'rollback-ownership-unverified',
        target === null || equal ? ['abandon', 'retry-cleanup'] : ['abandon']
      );
      return;
    }

    if (
      transition.targetOwnership === 'replace-approved' &&
      source !== null &&
      target !== null &&
      !equal
    ) {
      this.setTransitionConflict(transition, 'replacement-authorization-required', [
        'abandon',
        'reauthorize-replacement'
      ]);
      return;
    }
    if (source === null || (target !== null && !equal)) {
      this.setTransitionConflict(transition, 'pre-authority-ownership-unverified', ['abandon']);
      return;
    }
    this.setTransitionConflict(transition, 'pre-authority-recovery-required', [
      'abandon',
      'resume-transition'
    ]);
  }

  private async verifyStored(store: SecretStore, expected: string): Promise<void> {
    const actual = await store.get();
    if (!actual || !secretsEqual(actual, expected)) {
      throw new CredentialBackendError(
        'verification_failed',
        'The destination credential could not be verified.'
      );
    }
  }

  private async rollbackPreAuthority(
    transition: CredentialTransition,
    expectedTarget: string | null
  ): Promise<void> {
    if (transition.targetOwnership === 'preexisting-equal') {
      this.clearTransition(transition.sourceBackend);
      return;
    }
    const target = this.store(transition.targetBackend);
    try {
      const current = await target.get();
      if (current === null) {
        this.clearTransition(transition.sourceBackend);
        return;
      }
      if (!expectedTarget || !secretsEqual(current, expectedTarget)) {
        throw new CredentialBackendError(
          'transition_conflict',
          'Credential storage changed during rollback; no value was deleted.'
        );
      }
      await target.delete();
      if ((await target.get()) !== null) throw new Error('destination still present');
      this.clearTransition(transition.sourceBackend);
    } catch (error) {
      this.saveTransition(transition.sourceBackend, {
        ...transition,
        phase: 'rollback-cleanup-pending'
      });
      throw error;
    }
  }

  private async finishAuthoritativeCleanup(transition: CredentialTransition): Promise<void> {
    const target = await this.store(transition.targetBackend).get();
    if (!target) {
      throw new CredentialBackendError(
        'transition_conflict',
        'The authoritative credential is unavailable; the previous backend was retained.'
      );
    }
    const sourceStore = this.store(transition.sourceBackend);
    const source = await sourceStore.get();
    if (source !== null) {
      if (!secretsEqual(source, target)) {
        throw new CredentialBackendError(
          'transition_conflict',
          'Credential backends differ; the previous backend was retained.'
        );
      }
      await sourceStore.delete();
      if ((await sourceStore.get()) !== null) {
        throw new CredentialBackendError(
          'verification_failed',
          'The previous credential backend could not be cleared safely.'
        );
      }
    }
    this.saveTransition(transition.targetBackend, { ...transition, phase: 'complete' });
  }

  private async recoverRollback(transition: CredentialTransition): Promise<void> {
    if (transition.targetOwnership === 'preexisting-equal') {
      this.clearTransition(transition.sourceBackend);
      return;
    }
    const source = await this.store(transition.sourceBackend).get();
    const targetStore = this.store(transition.targetBackend);
    const target = await targetStore.get();
    if (target === null) {
      this.clearTransition(transition.sourceBackend);
      return;
    }
    if (!source || !secretsEqual(source, target)) {
      throw new CredentialBackendError(
        'transition_conflict',
        'Credential rollback ownership could not be verified; no value was deleted.'
      );
    }
    await targetStore.delete();
    if ((await targetStore.get()) !== null) {
      throw new CredentialBackendError(
        'verification_failed',
        'Credential rollback cleanup could not be verified.'
      );
    }
    this.clearTransition(transition.sourceBackend);
  }

  private async recoverPreAuthority(transition: CredentialTransition): Promise<void> {
    const source = await this.store(transition.sourceBackend).get();
    const targetStore = this.store(transition.targetBackend);
    const target = await targetStore.get();

    if (!source) {
      if (transition.targetOwnership === 'preexisting-equal' || target === null) {
        this.clearTransition(transition.sourceBackend);
        return;
      }
      throw new CredentialBackendError(
        'transition_conflict',
        'Credential transition ownership could not be verified; no value was adopted or deleted.'
      );
    }

    if (transition.phase === 'intent') {
      if (transition.targetOwnership === 'preexisting-equal' && target === null) {
        this.clearTransition(transition.sourceBackend);
        return;
      }
      if (target === null) {
        await targetStore.set(source);
      } else if (secretsEqual(source, target)) {
        // A target write may have completed before the durable phase update.
      } else {
        throw new CredentialBackendError(
          'transition_conflict',
          'Credential storage changed after transition intent.'
        );
      }
      await this.verifyStored(targetStore, source);
      this.saveTransition(transition.sourceBackend, { ...transition, phase: 'target-written' });
    } else if (target === null) {
      this.clearTransition(transition.sourceBackend);
      return;
    } else if (!secretsEqual(source, target)) {
      throw new CredentialBackendError(
        'transition_conflict',
        'The written credential could not be matched to its authoritative source.'
      );
    }

    await this.verifyStored(targetStore, source);
    const verified = { ...transition, phase: 'target-verified' as const };
    this.saveTransition(transition.sourceBackend, verified);
    const authoritative = {
      ...verified,
      phase: 'target-authoritative-cleanup-source' as const
    };
    this.saveTransition(transition.targetBackend, authoritative);
    await this.finishAuthoritativeCleanup(authoritative);
  }

  async initialize(): Promise<void> {
    await this.serialized(async () => {
      const state = this.state.initialize();
      if (environmentKey(this.options.environment)) return;
      if (state.transition && state.transition.phase !== 'complete') {
        await this.observeTransitionUnlocked(state.transition);
      }
    });
  }

  selectedBackend(): CredentialBackend {
    return this.state.get().selectedBackend;
  }

  async resolve(): Promise<ResolvedApiKey> {
    const resolve = () => this.serialized(() => this.resolveUnlocked());
    return this.options.mutationGate
      ? this.options.mutationGate.withWriterPermit('credential.status-persistence', resolve)
      : resolve();
  }

  async status(): Promise<ApiKeyStatusDto> {
    return this.serialized(() => this.statusUnlocked());
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
    return this.serialized(async () => {
      if (environmentKey(this.options.environment)) throw new EnvironmentKeyActiveError();
      const state = this.state.get();
      if (state.transition && state.transition.phase !== 'complete') {
        throw new CredentialBackendError(
          'transition_busy',
          'Credential storage recovery must complete before changing the API key.'
        );
      }
      const value = validateSecret(secret);
      if (!value) throw new Error('API key is required.');
      const store = this.store(state.selectedBackend);
      await store.set(value);
      await this.verifyStored(store, value);
      return (await this.resolveUnlocked()).status;
    });
  }

  async removeLocal(): Promise<ApiKeyStatusDto> {
    return this.serialized(async () => {
      if (environmentKey(this.options.environment)) throw new EnvironmentKeyActiveError();
      const state = this.state.get();
      if (state.transition && state.transition.phase !== 'complete') {
        throw new CredentialBackendError(
          'transition_busy',
          'Credential storage recovery must complete before removing the API key.'
        );
      }
      try {
        await this.store(state.selectedBackend).delete();
        if ((await this.store(state.selectedBackend).get()) !== null) {
          throw new Error('credential still present');
        }
      } catch {
        return this.dto(
          this.persistStatus('none', 'unavailable', state.selectedBackend),
          state,
          'unavailable'
        );
      }
      return (await this.resolveUnlocked()).status;
    });
  }

  private async switchBackendUnlocked(
    input: SwitchCredentialBackendInput,
    requireIdle: boolean
  ): Promise<ApiKeyStatusDto> {
    if (environmentKey(this.options.environment)) throw new EnvironmentKeyActiveError();
    const currentState = this.state.get();
    if (requireIdle && currentState.transition && currentState.transition.phase !== 'complete') {
      throw new CredentialBackendError(
        'transition_busy',
        'Credential storage recovery is still in progress.'
      );
    }
    if (input.backend === currentState.selectedBackend)
      return (await this.resolveUnlocked()).status;

    const submitted = validateSecret(input.secret);
    const sourceStore = this.store(currentState.selectedBackend);
    const targetStore = this.store(input.backend);
    if (!(await targetStore.checkAvailability())) {
      throw new CredentialBackendError(
        'backend_unavailable',
        'The requested credential backend is unavailable.'
      );
    }
    let source: string | null;
    try {
      source = await sourceStore.get();
    } catch (error) {
      if (!submitted) throw error;
      source = null;
    }
    const value = source ?? submitted;
    if (!value && input.backend === 'os') {
      throw new CredentialBackendError(
        'credential_required',
        'A new API key is required before operating-system storage can be selected.'
      );
    }

    const target = await targetStore.get();
    if (!value) {
      if (target !== null) {
        if (!input.replaceExisting) {
          throw new CredentialBackendError(
            'replacement_required',
            'The destination contains an unselected value; explicit replacement approval is required.'
          );
        }
        throw new CredentialBackendError(
          'credential_required',
          'A new API key is required before the destination credential backend can be selected.'
        );
      }
      this.state.save({ selectedBackend: input.backend, transition: null });
      return (await this.resolveUnlocked()).status;
    }

    let targetOwnership: CredentialTargetOwnership;
    if (target === null) targetOwnership = 'absent';
    else if (secretsEqual(target, value)) targetOwnership = 'preexisting-equal';
    else if (input.replaceExisting) targetOwnership = 'replace-approved';
    else {
      throw new CredentialBackendError(
        'replacement_required',
        'The destination contains a different value; explicit replacement approval is required.'
      );
    }

    const transition: CredentialTransition = {
      id: crypto.randomUUID(),
      sourceBackend: currentState.selectedBackend,
      targetBackend: input.backend,
      phase: 'intent',
      targetOwnership
    };
    this.saveTransition(currentState.selectedBackend, transition);
    if (targetOwnership === 'replace-approved') {
      const reobserved = await targetStore.get();
      if (target === null || reobserved === null || !secretsEqual(reobserved, target)) {
        this.clearTransition(currentState.selectedBackend);
        throw new CredentialBackendError(
          'transition_conflict',
          'Credential storage changed after replacement approval; no value was written.'
        );
      }
    }
    try {
      if (targetOwnership !== 'preexisting-equal') await targetStore.set(value);
      const written = { ...transition, phase: 'target-written' as const };
      this.saveTransition(currentState.selectedBackend, written);
      await this.verifyStored(targetStore, value);
      const verified = { ...written, phase: 'target-verified' as const };
      this.saveTransition(currentState.selectedBackend, verified);
      const authoritative = {
        ...verified,
        phase: 'target-authoritative-cleanup-source' as const
      };
      this.saveTransition(input.backend, authoritative);
      try {
        await this.finishAuthoritativeCleanup(authoritative);
      } catch {
        // Target authority is already durable. Only an explicit action may retry source cleanup.
        await this.observeTransitionUnlocked(authoritative);
      }
      return (await this.resolveUnlocked()).status;
    } catch (error) {
      const persisted = this.state.get();
      if (persisted.selectedBackend === input.backend) throw error;
      await this.rollbackPreAuthority(persisted.transition ?? transition, value);
      throw error;
    }
  }

  async switchBackend(input: SwitchCredentialBackendInput): Promise<ApiKeyStatusDto> {
    return this.serialized(() => this.switchBackendUnlocked(input, true));
  }

  async resolveTransitionConflict(action: CredentialConflictAction): Promise<ApiKeyStatusDto> {
    return this.serialized(async () => {
      if (environmentKey(this.options.environment)) throw new EnvironmentKeyActiveError();
      const state = this.state.get();
      const transition = state.transition;
      if (!transition || transition.phase === 'complete') {
        throw new CredentialBackendError(
          'transition_not_conflicted',
          'No credential transition is awaiting an explicit decision.'
        );
      }
      await this.observeTransitionUnlocked(transition);
      if (
        transition.id !== this.transitionConflict?.transitionId ||
        !this.transitionConflict.actions.includes(action)
      ) {
        throw new CredentialBackendError(
          'transition_not_conflicted',
          'That action is not safe for the current credential transition phase.'
        );
      }

      if (action === 'abandon') {
        if (
          transition.phase === 'target-authoritative-cleanup-source' ||
          transition.phase === 'target-authoritative-source-retained'
        ) {
          throw new CredentialBackendError(
            'transition_not_conflicted',
            'Target authority cannot be abandoned after it has been committed.'
          );
        }
        this.clearTransition(transition.sourceBackend);
        return this.statusUnlocked();
      }

      if (action === 'acknowledge-retained-source') {
        if (transition.phase !== 'target-authoritative-cleanup-source') {
          throw new CredentialBackendError(
            'transition_not_conflicted',
            'No authoritative cleanup conflict is awaiting acknowledgement.'
          );
        }
        const acknowledged = {
          ...transition,
          phase: 'target-authoritative-source-retained' as const
        };
        this.saveTransition(transition.targetBackend, acknowledged);
        await this.observeTransitionUnlocked(acknowledged);
        return this.statusUnlocked();
      }

      if (action === 'resume-transition') {
        await this.recoverPreAuthority(transition);
        return this.statusUnlocked();
      }

      if (action === 'retry-cleanup') {
        if (transition.phase === 'rollback-cleanup-pending') {
          await this.recoverRollback(transition);
        } else {
          await this.finishAuthoritativeCleanup(transition);
        }
        return this.statusUnlocked();
      }

      const source = await this.store(transition.sourceBackend).get();
      const observedTarget = await this.store(transition.targetBackend).get();
      if (
        action !== 'reauthorize-replacement' ||
        transition.targetOwnership !== 'replace-approved' ||
        !['intent', 'target-written', 'target-verified'].includes(transition.phase) ||
        !source ||
        observedTarget === null
      ) {
        throw new CredentialBackendError(
          'transition_conflict',
          'Both credential copies must remain observable before replacement can be re-authorized.'
        );
      }

      this.clearTransition(transition.sourceBackend);
      return this.switchBackendUnlocked(
        { backend: transition.targetBackend, replaceExisting: true },
        false
      );
    });
  }
}

import type { SettingsRepository } from './settings-repository';

export type CredentialBackend = 'file' | 'os';

export type CredentialTransitionPhase =
  | 'intent'
  | 'target-written'
  | 'target-verified'
  | 'target-authoritative-cleanup-source'
  | 'target-authoritative-source-retained'
  | 'rollback-cleanup-pending'
  | 'complete';

export type CredentialTargetOwnership = 'absent' | 'preexisting-equal' | 'replace-approved';

export interface CredentialTransition {
  id: string;
  sourceBackend: CredentialBackend;
  targetBackend: CredentialBackend;
  phase: CredentialTransitionPhase;
  targetOwnership: CredentialTargetOwnership;
}

export interface CredentialState {
  selectedBackend: CredentialBackend;
  transition: CredentialTransition | null;
}

const settingKey = 'local-access-storage';
const settingVersion = 1;
const defaultState: CredentialState = { selectedBackend: 'file', transition: null };

export class CredentialStateError extends Error {
  constructor() {
    super('Local credential storage state could not be verified safely.');
    this.name = 'CredentialStateError';
  }
}

function isBackend(value: unknown): value is CredentialBackend {
  return value === 'file' || value === 'os';
}

function isPhase(value: unknown): value is CredentialTransitionPhase {
  return (
    value === 'intent' ||
    value === 'target-written' ||
    value === 'target-verified' ||
    value === 'target-authoritative-cleanup-source' ||
    value === 'target-authoritative-source-retained' ||
    value === 'rollback-cleanup-pending' ||
    value === 'complete'
  );
}

function isOwnership(value: unknown): value is CredentialTargetOwnership {
  return value === 'absent' || value === 'preexisting-equal' || value === 'replace-approved';
}

function parseState(value: unknown): CredentialState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CredentialStateError();
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).toSorted().join(',') !== 'selectedBackend,transition') {
    throw new CredentialStateError();
  }
  if (!isBackend(candidate.selectedBackend)) throw new CredentialStateError();
  if (candidate.transition === null) {
    return { selectedBackend: candidate.selectedBackend, transition: null };
  }
  if (!candidate.transition || typeof candidate.transition !== 'object') {
    throw new CredentialStateError();
  }
  const transition = candidate.transition as Record<string, unknown>;
  if (
    Object.keys(transition).toSorted().join(',') !==
      'id,phase,sourceBackend,targetBackend,targetOwnership' ||
    typeof transition.id !== 'string' ||
    transition.id.length < 1 ||
    transition.id.length > 128 ||
    !isBackend(transition.sourceBackend) ||
    !isBackend(transition.targetBackend) ||
    transition.sourceBackend === transition.targetBackend ||
    !isPhase(transition.phase) ||
    !isOwnership(transition.targetOwnership)
  ) {
    throw new CredentialStateError();
  }
  const selectedMustBeTarget =
    transition.phase === 'target-authoritative-cleanup-source' ||
    transition.phase === 'target-authoritative-source-retained' ||
    transition.phase === 'complete';
  if (
    candidate.selectedBackend !==
    (selectedMustBeTarget ? transition.targetBackend : transition.sourceBackend)
  ) {
    throw new CredentialStateError();
  }

  return {
    selectedBackend: candidate.selectedBackend,
    transition: {
      id: transition.id,
      sourceBackend: transition.sourceBackend,
      targetBackend: transition.targetBackend,
      phase: transition.phase,
      targetOwnership: transition.targetOwnership
    }
  };
}

export class CredentialStateRepository {
  constructor(private readonly settings: SettingsRepository) {}

  get(): CredentialState {
    const stored = this.settings.get<unknown>(settingKey);
    if (!stored) return structuredClone(defaultState);
    if (stored.version !== settingVersion) throw new CredentialStateError();
    return parseState(stored.value);
  }

  initialize(): CredentialState {
    const stored = this.settings.get<unknown>(settingKey);
    if (stored) {
      if (stored.version !== settingVersion) throw new CredentialStateError();
      return parseState(stored.value);
    }
    return this.save(defaultState);
  }

  save(state: CredentialState): CredentialState {
    const validated = parseState(state);
    this.settings.set(settingKey, validated, settingVersion);
    return validated;
  }
}

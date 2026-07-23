import type { OnboardingStateDto, OnboardingStepsDto } from '../../features/settings/contracts';
import type { SettingsRepository } from './settings-repository';

const ONBOARDING_KEY = 'onboarding';

export interface OnboardingRecord {
  version: 1;
  completedAt: string | null;
  dismissedAt: string | null;
  steps: OnboardingStepsDto;
}

const DEFAULT_STEPS: OnboardingStepsDto = {
  location: false,
  mediaPrivacy: false,
  connection: false,
  theme: false,
  defaults: false
};

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isOnboardingRecord(value: unknown): value is OnboardingRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    (record.completedAt !== null && !isCanonicalTimestamp(record.completedAt)) ||
    (record.dismissedAt !== null && !isCanonicalTimestamp(record.dismissedAt)) ||
    !record.steps ||
    typeof record.steps !== 'object' ||
    Array.isArray(record.steps)
  ) {
    return false;
  }
  const steps = record.steps as Record<string, unknown>;
  return (
    typeof steps.location === 'boolean' &&
    typeof steps.mediaPrivacy === 'boolean' &&
    typeof steps.connection === 'boolean' &&
    typeof steps.theme === 'boolean' &&
    typeof steps.defaults === 'boolean'
  );
}

export function readOnboarding(settings: SettingsRepository): OnboardingRecord | null {
  const stored = settings.get<unknown>(ONBOARDING_KEY);
  if (stored?.version !== 1 || !isOnboardingRecord(stored.value)) return null;
  return stored.value;
}

export function computeOnboardingState(stored: OnboardingRecord | null): OnboardingStateDto {
  const record = stored ?? {
    version: 1 as const,
    completedAt: null,
    dismissedAt: null,
    steps: DEFAULT_STEPS
  };
  return {
    completed: Boolean(record.completedAt) || Boolean(record.dismissedAt),
    completedAt: record.completedAt,
    dismissedAt: record.dismissedAt,
    version: record.version,
    steps: record.steps
  };
}

export interface OnboardingUpdate {
  steps?: Partial<OnboardingStepsDto>;
  complete?: boolean;
  dismiss?: boolean;
  reopen?: boolean;
}

export function updateOnboarding(
  settings: SettingsRepository,
  update: OnboardingUpdate,
  now = new Date()
): OnboardingRecord {
  const current = readOnboarding(settings) ?? {
    version: 1 as const,
    completedAt: null,
    dismissedAt: null,
    steps: DEFAULT_STEPS
  };
  const next: OnboardingRecord = {
    version: 1,
    completedAt: update.reopen
      ? null
      : (current.completedAt ?? (update.complete ? now.toISOString() : null)),
    dismissedAt: update.reopen
      ? null
      : (current.dismissedAt ?? (update.dismiss ? now.toISOString() : null)),
    // Reopening ("re-run setup") restarts the flow from the first step, so reset the recorded steps
    // to their defaults; otherwise firstIncompleteStep() sees an all-complete record and lands the
    // user straight on the done screen instead of the beginning.
    steps: update.reopen
      ? { ...DEFAULT_STEPS, ...update.steps }
      : { ...current.steps, ...update.steps }
  };
  settings.set(ONBOARDING_KEY, next);
  return next;
}

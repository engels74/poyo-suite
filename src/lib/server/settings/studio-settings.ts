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

function normalizeSteps(value: unknown): OnboardingStepsDto {
  const input = (value ?? {}) as Record<string, unknown>;
  return {
    location: input.location === true,
    mediaPrivacy: input.mediaPrivacy === true,
    connection: input.connection === true,
    theme: input.theme === true,
    defaults: input.defaults === true
  };
}

export function readOnboarding(settings: SettingsRepository): OnboardingRecord | null {
  const stored = settings.get<Partial<OnboardingRecord>>(ONBOARDING_KEY)?.value;
  if (!stored) return null;
  return {
    version: 1,
    completedAt: typeof stored.completedAt === 'string' ? stored.completedAt : null,
    dismissedAt: typeof stored.dismissedAt === 'string' ? stored.dismissedAt : null,
    steps: normalizeSteps(stored.steps)
  };
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

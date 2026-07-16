import { isAbsolute, resolve } from 'node:path';
import type {
  OnboardingStateDto,
  OnboardingStepsDto,
  OutputLocationDto
} from '../../features/settings/contracts';
import type { AppPaths } from '../platform/app-paths';
import type { SettingsRepository } from './settings-repository';

const STORAGE_KEY = 'storage';
const ONBOARDING_KEY = 'onboarding';
const MAX_PREVIOUS_ROOTS = 8;

export interface StoragePreferences {
  outputDirectory: string | null;
  previousRoots: string[];
}

export interface OnboardingRecord {
  version: 1;
  completedAt: string | null;
  dismissedAt: string | null;
  steps: OnboardingStepsDto;
}

const DEFAULT_STEPS: OnboardingStepsDto = {
  location: false,
  connection: false,
  theme: false,
  defaults: false
};

/**
 * Accept a persisted media path only when it is safe to apply: a non-empty, null-byte-free,
 * absolute path, normalized (like the write-side `validateOutputDirectory`) so a corrupt or
 * hand-edited value can never redirect where media is written or defeat later path matching.
 */
function safeStoredPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0') || !isAbsolute(trimmed)) return null;
  return resolve(trimmed);
}

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const safe = safeStoredPath(entry);
    if (safe) seen.add(safe);
  }
  return [...seen];
}

export function readStoragePreferences(settings: SettingsRepository): StoragePreferences {
  const stored = settings.get<Partial<StoragePreferences>>(STORAGE_KEY)?.value;
  return {
    outputDirectory: safeStoredPath(stored?.outputDirectory),
    previousRoots: cleanStrings(stored?.previousRoots)
  };
}

/**
 * Persist a chosen output directory. The previously active media root is retained in
 * `previousRoots` so already-downloaded outputs stay servable after the change. Passing null
 * reverts future outputs to the platform default while keeping historical roots readable.
 */
export function saveOutputDirectory(
  settings: SettingsRepository,
  directory: string | null,
  activeMedia: string
): StoragePreferences {
  const current = readStoragePreferences(settings);
  const history = new Set(current.previousRoots);
  history.add(activeMedia);
  if (current.outputDirectory) history.add(current.outputDirectory);
  const previousRoots = [...history]
    .filter((root) => root !== directory)
    .slice(-MAX_PREVIOUS_ROOTS);
  const next: StoragePreferences = { outputDirectory: directory, previousRoots };
  settings.set(STORAGE_KEY, next);
  return next;
}

/**
 * Resolve the effective media write directory and the set of roots that remain readable.
 * `PLS_MEDIA_DIR` from the environment always wins over a locally chosen directory.
 */
export function resolveEffectiveMedia(
  basePaths: AppPaths,
  storage: StoragePreferences,
  mediaFromEnvironment: boolean
): { media: string; mediaReadRoots: string[]; environmentManaged: boolean } {
  // The platform default is independent of any PLS_MEDIA_DIR override, so outputs downloaded under
  // it before the override was introduced stay readable even though writes now go elsewhere.
  const platformDefault = basePaths.defaultMedia ?? basePaths.media;
  const historical = storage.previousRoots;
  if (!mediaFromEnvironment && storage.outputDirectory) {
    const media = storage.outputDirectory;
    const roots = [media, platformDefault, ...historical].filter(
      (root, index, all) => all.indexOf(root) === index
    );
    return { media, mediaReadRoots: roots, environmentManaged: false };
  }
  // Environment media (or the platform default) owns writes, but keep the platform default and any
  // still-configured custom directory readable: media may already have been downloaded to either
  // before PLS_MEDIA_DIR was introduced.
  const media = basePaths.media;
  const roots = [
    media,
    platformDefault,
    ...(storage.outputDirectory ? [storage.outputDirectory] : []),
    ...historical
  ].filter((root, index, all) => all.indexOf(root) === index);
  return { media, mediaReadRoots: roots, environmentManaged: mediaFromEnvironment };
}

export function outputLocationDto(
  paths: AppPaths,
  storage: StoragePreferences,
  mediaFromEnvironment: boolean
): OutputLocationDto {
  // The media that will be active after the next restart: the environment/custom directory when
  // set, otherwise the platform default. Clearing a custom directory (reset) therefore still
  // reports a pending change back to the default until the next restart applies it.
  const target = mediaFromEnvironment
    ? paths.media
    : (storage.outputDirectory ?? paths.defaultMedia ?? paths.media);
  const pending = target !== paths.media ? target : null;
  return {
    configured: Boolean(storage.outputDirectory),
    environmentManaged: mediaFromEnvironment,
    active: paths.media,
    pending,
    requiresRestart: pending !== null
  };
}

function normalizeSteps(value: unknown): OnboardingStepsDto {
  const input = (value ?? {}) as Record<string, unknown>;
  return {
    location: input.location === true,
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

export interface OnboardingContext {
  apiKeyConfigured: boolean;
  hasHistory: boolean;
}

/**
 * Combine the stored onboarding record with install context. Existing installs (an API key is
 * already configured, or media/jobs already exist) are treated as complete even without a
 * recorded marker, so upgraders are never trapped in the flow.
 */
export function computeOnboardingState(
  stored: OnboardingRecord | null,
  context: OnboardingContext
): OnboardingStateDto {
  const record = stored ?? {
    version: 1 as const,
    completedAt: null,
    dismissedAt: null,
    steps: DEFAULT_STEPS
  };
  const explicit = Boolean(record.completedAt) || Boolean(record.dismissedAt);
  const inferred = !stored && (context.apiKeyConfigured || context.hasHistory);
  return {
    completed: explicit || inferred,
    completedAt: record.completedAt,
    dismissedAt: record.dismissedAt,
    version: record.version,
    steps: record.steps,
    inferred: inferred && !explicit
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

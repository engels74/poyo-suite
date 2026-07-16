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

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) seen.add(entry.trim());
  }
  return [...seen];
}

export function readStoragePreferences(settings: SettingsRepository): StoragePreferences {
  const stored = settings.get<Partial<StoragePreferences>>(STORAGE_KEY)?.value;
  const outputDirectory =
    typeof stored?.outputDirectory === 'string' && stored.outputDirectory.trim()
      ? stored.outputDirectory.trim()
      : null;
  return { outputDirectory, previousRoots: cleanStrings(stored?.previousRoots) };
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
  const defaultMedia = basePaths.media;
  const historical = storage.previousRoots;
  if (!mediaFromEnvironment && storage.outputDirectory) {
    const media = storage.outputDirectory;
    const roots = [media, defaultMedia, ...historical].filter(
      (root, index, all) => all.indexOf(root) === index
    );
    return { media, mediaReadRoots: roots, environmentManaged: false };
  }
  // Keep a still-configured custom directory readable even when the environment manages writes:
  // media may already have been downloaded there before PLS_MEDIA_DIR was introduced.
  const roots = [
    defaultMedia,
    ...(storage.outputDirectory ? [storage.outputDirectory] : []),
    ...historical
  ].filter((root, index, all) => all.indexOf(root) === index);
  return { media: defaultMedia, mediaReadRoots: roots, environmentManaged: mediaFromEnvironment };
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
    steps: { ...current.steps, ...update.steps }
  };
  settings.set(ONBOARDING_KEY, next);
  return next;
}

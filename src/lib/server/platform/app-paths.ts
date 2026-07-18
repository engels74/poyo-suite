import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIRECTORY_NAME = 'poyo-local-studio';
export type AppRootKind = 'project' | 'platform';
export type AppPathSource = 'environment' | 'project-default' | 'platform-selected';

export interface AppPaths {
  root: string;
  database: string;
  media: string;
  /** The platform-default media directory, independent of any custom output-location override. */
  defaultMedia?: string;
  /**
   * Roots that may contain readable generated media. Always includes the active `media`
   * directory; also includes historical directories after the output location changes, so
   * previously downloaded outputs stay servable. Defaults to `[media]`.
   */
  mediaReadRoots?: string[];
  uploads: string;
  thumbnails: string;
  logs: string;
  secrets: string;
  temporary: string;
  source: AppPathSource;
  rootKind: AppRootKind | 'environment';
}

export interface ResolveAppPathsOptions {
  environment?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  projectRoot?: string;
  moduleDirectory?: string;
  rootKind?: AppRootKind;
}

function requireSafePath(value: string, variable: string): string {
  if (value.includes('\0')) throw new Error(`${variable} contains a null byte.`);
  return resolve(value);
}

function resolveHome(environment: Record<string, string | undefined>, explicit?: string): string {
  const home = explicit ?? environment.HOME ?? environment.USERPROFILE;
  if (!home) throw new Error('Unable to resolve the current user home directory.');
  return requireSafePath(home, 'home directory');
}

export function deriveProjectRoot(
  moduleDirectory = dirname(fileURLToPath(import.meta.url)),
  fileExists: (path: string) => boolean = existsSync
): string {
  let candidate = resolve(moduleDirectory);
  while (true) {
    if (fileExists(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error('Unable to derive the Poyo Local Studio project root.');
    }
    candidate = parent;
  }
}

function platformRoot(
  platform: NodeJS.Platform,
  environment: Record<string, string | undefined>,
  home: string
): string {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Poyo Local Studio');
  }

  if (platform === 'win32') {
    const localAppData = environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return join(requireSafePath(localAppData, 'LOCALAPPDATA'), 'Poyo Local Studio');
  }

  const xdgDataHome = environment.XDG_DATA_HOME
    ? requireSafePath(environment.XDG_DATA_HOME, 'XDG_DATA_HOME')
    : join(home, '.local', 'share');
  return join(xdgDataHome, APP_DIRECTORY_NAME);
}

export function resolveAppPaths(options: ResolveAppPathsOptions = {}): AppPaths {
  const environment = options.environment ?? Bun.env;
  const platform = options.platform ?? process.platform;
  const configuredRoot = environment.PLS_APP_DATA_DIR?.trim();
  const rootKind = options.rootKind ?? 'project';
  const root = configuredRoot
    ? requireSafePath(configuredRoot, 'PLS_APP_DATA_DIR')
    : rootKind === 'platform'
      ? platformRoot(platform, environment, resolveHome(environment, options.homeDirectory))
      : join(
          requireSafePath(
            options.projectRoot ?? deriveProjectRoot(options.moduleDirectory),
            'project root'
          ),
          'data'
        );

  // Match the trim()-based check the output-location endpoints use for "environment managed": a
  // whitespace-only PLS_MEDIA_DIR is not a real override, so it must not resolve a media path.
  const mediaOverride = environment.PLS_MEDIA_DIR?.trim();
  // The platform default stays fixed at <root>/media regardless of any PLS_MEDIA_DIR override, so an
  // install that later adds the override can still expose its previous default directory as a read
  // root and keep older outputs readable (see resolveEffectiveMedia).
  const defaultMedia = join(root, 'media');
  const media = mediaOverride ? requireSafePath(mediaOverride, 'PLS_MEDIA_DIR') : defaultMedia;

  return {
    root,
    database: environment.PLS_DATABASE_PATH?.trim()
      ? requireSafePath(environment.PLS_DATABASE_PATH.trim(), 'PLS_DATABASE_PATH')
      : join(root, 'poyo-studio.sqlite'),
    media,
    defaultMedia,
    mediaReadRoots: [media],
    uploads: join(root, 'uploads'),
    thumbnails: join(root, 'thumbnails'),
    logs: environment.PLS_LOG_DIR?.trim()
      ? requireSafePath(environment.PLS_LOG_DIR.trim(), 'PLS_LOG_DIR')
      : join(root, 'logs'),
    secrets: join(root, 'secrets'),
    temporary: join(root, 'tmp'),
    source: configuredRoot
      ? 'environment'
      : rootKind === 'platform'
        ? 'platform-selected'
        : 'project-default',
    rootKind: configuredRoot ? 'environment' : rootKind
  };
}

export function resolveAppPathCandidates(options: Omit<ResolveAppPathsOptions, 'rootKind'> = {}): {
  project: AppPaths;
  platform: AppPaths;
} {
  return {
    project: resolveAppPaths({ ...options, rootKind: 'project' }),
    platform: resolveAppPaths({ ...options, rootKind: 'platform' })
  };
}

export function resolvePathWithin(root: string, candidate: string): string {
  if (candidate.includes('\0')) throw new Error('Path contains a null byte.');
  const resolvedRoot = resolve(root);
  const resolvedCandidate = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(resolvedRoot, candidate);
  const pathFromRoot = relative(resolvedRoot, resolvedCandidate);

  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new Error('Path escapes the configured application root.');
  }

  return resolvedCandidate;
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;

  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Expected a private directory at ${path}.`);
  }
  await chmod(path, 0o700);
}

/**
 * Ensure a user-chosen directory exists and is a real (non-symlink) directory, creating it and any
 * missing parents when absent. Unlike {@link ensurePrivateDirectory} it never chmods an existing
 * directory, so a user's selected output folder keeps its own permissions.
 */
export async function ensureDirectoryExists(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });

  // The non-symlink guarantee is portable — lstat detects symlinks/junctions on win32 too (it stats
  // the link itself without following it) — and this function never chmods, so unlike
  // ensurePrivateDirectory there is no POSIX-only step to skip. Enforce the check on every platform.
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Expected a directory at ${path}.`);
  }
}

export async function ensureAppPaths(paths: AppPaths): Promise<void> {
  // The media directory is the one location an operator can redirect via PLS_MEDIA_DIR. When it is
  // environment-managed (anything other than the platform default under the app root), ensure it
  // exists without forcing 0o700: chmod'ing an existing/shared folder would either change its
  // permissions unexpectedly or fail with EPERM and block startup. This mirrors how a user-chosen
  // output folder is handled in the runtime; the platform default stays private.
  const mediaIsEnvironmentManaged =
    paths.defaultMedia !== undefined && paths.media !== paths.defaultMedia;
  await Promise.all([
    ensurePrivateDirectory(paths.root),
    ensurePrivateDirectory(dirname(paths.database)),
    mediaIsEnvironmentManaged
      ? ensureDirectoryExists(paths.media)
      : ensurePrivateDirectory(paths.media),
    ensurePrivateDirectory(paths.uploads),
    ensurePrivateDirectory(paths.thumbnails),
    ensurePrivateDirectory(paths.logs),
    ensurePrivateDirectory(paths.temporary)
  ]);
}

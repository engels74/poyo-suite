import type { Database } from 'bun:sqlite';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import type { AppPaths } from './app-paths';
import type { StorageRootExclusionDto } from '../../features/settings/contracts';
import { listPersistedOutputPathValues, listPersistedPathValues } from './persisted-paths';

export type RelocationTopologyCode =
  | 'environment_root_managed'
  | 'same_root'
  | 'root_overlap'
  | 'environment_path_overlap'
  | 'target_not_empty'
  | 'target_not_directory'
  | 'path_unverifiable';

export class RelocationTopologyError extends Error {
  constructor(
    readonly code: RelocationTopologyCode,
    message: string
  ) {
    super(message);
    this.name = 'RelocationTopologyError';
  }
}

export interface CanonicalPathIdentity {
  canonicalPath: string;
  pathHash: string;
  nearestDevice: number;
  nearestInode: number;
  exists: boolean;
}

export interface ExternalResourceIdentity extends Omit<CanonicalPathIdentity, 'canonicalPath'> {
  kind: 'database' | 'database-wal' | 'database-shm' | 'database-journal' | 'media' | 'logs';
}

export type PersistedExternalResourceIdentity = Omit<CanonicalPathIdentity, 'canonicalPath'>;

export interface RelocationTopology {
  source: CanonicalPathIdentity;
  target: CanonicalPathIdentity;
  externalResources: ExternalResourceIdentity[];
  databaseMode: 'managed' | 'external';
}

async function details(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function comparisonPath(path: string, platform: NodeJS.Platform): string {
  const normalized = resolve(path);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalizedLeft = comparisonPath(left, platform);
  const normalizedRight = comparisonPath(right, platform);
  const fromLeft = relative(normalizedLeft, normalizedRight);
  const fromRight = relative(normalizedRight, normalizedLeft);
  const within = (value: string) =>
    value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
  return within(fromLeft) || within(fromRight);
}

function pathWithinCanonicalRoot(
  root: string,
  candidate: string,
  platform: NodeJS.Platform
): boolean {
  const normalizedRoot = comparisonPath(root, platform);
  const normalizedCandidate = comparisonPath(candidate, platform);
  const value = relative(normalizedRoot, normalizedCandidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function canonicalIdentity(
  path: string,
  platform: NodeJS.Platform
): Promise<CanonicalPathIdentity> {
  const requested = resolve(path);
  const missing: string[] = [];
  let ancestor = requested;
  let ancestorDetails = await details(ancestor);
  while (!ancestorDetails) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new RelocationTopologyError(
        'path_unverifiable',
        'A relocation path could not be resolved safely.'
      );
    }
    missing.unshift(relative(parent, ancestor));
    ancestor = parent;
    ancestorDetails = await details(ancestor);
  }
  const canonicalAncestor = await realpath(ancestor).catch(() => {
    throw new RelocationTopologyError(
      'path_unverifiable',
      'A relocation path could not be resolved safely.'
    );
  });
  const canonicalPath = comparisonPath(resolve(canonicalAncestor, ...missing), platform);
  return {
    canonicalPath,
    pathHash: new Bun.CryptoHasher('sha256').update(canonicalPath).digest('hex'),
    nearestDevice: ancestorDetails.dev,
    nearestInode: ancestorDetails.ino,
    exists: missing.length === 0
  };
}

function configured(
  environment: Record<string, string | undefined>,
  key: 'PLS_APP_DATA_DIR' | 'PLS_DATABASE_PATH' | 'PLS_MEDIA_DIR' | 'PLS_LOG_DIR'
): string | null {
  const value = environment[key]?.trim();
  return value ? resolve(value) : null;
}

export function relocationResourceExclusions(
  environment: Record<string, string | undefined>
): StorageRootExclusionDto[] {
  const exclusions: StorageRootExclusionDto[] = [];
  if (configured(environment, 'PLS_DATABASE_PATH')) {
    exclusions.push({ resource: 'database', environmentManaged: true, count: 1, copied: false });
  }
  if (configured(environment, 'PLS_MEDIA_DIR')) {
    exclusions.push({ resource: 'media', environmentManaged: true, count: 1, copied: false });
  }
  if (configured(environment, 'PLS_LOG_DIR')) {
    exclusions.push({ resource: 'logs', environmentManaged: true, count: 1, copied: false });
  }
  return exclusions;
}

export async function classifyCanonicalPathOwnership(
  value: string,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform
): Promise<{ owned: boolean; identity: CanonicalPathIdentity }> {
  const identity = await canonicalIdentity(value, platform);
  for (const root of roots) {
    const rootIdentity = await canonicalIdentity(root, platform);
    if (pathWithinCanonicalRoot(rootIdentity.canonicalPath, identity.canonicalPath, platform)) {
      return { owned: true, identity };
    }
  }
  return { owned: false, identity };
}

export async function persistedOutputResourceExclusions(options: {
  database: Database;
  roots: readonly string[];
  platform?: NodeJS.Platform;
}): Promise<StorageRootExclusionDto[]> {
  const platform = options.platform ?? process.platform;
  const outputPaths = listPersistedOutputPathValues(options.database);
  let currentIdentity: string | null = null;
  if (outputPaths.current) {
    const current = await classifyCanonicalPathOwnership(
      outputPaths.current,
      options.roots,
      platform
    );
    if (!current.owned) currentIdentity = current.identity.pathHash;
  }
  const historical = new Set<string>();
  for (const value of outputPaths.historical) {
    const classification = await classifyCanonicalPathOwnership(value, options.roots, platform);
    if (!classification.owned && classification.identity.pathHash !== currentIdentity) {
      historical.add(classification.identity.pathHash);
    }
  }
  return [
    ...(currentIdentity
      ? [
          {
            resource: 'current-output-directory' as const,
            environmentManaged: false,
            count: 1,
            copied: false as const
          }
        ]
      : []),
    ...(historical.size > 0
      ? [
          {
            resource: 'historical-output-directories' as const,
            environmentManaged: false,
            count: historical.size,
            copied: false as const
          }
        ]
      : [])
  ];
}

export async function assertRelocationTopology(options: {
  source: AppPaths;
  target: AppPaths;
  environment: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Promise<RelocationTopology> {
  const platform = options.platform ?? process.platform;
  if (configured(options.environment, 'PLS_APP_DATA_DIR')) {
    throw new RelocationTopologyError(
      'environment_root_managed',
      'PLS_APP_DATA_DIR controls the application root.'
    );
  }
  if (options.source.rootKind === options.target.rootKind) {
    throw new RelocationTopologyError('same_root', 'The requested root is already active.');
  }
  const [source, target] = await Promise.all([
    canonicalIdentity(options.source.root, platform),
    canonicalIdentity(options.target.root, platform)
  ]);
  if (pathsOverlap(source.canonicalPath, target.canonicalPath, platform)) {
    throw new RelocationTopologyError(
      'root_overlap',
      'The source and target roots are not canonically disjoint.'
    );
  }

  const targetDetails = await details(options.target.root);
  if (targetDetails) {
    if (!targetDetails.isDirectory() || targetDetails.isSymbolicLink()) {
      throw new RelocationTopologyError(
        'target_not_directory',
        'The target root is not a regular directory.'
      );
    }
    if ((await readdir(options.target.root)).length > 0) {
      throw new RelocationTopologyError(
        'target_not_empty',
        'The target root contains unrelated data.'
      );
    }
  }

  const resources: Array<{
    kind: ExternalResourceIdentity['kind'];
    path: string;
  }> = [];
  const database = configured(options.environment, 'PLS_DATABASE_PATH');
  if (database) {
    resources.push(
      { kind: 'database', path: database },
      { kind: 'database-wal', path: `${database}-wal` },
      { kind: 'database-shm', path: `${database}-shm` },
      { kind: 'database-journal', path: `${database}-journal` }
    );
  }
  const media = configured(options.environment, 'PLS_MEDIA_DIR');
  if (media) resources.push({ kind: 'media', path: media });
  const logs = configured(options.environment, 'PLS_LOG_DIR');
  if (logs) resources.push({ kind: 'logs', path: logs });

  const externalResources: ExternalResourceIdentity[] = [];
  for (const resource of resources) {
    const identity = await canonicalIdentity(resource.path, platform);
    if (
      pathsOverlap(identity.canonicalPath, source.canonicalPath, platform) ||
      pathsOverlap(identity.canonicalPath, target.canonicalPath, platform)
    ) {
      throw new RelocationTopologyError(
        'environment_path_overlap',
        'An environment-managed resource overlaps an application root.'
      );
    }
    externalResources.push({
      kind: resource.kind,
      pathHash: identity.pathHash,
      nearestDevice: identity.nearestDevice,
      nearestInode: identity.nearestInode,
      exists: identity.exists
    });
  }

  return {
    source,
    target,
    externalResources,
    databaseMode: database ? 'external' : 'managed'
  };
}

function lexicalPathWithin(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === 'win32' ? win32 : { isAbsolute, relative, resolve, sep };
  if (!pathApi.isAbsolute(candidate)) return false;
  const fromRoot = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate));
  return (
    fromRoot === '' ||
    (fromRoot !== '..' && !fromRoot.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(fromRoot))
  );
}

export async function assertPersistedPathTopology(
  database: Database,
  source: AppPaths,
  target: AppPaths,
  topology: RelocationTopology,
  platform: NodeJS.Platform = process.platform
): Promise<PersistedExternalResourceIdentity[]> {
  const external = new Map<string, PersistedExternalResourceIdentity>();
  for (const value of new Set(listPersistedPathValues(database))) {
    const pathIsAbsolute = platform === 'win32' ? win32.isAbsolute(value) : isAbsolute(value);
    if (!pathIsAbsolute) continue;
    const lexicallyOwned =
      lexicalPathWithin(source.root, value, platform) ||
      lexicalPathWithin(target.root, value, platform);
    const classification = await classifyCanonicalPathOwnership(
      value,
      [source.root, target.root],
      platform
    );
    if (classification.owned) {
      if (!lexicallyOwned) {
        throw new RelocationTopologyError(
          'environment_path_overlap',
          'A persisted filesystem reference aliases an application root.'
        );
      }
      continue;
    }
    const identity = classification.identity;
    if (
      pathsOverlap(identity.canonicalPath, topology.source.canonicalPath, platform) ||
      pathsOverlap(identity.canonicalPath, topology.target.canonicalPath, platform)
    ) {
      throw new RelocationTopologyError(
        'environment_path_overlap',
        'A persisted filesystem reference aliases an application root.'
      );
    }
    external.set(identity.pathHash, {
      pathHash: identity.pathHash,
      nearestDevice: identity.nearestDevice,
      nearestInode: identity.nearestInode,
      exists: identity.exists
    });
  }
  return [...external.values()].toSorted((left, right) =>
    left.pathHash.localeCompare(right.pathHash)
  );
}

export async function verifyPersistedExternalResourceIdentities(
  database: Database,
  source: AppPaths,
  target: AppPaths,
  expected: readonly PersistedExternalResourceIdentity[],
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const [sourceIdentity, targetIdentity] = await Promise.all([
    canonicalIdentity(source.root, platform),
    canonicalIdentity(target.root, platform)
  ]);
  const actual = await assertPersistedPathTopology(
    database,
    source,
    target,
    {
      source: sourceIdentity,
      target: targetIdentity,
      externalResources: [],
      databaseMode: source.database === target.database ? 'external' : 'managed'
    },
    platform
  );
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new RelocationTopologyError(
      'path_unverifiable',
      'A persisted external filesystem reference changed identity.'
    );
  }
}

export async function verifyExternalResourceIdentities(
  environment: Record<string, string | undefined>,
  expected: readonly ExternalResourceIdentity[],
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const paths = new Map<ExternalResourceIdentity['kind'], string>();
  const database = configured(environment, 'PLS_DATABASE_PATH');
  if (database) {
    paths.set('database', database);
    paths.set('database-wal', `${database}-wal`);
    paths.set('database-shm', `${database}-shm`);
    paths.set('database-journal', `${database}-journal`);
  }
  const media = configured(environment, 'PLS_MEDIA_DIR');
  if (media) paths.set('media', media);
  const logs = configured(environment, 'PLS_LOG_DIR');
  if (logs) paths.set('logs', logs);
  if (paths.size !== expected.length) {
    throw new RelocationTopologyError(
      'path_unverifiable',
      'The environment-managed relocation resources changed across restart.'
    );
  }
  for (const item of expected) {
    const path = paths.get(item.kind);
    if (!path) {
      throw new RelocationTopologyError(
        'path_unverifiable',
        'The environment-managed relocation resources changed across restart.'
      );
    }
    const actual = await canonicalIdentity(path, platform);
    const sidecar = item.kind !== 'database' && item.kind.startsWith('database-');
    if (
      actual.pathHash !== item.pathHash ||
      (!sidecar &&
        (actual.nearestDevice !== item.nearestDevice ||
          actual.nearestInode !== item.nearestInode ||
          actual.exists !== item.exists))
    ) {
      throw new RelocationTopologyError(
        'path_unverifiable',
        'An environment-managed relocation resource changed identity.'
      );
    }
  }
}

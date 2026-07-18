import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AppPaths, AppRootKind } from './app-paths';
import { preflightDatabase } from './database';

export const ROOT_MARKER_FILE = '.poyo-root.json';
export const ROOT_RELOCATION_MANIFEST_FILE = '.poyo-relocation.json';
export const ROOT_SCHEMA_SIGNATURE_ID = 'poyo-studio-final-schema-v1';

export type RootMarkerState =
  | 'active'
  | 'active-intent'
  | 'prepared'
  | 'activating'
  | 'cleanup-pending'
  | 'failed';

export interface RootMarkerV1 {
  version: 1;
  rootKind: AppRootKind;
  rootIdentityNonce: string;
  generation: number;
  transitionId: string;
  state: RootMarkerState;
  peerRootKind: AppRootKind | null;
  peerRootIdentityNonce: string | null;
  rebasePhase: 'none' | 'pending' | 'complete';
  safeErrorCode: string | null;
  schemaSignatureId: typeof ROOT_SCHEMA_SIGNATURE_ID;
}

export type RootMarkerProbe =
  | { status: 'absent' }
  | { status: 'valid'; marker: RootMarkerV1 }
  | { status: 'corrupt'; code: 'root_not_directory' | 'marker_not_private' | 'marker_invalid' };

export interface RootMarkerDecision {
  selected: AppRootKind;
  mode: 'normal' | 'initialize' | 'provisional' | 'frozen';
  action:
    | 'none'
    | 'initialize-project'
    | 'activate-target'
    | 'restore-source'
    | 'repair-source-intent'
    | 'cleanup-source'
    | 'quarantine-target';
}

export class RootSelectionError extends Error {
  constructor(
    readonly code:
      | 'marker_conflict'
      | 'marker_corrupt'
      | 'markerless_root_not_empty'
      | 'active_database_missing'
      | 'root_not_directory'
      | 'recovery_not_implemented',
    message: string
  ) {
    super(message);
    this.name = 'RootSelectionError';
  }
}

const markerKeys = [
  'generation',
  'peerRootIdentityNonce',
  'peerRootKind',
  'rebasePhase',
  'rootIdentityNonce',
  'rootKind',
  'safeErrorCode',
  'schemaSignatureId',
  'state',
  'transitionId',
  'version'
];
const safeIdentifier = /^[a-zA-Z0-9_-]{8,128}$/;
const markerStates = new Set<RootMarkerState>([
  'active',
  'active-intent',
  'prepared',
  'activating',
  'cleanup-pending',
  'failed'
]);

function isRootKind(value: unknown): value is AppRootKind {
  return value === 'project' || value === 'platform';
}

export function parseRootMarker(value: unknown): RootMarkerV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RootSelectionError('marker_corrupt', 'The root marker is not an object.');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join('\0') !== markerKeys.join('\0')) {
    throw new RootSelectionError('marker_corrupt', 'The root marker fields are invalid.');
  }
  const peerPairValid =
    (input.peerRootKind === null && input.peerRootIdentityNonce === null) ||
    (isRootKind(input.peerRootKind) &&
      typeof input.peerRootIdentityNonce === 'string' &&
      safeIdentifier.test(input.peerRootIdentityNonce));
  if (
    input.version !== 1 ||
    !isRootKind(input.rootKind) ||
    typeof input.rootIdentityNonce !== 'string' ||
    !safeIdentifier.test(input.rootIdentityNonce) ||
    !Number.isSafeInteger(input.generation) ||
    (input.generation as number) < 1 ||
    typeof input.transitionId !== 'string' ||
    !safeIdentifier.test(input.transitionId) ||
    typeof input.state !== 'string' ||
    !markerStates.has(input.state as RootMarkerState) ||
    !peerPairValid ||
    !['none', 'pending', 'complete'].includes(String(input.rebasePhase)) ||
    !(
      input.safeErrorCode === null ||
      (typeof input.safeErrorCode === 'string' && safeIdentifier.test(input.safeErrorCode))
    ) ||
    input.schemaSignatureId !== ROOT_SCHEMA_SIGNATURE_ID
  ) {
    throw new RootSelectionError('marker_corrupt', 'The root marker values are invalid.');
  }
  if (input.peerRootKind === input.rootKind) {
    throw new RootSelectionError('marker_corrupt', 'A root marker cannot identify itself as peer.');
  }
  return input as unknown as RootMarkerV1;
}

async function pathDetails(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readRootMarker(root: string): Promise<RootMarkerProbe> {
  const rootDetails = await pathDetails(root);
  if (!rootDetails) return { status: 'absent' };
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    return { status: 'corrupt', code: 'root_not_directory' };
  }
  const markerPath = resolve(root, ROOT_MARKER_FILE);
  const markerDetails = await pathDetails(markerPath);
  if (!markerDetails) return { status: 'absent' };
  if (!markerDetails.isFile() || markerDetails.isSymbolicLink()) {
    return { status: 'corrupt', code: 'marker_invalid' };
  }
  if (process.platform !== 'win32' && (markerDetails.mode & 0o077) !== 0) {
    return { status: 'corrupt', code: 'marker_not_private' };
  }
  try {
    return { status: 'valid', marker: parseRootMarker(await Bun.file(markerPath).json()) };
  } catch {
    return { status: 'corrupt', code: 'marker_invalid' };
  }
}

function markerFrom(probe: RootMarkerProbe): RootMarkerV1 | null {
  if (probe.status === 'corrupt') {
    throw new RootSelectionError('marker_corrupt', 'A root marker is corrupt or unsafe.');
  }
  return probe.status === 'valid' ? probe.marker : null;
}

function pairedMarkers(source: RootMarkerV1, target: RootMarkerV1): boolean {
  return (
    source.rootKind !== target.rootKind &&
    target.generation === source.generation + 1 &&
    source.transitionId === target.transitionId &&
    source.peerRootKind === target.rootKind &&
    source.peerRootIdentityNonce === target.rootIdentityNonce &&
    target.peerRootKind === source.rootKind &&
    target.peerRootIdentityNonce === source.rootIdentityNonce
  );
}

export function reduceRootMarkers(
  projectProbe: RootMarkerProbe,
  platformProbe: RootMarkerProbe
): RootMarkerDecision {
  const project = markerFrom(projectProbe);
  const platform = markerFrom(platformProbe);
  if (!project && !platform) {
    return { selected: 'project', mode: 'initialize', action: 'initialize-project' };
  }
  if (!project || !platform) {
    const marker = project ?? platform;
    if (!marker) throw new RootSelectionError('marker_conflict', 'No root marker was selected.');
    if (marker.state === 'active') {
      return {
        selected: marker.rootKind,
        mode: 'normal',
        action: marker.peerRootKind === null ? 'none' : 'cleanup-source'
      };
    }
    if (
      marker.rootKind === 'project' &&
      marker.generation === 1 &&
      marker.state === 'activating' &&
      marker.peerRootKind === null
    ) {
      return { selected: 'project', mode: 'initialize', action: 'initialize-project' };
    }
    if (marker.state === 'active-intent') {
      return { selected: marker.rootKind, mode: 'frozen', action: 'restore-source' };
    }
    throw new RootSelectionError(
      'marker_conflict',
      'A provisional or cleanup root cannot become authoritative without its peer.'
    );
  }

  const [source, target] =
    project.generation < platform.generation ? [project, platform] : [platform, project];
  if (!pairedMarkers(source, target)) {
    throw new RootSelectionError(
      'marker_conflict',
      'The project and platform markers do not agree.'
    );
  }
  if (
    source.state === 'active-intent' &&
    (target.state === 'prepared' || target.state === 'activating')
  ) {
    return { selected: target.rootKind, mode: 'provisional', action: 'activate-target' };
  }
  if (source.state === 'active' && target.state === 'prepared') {
    return { selected: source.rootKind, mode: 'frozen', action: 'repair-source-intent' };
  }
  if (
    (source.state === 'active' || source.state === 'active-intent') &&
    target.state === 'active'
  ) {
    return { selected: target.rootKind, mode: 'normal', action: 'cleanup-source' };
  }
  if (source.state === 'cleanup-pending' && target.state === 'active') {
    return { selected: target.rootKind, mode: 'normal', action: 'cleanup-source' };
  }
  if (
    source.state === 'cleanup-pending' &&
    (target.state === 'prepared' || target.state === 'activating')
  ) {
    return { selected: source.rootKind, mode: 'frozen', action: 'restore-source' };
  }
  if (target.state === 'failed' && source.state === 'active') {
    return { selected: source.rootKind, mode: 'normal', action: 'quarantine-target' };
  }
  if (target.state === 'failed' && source.state === 'active-intent') {
    return { selected: source.rootKind, mode: 'frozen', action: 'restore-source' };
  }
  throw new RootSelectionError(
    'marker_conflict',
    'The paired root marker state is not recoverable.'
  );
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(candidate));
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  );
}

async function assertFreshProjectRoot(paths: AppPaths): Promise<void> {
  const rootDetails = await pathDetails(paths.root);
  if (!rootDetails) return;
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new RootSelectionError('root_not_directory', 'The project data root is not a directory.');
  }
  const entries = await readdir(paths.root);
  if (entries.length === 0) return;
  if (isWithin(paths.root, paths.database) && (await pathDetails(paths.database))) {
    await preflightDatabase(paths.database);
  }
  throw new RootSelectionError(
    'markerless_root_not_empty',
    'The markerless project data root contains unknown data.'
  );
}

async function assertResumableInitialProjectRoot(paths: AppPaths): Promise<void> {
  const allowedDirectories = new Set(
    [paths.media, paths.uploads, paths.thumbnails, paths.logs, paths.secrets, paths.temporary]
      .filter((path) => dirname(resolve(path)) === resolve(paths.root))
      .map((path) => basename(path))
  );
  const databaseName = isWithin(paths.root, paths.database) ? basename(paths.database) : null;
  for (const entry of await readdir(paths.root)) {
    if (entry === ROOT_MARKER_FILE || entry === databaseName) continue;
    if (!allowedDirectories.has(entry)) {
      throw new RootSelectionError(
        'markerless_root_not_empty',
        'The initializing project root contains unknown data.'
      );
    }
    const details = await lstat(resolve(paths.root, entry));
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new RootSelectionError(
        'markerless_root_not_empty',
        'The initializing project root contains an unsafe path.'
      );
    }
  }
  await preflightSelectedDatabase(paths, false);
}

async function preflightSelectedDatabase(paths: AppPaths, required: boolean): Promise<void> {
  const result = await preflightDatabase(paths.database);
  if (required && result.state === 'absent') {
    throw new RootSelectionError(
      'active_database_missing',
      'The selected active root has no database.'
    );
  }
}

export interface StartupRootSelection {
  paths: AppPaths;
  decision: RootMarkerDecision;
  projectProbe: RootMarkerProbe;
  platformProbe: RootMarkerProbe;
}

export async function selectRootForStartup(
  projectPaths: AppPaths,
  platformPaths: AppPaths
): Promise<StartupRootSelection> {
  const [projectProbe, platformProbe] = await Promise.all([
    readRootMarker(projectPaths.root),
    readRootMarker(platformPaths.root)
  ]);
  const decision = reduceRootMarkers(projectProbe, platformProbe);
  const paths = decision.selected === 'project' ? projectPaths : platformPaths;
  const startupPaths =
    decision.action === 'repair-source-intent'
      ? decision.selected === 'project'
        ? platformPaths
        : projectPaths
      : paths;
  if (decision.mode === 'initialize') {
    if (projectProbe.status === 'valid') {
      await assertResumableInitialProjectRoot(projectPaths);
    } else {
      await assertFreshProjectRoot(projectPaths);
      await preflightSelectedDatabase(projectPaths, false);
    }
  } else {
    await preflightSelectedDatabase(startupPaths, true);
  }
  return { paths, decision, projectProbe, platformProbe };
}

export async function preflightEnvironmentRoot(paths: AppPaths): Promise<void> {
  const rootDetails = await pathDetails(paths.root);
  if (rootDetails && (!rootDetails.isDirectory() || rootDetails.isSymbolicLink())) {
    throw new RootSelectionError('root_not_directory', 'The environment root is not a directory.');
  }
  const database = await preflightDatabase(paths.database);
  if (rootDetails && database.state === 'absent' && (await readdir(paths.root)).length > 0) {
    throw new RootSelectionError(
      'markerless_root_not_empty',
      'The environment root contains unknown data without a recognized database.'
    );
  }
}

export function createInitialProjectMarker(): RootMarkerV1 {
  return {
    version: 1,
    rootKind: 'project',
    rootIdentityNonce: crypto.randomUUID(),
    generation: 1,
    transitionId: crypto.randomUUID(),
    state: 'activating',
    peerRootKind: null,
    peerRootIdentityNonce: null,
    rebasePhase: 'none',
    safeErrorCode: null,
    schemaSignatureId: ROOT_SCHEMA_SIGNATURE_ID
  };
}

export function promoteInitialProjectMarker(marker: RootMarkerV1): RootMarkerV1 {
  if (
    marker.rootKind !== 'project' ||
    marker.generation !== 1 ||
    marker.state !== 'activating' ||
    marker.peerRootKind !== null
  ) {
    throw new RootSelectionError(
      'marker_conflict',
      'Only an initial project marker can be promoted.'
    );
  }
  return { ...marker, state: 'active' };
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    await directory?.close();
  }
}

export async function writeRootMarker(root: string, marker: RootMarkerV1): Promise<void> {
  parseRootMarker(marker);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new RootSelectionError(
      'root_not_directory',
      'The root marker parent is not a directory.'
    );
  }
  if (process.platform !== 'win32') await chmod(root, 0o700);
  const markerPath = resolve(root, ROOT_MARKER_FILE);
  const temporaryPath = resolve(root, `${ROOT_MARKER_FILE}.${crypto.randomUUID()}.tmp`);
  let temporary: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporary = await open(temporaryPath, 'wx', 0o600);
    await temporary.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
    await temporary.sync();
    await temporary.close();
    temporary = undefined;
    await rename(temporaryPath, markerPath);
    if (process.platform !== 'win32') await chmod(markerPath, 0o600);
    await syncDirectory(dirname(markerPath));
  } finally {
    await temporary?.close();
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

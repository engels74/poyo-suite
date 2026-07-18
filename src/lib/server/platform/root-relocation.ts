import { Database, constants as sqliteConstants } from 'bun:sqlite';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  statfs,
  unlink
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AppPaths, AppRootKind } from './app-paths';
import { databaseSchemaSignature } from './database';
import type {
  ExclusiveMaintenanceLease,
  MaintenanceGate,
  MaintenanceInitiatorPermit
} from './maintenance-gate';
import { findPersistedPathsUnderRoot, rebasePersistedPaths } from './persisted-paths';
import {
  ROOT_MARKER_FILE,
  ROOT_RELOCATION_MANIFEST_FILE,
  ROOT_SCHEMA_SIGNATURE_ID,
  type RootMarkerV1,
  readRootMarker,
  type StartupRootSelection,
  writeRootMarker
} from './root-selector';
import {
  assertPersistedPathTopology,
  assertRelocationTopology,
  type ExternalResourceIdentity,
  type PersistedExternalResourceIdentity,
  type RelocationTopology,
  verifyExternalResourceIdentities,
  verifyPersistedExternalResourceIdentities
} from './root-topology';
import { DATABASE_SCHEMA_VERSION } from './version';

export { ROOT_RELOCATION_MANIFEST_FILE } from './root-selector';

const STAGE_OWNER_FILE = '.poyo-stage-owner.json';
const MAX_STAGE_INVENTORY_ENTRIES = 100_000;
const MAX_STAGE_INVENTORY_DEPTH = 64;

export type RelocationCheckpoint =
  | 'exclusive-acquired'
  | 'stage-created'
  | 'files-copied'
  | 'database-snapshotted'
  | 'paths-rebased'
  | 'manifest-written'
  | 'prepared-marker-written'
  | 'source-intent-written'
  | 'target-published'
  | 'target-parent-synced'
  | 'stage-before-quarantine'
  | 'stage-quarantined'
  | 'stage-deleted';

export type StartupRelocationCheckpoint =
  | 'target-activated'
  | 'source-cleanup-marked'
  | 'source-entry-before-quarantine'
  | 'source-entry-quarantined'
  | 'source-entry-unlinked'
  | 'source-deleted'
  | 'target-finalized'
  | 'manifest-removed';

export type RootRelocationErrorCode =
  | 'source_not_active'
  | 'target_changed'
  | 'stage_conflict'
  | 'unsafe_source_entry'
  | 'hardlink_rejected'
  | 'insufficient_space'
  | 'snapshot_failed'
  | 'manifest_invalid'
  | 'manifest_mismatch'
  | 'database_invalid'
  | 'path_rebase_incomplete'
  | 'rollback_incomplete'
  | 'restart_required';

export class RootRelocationError extends Error {
  constructor(
    readonly code: RootRelocationErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RootRelocationError';
  }
}

interface ManifestDirectory {
  path: string;
  kind: 'directory';
  mode: number;
  sourceDevice: number;
  sourceInode: number;
}

interface ManifestFile {
  path: string;
  kind: 'file';
  mode: number;
  size: number;
  sha256: string | null;
  sensitive: boolean;
  sourceDevice: number;
  sourceInode: number;
}

type ManifestEntry = ManifestDirectory | ManifestFile;

export interface RootRelocationManifestV1 {
  version: 1;
  schemaSignatureId: typeof ROOT_SCHEMA_SIGNATURE_ID;
  transitionId: string;
  sourceRootKind: AppRootKind;
  targetRootKind: AppRootKind;
  sourceRootIdentityNonce: string;
  sourceRootDevice: number;
  sourceRootInode: number;
  targetRootIdentityNonce: string;
  stageDevice: number;
  stageInode: number;
  stageOwnerDevice: number;
  stageOwnerInode: number;
  stageOwnerNonce: string;
  sourceGeneration: number;
  targetGeneration: number;
  databaseMode: 'managed' | 'external';
  databaseSchemaVersion: number;
  databaseSchemaSignature: string;
  databaseRowCounts: Record<string, number> | null;
  cleanupPhase:
    | 'source-retained'
    | 'source-deletion-in-progress'
    | 'source-removed'
    | 'target-finalization-pending';
  externalResources: ExternalResourceIdentity[];
  persistedExternalResources: PersistedExternalResourceIdentity[];
  entries: ManifestEntry[];
  sourceDatabaseEntries: ManifestFile[];
}

export interface RootRelocationResult {
  transitionId: string;
  targetRootKind: AppRootKind;
  restartRequired: true;
}

export interface RootRelocationCoordinatorOptions {
  source: AppPaths;
  target: AppPaths;
  database: Database;
  environment: Record<string, string | undefined>;
  gate: MaintenanceGate;
  platform?: NodeJS.Platform;
  checkpoint?: (checkpoint: RelocationCheckpoint) => void | Promise<void>;
  resumeBeforePublication?: () => void | Promise<void>;
}

export interface StartupRelocationContext {
  kind: 'ordinary' | 'provisional' | 'cleanup';
  paths: AppPaths;
  source: AppPaths | null;
  target: AppPaths | null;
  sourceMarker: RootMarkerV1 | null;
  targetMarker: RootMarkerV1 | null;
  manifest: RootRelocationManifestV1 | null;
}

async function pathDetails(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(resolve(root), resolve(candidate));
  return value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
}

function relativeIfWithin(root: string, candidate: string): string | null {
  return isWithin(root, candidate) ? relative(resolve(root), resolve(candidate)) : null;
}

function stagePath(targetRoot: string, transitionId: string): string {
  return join(dirname(targetRoot), `.${basename(targetRoot)}.poyo-stage-${transitionId}`);
}

function stageQuarantinePath(targetRoot: string, transitionId: string): string {
  return join(
    dirname(targetRoot),
    `.${basename(targetRoot)}.poyo-stage-quarantine-${transitionId}`
  );
}

function quarantinePath(targetRoot: string, transitionId: string): string {
  return join(dirname(targetRoot), `.${basename(targetRoot)}.poyo-failed-${transitionId}`);
}

function cleanupQuarantinePath(sourceRoot: string, transitionId: string): string {
  return join(sourceRoot, `.poyo-cleanup-${transitionId}`);
}

function cleanupRootQuarantinePath(sourceRoot: string, transitionId: string): string {
  return join(dirname(sourceRoot), `.${basename(sourceRoot)}.poyo-cleanup-${transitionId}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close();
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

interface StageOwnerV1 {
  version: 1;
  transitionId: string;
  targetRootIdentityNonce: string;
  stageDevice: number;
  stageInode: number;
  ownerNonce: string;
}

interface StageIdentityProof {
  stageDevice: number;
  stageInode: number;
  ownerDevice: number;
  ownerInode: number;
  owner: StageOwnerV1;
}

interface StageCandidateIdentity {
  stageDevice: number;
  stageInode: number;
  ownerDevice: number | null;
  ownerInode: number | null;
}

function parseStageOwner(value: unknown): StageOwnerV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RootRelocationError('rollback_incomplete', 'Stage ownership is invalid.');
  }
  const owner = value as Record<string, unknown>;
  if (
    Object.keys(owner).toSorted().join(',') !==
      'ownerNonce,stageDevice,stageInode,targetRootIdentityNonce,transitionId,version' ||
    owner.version !== 1 ||
    typeof owner.transitionId !== 'string' ||
    typeof owner.targetRootIdentityNonce !== 'string' ||
    typeof owner.ownerNonce !== 'string' ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(owner.transitionId) ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(owner.targetRootIdentityNonce) ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(owner.ownerNonce) ||
    !Number.isSafeInteger(owner.stageDevice) ||
    !Number.isSafeInteger(owner.stageInode)
  ) {
    throw new RootRelocationError('rollback_incomplete', 'Stage ownership is invalid.');
  }
  return owner as unknown as StageOwnerV1;
}

async function captureStageCandidate(path: string): Promise<StageCandidateIdentity> {
  const stage = await lstat(path);
  const owner = await pathDetails(join(path, STAGE_OWNER_FILE));
  return {
    stageDevice: stage.dev,
    stageInode: stage.ino,
    ownerDevice: owner?.dev ?? null,
    ownerInode: owner?.ino ?? null
  };
}

async function verifyStageInventory(
  root: string,
  relativePath = '',
  count = { value: 0 }
): Promise<void> {
  const depth = relativePath ? relativePath.split(sep).length : 0;
  if (depth > MAX_STAGE_INVENTORY_DEPTH) {
    throw new RootRelocationError('rollback_incomplete', 'Stage inventory is not safely bounded.');
  }
  for (const name of await readdir(relativePath ? resolve(root, relativePath) : root)) {
    count.value += 1;
    if (count.value > MAX_STAGE_INVENTORY_ENTRIES) {
      throw new RootRelocationError(
        'rollback_incomplete',
        'Stage inventory is not safely bounded.'
      );
    }
    const childRelative = relativePath ? join(relativePath, name) : name;
    const details = await lstat(resolve(root, childRelative));
    if (
      details.isSymbolicLink() ||
      (!details.isDirectory() && !details.isFile()) ||
      (details.isFile() && details.nlink !== 1) ||
      details.nlink < 1 ||
      (process.platform !== 'win32' && (details.mode & 0o077) !== 0)
    ) {
      throw new RootRelocationError('rollback_incomplete', 'Stage inventory is not safely owned.');
    }
    if (details.isDirectory()) await verifyStageInventory(root, childRelative, count);
  }
}

async function verifyQuarantinedStage(
  quarantine: string,
  expected: { transitionId: string; targetRootIdentityNonce: string },
  candidate: StageCandidateIdentity,
  createdProof: StageIdentityProof | null
): Promise<StageIdentityProof> {
  const stage = await lstat(quarantine);
  const ownerPath = join(quarantine, STAGE_OWNER_FILE);
  const ownerDetails = await lstat(ownerPath);
  if (
    !stage.isDirectory() ||
    stage.isSymbolicLink() ||
    stage.dev !== candidate.stageDevice ||
    stage.ino !== candidate.stageInode ||
    (process.platform !== 'win32' && (stage.mode & 0o077) !== 0) ||
    !ownerDetails.isFile() ||
    ownerDetails.isSymbolicLink() ||
    ownerDetails.nlink !== 1 ||
    ownerDetails.dev !== candidate.ownerDevice ||
    ownerDetails.ino !== candidate.ownerInode ||
    (process.platform !== 'win32' && (ownerDetails.mode & 0o077) !== 0)
  ) {
    throw new RootRelocationError(
      'rollback_incomplete',
      'Stage ownership changed during rollback.'
    );
  }
  let owner: StageOwnerV1;
  try {
    owner = parseStageOwner(JSON.parse(await readFile(ownerPath, 'utf8')));
  } catch (error) {
    if (error instanceof RootRelocationError) throw error;
    throw new RootRelocationError('rollback_incomplete', 'Stage ownership could not be verified.');
  }
  if (
    owner.transitionId !== expected.transitionId ||
    owner.targetRootIdentityNonce !== expected.targetRootIdentityNonce ||
    owner.stageDevice !== stage.dev ||
    owner.stageInode !== stage.ino ||
    (createdProof !== null &&
      (createdProof.stageDevice !== stage.dev ||
        createdProof.stageInode !== stage.ino ||
        createdProof.ownerDevice !== ownerDetails.dev ||
        createdProof.ownerInode !== ownerDetails.ino ||
        createdProof.owner.ownerNonce !== owner.ownerNonce))
  ) {
    throw new RootRelocationError('rollback_incomplete', 'Stage ownership could not be verified.');
  }
  const manifestPath = join(quarantine, ROOT_RELOCATION_MANIFEST_FILE);
  if (await pathDetails(manifestPath)) {
    const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
    if (
      manifest.transitionId !== expected.transitionId ||
      manifest.targetRootIdentityNonce !== expected.targetRootIdentityNonce ||
      manifest.stageDevice !== stage.dev ||
      manifest.stageInode !== stage.ino ||
      manifest.stageOwnerDevice !== ownerDetails.dev ||
      manifest.stageOwnerInode !== ownerDetails.ino ||
      manifest.stageOwnerNonce !== owner.ownerNonce
    ) {
      throw new RootRelocationError(
        'rollback_incomplete',
        'Stage ownership could not be verified.'
      );
    }
  }
  await verifyStageInventory(quarantine);
  const recheckedStage = await lstat(quarantine);
  const recheckedOwner = await lstat(ownerPath);
  if (
    recheckedStage.dev !== stage.dev ||
    recheckedStage.ino !== stage.ino ||
    !recheckedStage.isDirectory() ||
    recheckedStage.isSymbolicLink() ||
    recheckedOwner.dev !== ownerDetails.dev ||
    recheckedOwner.ino !== ownerDetails.ino ||
    !recheckedOwner.isFile() ||
    recheckedOwner.isSymbolicLink() ||
    recheckedOwner.nlink !== 1
  ) {
    throw new RootRelocationError(
      'rollback_incomplete',
      'Stage ownership changed during rollback.'
    );
  }
  return {
    stageDevice: stage.dev,
    stageInode: stage.ino,
    ownerDevice: ownerDetails.dev,
    ownerInode: ownerDetails.ino,
    owner
  };
}

async function quarantineAndRemoveStage(options: {
  targetRoot: string;
  transitionId: string;
  targetRootIdentityNonce: string;
  createdProof?: StageIdentityProof | null;
  checkpoint?: (checkpoint: RelocationCheckpoint) => void | Promise<void>;
}): Promise<void> {
  const stage = stagePath(options.targetRoot, options.transitionId);
  const quarantine = stageQuarantinePath(options.targetRoot, options.transitionId);
  const stageDetails = await pathDetails(stage);
  const quarantineDetails = await pathDetails(quarantine);
  if (stageDetails && quarantineDetails) {
    throw new RootRelocationError(
      'rollback_incomplete',
      'Multiple stage candidates were retained.'
    );
  }
  if (!stageDetails && !quarantineDetails) return;

  let candidate: StageCandidateIdentity;
  if (quarantineDetails) {
    candidate = await captureStageCandidate(quarantine);
  } else {
    candidate = await captureStageCandidate(stage);
    await options.checkpoint?.('stage-before-quarantine');
    await rename(stage, quarantine);
    await syncDirectory(dirname(stage));
    await options.checkpoint?.('stage-quarantined');
  }
  await verifyQuarantinedStage(
    quarantine,
    {
      transitionId: options.transitionId,
      targetRootIdentityNonce: options.targetRootIdentityNonce
    },
    candidate,
    options.createdProof ?? null
  );
  const finalStage = await lstat(quarantine);
  if (
    finalStage.dev !== candidate.stageDevice ||
    finalStage.ino !== candidate.stageInode ||
    !finalStage.isDirectory() ||
    finalStage.isSymbolicLink()
  ) {
    throw new RootRelocationError(
      'rollback_incomplete',
      'Stage ownership changed before deletion.'
    );
  }
  await rm(quarantine, { recursive: true });
  await syncDirectory(dirname(quarantine));
  await options.checkpoint?.('stage-deleted');
}

function safeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) return false;
  if (isAbsolute(value) || value.includes(sep === '/' ? '\\' : '/')) return false;
  const components = value.split(sep);
  return (
    components.every(
      (component) => component.length > 0 && component !== '.' && component !== '..'
    ) && components.join(sep) === value
  );
}

function resolveManifestPath(root: string, value: string): string {
  if (!safeRelativePath(value)) {
    throw new RootRelocationError('manifest_invalid', 'The relocation manifest path is invalid.');
  }
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, value);
  if (candidate === resolvedRoot || !isWithin(resolvedRoot, candidate)) {
    throw new RootRelocationError('manifest_invalid', 'The relocation manifest path is invalid.');
  }
  return candidate;
}

function parseManifest(value: unknown): RootRelocationManifestV1 {
  const input = value as Partial<RootRelocationManifestV1> | null;
  const safeIdentifier = /^[a-zA-Z0-9_-]{8,128}$/;
  if (
    input?.version !== 1 ||
    input.schemaSignatureId !== ROOT_SCHEMA_SIGNATURE_ID ||
    typeof input.transitionId !== 'string' ||
    !safeIdentifier.test(input.transitionId) ||
    !['project', 'platform'].includes(String(input.sourceRootKind)) ||
    !['project', 'platform'].includes(String(input.targetRootKind)) ||
    input.sourceRootKind === input.targetRootKind ||
    typeof input.sourceRootIdentityNonce !== 'string' ||
    !safeIdentifier.test(input.sourceRootIdentityNonce) ||
    !Number.isSafeInteger(input.sourceRootDevice) ||
    !Number.isSafeInteger(input.sourceRootInode) ||
    typeof input.targetRootIdentityNonce !== 'string' ||
    !safeIdentifier.test(input.targetRootIdentityNonce) ||
    !Number.isSafeInteger(input.stageDevice) ||
    !Number.isSafeInteger(input.stageInode) ||
    !Number.isSafeInteger(input.stageOwnerDevice) ||
    !Number.isSafeInteger(input.stageOwnerInode) ||
    typeof input.stageOwnerNonce !== 'string' ||
    !safeIdentifier.test(input.stageOwnerNonce) ||
    !Number.isSafeInteger(input.sourceGeneration) ||
    !Number.isSafeInteger(input.targetGeneration) ||
    input.targetGeneration !== Number(input.sourceGeneration) + 1 ||
    !['managed', 'external'].includes(String(input.databaseMode)) ||
    !Number.isSafeInteger(input.databaseSchemaVersion) ||
    typeof input.databaseSchemaSignature !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.databaseSchemaSignature) ||
    ![
      'source-retained',
      'source-deletion-in-progress',
      'source-removed',
      'target-finalization-pending'
    ].includes(String(input.cleanupPhase)) ||
    !Array.isArray(input.externalResources) ||
    !Array.isArray(input.persistedExternalResources) ||
    !Array.isArray(input.entries) ||
    !Array.isArray(input.sourceDatabaseEntries)
  ) {
    throw new RootRelocationError('manifest_invalid', 'The relocation manifest is invalid.');
  }
  const resourceKinds = new Set([
    'database',
    'database-wal',
    'database-shm',
    'database-journal',
    'media',
    'logs'
  ]);
  const seenResources = new Set<string>();
  for (const resource of input.externalResources) {
    if (
      !resource ||
      typeof resource !== 'object' ||
      !resourceKinds.has(String(resource.kind)) ||
      seenResources.has(String(resource.kind)) ||
      typeof resource.pathHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(resource.pathHash) ||
      !Number.isSafeInteger(resource.nearestDevice) ||
      !Number.isSafeInteger(resource.nearestInode) ||
      typeof resource.exists !== 'boolean'
    ) {
      throw new RootRelocationError('manifest_invalid', 'The relocation manifest is invalid.');
    }
    seenResources.add(String(resource.kind));
  }
  for (const resource of input.persistedExternalResources) {
    if (
      !resource ||
      typeof resource !== 'object' ||
      typeof resource.pathHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(resource.pathHash) ||
      !Number.isSafeInteger(resource.nearestDevice) ||
      !Number.isSafeInteger(resource.nearestInode) ||
      typeof resource.exists !== 'boolean'
    ) {
      throw new RootRelocationError('manifest_invalid', 'The relocation manifest is invalid.');
    }
  }
  if (
    (input.databaseMode === 'external' && input.databaseRowCounts !== null) ||
    (input.databaseMode === 'managed' &&
      (!input.databaseRowCounts ||
        Array.isArray(input.databaseRowCounts) ||
        Object.entries(input.databaseRowCounts).some(
          ([table, count]) =>
            !/^[a-zA-Z0-9_]+$/.test(table) || !Number.isSafeInteger(count) || count < 0
        )))
  ) {
    throw new RootRelocationError('manifest_invalid', 'The relocation manifest is invalid.');
  }
  const paths = new Set<string>();
  for (const entry of input.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !safeRelativePath(entry.path) ||
      paths.has(entry.path) ||
      !['directory', 'file'].includes(entry.kind) ||
      !Number.isSafeInteger(entry.mode) ||
      !Number.isSafeInteger(entry.sourceDevice) ||
      !Number.isSafeInteger(entry.sourceInode)
    ) {
      throw new RootRelocationError('manifest_invalid', 'The relocation manifest is invalid.');
    }
    if (
      entry.kind === 'file' &&
      (!Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        typeof entry.sensitive !== 'boolean' ||
        !(
          (entry.sensitive && entry.sha256 === null) ||
          (!entry.sensitive &&
            typeof entry.sha256 === 'string' &&
            /^[a-f0-9]{64}$/.test(entry.sha256))
        ))
    ) {
      throw new RootRelocationError('manifest_invalid', 'The relocation manifest is invalid.');
    }
    paths.add(entry.path);
  }
  for (const entry of input.sourceDatabaseEntries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !safeRelativePath(entry.path) ||
      paths.has(entry.path) ||
      entry.kind !== 'file' ||
      !Number.isSafeInteger(entry.mode) ||
      !Number.isSafeInteger(entry.sourceDevice) ||
      !Number.isSafeInteger(entry.sourceInode) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.sensitive !== false ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new RootRelocationError('manifest_invalid', 'The relocation manifest is invalid.');
    }
    paths.add(entry.path);
  }
  return input as RootRelocationManifestV1;
}

async function readManifest(root: string): Promise<RootRelocationManifestV1> {
  const path = join(root, ROOT_RELOCATION_MANIFEST_FILE);
  const details = await pathDetails(path);
  if (!details?.isFile() || details.isSymbolicLink()) {
    throw new RootRelocationError('manifest_invalid', 'The relocation manifest is missing.');
  }
  if (process.platform !== 'win32' && (details.mode & 0o077) !== 0) {
    throw new RootRelocationError('manifest_invalid', 'The relocation manifest is not private.');
  }
  try {
    return parseManifest(await Bun.file(path).json());
  } catch (error) {
    if (error instanceof RootRelocationError) throw error;
    throw new RootRelocationError('manifest_invalid', 'The relocation manifest is invalid.');
  }
}

function markerMatchesManifest(
  source: RootMarkerV1,
  target: RootMarkerV1,
  manifest: RootRelocationManifestV1
): boolean {
  return (
    source.rootKind === manifest.sourceRootKind &&
    target.rootKind === manifest.targetRootKind &&
    source.rootIdentityNonce === manifest.sourceRootIdentityNonce &&
    target.rootIdentityNonce === manifest.targetRootIdentityNonce &&
    source.generation === manifest.sourceGeneration &&
    target.generation === manifest.targetGeneration &&
    source.transitionId === manifest.transitionId &&
    target.transitionId === manifest.transitionId
  );
}

function markerForActiveSource(
  marker: RootMarkerV1,
  safeErrorCode: string | null = null
): RootMarkerV1 {
  return {
    ...marker,
    state: 'active',
    peerRootKind: null,
    peerRootIdentityNonce: null,
    rebasePhase: 'none',
    safeErrorCode
  };
}

function databaseRowCounts(database: Database): Record<string, number> {
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all();
  return Object.fromEntries(
    tables.map(({ name }) => {
      const quoted = name.replaceAll('"', '""');
      const count = database
        .query<{ count: number }, []>(`SELECT COUNT(*) count FROM "${quoted}"`)
        .get()?.count;
      return [name, count ?? -1];
    })
  );
}

function verifyDatabase(
  database: Database,
  expectedVersion: number,
  expectedCounts: Record<string, number> | null,
  oldRoot?: string,
  expectedSchemaSignature?: string
): void {
  const integrity = database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get();
  const foreignKeys = database.query<Record<string, unknown>, []>('PRAGMA foreign_key_check').all();
  const version = database
    .query<{ version: number }, []>(
      'SELECT COALESCE(MAX(version),0) version FROM schema_migrations'
    )
    .get()?.version;
  if (
    integrity?.integrity_check !== 'ok' ||
    foreignKeys.length !== 0 ||
    version !== expectedVersion ||
    (expectedSchemaSignature && databaseSchemaSignature(database) !== expectedSchemaSignature) ||
    (expectedCounts &&
      JSON.stringify(databaseRowCounts(database)) !== JSON.stringify(expectedCounts))
  ) {
    throw new RootRelocationError(
      'database_invalid',
      'The relocation database verification failed.'
    );
  }
  if (oldRoot && findPersistedPathsUnderRoot(database, oldRoot).length > 0) {
    throw new RootRelocationError(
      'path_rebase_incomplete',
      'Persisted paths still reference the former root.'
    );
  }
}

async function hashFile(path: string): Promise<{ size: number; sha256: string }> {
  const hasher = new Bun.CryptoHasher('sha256');
  let size = 0;
  const reader = Bun.file(path).stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    hasher.update(value);
  }
  return { size, sha256: hasher.digest('hex') };
}

async function filesEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([hashFile(left), hashFile(right)]);
  return leftHash.size === rightHash.size && leftHash.sha256 === rightHash.sha256;
}

interface CopyContext {
  sourceRoot: string;
  targetRoot: string;
  excluded: Set<string>;
  sensitiveRoot: string | null;
  entries: ManifestEntry[];
}

function privateMode(mode: number, directory: boolean): number {
  const allowed = mode & 0o700;
  return directory ? (allowed | 0o700) & 0o700 : (allowed | 0o600) & 0o700;
}

async function copyRegularFile(
  source: string,
  target: string,
  sourceDetails: Awaited<ReturnType<typeof lstat>>,
  mode: number
): Promise<{ size: number; sha256: string }> {
  if (sourceDetails.nlink > 1) {
    throw new RootRelocationError(
      'hardlink_rejected',
      'A root-owned hard link is not relocatable.'
    );
  }
  const sourceHandle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const opened = await sourceHandle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== sourceDetails.dev ||
      opened.ino !== sourceDetails.ino ||
      opened.size !== sourceDetails.size
    ) {
      throw new RootRelocationError(
        'unsafe_source_entry',
        'A root-owned file changed during copy.'
      );
    }
    targetHandle = await open(target, 'wx', mode);
    const hasher = new Bun.CryptoHasher('sha256');
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let position = 0;
    while (position < opened.size) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hasher.update(chunk);
      await targetHandle.write(chunk);
      position += bytesRead;
    }
    if (position !== opened.size) {
      throw new RootRelocationError(
        'unsafe_source_entry',
        'A root-owned file changed during copy.'
      );
    }
    const rechecked = await sourceHandle.stat();
    if (
      rechecked.dev !== opened.dev ||
      rechecked.ino !== opened.ino ||
      rechecked.size !== opened.size ||
      rechecked.mtimeMs !== opened.mtimeMs
    ) {
      throw new RootRelocationError(
        'unsafe_source_entry',
        'A root-owned file changed during copy.'
      );
    }
    await targetHandle.sync();
    return { size: position, sha256: hasher.digest('hex') };
  } finally {
    await targetHandle?.close();
    await sourceHandle.close();
  }
}

async function copyTree(context: CopyContext, relativePath = ''): Promise<void> {
  const sourceDirectory = resolve(context.sourceRoot, relativePath);
  const entries = (await readdir(sourceDirectory)).toSorted();
  for (const name of entries) {
    const childRelative = relativePath ? join(relativePath, name) : name;
    if (context.excluded.has(childRelative)) continue;
    const source = resolve(context.sourceRoot, childRelative);
    const target = resolve(context.targetRoot, childRelative);
    const details = await lstat(source);
    if (details.isSymbolicLink()) {
      throw new RootRelocationError(
        'unsafe_source_entry',
        'Root relocation does not follow links.'
      );
    }
    if (details.isDirectory()) {
      const mode = privateMode(details.mode, true);
      await mkdir(target, { mode: 0o700 });
      if (process.platform !== 'win32') await chmod(target, mode);
      context.entries.push({
        path: childRelative,
        kind: 'directory',
        mode,
        sourceDevice: details.dev,
        sourceInode: details.ino
      });
      await copyTree(context, childRelative);
      await syncDirectory(target);
      const rechecked = await lstat(source);
      if (
        !rechecked.isDirectory() ||
        rechecked.isSymbolicLink() ||
        rechecked.dev !== details.dev ||
        rechecked.ino !== details.ino ||
        rechecked.mtimeMs !== details.mtimeMs
      ) {
        throw new RootRelocationError(
          'unsafe_source_entry',
          'A root-owned directory changed during copy.'
        );
      }
      continue;
    }
    if (!details.isFile()) {
      throw new RootRelocationError(
        'unsafe_source_entry',
        'A root-owned special file is not relocatable.'
      );
    }
    const mode = privateMode(details.mode, false);
    const copied = await copyRegularFile(source, target, details, mode);
    if (process.platform !== 'win32') await chmod(target, mode);
    const sensitive = Boolean(context.sensitiveRoot && isWithin(context.sensitiveRoot, source));
    context.entries.push({
      path: childRelative,
      kind: 'file',
      mode,
      size: copied.size,
      sha256: sensitive ? null : copied.sha256,
      sensitive,
      sourceDevice: details.dev,
      sourceInode: details.ino
    });
  }
}

async function sourceDatabaseEntries(
  paths: AppPaths,
  databaseMode: 'managed' | 'external',
  databaseHandle: Database
): Promise<ManifestFile[]> {
  if (databaseMode === 'external') return [];
  const database = relativeIfWithin(paths.root, paths.database);
  if (database === null) return [];
  const entries: ManifestFile[] = [];
  for (const path of [database, `${database}-wal`, `${database}-shm`, `${database}-journal`]) {
    const absolute = resolve(paths.root, path);
    const details = await pathDetails(absolute);
    if (!details) continue;
    if (!details.isFile() || details.isSymbolicLink() || details.nlink > 1) {
      throw new RootRelocationError(
        'unsafe_source_entry',
        'A managed database file is not safe to relocate.'
      );
    }
    const isMainDatabase = path === database;
    const serialized = isMainDatabase ? databaseHandle.serialize() : null;
    const hashed = serialized
      ? {
          size: serialized.byteLength,
          sha256: new Bun.CryptoHasher('sha256').update(serialized).digest('hex')
        }
      : await hashFile(absolute);
    const rechecked = await lstat(absolute);
    if (
      !rechecked.isFile() ||
      rechecked.isSymbolicLink() ||
      rechecked.dev !== details.dev ||
      rechecked.ino !== details.ino ||
      (!isMainDatabase && rechecked.size !== hashed.size) ||
      rechecked.mtimeMs !== details.mtimeMs
    ) {
      throw new RootRelocationError(
        'unsafe_source_entry',
        'A managed database file changed during relocation.'
      );
    }
    entries.push({
      path,
      kind: 'file',
      mode: privateMode(details.mode, false),
      size: hashed.size,
      sha256: hashed.sha256,
      sensitive: false,
      sourceDevice: details.dev,
      sourceInode: details.ino
    });
  }
  return entries;
}

function manifestExclusions(
  paths: Pick<AppPaths, 'root' | 'database'>,
  databaseMode: 'managed' | 'external'
): Set<string> {
  const excluded = new Set([ROOT_MARKER_FILE, ROOT_RELOCATION_MANIFEST_FILE, STAGE_OWNER_FILE]);
  if (databaseMode === 'managed') {
    const database = relativeIfWithin(paths.root, paths.database);
    if (database !== null) {
      excluded.add(database);
      excluded.add(`${database}-wal`);
      excluded.add(`${database}-shm`);
      excluded.add(`${database}-journal`);
    }
  }
  return excluded;
}

async function listManifestEntries(
  root: string,
  excluded: Set<string>,
  relativePath = '',
  entries: string[] = []
): Promise<string[]> {
  for (const name of (await readdir(resolve(root, relativePath))).toSorted()) {
    const child = relativePath ? join(relativePath, name) : name;
    if (excluded.has(child)) continue;
    entries.push(child);
    const details = await lstat(resolve(root, child));
    if (details.isDirectory() && !details.isSymbolicLink()) {
      await listManifestEntries(root, excluded, child, entries);
    }
  }
  return entries;
}

async function verifyManifestFiles(
  targetRoot: string,
  sourceRoot: string,
  manifest: RootRelocationManifestV1
): Promise<void> {
  const excluded = manifestExclusions(
    {
      root: targetRoot,
      database: resolve(targetRoot, 'poyo-studio.sqlite')
    },
    manifest.databaseMode
  );
  const actual = await listManifestEntries(targetRoot, excluded);
  const expected = manifest.entries.map((entry) => entry.path).toSorted();
  if (JSON.stringify(actual.toSorted()) !== JSON.stringify(expected)) {
    throw new RootRelocationError('manifest_mismatch', 'The relocated file inventory changed.');
  }
  for (const entry of manifest.entries) {
    const target = resolveManifestPath(targetRoot, entry.path);
    const details = await lstat(target);
    if (details.isSymbolicLink()) {
      throw new RootRelocationError('manifest_mismatch', 'The relocated file inventory changed.');
    }
    if (entry.kind === 'directory') {
      if (!details.isDirectory()) {
        throw new RootRelocationError('manifest_mismatch', 'The relocated file inventory changed.');
      }
      if (process.platform !== 'win32' && (details.mode & 0o777) !== entry.mode) {
        throw new RootRelocationError('manifest_mismatch', 'The relocated file mode changed.');
      }
      continue;
    }
    if (
      !details.isFile() ||
      details.size !== entry.size ||
      (process.platform !== 'win32' && (details.mode & 0o777) !== entry.mode)
    ) {
      throw new RootRelocationError('manifest_mismatch', 'The relocated file inventory changed.');
    }
    if (entry.sensitive) {
      const source = resolveManifestPath(sourceRoot, entry.path);
      if (!(await filesEqual(source, target))) {
        throw new RootRelocationError('manifest_mismatch', 'A private relocated file changed.');
      }
    } else {
      const hashed = await hashFile(target);
      if (hashed.sha256 !== entry.sha256) {
        throw new RootRelocationError('manifest_mismatch', 'The relocated file inventory changed.');
      }
    }
  }
}

async function verifySourceStillMatches(
  sourceRoot: string,
  targetRoot: string,
  manifest: RootRelocationManifestV1
): Promise<void> {
  const excluded = manifestExclusions(
    {
      root: sourceRoot,
      database: resolve(sourceRoot, 'poyo-studio.sqlite')
    },
    manifest.databaseMode
  );
  const actual = await listManifestEntries(sourceRoot, excluded);
  const expected = manifest.entries.map((entry) => entry.path).toSorted();
  if (JSON.stringify(actual.toSorted()) !== JSON.stringify(expected)) {
    throw new RootRelocationError('manifest_mismatch', 'The retained source inventory changed.');
  }
  for (const entry of manifest.entries) {
    const source = resolveManifestPath(sourceRoot, entry.path);
    const details = await lstat(source);
    if (
      details.isSymbolicLink() ||
      details.dev !== entry.sourceDevice ||
      details.ino !== entry.sourceInode ||
      (entry.kind === 'directory') !== details.isDirectory()
    ) {
      throw new RootRelocationError('manifest_mismatch', 'The retained source inventory changed.');
    }
    if (entry.kind === 'directory') continue;
    if (!details.isFile() || details.size !== entry.size) {
      throw new RootRelocationError('manifest_mismatch', 'The retained source inventory changed.');
    }
    if (entry.sensitive) {
      if (!(await filesEqual(source, resolveManifestPath(targetRoot, entry.path)))) {
        throw new RootRelocationError('manifest_mismatch', 'A private retained file changed.');
      }
    } else if ((await hashFile(source)).sha256 !== entry.sha256) {
      throw new RootRelocationError('manifest_mismatch', 'The retained source inventory changed.');
    }
  }
}

async function assertSourceRootIdentity(
  root: string,
  manifest: RootRelocationManifestV1
): Promise<void> {
  const details = await pathDetails(root);
  if (
    !details?.isDirectory() ||
    details.isSymbolicLink() ||
    details.dev !== manifest.sourceRootDevice ||
    details.ino !== manifest.sourceRootInode
  ) {
    throw new RootRelocationError(
      'manifest_mismatch',
      'The retained source root identity changed during cleanup.'
    );
  }
}

function sourceCleanupAllowedPaths(manifest: RootRelocationManifestV1): Set<string> {
  const allowed = new Set(manifest.entries.map((entry) => entry.path));
  allowed.add(ROOT_MARKER_FILE);
  for (const entry of manifest.sourceDatabaseEntries) allowed.add(entry.path);
  return allowed;
}

async function verifySourceResidue(
  source: AppPaths,
  targetRoot: string,
  manifest: RootRelocationManifestV1
): Promise<void> {
  await assertSourceRootIdentity(source.root, manifest);
  const actual = await listManifestEntries(source.root, new Set());
  const allowed = sourceCleanupAllowedPaths(manifest);
  if (actual.some((path) => !allowed.has(path))) {
    throw new RootRelocationError('manifest_mismatch', 'The retained source residue changed.');
  }
  const manifestByPath = new Map(
    [...manifest.entries, ...manifest.sourceDatabaseEntries].map((entry) => [entry.path, entry])
  );
  for (const path of actual) {
    const entry = manifestByPath.get(path);
    if (!entry) continue;
    const sourcePath = resolveManifestPath(source.root, path);
    const details = await lstat(sourcePath);
    if (
      details.isSymbolicLink() ||
      details.dev !== entry.sourceDevice ||
      details.ino !== entry.sourceInode ||
      (entry.kind === 'directory') !== details.isDirectory()
    ) {
      throw new RootRelocationError('manifest_mismatch', 'The retained source residue changed.');
    }
    if (entry.kind === 'directory') continue;
    if (!details.isFile() || details.size !== entry.size) {
      throw new RootRelocationError('manifest_mismatch', 'The retained source residue changed.');
    }
    if (entry.sensitive) {
      if (!(await filesEqual(sourcePath, resolveManifestPath(targetRoot, path)))) {
        throw new RootRelocationError('manifest_mismatch', 'A private source residue changed.');
      }
    } else if ((await hashFile(sourcePath)).sha256 !== entry.sha256) {
      throw new RootRelocationError('manifest_mismatch', 'The retained source residue changed.');
    }
  }
}

async function verifyEntryForDeletion(
  path: string,
  targetRoot: string,
  entry: ManifestEntry
): Promise<void> {
  const details = await lstat(path);
  if (
    details.isSymbolicLink() ||
    details.dev !== entry.sourceDevice ||
    details.ino !== entry.sourceInode ||
    (entry.kind === 'directory') !== details.isDirectory()
  ) {
    throw new RootRelocationError('manifest_mismatch', 'A retained source entry changed.');
  }
  if (entry.kind === 'directory') {
    if ((await readdir(path)).length !== 0) {
      throw new RootRelocationError('manifest_mismatch', 'A retained source directory changed.');
    }
  } else {
    if (!details.isFile() || details.size !== entry.size) {
      throw new RootRelocationError('manifest_mismatch', 'A retained source entry changed.');
    }
    if (entry.sensitive) {
      if (!(await filesEqual(path, resolveManifestPath(targetRoot, entry.path)))) {
        throw new RootRelocationError('manifest_mismatch', 'A private retained file changed.');
      }
    } else if ((await hashFile(path)).sha256 !== entry.sha256) {
      throw new RootRelocationError('manifest_mismatch', 'A retained source entry changed.');
    }
  }
  const rechecked = await lstat(path);
  if (
    rechecked.isSymbolicLink() ||
    rechecked.dev !== details.dev ||
    rechecked.ino !== details.ino ||
    rechecked.size !== details.size ||
    rechecked.mtimeMs !== details.mtimeMs ||
    (entry.kind === 'directory') !== rechecked.isDirectory()
  ) {
    throw new RootRelocationError('manifest_mismatch', 'A retained source entry changed.');
  }
}

async function verifySourceMarkerForDeletion(
  markerRoot: string,
  manifest: RootRelocationManifestV1
): Promise<void> {
  const probe = await readRootMarker(markerRoot);
  if (
    probe.status !== 'valid' ||
    probe.marker.state !== 'cleanup-pending' ||
    probe.marker.rootKind !== manifest.sourceRootKind ||
    probe.marker.rootIdentityNonce !== manifest.sourceRootIdentityNonce ||
    probe.marker.generation !== manifest.sourceGeneration ||
    probe.marker.transitionId !== manifest.transitionId ||
    probe.marker.peerRootKind !== manifest.targetRootKind ||
    probe.marker.peerRootIdentityNonce !== manifest.targetRootIdentityNonce
  ) {
    throw new RootRelocationError('manifest_mismatch', 'The retained source marker changed.');
  }
}

function cleanupEntryKey(path: string): string {
  return new Bun.CryptoHasher('sha256').update(path).digest('hex');
}

function cleanupObjectName(relativePath: string, entry: ManifestEntry): string {
  if (relativePath === ROOT_MARKER_FILE) return ROOT_MARKER_FILE;
  return entry.kind === 'directory' ? 'directory' : 'file';
}

async function assertPrivateCleanupDirectory(path: string): Promise<void> {
  const details = await lstat(path);
  if (
    !details.isDirectory() ||
    details.isSymbolicLink() ||
    (process.platform !== 'win32' && (details.mode & 0o077) !== 0)
  ) {
    throw new RootRelocationError('manifest_mismatch', 'The cleanup quarantine is invalid.');
  }
}

async function ensureCleanupQuarantine(sourceRoot: string, transitionId: string): Promise<string> {
  const quarantine = cleanupQuarantinePath(sourceRoot, transitionId);
  const details = await pathDetails(quarantine);
  if (details) {
    await assertPrivateCleanupDirectory(quarantine);
    return quarantine;
  }
  await mkdir(quarantine, { mode: 0o700 });
  if (process.platform !== 'win32') await chmod(quarantine, 0o700);
  await syncDirectory(sourceRoot);
  return quarantine;
}

async function restoreQuarantinedObject(
  quarantined: string,
  sourcePath: string,
  quarantineEntry: string,
  quarantineRoot: string
): Promise<void> {
  if (await pathDetails(sourcePath)) return;
  await rename(quarantined, sourcePath);
  await Promise.all([syncDirectory(dirname(sourcePath)), syncDirectory(quarantineEntry)]);
  await rmdir(quarantineEntry);
  await syncDirectory(quarantineRoot);
}

async function verifyQuarantinedObject(
  quarantineEntry: string,
  quarantined: string,
  targetRoot: string,
  relativePath: string,
  entry: ManifestEntry,
  manifest: RootRelocationManifestV1
): Promise<void> {
  await verifyEntryForDeletion(quarantined, targetRoot, entry);
  if (relativePath === ROOT_MARKER_FILE) {
    await verifySourceMarkerForDeletion(quarantineEntry, manifest);
  }
}

async function deleteQuarantinedObject(
  quarantineEntry: string,
  quarantined: string,
  quarantineRoot: string,
  entry: ManifestEntry,
  hook?: (checkpoint: StartupRelocationCheckpoint) => void | Promise<void>
): Promise<void> {
  if (entry.kind === 'directory') await rmdir(quarantined);
  else await unlink(quarantined);
  await syncDirectory(quarantineEntry);
  await rmdir(quarantineEntry);
  await syncDirectory(quarantineRoot);
  await hook?.('source-entry-unlinked');
}

async function recoverCleanupQuarantine(
  source: AppPaths,
  targetRoot: string,
  manifest: RootRelocationManifestV1,
  hook?: (checkpoint: StartupRelocationCheckpoint) => void | Promise<void>
): Promise<void> {
  const quarantineRoot = cleanupQuarantinePath(source.root, manifest.transitionId);
  const quarantineDetails = await pathDetails(quarantineRoot);
  if (!quarantineDetails) return;
  await assertPrivateCleanupDirectory(quarantineRoot);
  const manifestByPath = new Map(
    [...manifest.entries, ...manifest.sourceDatabaseEntries].map((entry) => [entry.path, entry])
  );
  const pathByKey = new Map(
    [...sourceCleanupAllowedPaths(manifest)].map((path) => [cleanupEntryKey(path), path])
  );
  for (const key of await readdir(quarantineRoot)) {
    const relativePath = pathByKey.get(key);
    if (!relativePath) {
      throw new RootRelocationError('manifest_mismatch', 'The cleanup quarantine is invalid.');
    }
    const entry = manifestByPath.get(relativePath);
    if (!entry) {
      throw new RootRelocationError('manifest_mismatch', 'The cleanup allowlist is invalid.');
    }
    const quarantineEntry = resolveManifestPath(quarantineRoot, key);
    await assertPrivateCleanupDirectory(quarantineEntry);
    const objectName = cleanupObjectName(relativePath, entry);
    const quarantined = resolveManifestPath(quarantineEntry, objectName);
    const sourcePath = resolveManifestPath(source.root, relativePath);
    const names = await readdir(quarantineEntry);
    if (names.some((name) => name !== objectName) || names.length > 1) {
      throw new RootRelocationError('manifest_mismatch', 'The cleanup quarantine is invalid.');
    }
    const quarantinedDetails = await pathDetails(quarantined);
    const sourceDetails = await pathDetails(sourcePath);
    if (quarantinedDetails && sourceDetails) {
      throw new RootRelocationError('manifest_mismatch', 'A retained source entry changed.');
    }
    if (quarantinedDetails) {
      try {
        await verifyQuarantinedObject(
          quarantineEntry,
          quarantined,
          targetRoot,
          relativePath,
          entry,
          manifest
        );
      } catch (error) {
        await restoreQuarantinedObject(quarantined, sourcePath, quarantineEntry, quarantineRoot);
        throw error;
      }
      await deleteQuarantinedObject(quarantineEntry, quarantined, quarantineRoot, entry, hook);
    } else {
      await rmdir(quarantineEntry);
      await syncDirectory(quarantineRoot);
    }
  }
  if ((await readdir(quarantineRoot)).length !== 0) {
    throw new RootRelocationError('manifest_mismatch', 'The cleanup quarantine is invalid.');
  }
  await rmdir(quarantineRoot);
  await syncDirectory(source.root);
}

async function quarantineAndDeleteEntry(
  source: AppPaths,
  targetRoot: string,
  manifest: RootRelocationManifestV1,
  relativePath: string,
  entry: ManifestEntry,
  hook?: (checkpoint: StartupRelocationCheckpoint) => void | Promise<void>
): Promise<void> {
  const sourcePath = resolveManifestPath(source.root, relativePath);
  if (relativePath === ROOT_MARKER_FILE) {
    await verifySourceMarkerForDeletion(source.root, manifest);
  }
  await verifyEntryForDeletion(sourcePath, targetRoot, entry);
  const quarantineRoot = await ensureCleanupQuarantine(source.root, manifest.transitionId);
  const quarantineEntry = resolveManifestPath(quarantineRoot, cleanupEntryKey(relativePath));
  if (await pathDetails(quarantineEntry)) {
    throw new RootRelocationError('manifest_mismatch', 'The cleanup quarantine is invalid.');
  }
  await mkdir(quarantineEntry, { mode: 0o700 });
  if (process.platform !== 'win32') await chmod(quarantineEntry, 0o700);
  await syncDirectory(quarantineRoot);
  const quarantined = resolveManifestPath(quarantineEntry, cleanupObjectName(relativePath, entry));
  await hook?.('source-entry-before-quarantine');
  await rename(sourcePath, quarantined);
  await Promise.all([syncDirectory(dirname(sourcePath)), syncDirectory(quarantineEntry)]);
  await hook?.('source-entry-quarantined');
  try {
    await verifyQuarantinedObject(
      quarantineEntry,
      quarantined,
      targetRoot,
      relativePath,
      entry,
      manifest
    );
  } catch (error) {
    await restoreQuarantinedObject(quarantined, sourcePath, quarantineEntry, quarantineRoot);
    throw error;
  }
  await deleteQuarantinedObject(quarantineEntry, quarantined, quarantineRoot, entry, hook);
}

async function refreshSourceDatabaseEntries(
  sourceRoot: string,
  manifest: RootRelocationManifestV1
): Promise<ManifestFile[]> {
  const refreshed: ManifestFile[] = [];
  for (const entry of manifest.sourceDatabaseEntries.filter(
    (candidate) => candidate.path !== ROOT_MARKER_FILE
  )) {
    const path = resolveManifestPath(sourceRoot, entry.path);
    const details = await pathDetails(path);
    if (!details) continue;
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.nlink > 1 ||
      details.dev !== entry.sourceDevice ||
      details.ino !== entry.sourceInode
    ) {
      throw new RootRelocationError('manifest_mismatch', 'A managed database file changed.');
    }
    const hashed = await hashFile(path);
    const rechecked = await lstat(path);
    if (
      !rechecked.isFile() ||
      rechecked.isSymbolicLink() ||
      rechecked.dev !== details.dev ||
      rechecked.ino !== details.ino ||
      rechecked.size !== hashed.size ||
      rechecked.mtimeMs !== details.mtimeMs
    ) {
      throw new RootRelocationError('manifest_mismatch', 'A managed database file changed.');
    }
    refreshed.push({ ...entry, size: hashed.size, sha256: hashed.sha256 });
  }
  const markerPath = resolveManifestPath(sourceRoot, ROOT_MARKER_FILE);
  const markerDetails = await lstat(markerPath);
  if (!markerDetails.isFile() || markerDetails.isSymbolicLink() || markerDetails.nlink > 1) {
    throw new RootRelocationError('manifest_mismatch', 'The retained source marker changed.');
  }
  const markerHash = await hashFile(markerPath);
  const markerRechecked = await lstat(markerPath);
  if (
    !markerRechecked.isFile() ||
    markerRechecked.isSymbolicLink() ||
    markerRechecked.dev !== markerDetails.dev ||
    markerRechecked.ino !== markerDetails.ino ||
    markerRechecked.size !== markerHash.size ||
    markerRechecked.mtimeMs !== markerDetails.mtimeMs
  ) {
    throw new RootRelocationError('manifest_mismatch', 'The retained source marker changed.');
  }
  refreshed.push({
    path: ROOT_MARKER_FILE,
    kind: 'file',
    mode: privateMode(markerDetails.mode, false),
    size: markerHash.size,
    sha256: markerHash.sha256,
    sensitive: false,
    sourceDevice: markerDetails.dev,
    sourceInode: markerDetails.ino
  });
  return refreshed;
}

async function removeSourceEntries(
  source: AppPaths,
  targetRoot: string,
  manifest: RootRelocationManifestV1,
  hook?: (checkpoint: StartupRelocationCheckpoint) => void | Promise<void>
): Promise<void> {
  await assertSourceRootIdentity(source.root, manifest);
  await recoverCleanupQuarantine(source, targetRoot, manifest, hook);
  const manifestByPath = new Map(
    [...manifest.entries, ...manifest.sourceDatabaseEntries].map((entry) => [entry.path, entry])
  );
  const allowed = sourceCleanupAllowedPaths(manifest);
  const paths = [...allowed].toSorted((left, right) => {
    const depth = right.split(sep).length - left.split(sep).length;
    return depth || left.localeCompare(right);
  });
  for (const relativePath of paths) {
    await assertSourceRootIdentity(source.root, manifest);
    const child = resolveManifestPath(source.root, relativePath);
    const details = await pathDetails(child);
    if (!details) continue;
    const entry = manifestByPath.get(relativePath);
    if (!entry) {
      throw new RootRelocationError('manifest_mismatch', 'The cleanup allowlist is invalid.');
    }
    if ((entry.kind === 'directory') !== details.isDirectory()) {
      throw new RootRelocationError('manifest_mismatch', 'A retained source entry changed.');
    }
    await quarantineAndDeleteEntry(source, targetRoot, manifest, relativePath, entry, hook);
  }
  const cleanupQuarantine = cleanupQuarantinePath(source.root, manifest.transitionId);
  if (await pathDetails(cleanupQuarantine)) {
    await recoverCleanupQuarantine(source, targetRoot, manifest, hook);
  }
  await assertSourceRootIdentity(source.root, manifest);
  if ((await readdir(source.root)).length !== 0) {
    throw new RootRelocationError('manifest_mismatch', 'The retained source residue changed.');
  }
  const rootQuarantine = cleanupRootQuarantinePath(source.root, manifest.transitionId);
  if (await pathDetails(rootQuarantine)) {
    throw new RootRelocationError('manifest_mismatch', 'The cleanup quarantine is invalid.');
  }
  await hook?.('source-entry-before-quarantine');
  await rename(source.root, rootQuarantine);
  await syncDirectory(dirname(source.root));
  await hook?.('source-entry-quarantined');
  const moved = await lstat(rootQuarantine);
  if (
    !moved.isDirectory() ||
    moved.isSymbolicLink() ||
    moved.dev !== manifest.sourceRootDevice ||
    moved.ino !== manifest.sourceRootInode ||
    (await readdir(rootQuarantine)).length !== 0
  ) {
    if (!(await pathDetails(source.root))) {
      await rename(rootQuarantine, source.root);
      await syncDirectory(dirname(source.root));
    }
    throw new RootRelocationError('manifest_mismatch', 'The retained source root changed.');
  }
  await rmdir(rootQuarantine);
  await syncDirectory(dirname(source.root));
  await hook?.('source-entry-unlinked');
}

async function recoverSourceRootQuarantine(
  source: AppPaths,
  manifest: RootRelocationManifestV1,
  hook?: (checkpoint: StartupRelocationCheckpoint) => void | Promise<void>
): Promise<void> {
  const rootQuarantine = cleanupRootQuarantinePath(source.root, manifest.transitionId);
  const quarantined = await pathDetails(rootQuarantine);
  if (!quarantined) return;
  if (await pathDetails(source.root)) {
    throw new RootRelocationError('manifest_mismatch', 'The cleanup quarantine is invalid.');
  }
  if (
    !quarantined.isDirectory() ||
    quarantined.isSymbolicLink() ||
    quarantined.dev !== manifest.sourceRootDevice ||
    quarantined.ino !== manifest.sourceRootInode ||
    (await readdir(rootQuarantine)).length !== 0
  ) {
    await rename(rootQuarantine, source.root);
    await syncDirectory(dirname(source.root));
    throw new RootRelocationError('manifest_mismatch', 'The retained source root changed.');
  }
  await rmdir(rootQuarantine);
  await syncDirectory(dirname(source.root));
  await hook?.('source-entry-unlinked');
}

async function availableBytes(path: string): Promise<number> {
  let candidate = path;
  while (!(await pathDetails(candidate))) {
    const parent = dirname(candidate);
    if (parent === candidate) return 0;
    candidate = parent;
  }
  const stats = await statfs(candidate);
  return stats.bavail * stats.bsize;
}

async function estimateRelocationBytes(
  paths: AppPaths,
  databaseMode: 'managed' | 'external',
  relativePath = ''
): Promise<number> {
  const excluded = manifestExclusions(paths, databaseMode);
  let bytes = 0;
  for (const name of await readdir(resolve(paths.root, relativePath))) {
    const child = relativePath ? join(relativePath, name) : name;
    if (excluded.has(child)) continue;
    const details = await lstat(resolve(paths.root, child));
    if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) {
      throw new RootRelocationError(
        'unsafe_source_entry',
        'A root-owned entry is not safely relocatable.'
      );
    }
    if (details.isFile()) {
      if (details.nlink > 1) {
        throw new RootRelocationError(
          'hardlink_rejected',
          'A root-owned hard link is not relocatable.'
        );
      }
      bytes += details.size;
    } else {
      bytes += await estimateRelocationBytes(paths, databaseMode, child);
    }
  }
  if (relativePath === '' && databaseMode === 'managed') {
    bytes += (await lstat(paths.database)).size;
  }
  return bytes;
}

async function assertAvailableSpace(paths: AppPaths, topology: RelocationTopology): Promise<void> {
  const estimated = await estimateRelocationBytes(paths, topology.databaseMode);
  const required = Math.ceil(estimated * 1.1) + 1024 * 1024;
  if ((await availableBytes(dirname(topology.target.canonicalPath))) < required) {
    throw new RootRelocationError(
      'insufficient_space',
      'The target filesystem does not have enough available space.'
    );
  }
}

async function removeEmptyTarget(path: string): Promise<void> {
  const details = await pathDetails(path);
  if (!details) return;
  if (!details.isDirectory() || details.isSymbolicLink() || (await readdir(path)).length !== 0) {
    throw new RootRelocationError('target_changed', 'The target root changed after preflight.');
  }
  await rm(path, { recursive: false });
  await syncDirectory(dirname(path));
}

function targetPathsInStage(paths: AppPaths, stage: string): AppPaths {
  const relocate = (path: string) => {
    const child = relativeIfWithin(paths.root, path);
    return child === null ? path : resolve(stage, child);
  };
  return {
    ...paths,
    root: stage,
    database: relocate(paths.database),
    media: relocate(paths.media),
    ...(paths.defaultMedia ? { defaultMedia: relocate(paths.defaultMedia) } : {}),
    ...(paths.mediaReadRoots ? { mediaReadRoots: paths.mediaReadRoots.map(relocate) } : {}),
    uploads: relocate(paths.uploads),
    thumbnails: relocate(paths.thumbnails),
    logs: relocate(paths.logs),
    secrets: relocate(paths.secrets),
    temporary: relocate(paths.temporary)
  };
}

async function snapshotManagedDatabase(
  sourceDatabase: Database,
  stageDatabasePath: string,
  sourceRoot: string,
  targetRoot: string,
  platform: NodeJS.Platform
): Promise<{ schemaVersion: number; schemaSignature: string; rowCounts: Record<string, number> }> {
  try {
    sourceDatabase.query('VACUUM INTO ?').run(stageDatabasePath);
    if (process.platform !== 'win32') await chmod(stageDatabasePath, 0o600);
    const target = new Database(stageDatabasePath, { strict: true });
    try {
      target.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
      rebasePersistedPaths(target, sourceRoot, targetRoot, { platform });
      const schemaVersion = target
        .query<{ version: number }, []>(
          'SELECT COALESCE(MAX(version),0) version FROM schema_migrations'
        )
        .get()?.version;
      if (!schemaVersion) {
        throw new RootRelocationError('database_invalid', 'The snapshot schema is invalid.');
      }
      verifyDatabase(target, schemaVersion, null, sourceRoot);
      return {
        schemaVersion,
        schemaSignature: databaseSchemaSignature(target),
        rowCounts: databaseRowCounts(target)
      };
    } finally {
      target.close();
    }
  } catch (error) {
    if (error instanceof RootRelocationError) throw error;
    throw new RootRelocationError('snapshot_failed', 'The database snapshot could not be created.');
  }
}

async function verifyPreparedDatabase(
  paths: AppPaths,
  manifest: RootRelocationManifestV1
): Promise<void> {
  if (manifest.databaseMode === 'external') return;
  const database = new Database(
    paths.database,
    sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOMUTEX
  );
  try {
    verifyDatabase(
      database,
      manifest.databaseSchemaVersion,
      manifest.databaseRowCounts,
      undefined,
      manifest.databaseSchemaSignature
    );
  } finally {
    database.close();
  }
}

async function verifyPreparedPersistedExternalResources(
  source: AppPaths,
  target: AppPaths,
  manifest: RootRelocationManifestV1,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const database = new Database(
    target.database,
    sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_NOMUTEX
  );
  try {
    await verifyPersistedExternalResourceIdentities(
      database,
      source,
      target,
      manifest.persistedExternalResources,
      platform
    );
  } finally {
    database.close();
  }
}

async function checkpoint(
  hook: RootRelocationCoordinatorOptions['checkpoint'],
  name: RelocationCheckpoint
): Promise<void> {
  await hook?.(name);
}

export class RootRelocationCoordinator {
  constructor(private readonly options: RootRelocationCoordinatorOptions) {}

  async relocate(initiator: MaintenanceInitiatorPermit): Promise<RootRelocationResult> {
    const platform = this.options.platform ?? process.platform;
    let topology: RelocationTopology;
    let persistedExternalResources: PersistedExternalResourceIdentity[];
    let sourceMarker: RootMarkerV1;
    let transitionId: string;
    let targetIdentity: string;
    let stage: string;
    let targetMarker: RootMarkerV1;
    let sourceIntent: RootMarkerV1;
    try {
      topology = await assertRelocationTopology({
        source: this.options.source,
        target: this.options.target,
        environment: this.options.environment,
        platform
      });
      persistedExternalResources = await assertPersistedPathTopology(
        this.options.database,
        this.options.source,
        this.options.target,
        topology,
        platform
      );
      await assertAvailableSpace(this.options.source, topology);
      const sourceProbe = await readRootMarker(this.options.source.root);
      if (
        sourceProbe.status !== 'valid' ||
        sourceProbe.marker.state !== 'active' ||
        sourceProbe.marker.peerRootKind !== null ||
        sourceProbe.marker.rootKind !== this.options.source.rootKind
      ) {
        throw new RootRelocationError('source_not_active', 'The current root is not relocatable.');
      }
      sourceMarker = sourceProbe.marker;
      transitionId = crypto.randomUUID();
      targetIdentity = crypto.randomUUID();
      stage = stagePath(this.options.target.root, transitionId);
      targetMarker = {
        version: 1,
        rootKind: this.options.target.rootKind as AppRootKind,
        rootIdentityNonce: targetIdentity,
        generation: sourceMarker.generation + 1,
        transitionId,
        state: 'prepared',
        peerRootKind: sourceMarker.rootKind,
        peerRootIdentityNonce: sourceMarker.rootIdentityNonce,
        rebasePhase: topology.databaseMode === 'external' ? 'pending' : 'complete',
        safeErrorCode: null,
        schemaSignatureId: ROOT_SCHEMA_SIGNATURE_ID
      };
      sourceIntent = {
        ...sourceMarker,
        transitionId,
        state: 'active-intent',
        peerRootKind: targetMarker.rootKind,
        peerRootIdentityNonce: targetIdentity,
        rebasePhase: targetMarker.rebasePhase,
        safeErrorCode: null
      };
    } catch (error) {
      initiator.release();
      throw error;
    }
    let lease: ExclusiveMaintenanceLease | null = null;
    let sourceIntentWritten = false;
    let targetPublished = false;
    let createdStageProof: StageIdentityProof | null = null;
    try {
      lease = await this.options.gate.upgradeToExclusiveMaintenance(initiator);
      await checkpoint(this.options.checkpoint, 'exclusive-acquired');
      topology = await assertRelocationTopology({
        source: this.options.source,
        target: this.options.target,
        environment: this.options.environment,
        platform
      });
      persistedExternalResources = await assertPersistedPathTopology(
        this.options.database,
        this.options.source,
        this.options.target,
        topology,
        platform
      );
      await assertAvailableSpace(this.options.source, topology);
      if (await pathDetails(stage)) {
        throw new RootRelocationError('stage_conflict', 'A relocation stage already exists.');
      }
      await removeEmptyTarget(this.options.target.root);
      await mkdir(dirname(stage), { recursive: true });
      await mkdir(stage, { mode: 0o700 });
      if (process.platform !== 'win32') await chmod(stage, 0o700);
      const createdStage = await lstat(stage);
      await writePrivateJson(join(stage, STAGE_OWNER_FILE), {
        version: 1,
        transitionId,
        targetRootIdentityNonce: targetIdentity,
        stageDevice: createdStage.dev,
        stageInode: createdStage.ino,
        ownerNonce: crypto.randomUUID()
      });
      const createdOwner = await lstat(join(stage, STAGE_OWNER_FILE));
      createdStageProof = await verifyQuarantinedStage(
        stage,
        { transitionId, targetRootIdentityNonce: targetIdentity },
        {
          stageDevice: createdStage.dev,
          stageInode: createdStage.ino,
          ownerDevice: createdOwner.dev,
          ownerInode: createdOwner.ino
        },
        null
      );
      await checkpoint(this.options.checkpoint, 'stage-created');

      const stagePaths = targetPathsInStage(this.options.target, stage);
      const copy: CopyContext = {
        sourceRoot: this.options.source.root,
        targetRoot: stage,
        excluded: manifestExclusions(this.options.source, topology.databaseMode),
        sensitiveRoot: isWithin(this.options.source.root, this.options.source.secrets)
          ? this.options.source.secrets
          : null,
        entries: []
      };
      await copyTree(copy);
      await checkpoint(this.options.checkpoint, 'files-copied');

      let databaseSchemaVersion = DATABASE_SCHEMA_VERSION;
      let schemaSignature = databaseSchemaSignature(this.options.database);
      let rowCounts: Record<string, number> | null = null;
      if (topology.databaseMode === 'managed') {
        const snapshot = await snapshotManagedDatabase(
          this.options.database,
          stagePaths.database,
          this.options.source.root,
          this.options.target.root,
          platform
        );
        databaseSchemaVersion = snapshot.schemaVersion;
        schemaSignature = snapshot.schemaSignature;
        rowCounts = snapshot.rowCounts;
        await checkpoint(this.options.checkpoint, 'database-snapshotted');
        await checkpoint(this.options.checkpoint, 'paths-rebased');
      } else {
        databaseSchemaVersion =
          this.options.database
            .query<{ version: number }, []>(
              'SELECT COALESCE(MAX(version),0) version FROM schema_migrations'
            )
            .get()?.version ?? 0;
      }
      const databaseEntries = await sourceDatabaseEntries(
        this.options.source,
        topology.databaseMode,
        this.options.database
      );
      const manifest: RootRelocationManifestV1 = {
        version: 1,
        schemaSignatureId: ROOT_SCHEMA_SIGNATURE_ID,
        transitionId,
        sourceRootKind: sourceMarker.rootKind,
        targetRootKind: targetMarker.rootKind,
        sourceRootIdentityNonce: sourceMarker.rootIdentityNonce,
        sourceRootDevice: topology.source.nearestDevice,
        sourceRootInode: topology.source.nearestInode,
        targetRootIdentityNonce: targetIdentity,
        stageDevice: createdStageProof.stageDevice,
        stageInode: createdStageProof.stageInode,
        stageOwnerDevice: createdStageProof.ownerDevice,
        stageOwnerInode: createdStageProof.ownerInode,
        stageOwnerNonce: createdStageProof.owner.ownerNonce,
        sourceGeneration: sourceMarker.generation,
        targetGeneration: targetMarker.generation,
        databaseMode: topology.databaseMode,
        databaseSchemaVersion,
        databaseSchemaSignature: schemaSignature,
        databaseRowCounts: rowCounts,
        cleanupPhase: 'source-retained',
        externalResources: topology.externalResources,
        persistedExternalResources,
        entries: copy.entries.toSorted((left, right) => left.path.localeCompare(right.path)),
        sourceDatabaseEntries: databaseEntries.toSorted((left, right) =>
          left.path.localeCompare(right.path)
        )
      };
      await writePrivateJson(join(stage, ROOT_RELOCATION_MANIFEST_FILE), manifest);
      await checkpoint(this.options.checkpoint, 'manifest-written');
      await writeRootMarker(stage, targetMarker);
      await checkpoint(this.options.checkpoint, 'prepared-marker-written');
      await verifyManifestFiles(stage, this.options.source.root, manifest);
      await verifyPreparedDatabase(stagePaths, manifest);
      await verifyExternalResourceIdentities(
        this.options.environment,
        manifest.externalResources,
        platform
      );
      await writeRootMarker(this.options.source.root, sourceIntent);
      sourceIntentWritten = true;
      await checkpoint(this.options.checkpoint, 'source-intent-written');
      const stableGeneration = this.options.gate.status().writerGeneration;
      await rename(stage, this.options.target.root);
      targetPublished = true;
      await checkpoint(this.options.checkpoint, 'target-published');
      await syncDirectory(dirname(this.options.target.root));
      await checkpoint(this.options.checkpoint, 'target-parent-synced');
      await rm(join(this.options.target.root, STAGE_OWNER_FILE));
      await syncDirectory(this.options.target.root);
      if (this.options.gate.status().writerGeneration !== stableGeneration) {
        throw new RootRelocationError(
          'target_changed',
          'Writer admission changed during publication.'
        );
      }
      lease.freezeUntilRestart();
      lease = null;
      return {
        transitionId,
        targetRootKind: targetMarker.rootKind,
        restartRequired: true
      };
    } catch (error) {
      const activeLease = lease;
      if (activeLease) {
        if (targetPublished) {
          activeLease.freezeUntilRestart();
          lease = null;
          throw new RootRelocationError(
            'restart_required',
            'Relocation publication requires restart recovery.'
          );
        }
        try {
          await quarantineAndRemoveStage({
            targetRoot: this.options.target.root,
            transitionId,
            targetRootIdentityNonce: targetIdentity,
            createdProof: createdStageProof,
            ...(this.options.checkpoint ? { checkpoint: this.options.checkpoint } : {})
          });
          if (sourceIntentWritten) await writeRootMarker(this.options.source.root, sourceMarker);
          await this.options.resumeBeforePublication?.();
          activeLease.reopenBeforePublication();
          lease = null;
        } catch {
          activeLease.freezeUntilRestart();
          lease = null;
          throw new RootRelocationError(
            'rollback_incomplete',
            'Relocation rollback requires a restart.'
          );
        }
      }
      throw error;
    }
  }
}

function markerPair(selection: StartupRootSelection): {
  source: RootMarkerV1;
  target: RootMarkerV1;
} | null {
  const markers = [selection.projectProbe, selection.platformProbe]
    .filter((probe) => probe.status === 'valid')
    .map((probe) => (probe.status === 'valid' ? probe.marker : null))
    .filter((marker): marker is RootMarkerV1 => marker !== null)
    .toSorted((left, right) => left.generation - right.generation);
  const [source, target] = markers;
  return markers.length === 2 && source && target ? { source, target } : null;
}

function candidateForKind(
  candidates: { project: AppPaths; platform: AppPaths },
  kind: AppRootKind
): AppPaths {
  return kind === 'project' ? candidates.project : candidates.platform;
}

async function quarantineTarget(paths: AppPaths, marker: RootMarkerV1): Promise<void> {
  const quarantine = quarantinePath(paths.root, marker.transitionId);
  if (await pathDetails(quarantine)) {
    throw new RootRelocationError('rollback_incomplete', 'A failed target needs manual recovery.');
  }
  await rename(paths.root, quarantine);
  await syncDirectory(dirname(paths.root));
}

async function readLoneActiveManifest(
  target: AppPaths,
  marker: RootMarkerV1,
  environment: Record<string, string | undefined>
): Promise<RootRelocationManifestV1 | null> {
  const manifestPath = join(target.root, ROOT_RELOCATION_MANIFEST_FILE);
  const manifestDetails = await pathDetails(manifestPath);
  if (!manifestDetails) {
    if (marker.peerRootKind !== null) {
      throw new RootRelocationError('manifest_invalid', 'The active target manifest is missing.');
    }
    return null;
  }
  const manifest = await readManifest(target.root);
  if (
    marker.rootKind !== manifest.targetRootKind ||
    marker.rootIdentityNonce !== manifest.targetRootIdentityNonce ||
    marker.generation !== manifest.targetGeneration ||
    marker.transitionId !== manifest.transitionId ||
    (marker.peerRootKind !== null &&
      (marker.peerRootKind !== manifest.sourceRootKind ||
        marker.peerRootIdentityNonce !== manifest.sourceRootIdentityNonce))
  ) {
    throw new RootRelocationError('manifest_invalid', 'The active target manifest is invalid.');
  }
  await verifyExternalResourceIdentities(environment, manifest.externalResources);
  if (
    marker.peerRootKind === null &&
    manifest.cleanupPhase !== 'target-finalization-pending' &&
    manifest.cleanupPhase !== 'source-removed'
  ) {
    throw new RootRelocationError(
      'manifest_invalid',
      'The active target cleanup phase is invalid.'
    );
  }
  return manifest;
}

function sourceMarkerFromManifest(manifest: RootRelocationManifestV1): RootMarkerV1 {
  return {
    version: 1,
    rootKind: manifest.sourceRootKind,
    rootIdentityNonce: manifest.sourceRootIdentityNonce,
    generation: manifest.sourceGeneration,
    transitionId: manifest.transitionId,
    state: 'cleanup-pending',
    peerRootKind: manifest.targetRootKind,
    peerRootIdentityNonce: manifest.targetRootIdentityNonce,
    rebasePhase: 'complete',
    safeErrorCode: null,
    schemaSignatureId: ROOT_SCHEMA_SIGNATURE_ID
  };
}

async function removeOwnedStage(
  target: AppPaths,
  sourceMarker: RootMarkerV1,
  checkpointHook?: (checkpoint: RelocationCheckpoint) => void | Promise<void>
): Promise<void> {
  if (!sourceMarker.peerRootIdentityNonce) {
    throw new RootRelocationError('rollback_incomplete', 'Stage ownership is incomplete.');
  }
  await quarantineAndRemoveStage({
    targetRoot: target.root,
    transitionId: sourceMarker.transitionId,
    targetRootIdentityNonce: sourceMarker.peerRootIdentityNonce,
    ...(checkpointHook ? { checkpoint: checkpointHook } : {})
  });
}

async function removePublishedStageOwner(
  target: AppPaths,
  targetMarker: RootMarkerV1
): Promise<void> {
  const ownerPath = join(target.root, STAGE_OWNER_FILE);
  const ownerDetails = await pathDetails(ownerPath);
  if (!ownerDetails) return;
  try {
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as {
      transitionId?: unknown;
      targetRootIdentityNonce?: unknown;
    };
    if (
      owner.transitionId !== targetMarker.transitionId ||
      owner.targetRootIdentityNonce !== targetMarker.rootIdentityNonce
    ) {
      throw new Error('owner mismatch');
    }
  } catch {
    throw new RootRelocationError('manifest_invalid', 'Published stage ownership is invalid.');
  }
  await rm(ownerPath);
  await syncDirectory(target.root);
}

async function rollbackExternalDatabase(
  source: AppPaths,
  target: AppPaths,
  manifest: RootRelocationManifestV1
): Promise<void> {
  if (manifest.databaseMode !== 'external') return;
  const database = new Database(source.database, { strict: true });
  try {
    database.exec('PRAGMA foreign_keys=ON;');
    rebasePersistedPaths(database, target.root, source.root);
    if (findPersistedPathsUnderRoot(database, target.root).length > 0) {
      throw new RootRelocationError(
        'rollback_incomplete',
        'External database rollback is incomplete.'
      );
    }
  } finally {
    database.close();
  }
}

export async function resolveStartupRelocation(options: {
  selection: StartupRootSelection;
  candidates: { project: AppPaths; platform: AppPaths };
  environment: Record<string, string | undefined>;
  checkpoint?: (checkpoint: RelocationCheckpoint) => void | Promise<void>;
}): Promise<StartupRelocationContext> {
  const pair = markerPair(options.selection);
  if (options.selection.decision.mode === 'initialize') {
    return {
      kind: 'ordinary',
      paths: options.selection.paths,
      source: null,
      target: null,
      sourceMarker: null,
      targetMarker: null,
      manifest: null
    };
  }
  if (!pair && options.selection.decision.mode === 'normal') {
    const lone =
      options.selection.projectProbe.status === 'valid'
        ? options.selection.projectProbe.marker
        : options.selection.platformProbe.status === 'valid'
          ? options.selection.platformProbe.marker
          : null;
    if (lone?.state !== 'active') {
      throw new RootRelocationError('manifest_invalid', 'The active root marker is invalid.');
    }
    const target = candidateForKind(options.candidates, lone.rootKind);
    const manifest = await readLoneActiveManifest(target, lone, options.environment);
    if (manifest) {
      const source = candidateForKind(options.candidates, manifest.sourceRootKind);
      return {
        kind: 'cleanup',
        paths: target,
        source,
        target,
        sourceMarker: sourceMarkerFromManifest(manifest),
        targetMarker: lone,
        manifest
      };
    }
    return {
      kind: 'ordinary',
      paths: target,
      source: null,
      target: null,
      sourceMarker: null,
      targetMarker: null,
      manifest: null
    };
  }
  if (!pair) {
    const lone =
      options.selection.projectProbe.status === 'valid'
        ? options.selection.projectProbe.marker
        : options.selection.platformProbe.status === 'valid'
          ? options.selection.platformProbe.marker
          : null;
    if (
      lone?.state === 'active-intent' &&
      lone.peerRootKind &&
      lone.peerRootIdentityNonce &&
      options.selection.decision.action === 'restore-source'
    ) {
      const source = candidateForKind(options.candidates, lone.rootKind);
      const target = candidateForKind(options.candidates, lone.peerRootKind);
      await removeOwnedStage(target, lone, options.checkpoint);
      await writeRootMarker(source.root, markerForActiveSource(lone, 'relocation_rollback'));
      return {
        kind: 'ordinary',
        paths: source,
        source: null,
        target: null,
        sourceMarker: null,
        targetMarker: null,
        manifest: null
      };
    }
    throw new RootRelocationError('manifest_invalid', 'The relocation marker pair is incomplete.');
  }
  const source = candidateForKind(options.candidates, pair.source.rootKind);
  const target = candidateForKind(options.candidates, pair.target.rootKind);
  const manifest = await readManifest(target.root);
  if (!markerMatchesManifest(pair.source, pair.target, manifest)) {
    throw new RootRelocationError('manifest_invalid', 'The relocation marker pair is invalid.');
  }

  if (options.selection.decision.action === 'repair-source-intent') {
    const repaired: RootMarkerV1 = { ...pair.source, state: 'active-intent' };
    await writeRootMarker(source.root, repaired);
    pair.source = repaired;
    return {
      kind: 'provisional',
      paths: target,
      source,
      target,
      sourceMarker: repaired,
      targetMarker: pair.target,
      manifest
    };
  }
  if (
    options.selection.decision.action === 'restore-source' ||
    options.selection.decision.action === 'quarantine-target'
  ) {
    await rollbackExternalDatabase(source, target, manifest);
    await writeRootMarker(source.root, markerForActiveSource(pair.source, 'relocation_rollback'));
    await quarantineTarget(target, pair.target);
    return {
      kind: 'ordinary',
      paths: source,
      source: null,
      target: null,
      sourceMarker: null,
      targetMarker: null,
      manifest: null
    };
  }
  if (options.selection.decision.mode === 'provisional') {
    return {
      kind: 'provisional',
      paths: target,
      source,
      target,
      sourceMarker: pair.source,
      targetMarker: pair.target,
      manifest
    };
  }
  if (options.selection.decision.action === 'cleanup-source') {
    return {
      kind: 'cleanup',
      paths: target,
      source,
      target,
      sourceMarker: pair.source,
      targetMarker: pair.target,
      manifest
    };
  }
  throw new RootRelocationError('manifest_invalid', 'The relocation startup state is unsupported.');
}

function requireRelocationContext(context: StartupRelocationContext) {
  if (
    !context.source ||
    !context.target ||
    !context.sourceMarker ||
    !context.targetMarker ||
    !context.manifest
  ) {
    throw new RootRelocationError('manifest_invalid', 'The relocation context is incomplete.');
  }
  return {
    source: context.source,
    target: context.target,
    sourceMarker: context.sourceMarker,
    targetMarker: context.targetMarker,
    manifest: context.manifest
  };
}

export async function beginProvisionalActivation(
  context: StartupRelocationContext,
  environment: Record<string, string | undefined>
): Promise<void> {
  const state = requireRelocationContext(context);
  await verifyExternalResourceIdentities(environment, state.manifest.externalResources);
  await verifyManifestFiles(state.target.root, state.source.root, state.manifest);
  await verifyPreparedDatabase(state.target, state.manifest);
  await verifyPreparedPersistedExternalResources(state.source, state.target, state.manifest);
  await removePublishedStageOwner(state.target, state.targetMarker);
  await writeRootMarker(state.target.root, { ...state.targetMarker, state: 'activating' });
  context.targetMarker = { ...state.targetMarker, state: 'activating' };
}

export function applyExternalDatabaseRebase(
  context: StartupRelocationContext,
  database: Database
): void {
  const state = requireRelocationContext(context);
  if (state.manifest.databaseMode !== 'external') return;
  rebasePersistedPaths(database, state.source.root, state.target.root);
  verifyDatabase(
    database,
    state.manifest.databaseSchemaVersion,
    null,
    state.source.root,
    state.manifest.databaseSchemaSignature
  );
}

async function promoteAndCleanup(
  context: StartupRelocationContext,
  database: Database,
  hook?: (checkpoint: StartupRelocationCheckpoint) => void | Promise<void>
): Promise<RootRelocationManifestV1['cleanupPhase'] | 'complete'> {
  const state = requireRelocationContext(context);
  let durableManifest = state.manifest;
  let cleanupPhase: RootRelocationManifestV1['cleanupPhase'] | 'complete' =
    durableManifest.cleanupPhase;
  const setCleanupPhase = async (
    phase: RootRelocationManifestV1['cleanupPhase'],
    updates: Partial<RootRelocationManifestV1> = {}
  ) => {
    const manifest = { ...durableManifest, ...updates, cleanupPhase: phase };
    await writePrivateJson(join(state.target.root, ROOT_RELOCATION_MANIFEST_FILE), manifest);
    durableManifest = manifest;
    context.manifest = manifest;
    cleanupPhase = phase;
  };
  verifyDatabase(
    database,
    state.manifest.databaseSchemaVersion,
    state.manifest.databaseMode === 'managed' ? state.manifest.databaseRowCounts : null,
    state.source.root,
    state.manifest.databaseSchemaSignature
  );
  await verifyPersistedExternalResourceIdentities(
    database,
    state.source,
    state.target,
    state.manifest.persistedExternalResources
  );
  if (context.kind === 'provisional') {
    await verifyManifestFiles(state.target.root, state.source.root, state.manifest);
    const activeTarget: RootMarkerV1 = {
      ...state.targetMarker,
      state: 'active',
      rebasePhase: 'complete',
      safeErrorCode: null
    };
    await writeRootMarker(state.target.root, activeTarget);
    context.targetMarker = activeTarget;
    await hook?.('target-activated');
    const cleanupSource: RootMarkerV1 = {
      ...state.sourceMarker,
      state: 'cleanup-pending',
      rebasePhase: 'complete',
      safeErrorCode: null
    };
    await writeRootMarker(state.source.root, cleanupSource);
    context.sourceMarker = cleanupSource;
    await hook?.('source-cleanup-marked');
  }
  try {
    if (cleanupPhase === 'source-retained') {
      await verifySourceStillMatches(state.source.root, state.target.root, durableManifest);
      await assertSourceRootIdentity(state.source.root, durableManifest);
      const databaseEntries = await refreshSourceDatabaseEntries(
        state.source.root,
        durableManifest
      );
      await setCleanupPhase('source-deletion-in-progress', {
        sourceDatabaseEntries: databaseEntries
      });
    }
    if (cleanupPhase === 'source-deletion-in-progress') {
      await recoverSourceRootQuarantine(state.source, durableManifest, hook);
      if (await pathDetails(state.source.root)) {
        await recoverCleanupQuarantine(state.source, state.target.root, durableManifest, hook);
        await verifySourceResidue(state.source, state.target.root, durableManifest);
        await removeSourceEntries(state.source, state.target.root, durableManifest, hook);
        await syncDirectory(dirname(state.source.root));
      }
      await setCleanupPhase('source-removed');
      await hook?.('source-deleted');
    }
    if (cleanupPhase === 'source-removed') {
      await setCleanupPhase('target-finalization-pending');
    }
    await writeRootMarker(
      state.target.root,
      markerForActiveSource(context.targetMarker ?? state.targetMarker)
    );
    await hook?.('target-finalized');
    await rm(join(state.target.root, ROOT_RELOCATION_MANIFEST_FILE));
    await syncDirectory(state.target.root);
    cleanupPhase = 'complete';
    await hook?.('manifest-removed');
    return cleanupPhase;
  } catch {
    return cleanupPhase;
  }
}

export async function completeStartupRelocation(
  context: StartupRelocationContext,
  database: Database,
  options: {
    checkpoint?: (checkpoint: StartupRelocationCheckpoint) => void | Promise<void>;
  } = {}
): Promise<{
  cleanupPhase: RootRelocationManifestV1['cleanupPhase'] | 'complete';
}> {
  if (context.kind === 'ordinary') return { cleanupPhase: 'complete' };
  return { cleanupPhase: await promoteAndCleanup(context, database, options.checkpoint) };
}

export async function rollbackProvisionalActivation(
  context: StartupRelocationContext,
  database: Database | null
): Promise<void> {
  if (context.kind !== 'provisional') return;
  const state = requireRelocationContext(context);
  if (state.manifest.databaseMode === 'external') {
    if (!database) {
      throw new RootRelocationError(
        'rollback_incomplete',
        'External database rollback is unavailable.'
      );
    }
    rebasePersistedPaths(database, state.target.root, state.source.root);
    if (findPersistedPathsUnderRoot(database, state.target.root).length > 0) {
      throw new RootRelocationError(
        'rollback_incomplete',
        'External database rollback is incomplete.'
      );
    }
  }
  await writeRootMarker(state.target.root, {
    ...state.targetMarker,
    state: 'failed',
    safeErrorCode: 'relocation_failed'
  });
  await writeRootMarker(
    state.source.root,
    markerForActiveSource(state.sourceMarker, 'relocation_rollback')
  );
}

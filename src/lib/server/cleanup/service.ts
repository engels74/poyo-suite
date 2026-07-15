import { lstat, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
import type {
  CleanupCandidateDto,
  CleanupConsequence,
  CleanupPreviewDto,
  LocalCleanupPolicy
} from '../../features/cleanup/contracts';
import { resolvePathWithin, type AppPaths } from '../platform/app-paths';
import { safeErrorSummary } from '../diagnostics/redaction';
import type { CleanupActionSnapshot, CleanupClaim, CleanupRepository } from './repository';
import {
  cleanupHash,
  CleanupValidationError,
  DEFAULT_CLEANUP_POLICY,
  normalizeCleanupPolicy
} from './policy';

export interface CleanupStorageSnapshot {
  freeBytes: number | null;
}

export interface CleanupServiceOptions {
  repository: CleanupRepository;
  paths: Pick<AppPaths, 'media'>;
  now?: () => Date;
  storage?: () => Promise<CleanupStorageSnapshot>;
  removeFile?: (root: string, path: string) => Promise<'removed' | 'already-missing'>;
}

async function defaultStorage(paths: Pick<AppPaths, 'media'>): Promise<CleanupStorageSnapshot> {
  try {
    const stats = await import('node:fs/promises').then(({ statfs }) => statfs(paths.media));
    return { freeBytes: Number(stats.bavail) * Number(stats.bsize) };
  } catch {
    return { freeBytes: null };
  }
}

async function secureRemove(
  root: string,
  candidate: string
): Promise<'removed' | 'already-missing'> {
  const path = resolvePathWithin(root, candidate);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'already-missing';
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error('Cleanup refuses to remove symbolic links.');
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(path)]);
  resolvePathWithin(realRoot, realCandidate);
  await Bun.file(realCandidate).delete();
  return 'removed';
}

function isProtected(
  output: ReturnType<CleanupRepository['listOutputs']>[number],
  policy: LocalCleanupPolicy
): boolean {
  return (
    (policy.exclusions.favorites && output.favorite) ||
    (policy.exclusions.pinned && output.pinned) ||
    output.tags.some((tag) => policy.exclusions.tags.includes(tag))
  );
}

function assertConsequence(value: unknown): asserts value is CleanupConsequence {
  if (!['file', 'metadata', 'both'].includes(String(value))) {
    throw new CleanupValidationError('Cleanup consequence is not supported.');
  }
}

export class CleanupService {
  private readonly now: () => Date;

  constructor(private readonly options: CleanupServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  policy(): LocalCleanupPolicy {
    const current = this.options.repository.getPolicy();
    if (current) return current;
    return this.options.repository.savePolicy(DEFAULT_CLEANUP_POLICY);
  }

  setPolicy(input: unknown): LocalCleanupPolicy {
    return this.options.repository.savePolicy(normalizeCleanupPolicy(input));
  }

  async preview(consequenceInput: unknown): Promise<CleanupPreviewDto> {
    assertConsequence(consequenceInput);
    const consequence = consequenceInput;
    const policy = this.policy();
    const outputs = this.options.repository.listOutputs();
    const eligible = outputs.filter((output) => !isProtected(output, policy));
    const selected = new Map<
      string,
      { output: (typeof outputs)[number]; reasons: CleanupActionSnapshot['reasons'] }
    >();

    if (policy.mode === 'age') {
      const cutoff = this.now().getTime() - (policy.olderThanDays ?? 0) * 86_400_000;
      for (const output of eligible) {
        if (new Date(output.createdAt).getTime() < cutoff) {
          selected.set(output.outputId, { output, reasons: ['age'] });
        }
      }
    }

    if (policy.mode === 'total-size') {
      const total = outputs.reduce((sum, output) => sum + output.bytes, 0);
      let remaining = Math.max(0, total - (policy.maxBytes ?? total));
      for (const output of eligible) {
        if (remaining <= 0) break;
        selected.set(output.outputId, { output, reasons: ['storage-limit'] });
        remaining -= output.bytes;
      }
    }

    if (policy.mode === 'min-free-space') {
      const storage = await (this.options.storage ?? (() => defaultStorage(this.options.paths)))();
      if (storage.freeBytes === null) {
        throw new CleanupValidationError('Free disk space could not be measured safely.');
      }
      let remaining = Math.max(0, (policy.minFreeBytes ?? storage.freeBytes) - storage.freeBytes);
      for (const output of eligible) {
        if (remaining <= 0) break;
        selected.set(output.outputId, { output, reasons: ['free-space'] });
        remaining -= output.bytes;
      }
    }

    const policyHash = cleanupHash(policy);
    const snapshots: CleanupActionSnapshot[] = [...selected.values()].map(
      ({ output, reasons }) => ({
        ...output,
        reasons,
        policyHash
      })
    );
    const token = cleanupHash({
      version: 1,
      policyHash,
      consequence,
      candidates: snapshots.map(({ outputId, localPath, bytes, reasons }) => ({
        outputId,
        localPath,
        bytes,
        reasons
      }))
    });
    this.options.repository.persistPreview(token, policyHash, consequence, snapshots);
    const candidates: CleanupCandidateDto[] = snapshots.map((snapshot) => ({
      outputId: snapshot.outputId,
      jobId: snapshot.jobId,
      fileName: basename(snapshot.localPath),
      mediaKind: snapshot.mediaKind,
      bytes: snapshot.bytes,
      createdAt: snapshot.createdAt,
      reasons: snapshot.reasons
    }));
    return {
      token,
      policy,
      consequence,
      candidates,
      totalBytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
      createdAt: this.now().toISOString(),
      requiresConfirmation: true
    };
  }

  apply(token: unknown, confirmed: unknown): { scheduled: number; token: string } {
    if (confirmed !== true) throw new CleanupValidationError('Cleanup confirmation is required.');
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
      throw new CleanupValidationError('Cleanup preview token is invalid.');
    }
    return { scheduled: this.options.repository.schedulePreview(token), token };
  }

  async execute(claim: CleanupClaim): Promise<unknown> {
    const removeFile = this.options.removeFile ?? secureRemove;
    try {
      let file: 'removed' | 'already-missing' | 'retained' = 'retained';
      let metadata: 'removed' | 'already-missing' | 'retained' = 'retained';
      if (claim.actionKind === 'local_file' || claim.actionKind === 'local_both') {
        file = await removeFile(this.options.paths.media, claim.snapshot.localPath);
      }
      if (claim.actionKind === 'local_metadata' || claim.actionKind === 'local_both') {
        metadata = this.options.repository.removeOutputMetadata(claim.outputId)
          ? 'removed'
          : 'already-missing';
      } else {
        metadata = this.options.repository.markOutputFileRemoved(claim.outputId)
          ? 'retained'
          : 'already-missing';
      }
      const result = { file, metadata };
      this.options.repository.complete(claim, result);
      return result;
    } catch (error) {
      const result = { error: safeErrorSummary(error) };
      this.options.repository.fail(claim, result);
      throw error;
    }
  }
}

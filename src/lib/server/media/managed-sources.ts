import type { Database } from 'bun:sqlite';
import { unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type AppPaths, resolvePathWithin } from '../platform/app-paths';
import { DatabaseRepository } from '../platform/repository';
import {
  assertCanonicalDirectory,
  inspectCanonicalFile,
  inspectCanonicalRoot,
  syncDirectory
} from './filesystem-boundary';
import type { LocalSourceIntake } from './source-intake';

export type ManagedSourceAvailability = 'available' | 'missing' | 'deleted';

export interface ManagedSourceRecord {
  id: string;
  originalName: string;
  mediaKind: 'image' | 'video';
  mimeType: string;
  byteSize: number;
  checksum: string;
  signature: string;
  localPath: string;
  availability: ManagedSourceAvailability;
  createdAt: string;
  lastVerifiedAt: string | null;
  missingAt: string | null;
  deletedAt: string | null;
}

type ManagedSourceRow = {
  id: string;
  original_name: string;
  media_kind: 'image' | 'video';
  mime_type: string;
  byte_size: number;
  checksum: string;
  signature: string;
  relative_path: string;
  availability: ManagedSourceAvailability;
  created_at: string;
  last_verified_at: string | null;
  missing_at: string | null;
  deleted_at: string | null;
};

const managedSourceId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertManagedSourceId(id: string): void {
  if (!managedSourceId.test(id)) {
    throw new Error('The managed local source identifier is not valid.');
  }
}

interface ManagedSourceFileOperations {
  unlink: (path: string) => Promise<void>;
  syncDirectory: (path: string) => Promise<void>;
}

const managedSourceFileOperations: ManagedSourceFileOperations = { unlink, syncDirectory };

export class ManagedSourceRepository extends DatabaseRepository {
  constructor(
    database: Database,
    private readonly paths: Pick<AppPaths, 'uploads'>,
    private readonly now: () => Date = () => new Date(),
    private readonly fileOperations: ManagedSourceFileOperations = managedSourceFileOperations
  ) {
    super(database);
  }

  async register(source: LocalSourceIntake): Promise<ManagedSourceRecord> {
    assertManagedSourceId(source.id);
    let inserted = false;
    try {
      const inspected = await inspectCanonicalFile(
        this.paths.uploads,
        source.localPath,
        'Managed source'
      );
      if (!inspected || inspected.size !== source.sizeBytes) {
        throw new Error('Managed source copy could not be verified.');
      }
      this.database
        .query(
          `INSERT INTO managed_sources(id,original_name,media_kind,mime_type,byte_size,checksum,signature,relative_path,availability,created_at,last_verified_at)
           VALUES (?,?,?,?,?,?,?,?,'available',?,?)`
        )
        .run(
          source.id,
          source.originalName,
          source.mediaKind,
          source.mimeType,
          source.sizeBytes,
          source.checksum,
          source.signature,
          inspected.relativePath,
          source.createdAt,
          source.createdAt
        );
      inserted = true;
      const registered = this.get(source.id);
      if (!registered) throw new Error('Managed source registration failed.');
      return registered;
    } catch (registrationError) {
      try {
        if (inserted) await this.discardUnreferenced(source.id);
        else await this.discardUnregisteredIntake(source);
      } catch (cleanupError) {
        throw new AggregateError(
          [registrationError, cleanupError],
          'Managed source registration and cleanup failed.',
          { cause: registrationError }
        );
      }
      throw registrationError;
    }
  }

  get(id: string): ManagedSourceRecord | null {
    assertManagedSourceId(id);
    const row = this.getRow(id);
    return row ? this.map(row) : null;
  }

  async resolveAvailable(
    id: string,
    expectedKind?: 'image' | 'video'
  ): Promise<ManagedSourceRecord> {
    if ((await this.reconcile(id)) !== 'available') {
      throw new Error('The managed local source is no longer available.');
    }
    const source = this.get(id);
    if (!source) throw new Error('The managed local source was not found.');
    if (expectedKind && source.mediaKind !== expectedKind) {
      throw new Error('The managed local source media kind does not match the input role.');
    }
    return source;
  }

  async reconcile(id: string): Promise<ManagedSourceAvailability | null> {
    assertManagedSourceId(id);
    const source = this.getRow(id);
    if (!source || source.availability === 'deleted') return source?.availability ?? null;
    let available = false;
    try {
      const inspected = await inspectCanonicalFile(
        this.paths.uploads,
        source.relative_path,
        'Managed source'
      );
      available = inspected?.size === source.byte_size;
    } catch {
      available = false;
    }
    const now = this.now().toISOString();
    this.transaction(() => {
      if (available) {
        this.database
          .query(
            "UPDATE managed_sources SET availability='available',last_verified_at=?,missing_at=NULL WHERE id=? AND availability!='deleted'"
          )
          .run(now, id);
        this.database
          .query("UPDATE job_inputs SET availability='available' WHERE managed_source_id=?")
          .run(id);
      } else {
        this.database
          .query(
            "UPDATE managed_sources SET availability='missing',missing_at=COALESCE(missing_at,?) WHERE id=? AND availability!='deleted'"
          )
          .run(now, id);
        this.database
          .query("UPDATE job_inputs SET availability='missing' WHERE managed_source_id=?")
          .run(id);
      }
    });
    return available ? 'available' : 'missing';
  }

  async reconcileAll(): Promise<number> {
    const ids = this.database
      .query<{ id: string }, []>("SELECT id FROM managed_sources WHERE availability!='deleted'")
      .all();
    let changed = 0;
    for (const { id } of ids) {
      const before = this.getRow(id)?.availability;
      const after = await this.reconcile(id);
      if (before !== after) changed += 1;
    }
    return changed;
  }

  async discardUnreferenced(id: string): Promise<boolean> {
    assertManagedSourceId(id);
    const source = this.getRow(id);
    if (!source) return false;
    const references =
      this.database
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) count FROM job_inputs WHERE managed_source_id=?'
        )
        .get(id)?.count ?? 0;
    if (references > 0) return false;
    const root = await inspectCanonicalRoot(this.paths.uploads, 'Managed source cleanup');
    const path = resolvePathWithin(root, source.relative_path);
    const parent = dirname(path);
    await assertCanonicalDirectory(root, parent, 'Managed source cleanup');
    const inspected = await inspectCanonicalFile(root, path, 'Managed source cleanup');
    if (inspected) {
      const revalidated = await inspectCanonicalFile(root, path, 'Managed source cleanup');
      if (!revalidated || revalidated.path !== inspected.path) {
        throw new Error('Managed source cleanup path changed before deletion.');
      }
      await this.fileOperations.unlink(revalidated.path);
    }
    await this.fileOperations.syncDirectory(parent);
    return this.database.query('DELETE FROM managed_sources WHERE id=?').run(id).changes === 1;
  }

  private async discardUnregisteredIntake(source: LocalSourceIntake): Promise<void> {
    const inspected = await inspectCanonicalFile(
      this.paths.uploads,
      source.localPath,
      'Managed source cleanup'
    );
    if (!inspected || this.hasPathOwner(inspected.relativePath)) return;
    const revalidated = await inspectCanonicalFile(
      this.paths.uploads,
      source.localPath,
      'Managed source cleanup'
    );
    if (
      !revalidated ||
      revalidated.path !== inspected.path ||
      revalidated.relativePath !== inspected.relativePath
    ) {
      throw new Error('Managed source cleanup path changed before deletion.');
    }
    if (this.hasPathOwner(revalidated.relativePath)) return;
    await this.fileOperations.unlink(revalidated.path);
    await this.fileOperations.syncDirectory(dirname(revalidated.path));
  }

  private hasPathOwner(relativePath: string): boolean {
    return (
      this.database
        .query<{ id: string }, [string]>(
          'SELECT id FROM managed_sources WHERE relative_path=? LIMIT 1'
        )
        .get(relativePath) !== null
    );
  }

  private map(row: ManagedSourceRow): ManagedSourceRecord {
    return {
      id: row.id,
      originalName: row.original_name,
      mediaKind: row.media_kind,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      checksum: row.checksum,
      signature: row.signature,
      localPath: resolvePathWithin(this.paths.uploads, row.relative_path),
      availability: row.availability,
      createdAt: row.created_at,
      lastVerifiedAt: row.last_verified_at,
      missingAt: row.missing_at,
      deletedAt: row.deleted_at
    };
  }

  private getRow(id: string): ManagedSourceRow | null {
    return this.database
      .query<ManagedSourceRow, [string]>('SELECT * FROM managed_sources WHERE id=?')
      .get(id);
  }
}

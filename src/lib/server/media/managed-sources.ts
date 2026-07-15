import type { Database } from 'bun:sqlite';
import { unlink } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { type AppPaths, resolvePathWithin } from '../platform/app-paths';
import { DatabaseRepository } from '../platform/repository';
import { inspectCanonicalFile } from './filesystem-boundary';
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

type LegacyReferenceRow = {
  local_reference: string;
  media_kind: 'image' | 'video';
  metadata_json: string;
  created_at: string;
};

const managedSourceId =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertManagedSourceId(id: string): void {
  if (!managedSourceId.test(id)) {
    throw new Error('The managed local source identifier is not valid.');
  }
}

const legacyMimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska'
};

async function inspectLegacyFile(path: string): Promise<{
  byteSize: number;
  checksum: string;
  signature: string;
}> {
  const hasher = new Bun.CryptoHasher('sha256');
  const signature: number[] = [];
  let byteSize = 0;
  const reader = Bun.file(path).stream().getReader();
  while (true) {
    const { done, value: bytes } = await reader.read();
    if (done) break;
    hasher.update(bytes);
    byteSize += bytes.byteLength;
    for (const byte of bytes) {
      if (signature.length === 16) break;
      signature.push(byte);
    }
  }
  return {
    byteSize,
    checksum: hasher.digest('hex'),
    signature: signature.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  };
}

export class ManagedSourceRepository extends DatabaseRepository {
  constructor(
    database: Database,
    private readonly paths: Pick<AppPaths, 'uploads'>,
    private readonly now: () => Date = () => new Date()
  ) {
    super(database);
  }

  async register(source: LocalSourceIntake): Promise<ManagedSourceRecord> {
    assertManagedSourceId(source.id);
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
    const registered = this.get(source.id);
    if (!registered) throw new Error('Managed source registration failed.');
    return registered;
  }

  async adoptLegacyReferences(): Promise<number> {
    const references = this.database
      .query<LegacyReferenceRow, []>(
        `SELECT ji.local_reference,ji.media_kind,MIN(ji.metadata_json) metadata_json,MIN(j.created_at) created_at
         FROM job_inputs ji JOIN jobs j ON j.id=ji.job_id
         WHERE ji.local_reference IS NOT NULL AND ji.managed_source_id IS NULL
         GROUP BY ji.local_reference,ji.media_kind
         ORDER BY ji.local_reference`
      )
      .all();
    let adopted = 0;
    for (const reference of references) {
      let inspected: Awaited<ReturnType<typeof inspectCanonicalFile>>;
      try {
        inspected = await inspectCanonicalFile(
          this.paths.uploads,
          reference.local_reference,
          'Legacy managed source'
        );
      } catch {
        continue;
      }
      if (!inspected) continue;
      const localPath = inspected.path;
      const extension = extname(localPath).toLowerCase();
      const id = basename(localPath, extension);
      if (!managedSourceId.test(id)) continue;
      const content = await inspectLegacyFile(localPath);
      const existing = this.getRow(id);
      if (existing && existing.relative_path !== inspected.relativePath) continue;
      let originalName = basename(localPath);
      try {
        const metadata = JSON.parse(reference.metadata_json) as { name?: unknown };
        if (typeof metadata.name === 'string' && metadata.name.trim()) {
          originalName = basename(metadata.name.trim()).slice(0, 255);
        }
      } catch {}
      const now = this.now().toISOString();
      this.transaction(() => {
        this.database
          .query(
            `INSERT INTO managed_sources(id,original_name,media_kind,mime_type,byte_size,checksum,signature,relative_path,availability,created_at,last_verified_at,missing_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`
          )
          .run(
            id,
            originalName,
            reference.media_kind,
            legacyMimeTypes[extension] ?? 'application/octet-stream',
            content.byteSize,
            content.checksum,
            content.signature,
            inspected.relativePath,
            'available',
            reference.created_at,
            now,
            null
          );
        this.database
          .query(
            `UPDATE job_inputs SET managed_source_id=?,local_reference=NULL,availability=?
             WHERE local_reference=? AND managed_source_id IS NULL`
          )
          .run(id, 'available', reference.local_reference);
      });
      adopted += 1;
    }
    return adopted;
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
    const inspected = await inspectCanonicalFile(
      this.paths.uploads,
      source.relative_path,
      'Managed source cleanup'
    );
    if (inspected) {
      const revalidated = await inspectCanonicalFile(
        this.paths.uploads,
        source.relative_path,
        'Managed source cleanup'
      );
      if (!revalidated || revalidated.path !== inspected.path) {
        throw new Error('Managed source cleanup path changed before deletion.');
      }
      await unlink(revalidated.path);
    }
    return this.database.query('DELETE FROM managed_sources WHERE id=?').run(id).changes === 1;
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

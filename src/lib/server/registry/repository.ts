import type { Database } from 'bun:sqlite';
import { IMAGE_AUDIT_RECORDS, IMAGE_REGISTRY } from '../../features/registry/image-registry';
export function seedImageRegistry(database: Database): void {
  database.transaction(() => {
    database
      .query(
        `INSERT INTO registry_versions(version,source_hash,manifest_hash,verified_at,status) VALUES (?,?,?,?,'current') ON CONFLICT(version) DO UPDATE SET source_hash=excluded.source_hash,manifest_hash=excluded.manifest_hash,verified_at=excluded.verified_at,status='current'`
      )
      .run(
        IMAGE_REGISTRY.version,
        IMAGE_REGISTRY.sourceHash,
        IMAGE_REGISTRY.manifestHash,
        IMAGE_REGISTRY.verifiedAt
      );
    const insert = database.query(
      `INSERT INTO registry_entries(registry_version,entry_key,public_model_id,provider,modality,workflow,status,definition_json,provenance_json,limitations_json) VALUES (?,?,?,?,? ,?,?,?,?,?) ON CONFLICT(registry_version,entry_key) DO UPDATE SET definition_json=excluded.definition_json,provenance_json=excluded.provenance_json,limitations_json=excluded.limitations_json,status=excluded.status`
    );
    for (const entry of IMAGE_REGISTRY.entries)
      insert.run(
        IMAGE_REGISTRY.version,
        entry.key,
        entry.publicModelId,
        entry.provider,
        'image',
        entry.workflow,
        entry.status,
        JSON.stringify(entry),
        JSON.stringify(entry.provenance),
        JSON.stringify(entry.limitations)
      );
    for (const record of IMAGE_AUDIT_RECORDS)
      insert.run(
        IMAGE_REGISTRY.version,
        record.key,
        record.publicModelIds.join(','),
        'audit',
        'image',
        'audit-only',
        record.status,
        JSON.stringify(record),
        JSON.stringify({ sourceUrl: record.sourceUrl, verifiedAt: IMAGE_REGISTRY.verifiedAt }),
        JSON.stringify([record.reason])
      );
  })();
}

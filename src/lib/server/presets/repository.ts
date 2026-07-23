import type { Database } from 'bun:sqlite';
import type { PresetRecord, PresetValues } from '../../features/presets/types';
import { IMAGE_REGISTRY, IMAGE_REGISTRY_ENTRIES } from '../../features/registry/image-registry';
import { VIDEO_REGISTRY, VIDEO_REGISTRY_ENTRIES } from '../../features/registry/video-registry';
import { DatabaseRepository } from '../platform/repository';

type PresetRow = {
  id: string;
  registry_version: string;
  entry_key: string;
  workflow: string;
  name: string;
  description: string | null;
  values_version: number;
  values_json: string;
  created_at: string;
  updated_at: string;
};

export interface SavePresetInput {
  id?: string;
  entryKey: string;
  name: string;
  description?: string;
  values: PresetValues;
}

function currentEntryMetadata(entryKey: string): {
  registryVersion: string;
  workflow: string;
} | null {
  const image = IMAGE_REGISTRY_ENTRIES.find(
    (entry) => entry.key === entryKey && entry.status === 'current'
  );
  if (image)
    return {
      registryVersion: IMAGE_REGISTRY.version,
      workflow: image.workflow
    };
  const video = VIDEO_REGISTRY_ENTRIES.find(
    (entry) => entry.key === entryKey && entry.status === 'current'
  );
  if (video)
    return {
      registryVersion: VIDEO_REGISTRY.version,
      workflow: video.workflow
    };
  return null;
}

function entryMetadata(entryKey: string): {
  registryVersion: string;
  workflow: string;
} {
  const metadata = currentEntryMetadata(entryKey);
  if (metadata) return metadata;
  throw new Error('Preset model workflow is unknown or unavailable.');
}

function assertPresetValues(values: PresetValues): void {
  if (values.version !== 1 || !['image', 'video'].includes(values.modality))
    throw new Error('Preset values use an unsupported version.');
  const visit = (value: unknown): void => {
    if (value instanceof Blob) throw new Error('Presets cannot contain media bodies.');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/(?:api.?key|authorization|cookie|credential|password|secret|token)/i.test(key))
        throw new Error('Presets cannot contain credential fields.');
      visit(item);
    }
  };
  visit(values);
  if (JSON.stringify(values).length > 256 * 1024) throw new Error('Preset values are too large.');
}

function mapPreset(row: PresetRow): PresetRecord | null {
  const metadata = currentEntryMetadata(row.entry_key);
  if (
    !metadata ||
    row.registry_version !== metadata.registryVersion ||
    row.workflow !== metadata.workflow ||
    row.values_version !== 1
  )
    return null;
  let values: PresetValues;
  try {
    values = JSON.parse(row.values_json) as PresetValues;
  } catch {
    return null;
  }
  if (values?.version !== 1) return null;
  return {
    id: row.id,
    registryVersion: row.registry_version,
    entryKey: row.entry_key,
    workflow: row.workflow,
    name: row.name,
    description: row.description,
    valuesVersion: 1,
    values,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class PresetRepository extends DatabaseRepository {
  constructor(
    database: Database,
    private readonly now: () => Date = () => new Date()
  ) {
    super(database);
  }

  list(): PresetRecord[] {
    return this.database
      .query<PresetRow, []>('SELECT * FROM presets ORDER BY updated_at DESC, name')
      .all()
      .flatMap((row) => {
        const preset = mapPreset(row);
        return preset ? [preset] : [];
      });
  }

  get(id: string): PresetRecord | null {
    const row = this.database
      .query<PresetRow, [string]>('SELECT * FROM presets WHERE id=?')
      .get(id);
    return row ? mapPreset(row) : null;
  }

  save(input: SavePresetInput): PresetRecord {
    const name = input.name.trim();
    const description = input.description?.trim() || null;
    if (!name || name.length > 120)
      throw new Error('Preset name is required and limited to 120 characters.');
    if (description && description.length > 500)
      throw new Error('Preset description is limited to 500 characters.');
    assertPresetValues(input.values);
    const metadata = entryMetadata(input.entryKey);
    const existing = input.id ? this.get(input.id) : null;
    if (input.id && !existing) throw new Error('Preset not found.');
    const id = existing?.id ?? crypto.randomUUID();
    const timestamp = this.now().toISOString();
    this.database
      .query(
        `INSERT INTO presets(id,registry_version,entry_key,workflow,name,description,values_version,values_json,created_at,updated_at)
         VALUES (?,?,?,?,?,?,1,?,?,?)
         ON CONFLICT(id) DO UPDATE SET registry_version=excluded.registry_version,entry_key=excluded.entry_key,workflow=excluded.workflow,name=excluded.name,description=excluded.description,values_version=1,values_json=excluded.values_json,updated_at=excluded.updated_at`
      )
      .run(
        id,
        metadata.registryVersion,
        input.entryKey,
        metadata.workflow,
        name,
        description,
        JSON.stringify(input.values),
        existing?.createdAt ?? timestamp,
        timestamp
      );
    const saved = this.get(id);
    if (!saved) throw new Error('Preset could not be saved.');
    return saved;
  }

  delete(id: string): boolean {
    return this.database.query('DELETE FROM presets WHERE id=?').run(id).changes > 0;
  }
}

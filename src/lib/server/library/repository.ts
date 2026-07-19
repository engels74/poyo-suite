import type { Database } from 'bun:sqlite';
import { basename } from 'node:path';
import type {
  CursorPage,
  DownloadAttemptDto,
  JobDetailDto,
  JobFilterOptionsDto,
  JobFiltersDto,
  JobHistoryDto,
  JobInputDto,
  JobListItemDto,
  JobOutputDto,
  LibraryFiltersDto,
  LibraryGroupDto,
  LocalDeleteChoice,
  ModelFilterOption,
  SafeMediaSummary,
  StorageStatisticsDto
} from '../../features/library/contracts';
import { modelCatalogue } from '../../features/registry/catalogue';
import { IMAGE_REGISTRY_ENTRIES } from '../../features/registry/image-registry';
import { VIDEO_REGISTRY_ENTRIES } from '../../features/registry/video-registry';
import { ManagedSourceRepository } from '../media/managed-sources';
import { type AppPaths, resolvePathWithin } from '../platform/app-paths';
import { DatabaseRepository } from '../platform/repository';
import {
  packDurableJobEventPayload,
  sanitizeDurableJobEventPayload
} from '../jobs/event-attention';
import { publicIpv4GuardReason } from '../poyo/errors';

type Binding = string | number | null;

type JobListRow = {
  id: string;
  entry_key: string | null;
  workflow: string;
  public_model_id: string;
  local_phase: string;
  remote_status: string;
  failure_domain: string;
  attention_code: string | null;
  progress: number | null;
  estimated_credits: number | null;
  actual_credits: number | null;
  prompt_text: string | null;
  last_polled_at: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  completed_at: string | null;
  output_count: number;
  verified_count: number;
  output_state: string | null;
  representative_id: string | null;
  representative_kind: 'image' | 'video' | null;
  representative_type: string | null;
  representative_state: SafeMediaSummary['downloadState'] | null;
  representative_path: string | null;
  representative_width: number | null;
  representative_height: number | null;
};

type LibraryRow = {
  id: string;
  entry_key: string | null;
  workflow: string;
  public_model_id: string;
  prompt_text: string | null;
  created_at: string;
  completed_at: string | null;
  output_count: number;
  verified_count: number;
  total_bytes: number;
  favorite: number;
  pinned: number;
  aspect_ratio: string | null;
  warning: string | null;
  attention_code: string | null;
  tags_json: string;
  representative_id: string | null;
  representative_kind: 'image' | 'video' | null;
  representative_type: string | null;
  representative_state: SafeMediaSummary['downloadState'] | null;
  representative_path: string | null;
  representative_width: number | null;
  representative_height: number | null;
};

type DetailJobRow = JobListRow & {
  poyo_task_id: string | null;
  correlation_id: string;
  retry_of_job_id: string | null;
  guided_request_json: string;
  actual_payload_json: string;
  expert_diff_json: string | null;
  submission_state: string | null;
};

type InputRow = {
  role: string;
  input_order: number;
  media_kind: 'image' | 'video';
  source_url: string | null;
  upload_url: string | null;
  metadata_json: string;
  availability: string;
  managed_source_id: string | null;
  managed_source_name: string | null;
  managed_source_bytes: number | null;
  managed_source_checksum: string | null;
  managed_source_availability: 'available' | 'missing' | 'deleted' | null;
};

type OutputRow = {
  id: string;
  output_order: number;
  media_kind: 'image' | 'video';
  remote_url: string | null;
  remote_expires_at: string | null;
  remote_metadata_json: string | null;
  local_path: string | null;
  content_type: string | null;
  byte_size: number | null;
  checksum: string | null;
  signature: string | null;
  aspect_ratio: string | null;
  pixel_width: number | null;
  pixel_height: number | null;
  download_state: SafeMediaSummary['downloadState'];
  favorite: number;
  pinned: number;
  verified_at: string | null;
  deleted_at: string | null;
};

type AttemptRow = {
  output_id: string;
  attempt: number;
  status: DownloadAttemptDto['status'];
  bytes_received: number;
  safe_error_json: string | null;
  started_at: string;
  completed_at: string | null;
};

type HistoryRow = {
  event_id: number;
  event_type: string;
  local_phase: string;
  remote_status_raw: string | null;
  remote_status: string;
  failure_domain: string;
  progress: number | null;
  safe_payload_json: string | null;
  observed_at: string;
};

type Cursor = { createdAt: string; id: string };

const allModels = modelCatalogue();
const modelByKey = new Map(allModels.map((entry) => [entry.key, entry]));

function resolveModel(entryKey: string | null, publicModelId: string, workflow: string) {
  return (
    (entryKey ? modelByKey.get(entryKey) : undefined) ??
    allModels.find(
      (entry) => entry.publicModelId === publicModelId && entry.workflow === workflow
    ) ??
    allModels.find((entry) => entry.publicModelId === publicModelId)
  );
}

function encodeCursor(row: { created_at: string; id: string }): string {
  return btoa(JSON.stringify({ createdAt: row.created_at, id: row.id } satisfies Cursor));
}

export function decodePageCursor(value: string): Cursor | null {
  if (!value || value.length > 512) return null;
  try {
    const parsed = JSON.parse(atob(value)) as Partial<Cursor>;
    if (
      typeof parsed.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== 'string' ||
      parsed.id.length < 8 ||
      parsed.id.length > 128
    )
      return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function like(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

function addDateFilters(
  alias: string,
  dateFrom: string,
  dateTo: string,
  clauses: string[],
  bindings: Binding[]
): void {
  if (dateFrom) {
    clauses.push(`${alias}.created_at>=?`);
    bindings.push(`${dateFrom}T00:00:00.000Z`);
  }
  if (dateTo) {
    const exclusive = new Date(`${dateTo}T00:00:00.000Z`);
    exclusive.setUTCDate(exclusive.getUTCDate() + 1);
    clauses.push(`${alias}.created_at<?`);
    bindings.push(exclusive.toISOString());
  }
}

function addCursor(alias: string, value: string, clauses: string[], bindings: Binding[]): void {
  const cursor = decodePageCursor(value);
  if (!cursor) return;
  clauses.push(`(${alias}.created_at<? OR (${alias}.created_at=? AND ${alias}.id<?))`);
  bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
}

function modelIdsForProvider(provider: string): string[] {
  return [
    ...new Set(
      allModels.filter((entry) => entry.provider === provider).map((entry) => entry.publicModelId)
    )
  ];
}

function mediaSummary(row: {
  representative_id: string | null;
  representative_kind: 'image' | 'video' | null;
  representative_type: string | null;
  representative_state: SafeMediaSummary['downloadState'] | null;
  representative_path: string | null;
  representative_width: number | null;
  representative_height: number | null;
}): SafeMediaSummary | null {
  if (!row.representative_id || !row.representative_kind || !row.representative_state) return null;
  return {
    outputId: row.representative_id,
    mediaKind: row.representative_kind,
    contentType: row.representative_type,
    fileName: row.representative_path ? basename(row.representative_path) : null,
    pixelWidth: row.representative_width,
    pixelHeight: row.representative_height,
    downloadState: row.representative_state,
    mediaUrl:
      row.representative_state === 'verified'
        ? `/api/media/${encodeURIComponent(row.representative_id)}`
        : null
  };
}

function jobDto(row: JobListRow): JobListItemDto {
  const model = resolveModel(row.entry_key, row.public_model_id, row.workflow);
  const ipGuardReason = publicIpv4GuardReason(row.attention_code);
  return {
    id: row.id,
    entryKey: row.entry_key,
    displayName: model?.displayName ?? row.public_model_id,
    provider: model?.provider ?? 'Unknown provider',
    modality: model?.modality ?? row.representative_kind ?? 'image',
    workflow: row.workflow,
    publicModelId: row.public_model_id,
    localPhase: row.local_phase,
    remoteStatus: row.remote_status,
    failureDomain: row.failure_domain,
    attentionCode: ipGuardReason ? 'ip_guard_blocked' : row.attention_code,
    ipGuardReason,
    progress: row.progress,
    estimatedCredits: row.estimated_credits,
    actualCredits: row.actual_credits,
    lastPolledAt: row.last_polled_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    promptExcerpt: row.prompt_text?.slice(0, 220) ?? null,
    outputCount: row.output_count,
    verifiedOutputCount: row.verified_count,
    outputState: row.output_state,
    representative: mediaSummary(row)
  };
}

function listSelect(): string {
  return `j.id,j.entry_key,j.workflow,j.public_model_id,j.local_phase,j.remote_status,j.failure_domain,j.attention_code,j.progress,j.estimated_credits,j.actual_credits,j.prompt_text,j.last_polled_at,j.created_at,j.started_at,j.updated_at,j.completed_at,
    (SELECT COUNT(*) FROM job_outputs o WHERE o.job_id=j.id) output_count,
    (SELECT COUNT(*) FROM job_outputs o WHERE o.job_id=j.id AND o.download_state='verified') verified_count,
    (SELECT CASE WHEN COUNT(*)=0 THEN NULL WHEN SUM(o.download_state='verified')=COUNT(*) THEN 'verified' WHEN SUM(o.download_state IN ('failed','expired'))>0 THEN 'attention' WHEN SUM(o.download_state='downloading')>0 THEN 'downloading' ELSE 'pending' END FROM job_outputs o WHERE o.job_id=j.id) output_state,
    (SELECT o.id FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_id,
    (SELECT o.media_kind FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_kind,
    (SELECT o.content_type FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_type,
    (SELECT o.download_state FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_state,
    (SELECT o.local_path FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_path,
    (SELECT o.pixel_width FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_width,
    (SELECT o.pixel_height FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_height`;
}

function tagArray(source: string): string[] {
  try {
    const parsed = JSON.parse(source) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

export class LibraryRepository extends DatabaseRepository {
  constructor(
    database: Database,
    private readonly now: () => Date = () => new Date()
  ) {
    super(database);
  }

  listJobs(filters: JobFiltersDto, limit = 40): CursorPage<JobListItemDto> {
    const clauses = ['1=1'];
    const bindings: Binding[] = [];
    const states: Record<Exclude<JobFiltersDto['status'], 'all'>, string> = {
      queued:
        "j.local_phase IN ('queued','validating','uploading','submission_prepared','submitting')",
      running: "j.local_phase IN ('monitoring','downloading') AND j.remote_status!='failed'",
      completed: "j.local_phase='complete' AND j.remote_status!='failed'",
      failed: "j.remote_status='failed'",
      attention: "j.local_phase='requires_attention'",
      stale: "j.attention_code='stale'"
    };
    if (filters.status !== 'all') clauses.push(states[filters.status]);
    if (filters.q) {
      clauses.push("(j.search_text LIKE ? ESCAPE '\\' OR j.public_model_id LIKE ? ESCAPE '\\')");
      bindings.push(like(filters.q), like(filters.q));
    }
    if (filters.model) {
      clauses.push('j.public_model_id=?');
      bindings.push(filters.model);
    }
    if (filters.workflow) {
      clauses.push('j.workflow=?');
      bindings.push(filters.workflow);
    }
    addDateFilters('j', filters.dateFrom, filters.dateTo, clauses, bindings);
    const countBindings = [...bindings];
    addCursor('j', filters.cursor, clauses, bindings);
    const sql = `SELECT ${listSelect()} FROM jobs j WHERE ${clauses.join(' AND ')} ORDER BY j.created_at DESC,j.id DESC LIMIT ?`;
    const rows = this.database
      .query<JobListRow, Binding[]>(sql)
      .all(...bindings, Math.min(100, Math.max(1, limit)) + 1);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const lastItem = items.at(-1);
    const countClauses = clauses.filter((clause) => !clause.includes('j.created_at<? OR'));
    const total =
      this.database
        .query<{ count: number }, Binding[]>(
          `SELECT COUNT(*) count FROM jobs j WHERE ${countClauses.join(' AND ')}`
        )
        .get(...countBindings)?.count ?? 0;
    return {
      items: items.map(jobDto),
      nextCursor: hasMore && lastItem ? encodeCursor(lastItem) : null,
      total
    };
  }

  listLibrary(filters: LibraryFiltersDto, limit = 24): CursorPage<LibraryGroupDto> {
    const clauses = ['EXISTS(SELECT 1 FROM job_outputs o WHERE o.job_id=j.id)'];
    const bindings: Binding[] = [];
    if (filters.q) {
      const search = like(filters.q);
      clauses.push(
        `(j.search_text LIKE ? ESCAPE '\\' OR j.public_model_id LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM job_outputs oq WHERE oq.job_id=j.id AND oq.local_path LIKE ? ESCAPE '\\') OR EXISTS(SELECT 1 FROM job_tags jt JOIN tags t ON t.id=jt.tag_id WHERE jt.job_id=j.id AND t.display_name LIKE ? ESCAPE '\\'))`
      );
      bindings.push(search, search, search, search);
    }
    if (filters.mediaKind) {
      clauses.push('EXISTS(SELECT 1 FROM job_outputs ok WHERE ok.job_id=j.id AND ok.media_kind=?)');
      bindings.push(filters.mediaKind);
    }
    if (filters.model) {
      clauses.push('j.public_model_id=?');
      bindings.push(filters.model);
    }
    if (filters.provider) {
      const ids = modelIdsForProvider(filters.provider);
      if (!ids.length) clauses.push('0=1');
      else {
        clauses.push(`j.public_model_id IN (${ids.map(() => '?').join(',')})`);
        bindings.push(...ids);
      }
    }
    if (filters.workflow) {
      clauses.push('j.workflow=?');
      bindings.push(filters.workflow);
    }
    if (filters.aspectRatio) {
      clauses.push(
        "COALESCE(json_extract(j.guided_request_json,'$.aspectRatio'),json_extract(j.guided_request_json,'$.size'))=?"
      );
      bindings.push(filters.aspectRatio);
    }
    if (filters.favorite)
      clauses.push(
        'EXISTS(SELECT 1 FROM job_outputs ofav WHERE ofav.job_id=j.id AND ofav.favorite=1)'
      );
    if (filters.tag) {
      clauses.push(
        'EXISTS(SELECT 1 FROM job_tags jt JOIN tags t ON t.id=jt.tag_id WHERE jt.job_id=j.id AND t.normalized_name=?)'
      );
      bindings.push(filters.tag.toLocaleLowerCase());
    }
    const statusClauses: Record<Exclude<LibraryFiltersDto['status'], 'all'>, string> = {
      available:
        "EXISTS(SELECT 1 FROM job_outputs os WHERE os.job_id=j.id AND os.download_state='verified' AND os.local_path IS NOT NULL)",
      attention:
        "(j.local_phase='requires_attention' OR EXISTS(SELECT 1 FROM job_outputs os WHERE os.job_id=j.id AND os.download_state IN ('failed','expired')))",
      'remote-only':
        "NOT EXISTS(SELECT 1 FROM job_outputs os WHERE os.job_id=j.id AND os.download_state='verified') AND EXISTS(SELECT 1 FROM job_outputs os WHERE os.job_id=j.id AND os.remote_url IS NOT NULL)",
      deleted:
        "NOT EXISTS(SELECT 1 FROM job_outputs os WHERE os.job_id=j.id AND os.download_state!='deleted')"
    };
    if (filters.status !== 'all') clauses.push(statusClauses[filters.status]);
    addDateFilters('j', filters.dateFrom, filters.dateTo, clauses, bindings);
    const countBindings = [...bindings];
    addCursor('j', filters.cursor, clauses, bindings);
    const sql = `SELECT j.id,j.entry_key,j.workflow,j.public_model_id,j.prompt_text,j.created_at,j.completed_at,j.attention_code,
      (SELECT COUNT(*) FROM job_outputs o WHERE o.job_id=j.id) output_count,
      (SELECT COUNT(*) FROM job_outputs o WHERE o.job_id=j.id AND o.download_state='verified') verified_count,
      COALESCE((SELECT SUM(COALESCE(o.byte_size,0)) FROM job_outputs o WHERE o.job_id=j.id AND o.download_state='verified'),0) total_bytes,
      COALESCE((SELECT MAX(o.favorite) FROM job_outputs o WHERE o.job_id=j.id),0) favorite,
      COALESCE((SELECT MAX(o.pinned) FROM job_outputs o WHERE o.job_id=j.id),0) pinned,
      COALESCE(json_extract(j.guided_request_json,'$.aspectRatio'),json_extract(j.guided_request_json,'$.size')) aspect_ratio,
      (SELECT CASE WHEN SUM(o.download_state IN ('failed','expired'))>0 THEN 'Download needs attention' WHEN SUM(o.download_state='deleted')>0 THEN 'A local file was removed' WHEN SUM(o.download_state!='verified')>0 THEN 'Some outputs are not available locally' ELSE NULL END FROM job_outputs o WHERE o.job_id=j.id) warning,
      COALESCE((SELECT json_group_array(display_name) FROM (SELECT t.display_name FROM job_tags jt JOIN tags t ON t.id=jt.tag_id WHERE jt.job_id=j.id ORDER BY t.display_name)),'[]') tags_json,
      (SELECT o.id FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_id,
      (SELECT o.media_kind FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_kind,
      (SELECT o.content_type FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_type,
      (SELECT o.download_state FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_state,
      (SELECT o.local_path FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_path,
      (SELECT o.pixel_width FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_width,
      (SELECT o.pixel_height FROM job_outputs o WHERE o.job_id=j.id ORDER BY o.favorite DESC,o.download_state='verified' DESC,o.output_order LIMIT 1) representative_height
      FROM jobs j WHERE ${clauses.join(' AND ')} ORDER BY j.created_at DESC,j.id DESC LIMIT ?`;
    const rows = this.database
      .query<LibraryRow, Binding[]>(sql)
      .all(...bindings, Math.min(60, Math.max(1, limit)) + 1);
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const lastPageRow = pageRows.at(-1);
    const countClauses = clauses.filter((clause) => !clause.includes('j.created_at<? OR'));
    const total =
      this.database
        .query<{ count: number }, Binding[]>(
          `SELECT COUNT(*) count FROM jobs j WHERE ${countClauses.join(' AND ')}`
        )
        .get(...countBindings)?.count ?? 0;
    return {
      items: pageRows.map((row) => {
        const model = resolveModel(row.entry_key, row.public_model_id, row.workflow);
        const ipGuardReason = publicIpv4GuardReason(row.attention_code);
        return {
          jobId: row.id,
          entryKey: row.entry_key,
          displayName: model?.displayName ?? row.public_model_id,
          provider: model?.provider ?? 'Unknown provider',
          modality: model?.modality ?? row.representative_kind ?? 'image',
          workflow: row.workflow,
          publicModelId: row.public_model_id,
          promptExcerpt: row.prompt_text?.slice(0, 220) ?? null,
          createdAt: row.created_at,
          completedAt: row.completed_at,
          outputCount: row.output_count,
          verifiedOutputCount: row.verified_count,
          totalBytes: row.total_bytes,
          favorite: row.favorite === 1,
          pinned: row.pinned === 1,
          aspectRatio: row.aspect_ratio,
          warning:
            ipGuardReason === 'match'
              ? 'Blocked by IP guard'
              : ipGuardReason === 'unavailable'
                ? 'IP check unavailable'
                : ipGuardReason === 'misconfigured'
                  ? 'IP guard settings invalid'
                  : row.warning,
          tags: tagArray(row.tags_json),
          representative: mediaSummary(row)
        } satisfies LibraryGroupDto;
      }),
      nextCursor: hasMore && lastPageRow ? encodeCursor(lastPageRow) : null,
      total
    };
  }

  async getJobDetail(id: string): Promise<JobDetailDto | null> {
    const row = this.database
      .query<DetailJobRow, [string]>(
        `SELECT ${listSelect()},j.poyo_task_id,j.correlation_id,j.retry_of_job_id,j.guided_request_json,j.actual_payload_json,j.expert_diff_json,(SELECT state FROM submission_intents si WHERE si.job_id=j.id) submission_state FROM jobs j WHERE j.id=?`
      )
      .get(id);
    if (!row) return null;
    const attempts = this.database
      .query<AttemptRow, [string]>(
        'SELECT da.* FROM download_attempts da JOIN job_outputs o ON o.id=da.output_id WHERE o.job_id=? ORDER BY da.output_id,da.attempt DESC'
      )
      .all(id);
    const attemptsByOutput = Map.groupBy(attempts, (item) => item.output_id);
    const outputRows = this.database
      .query<OutputRow, [string]>('SELECT * FROM job_outputs WHERE job_id=? ORDER BY output_order')
      .all(id);
    const outputs: JobOutputDto[] = [];
    for (const output of outputRows) {
      const localAvailable = Boolean(
        output.local_path && (await Bun.file(output.local_path).exists())
      );
      let remoteHost: string | null = null;
      if (output.remote_url)
        try {
          remoteHost = new URL(output.remote_url).hostname;
        } catch {}
      outputs.push({
        outputId: output.id,
        outputOrder: output.output_order,
        mediaKind: output.media_kind,
        contentType: output.content_type,
        fileName: output.local_path ? basename(output.local_path) : null,
        downloadState: output.download_state,
        mediaUrl: localAvailable ? `/api/media/${encodeURIComponent(output.id)}` : null,
        remoteAvailable: Boolean(output.remote_url),
        remoteHost,
        remoteExpiresAt: output.remote_expires_at,
        byteSize: output.byte_size,
        checksum: output.checksum,
        signature: output.signature,
        aspectRatio: output.aspect_ratio,
        pixelWidth: output.pixel_width,
        pixelHeight: output.pixel_height,
        favorite: output.favorite === 1,
        pinned: output.pinned === 1,
        localAvailable,
        verifiedAt: output.verified_at,
        deletedAt: output.deleted_at,
        metadata: output.remote_metadata_json ? JSON.parse(output.remote_metadata_json) : null,
        attempts: (attemptsByOutput.get(output.id) ?? []).map((attempt) => ({
          attempt: attempt.attempt,
          status: attempt.status,
          bytesReceived: attempt.bytes_received,
          error: attempt.safe_error_json ? JSON.parse(attempt.safe_error_json) : null,
          startedAt: attempt.started_at,
          completedAt: attempt.completed_at
        }))
      });
    }
    const inputs: JobInputDto[] = this.database
      .query<InputRow, [string]>(
        `SELECT ji.*,ms.original_name managed_source_name,ms.byte_size managed_source_bytes,
          ms.checksum managed_source_checksum,ms.availability managed_source_availability
         FROM job_inputs ji LEFT JOIN managed_sources ms ON ms.id=ji.managed_source_id
         WHERE ji.job_id=? ORDER BY ji.role,ji.input_order`
      )
      .all(id)
      .map((input) => ({
        role: input.role,
        inputOrder: input.input_order,
        mediaKind: input.media_kind,
        sourceKind: input.managed_source_id
          ? 'local'
          : input.source_url
            ? 'remote'
            : input.upload_url
              ? 'uploaded'
              : 'unknown',
        sourceLabel:
          input.managed_source_name ?? safeUrlLabel(input.source_url ?? input.upload_url),
        availability: input.managed_source_availability ?? input.availability,
        managedSourceId: input.managed_source_id,
        byteSize: input.managed_source_bytes,
        checksum: input.managed_source_checksum,
        localConsequence:
          input.managed_source_availability === 'available'
            ? 'retained'
            : (input.managed_source_availability ?? 'not-managed'),
        metadata: JSON.parse(input.metadata_json)
      }));
    const history: JobHistoryDto[] = this.database
      .query<HistoryRow, [string]>(
        'SELECT * FROM job_events WHERE job_id=? ORDER BY event_id DESC LIMIT 500'
      )
      .all(id)
      .map((event) => ({
        eventId: event.event_id,
        eventType: event.event_type,
        localPhase: event.local_phase,
        remoteStatusRaw: event.remote_status_raw,
        remoteStatus: event.remote_status,
        failureDomain: event.failure_domain,
        progress: event.progress,
        payload: (() => {
          const payload = event.safe_payload_json ? JSON.parse(event.safe_payload_json) : null;
          return sanitizeDurableJobEventPayload(payload).payload;
        })(),
        observedAt: event.observed_at,
        authority: event.event_type === 'status.observed' ? 'poyo' : 'local'
      }));
    return {
      ...jobDto(row),
      prompt: row.prompt_text,
      poyoTaskId: row.poyo_task_id,
      correlationId: row.correlation_id,
      retryOfJobId: row.retry_of_job_id,
      submissionState: row.submission_state,
      guidedRequest: JSON.parse(row.guided_request_json),
      normalizedPayload: JSON.parse(row.actual_payload_json),
      expertDiff: row.expert_diff_json ? JSON.parse(row.expert_diff_json) : [],
      inputs,
      outputs,
      history,
      tags: this.tags(id)
    };
  }

  filterOptions(): JobFilterOptionsDto {
    const present = this.database
      .query<{ public_model_id: string; workflow: string; entry_key: string | null }, []>(
        'SELECT DISTINCT public_model_id,workflow,entry_key FROM jobs ORDER BY public_model_id,workflow'
      )
      .all();
    const models: ModelFilterOption[] = present.map((row) => {
      const model = resolveModel(row.entry_key, row.public_model_id, row.workflow);
      return {
        publicModelId: row.public_model_id,
        displayName: model?.displayName ?? row.public_model_id,
        provider: model?.provider ?? 'Unknown provider',
        workflow: row.workflow,
        modality: model?.modality ?? 'image'
      };
    });
    return {
      models: models.toSorted((a, b) => a.displayName.localeCompare(b.displayName)),
      workflows: [...new Set(models.map((entry) => entry.workflow))].toSorted(),
      providers: [...new Set(models.map((entry) => entry.provider))].toSorted(),
      tags: this.database
        .query<{ display_name: string }, []>('SELECT display_name FROM tags ORDER BY display_name')
        .all()
        .map((row) => row.display_name)
    };
  }

  tags(jobId: string): string[] {
    return this.database
      .query<{ display_name: string }, [string]>(
        'SELECT t.display_name FROM job_tags jt JOIN tags t ON t.id=jt.tag_id WHERE jt.job_id=? ORDER BY t.display_name'
      )
      .all(jobId)
      .map((row) => row.display_name);
  }

  setFavorite(jobId: string, favorite: boolean): void {
    this.requireJob(jobId);
    this.database
      .query('UPDATE job_outputs SET favorite=? WHERE job_id=?')
      .run(favorite ? 1 : 0, jobId);
  }

  setPinned(jobId: string, pinned: boolean): void {
    this.requireJob(jobId);
    this.database
      .query('UPDATE job_outputs SET pinned=? WHERE job_id=?')
      .run(pinned ? 1 : 0, jobId);
  }

  replaceTags(jobId: string, values: string[]): string[] {
    this.requireJob(jobId);
    const tags = [
      ...new Map(
        values
          .map((value) => value.trim().replace(/\s+/g, ' ').slice(0, 48))
          .filter(Boolean)
          .slice(0, 20)
          .map((value) => [value.toLocaleLowerCase(), value])
      ).entries()
    ];
    this.transaction(() => {
      this.database.query('DELETE FROM job_tags WHERE job_id=?').run(jobId);
      for (const [normalized, display] of tags) {
        this.database
          .query(
            'INSERT INTO tags(normalized_name,display_name,created_at) VALUES (?,?,?) ON CONFLICT(normalized_name) DO UPDATE SET display_name=excluded.display_name'
          )
          .run(normalized, display, this.now().toISOString());
        this.database
          .query(
            'INSERT OR IGNORE INTO job_tags(job_id,tag_id) SELECT ?,id FROM tags WHERE normalized_name=?'
          )
          .run(jobId, normalized);
      }
      this.database.query('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM job_tags)').run();
    });
    return this.tags(jobId);
  }

  async deleteOutput(
    jobId: string,
    outputId: string,
    choice: LocalDeleteChoice,
    paths: Pick<AppPaths, 'media'>
  ): Promise<void> {
    this.requireJob(jobId);
    const output = this.database
      .query<{ local_path: string | null }, [string, string]>(
        'SELECT local_path FROM job_outputs WHERE id=? AND job_id=?'
      )
      .get(outputId, jobId);
    if (!output) throw new Error('Output not found.');
    if ((choice === 'file' || choice === 'both') && output.local_path) {
      let resolved: string;
      try {
        resolved = resolvePathWithin(paths.media, output.local_path);
      } catch {
        throw new Error('The output file is outside managed media storage and cannot be removed.');
      }
      await Bun.file(resolved)
        .delete()
        .catch((error) => {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
        });
    }
    const timestamp = this.now().toISOString();
    this.transaction(() => {
      if (choice === 'file')
        this.database
          .query(
            "UPDATE job_outputs SET local_path=NULL,download_state='deleted',verified_at=NULL,deleted_at=? WHERE id=? AND job_id=?"
          )
          .run(timestamp, outputId, jobId);
      else
        this.database.query('DELETE FROM job_outputs WHERE id=? AND job_id=?').run(outputId, jobId);
      this.appendEvent(jobId, `output.local_${choice}_removed`, { outputId });
    });
  }

  async storageStatistics(
    paths: Pick<AppPaths, 'media' | 'uploads'>
  ): Promise<StorageStatisticsDto> {
    await new ManagedSourceRepository(this.database, paths).reconcileAll();
    const outputs = this.database
      .query<{ indexed_bytes: number; verified: number; missing: number }, []>(
        `SELECT COALESCE(SUM(CASE WHEN download_state='verified' THEN COALESCE(byte_size,0) ELSE 0 END),0) indexed_bytes,
          COALESCE(SUM(download_state='verified'),0) verified,
          COALESCE(SUM(download_state IN ('deleted','failed','expired')),0) missing
         FROM job_outputs`
      )
      .get();
    const sources = this.database
      .query<{ indexed_bytes: number; available: number; missing: number }, []>(
        `SELECT COALESCE(SUM(CASE WHEN availability='available' THEN byte_size ELSE 0 END),0) indexed_bytes,
          COALESCE(SUM(availability='available'),0) available,
          COALESCE(SUM(availability IN ('missing','deleted')),0) missing
         FROM managed_sources`
      )
      .get();
    let capacityBytes: number | null = null;
    let freeBytes: number | null = null;
    try {
      const stats = await import('node:fs/promises').then(({ statfs }) => statfs(paths.media));
      capacityBytes = Number(stats.blocks) * Number(stats.bsize);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {}
    return {
      indexedBytes: (outputs?.indexed_bytes ?? 0) + (sources?.indexed_bytes ?? 0),
      verifiedFiles: (outputs?.verified ?? 0) + (sources?.available ?? 0),
      missingOrDeletedFiles: (outputs?.missing ?? 0) + (sources?.missing ?? 0),
      generatedBytes: outputs?.indexed_bytes ?? 0,
      managedSourceBytes: sources?.indexed_bytes ?? 0,
      managedSourceFiles: sources?.available ?? 0,
      missingOrDeletedSources: sources?.missing ?? 0,
      capacityBytes,
      freeBytes
    };
  }

  private requireJob(id: string): void {
    if (!this.database.query<{ id: string }, [string]>('SELECT id FROM jobs WHERE id=?').get(id))
      throw new Error('Job not found.');
  }

  private appendEvent(jobId: string, eventType: string, payload: Record<string, unknown>): void {
    const job = this.database
      .query<{ attention_code: string | null }, [string]>(
        'SELECT attention_code FROM jobs WHERE id=?'
      )
      .get(jobId);
    if (!job) throw new Error('Job not found.');
    this.database
      .query(
        `INSERT INTO job_events(job_id,event_type,local_phase,remote_status_raw,remote_status,failure_domain,progress,safe_payload_json,observed_at)
         SELECT id,?,local_phase,remote_status_raw,remote_status,failure_domain,progress,?,? FROM jobs WHERE id=?`
      )
      .run(
        eventType,
        JSON.stringify(packDurableJobEventPayload(payload, job.attention_code)),
        this.now().toISOString(),
        jobId
      );
  }
}

function safeUrlLabel(value: string | null): string {
  if (!value) return 'Source metadata unavailable';
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.slice(0, 180);
  } catch {
    return 'Source URL unavailable';
  }
}

export function studioReuseEntry(modality: 'image' | 'video', sourceKind: 'image' | 'video') {
  const entries = modality === 'image' ? IMAGE_REGISTRY_ENTRIES : VIDEO_REGISTRY_ENTRIES;
  const preferredWorkflows =
    modality === 'image'
      ? ['image-edit', 'image-to-image']
      : sourceKind === 'image'
        ? ['image-to-video', 'frame-to-video', 'reference-to-video']
        : ['video-to-video', 'video-edit'];
  return entries.find(
    (entry) =>
      entry.status === 'current' &&
      preferredWorkflows.includes(entry.workflow) &&
      entry.inputRoles.some((role) => role.mediaKind === sourceKind)
  );
}

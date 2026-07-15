import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import { modelCatalogue } from '../../src/lib/features/registry/catalogue';
import type { JobFiltersDto, LibraryFiltersDto } from '../../src/lib/features/library/contracts';
import { LibraryRepository } from '../../src/lib/server/library/repository';
import { openDatabase } from '../../src/lib/server/platform/database';
import { createTemporaryDirectory } from '../helpers/temporary-directory';

setDefaultTimeout(30_000);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function measure(operation: () => void, iterations = 20): number {
  operation();
  const samples = Array.from({ length: iterations }, () => {
    const started = performance.now();
    operation();
    return performance.now() - started;
  });
  return percentile95(samples);
}

const libraryFilters: LibraryFiltersDto = {
  q: '',
  mediaKind: '',
  model: '',
  provider: '',
  workflow: '',
  aspectRatio: '',
  status: 'all',
  favorite: false,
  tag: '',
  dateFrom: '',
  dateTo: '',
  cursor: '',
  view: 'grid'
};
const jobFilters: JobFiltersDto = {
  status: 'all',
  q: '',
  model: '',
  workflow: '',
  dateFrom: '',
  dateTo: '',
  cursor: ''
};

describe('PERF-01..04 representative local scale', () => {
  test('10k generations and 25k outputs keep bounded list and search latency', async () => {
    const temporary = await createTemporaryDirectory('poyo-performance-');
    cleanups.push(temporary.cleanup);
    const database = await openDatabase(join(temporary.path, 'studio.sqlite'));
    try {
      const insertJob = database.query(
        `INSERT INTO jobs(
          id,workflow,public_model_id,local_phase,remote_status,failure_domain,
          guided_request_json,actual_payload_json,prompt_text,search_text,correlation_id,
          created_at,updated_at,completed_at
        ) VALUES (?,?,?,'complete','finished','none',?,?,?,?,?,?,?,?)`
      );
      const insertOutput = database.query(
        `INSERT INTO job_outputs(
          id,job_id,output_order,media_kind,remote_url,local_path,content_type,byte_size,
          download_state,favorite,pinned,created_at,verified_at
        ) VALUES (?,?,?,?,?,?,?,?, 'verified',?,?,?,?)`
      );
      database.transaction(() => {
        let outputIndex = 0;
        for (let index = 0; index < 10_000; index += 1) {
          const id = `job-${index.toString().padStart(8, '0')}`;
          const createdAt = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
          const prompt = index === 7_777 ? 'unique cobalt observatory' : `calm coast ${index}`;
          insertJob.run(
            id,
            index % 3 === 0 ? 'text-to-video' : 'text-to-image',
            index % 3 === 0 ? 'grok-imagine-video' : 'flux-schnell',
            JSON.stringify({ prompt, aspectRatio: '16:9' }),
            JSON.stringify({
              model: index % 3 === 0 ? 'grok-imagine-video' : 'flux-schnell',
              input: { prompt }
            }),
            prompt,
            `${prompt} ${index % 3 === 0 ? 'video' : 'image'}`,
            `correlation-${index}`,
            createdAt,
            createdAt,
            createdAt
          );
          const count = index % 2 === 0 ? 3 : 2;
          for (let order = 0; order < count; order += 1) {
            const mediaKind = index % 3 === 0 ? 'video' : 'image';
            insertOutput.run(
              `output-${outputIndex.toString().padStart(8, '0')}`,
              id,
              order,
              mediaKind,
              `https://media.example/${outputIndex}.${mediaKind === 'video' ? 'mp4' : 'png'}`,
              `/studio/media/${id}/${order}.${mediaKind === 'video' ? 'mp4' : 'png'}`,
              mediaKind === 'video' ? 'video/mp4' : 'image/png',
              1024 + order,
              index % 97 === 0 ? 1 : 0,
              0,
              createdAt,
              createdAt
            );
            outputIndex += 1;
          }
        }
        expect(outputIndex).toBe(25_000);
      })();

      const repository = new LibraryRepository(database);
      const libraryP95 = measure(() => {
        expect(repository.listLibrary(libraryFilters, 24).items).toHaveLength(24);
      });
      const searchP95 = measure(() => {
        const result = repository.listLibrary(
          { ...libraryFilters, q: 'unique cobalt observatory' },
          24
        );
        expect(result.total).toBe(1);
      });
      const jobsP95 = measure(() => {
        expect(repository.listJobs(jobFilters, 8).items).toHaveLength(8);
      });

      expect(libraryP95).toBeLessThan(500);
      expect(searchP95).toBeLessThan(300);
      expect(jobsP95).toBeLessThan(350);
    } finally {
      database.close();
    }
  });

  test('model catalogue filtering stays comfortably below interactive budget', () => {
    const entries = modelCatalogue();
    const p95 = measure(() => {
      const filtered = entries.filter(
        (entry) =>
          entry.displayName.toLowerCase().includes('video') ||
          entry.provider.toLowerCase().includes('google') ||
          entry.workflow.includes('image')
      );
      expect(filtered.length).toBeGreaterThan(0);
    }, 100);
    expect(p95).toBeLessThan(50);
  });
});

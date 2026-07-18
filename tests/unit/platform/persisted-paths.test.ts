import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { migrations } from '../../../migrations';
import { openDatabase } from '../../../src/lib/server/platform/database';
import {
  findPersistedPathsUnderRoot,
  PERSISTED_PATH_INVENTORY,
  PERSISTED_RELATIVE_PATH_FIELDS,
  rebasePersistedPath,
  rebasePersistedPaths
} from '../../../src/lib/server/platform/persisted-paths';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('persisted root-owned path inventory', () => {
  test('keeps the reviewed absolute-path surfaces explicit', () => {
    expect(PERSISTED_PATH_INVENTORY).toEqual([
      'job_outputs.local_path',
      'job_inputs.local_reference',
      'app_settings.storage.outputDirectory',
      'app_settings.storage.previousRoots[]',
      'cleanup_actions.safe_result_json..localPath',
      'cleanup_attempts.safe_result_json..localPath'
    ]);
  });

  test('statically accounts for schema, settings, and cleanup snapshot path fields', async () => {
    const discoveredSchemaFields = new Set<string>();
    for (const migration of migrations) {
      let table: string | null = null;
      for (const line of migration.sql.split('\n')) {
        const created = line.match(/^CREATE TABLE\s+([a-z_]+)/i);
        const altered = line.match(/^ALTER TABLE\s+([a-z_]+)/i);
        if (created?.[1]) table = created[1];
        if (altered?.[1]) table = altered[1];
        const column = line.match(
          /^\s*([a-z_]*(?:path|reference|directory|root)[a-z_]*)\s+TEXT\b/i
        );
        if (table && column?.[1]) discoveredSchemaFields.add(`${table}.${column[1]}`);
        if (line.trim() === ');') table = null;
      }
    }
    const registeredSchemaFields = [
      ...PERSISTED_PATH_INVENTORY.filter(
        (entry) => entry.startsWith('job_outputs.') || entry.startsWith('job_inputs.')
      ),
      ...PERSISTED_RELATIVE_PATH_FIELDS
    ];
    expect([...discoveredSchemaFields].toSorted()).toEqual(registeredSchemaFields.toSorted());

    const settings = await Bun.file('src/lib/server/settings/studio-settings.ts').text();
    const storageInterface =
      settings.match(/export interface StoragePreferences \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const storageFields = [...storageInterface.matchAll(/^\s*([a-zA-Z0-9_]+):/gm)].map(
      (match) => `app_settings.storage.${match[1]}${match[1] === 'previousRoots' ? '[]' : ''}`
    );
    expect(storageFields.toSorted()).toEqual(
      PERSISTED_PATH_INVENTORY.filter((entry) => entry.startsWith('app_settings.')).toSorted()
    );

    const cleanup = await Bun.file('src/lib/server/cleanup/repository.ts').text();
    expect(cleanup).toContain('localPath: string;');
    expect(PERSISTED_PATH_INVENTORY.filter((entry) => entry.includes('safe_result_json'))).toEqual([
      'cleanup_actions.safe_result_json..localPath',
      'cleanup_attempts.safe_result_json..localPath'
    ]);
  });

  test('rebases source-owned paths once while preserving external references', async () => {
    const temporary = await createTemporaryDirectory('poyo-path-rebase-');
    cleanups.push(temporary.cleanup);
    const source = join(temporary.path, 'source');
    const target = join(temporary.path, 'target');
    const external = join(temporary.path, 'external', 'kept.png');
    const database = await openDatabase(join(temporary.path, 'paths.sqlite'));
    const timestamp = '2026-07-17T00:00:00.000Z';
    try {
      database
        .query(
          `INSERT INTO jobs(
            id,workflow,public_model_id,local_phase,remote_status,failure_domain,
            guided_request_json,correlation_id,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          'job-1',
          'generate',
          'model-1',
          'complete',
          'finished',
          'none',
          '{}',
          'correlation-1',
          timestamp,
          timestamp
        );
      database
        .query(
          `INSERT INTO job_outputs(
            id,job_id,output_order,media_kind,local_path,download_state,created_at
          ) VALUES (?,?,?,?,?,?,?)`
        )
        .run(
          'output-1',
          'job-1',
          0,
          'image',
          join(source, 'media', 'output.png'),
          'verified',
          timestamp
        );
      database
        .query(
          `INSERT INTO job_outputs(
            id,job_id,output_order,media_kind,local_path,download_state,created_at
          ) VALUES (?,?,?,?,?,?,?)`
        )
        .run('output-2', 'job-1', 1, 'image', external, 'verified', timestamp);
      database
        .query(
          `INSERT INTO job_inputs(
            job_id,role,input_order,media_kind,local_reference,metadata_json,availability
          ) VALUES (?,?,?,?,?,?,?)`
        )
        .run(
          'job-1',
          'reference',
          0,
          'image',
          join(source, 'uploads', 'input.png'),
          '{}',
          'available'
        );
      database
        .query('INSERT INTO app_settings(key,value_version,value_json,updated_at) VALUES (?,?,?,?)')
        .run(
          'storage',
          1,
          JSON.stringify({
            outputDirectory: join(source, 'media'),
            previousRoots: [join(source, 'old-media'), external],
            unrelated: 'preserved'
          }),
          timestamp
        );
      database
        .query(
          `INSERT INTO cleanup_actions(
            id,action_kind,target_id,preview_version,state,due_at,safe_result_json,created_at
          ) VALUES (?,?,?,?,?,?,?,?)`
        )
        .run(
          'cleanup-1',
          'local_file',
          'output-1',
          'preview-1',
          'executing',
          timestamp,
          JSON.stringify({ nested: { localPath: join(source, 'media', 'output.png') } }),
          timestamp
        );
      database
        .query(
          `INSERT INTO cleanup_attempts(
            action_id,attempt,status,safe_result_json,started_at
          ) VALUES (?,?,?,?,?)`
        )
        .run(
          'cleanup-1',
          1,
          'started',
          JSON.stringify({ localPath: join(source, 'media', 'output.png') }),
          timestamp
        );
      database
        .query(
          `INSERT INTO work_claims(
            work_type,work_id,owner,token,acquired_at,expires_at,attempt
          ) VALUES (?,?,?,?,?,?,?)`
        )
        .run('cleanup', 'cleanup-1', 'owner', 'claim-token', timestamp, timestamp, 1);

      expect(findPersistedPathsUnderRoot(database, source)).toHaveLength(6);
      const first = rebasePersistedPaths(database, source, target, {
        now: new Date('2026-07-17T01:00:00.000Z')
      });
      expect(first).toEqual({ changedPaths: 6, invalidatedCleanupActions: 1 });
      expect(findPersistedPathsUnderRoot(database, source)).toEqual([]);
      // The started attempt is invalidated to a safe code-only result, so its stale action path is
      // deliberately removed rather than retained as an executable-looking audit payload.
      expect(findPersistedPathsUnderRoot(database, target)).toHaveLength(5);
      expect(
        database
          .query<{ local_path: string }, []>(
            "SELECT local_path FROM job_outputs WHERE id='output-2'"
          )
          .get()?.local_path
      ).toBe(external);
      expect(
        database
          .query<{ state: string }, []>("SELECT state FROM cleanup_actions WHERE id='cleanup-1'")
          .get()?.state
      ).toBe('failed');
      expect(
        database
          .query<{ status: string }, [string]>(
            'SELECT status FROM cleanup_attempts WHERE action_id=?'
          )
          .get('cleanup-1')?.status
      ).toBe('failed');
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) count FROM work_claims WHERE work_type='cleanup'"
          )
          .get()?.count
      ).toBe(0);

      expect(rebasePersistedPaths(database, source, target)).toEqual({
        changedPaths: 0,
        invalidatedCleanupActions: 0
      });
    } finally {
      database.close();
    }
  });

  test('uses platform case rules for the pure transform', () => {
    expect(rebasePersistedPath('C:\\Studio\\Media\\a.png', 'c:\\studio', 'D:\\Poyo', 'win32')).toBe(
      'D:\\Poyo\\Media\\a.png'
    );
  });
});

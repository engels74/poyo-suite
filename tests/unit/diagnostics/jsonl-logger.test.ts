import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  StructuredLogger,
  type LoggerFileOperations
} from '../../../src/lib/server/diagnostics/jsonl-logger';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('structured JSONL logging', () => {
  test('LOG-01 separates errors, redacts records, and bounds size rotation retention', async () => {
    const temporary = await createTemporaryDirectory('poyo-log-');
    cleanups.push(temporary.cleanup);
    const secret = 'sk-test_log_canary_123456789';
    const logger = new StructuredLogger({
      directory: temporary.path,
      maxBytes: 220,
      maxRotatedFiles: 2,
      retentionAgeMs: Number.MAX_SAFE_INTEGER
    });

    for (let index = 0; index < 7; index += 1) {
      await logger.info('generation.observed', {
        correlationId: `correlation-${index}`,
        data: { authorization: `Bearer ${secret}`, message: 'x'.repeat(100) }
      });
    }
    await logger.error('generation.failed', new Error(`failure ${secret}`));

    const names = await readdir(temporary.path);
    const rotated = names.filter((name) => name.startsWith('app.jsonl.'));
    const contents = await Promise.all(
      names.map((name) => Bun.file(join(temporary.path, name)).text())
    );

    expect(rotated.length).toBeLessThanOrEqual(2);
    expect(names).toContain('app.jsonl');
    expect(names).toContain('error.jsonl');
    expect(contents.join('')).not.toContain(secret);
    for (const line of contents.join('').trim().split('\n'))
      expect(() => JSON.parse(line)).not.toThrow();
  });

  test('survives rotation failures and exposes only a safe degraded diagnostic', async () => {
    const temporary = await createTemporaryDirectory('poyo-log-failure-');
    cleanups.push(temporary.cleanup);
    let rotationErrors = 0;
    const files: LoggerFileOperations = {
      append: (path, content) => appendFile(path, content, 'utf8'),
      list: (path) => readdir(path),
      mkdir: async (path) => mkdir(path, { recursive: true }).then(() => undefined),
      remove: (path) => unlink(path),
      rename: () => Promise.reject(new Error('rename failed with token=unsafe-value')),
      stat: async (path) => {
        try {
          const info = await stat(path);
          return { size: info.size, mtimeMs: info.mtimeMs };
        } catch {
          return null;
        }
      }
    };
    const logger = new StructuredLogger({
      directory: temporary.path,
      maxBytes: 1,
      files,
      onRotationError: () => {
        rotationErrors += 1;
      }
    });

    await logger.info('first');
    await logger.info('second');
    const diagnostics = await logger.diagnostics();
    expect(rotationErrors).toBe(1);
    expect(diagnostics.status).toBe('degraded');
    expect(JSON.stringify(diagnostics)).not.toContain('unsafe-value');
    expect(
      (await Bun.file(join(temporary.path, 'app.jsonl')).text()).trim().split('\n')
    ).toHaveLength(2);
  });

  test('applies validated runtime rotation settings without recreating the logger', () => {
    const logger = new StructuredLogger({ directory: '/tmp/poyo-test-logs' });
    logger.updateRotationSettings({
      separateErrorFile: false,
      maxBytes: 65_536,
      maxAgeMs: 60_000,
      retentionAgeMs: 3_600_000,
      maxRotatedFiles: 4
    });
    expect(logger.rotationSettings()).toEqual({
      separateErrorFile: false,
      maxBytes: 65_536,
      maxAgeMs: 60_000,
      retentionAgeMs: 3_600_000,
      maxRotatedFiles: 4
    });
    expect(() =>
      logger.updateRotationSettings({
        separateErrorFile: true,
        maxBytes: 0,
        maxAgeMs: 1,
        retentionAgeMs: 1,
        maxRotatedFiles: 1
      })
    ).toThrow('supported bounds');
  });
});

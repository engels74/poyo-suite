import { describe, expect, test } from 'bun:test';
import type { CleanupRepository } from '../../../src/lib/server/cleanup/repository';
import { CleanupRuntime } from '../../../src/lib/server/cleanup/runtime';
import type { CleanupService } from '../../../src/lib/server/cleanup/service';
import {
  type LoggerFileOperations,
  StructuredLogger
} from '../../../src/lib/server/diagnostics/jsonl-logger';
import { JobWorker } from '../../../src/lib/server/jobs/coordinator';
import { MaintenanceGate } from '../../../src/lib/server/platform/maintenance-gate';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  expect(
    await Promise.race([promise.then(() => 'settled'), Bun.sleep(10).then(() => 'pending')])
  ).toBe('pending');
}

describe('maintenance drain adapters', () => {
  test('JobWorker stopAndDrain cancels future ticks and awaits the running tick', async () => {
    const gate = new MaintenanceGate();
    const started = deferred();
    const finish = deferred();
    let calls = 0;
    const worker = new JobWorker(
      {
        recoverOnce: async () => {
          calls += 1;
          started.resolve();
          await finish.promise;
        }
      },
      60_000,
      gate
    );
    worker.start();
    await started.promise;

    const drain = worker.stopAndDrain();
    await expectPending(drain);
    finish.resolve();
    await drain;
    expect(calls).toBe(1);
    expect(gate.status().activeWriters).toBe(0);
  });

  test('CleanupRuntime stopAndDrain cancels its schedule and awaits runOnce', async () => {
    const gate = new MaintenanceGate();
    const started = deferred();
    const finish = deferred();
    let scheduleCancelled = false;
    const repository = {
      reconcileExpiredClaims: () => undefined,
      claimNext: () => null,
      actionCounts: () => ({})
    } as unknown as CleanupRepository;
    const service = {
      scheduleEnabledPolicy: async () => {
        started.resolve();
        await finish.promise;
      },
      execute: () => Promise.resolve()
    } as unknown as CleanupService;
    const runtime = new CleanupRuntime({
      repository,
      service,
      gate,
      schedule: () => () => {
        scheduleCancelled = true;
      }
    });
    runtime.start();
    await started.promise;

    const drain = runtime.stopAndDrain();
    expect(scheduleCancelled).toBe(true);
    await expectPending(drain);
    finish.resolve();
    await drain;
    expect(gate.status().activeWriters).toBe(0);
  });

  test('StructuredLogger suspends new appends and flushes its queued write', async () => {
    const gate = new MaintenanceGate();
    const appendStarted = deferred();
    const finishAppend = deferred();
    let appends = 0;
    const files: LoggerFileOperations = {
      append: async () => {
        appends += 1;
        appendStarted.resolve();
        await finishAppend.promise;
      },
      list: () => Promise.resolve([]),
      mkdir: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      rename: () => Promise.resolve(),
      stat: () => Promise.resolve(null)
    };
    const logger = new StructuredLogger({ directory: '/logs', files, gate });
    const write = logger.info('maintenance.drain');
    await appendStarted.promise;

    const drain = logger.suspendAndDrain();
    await expectPending(drain);
    finishAppend.resolve();
    await Promise.all([write, drain]);
    await expect(logger.info('must-not-append')).rejects.toThrow('suspended');
    expect(appends).toBe(1);
    expect(gate.status().activeWriters).toBe(0);
  });
});

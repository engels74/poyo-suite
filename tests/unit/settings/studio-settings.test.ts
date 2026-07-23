import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDatabase } from '../../../src/lib/server/platform/database';
import { SettingsRepository } from '../../../src/lib/server/settings/settings-repository';
import {
  computeOnboardingState,
  readOnboarding,
  updateOnboarding
} from '../../../src/lib/server/settings/studio-settings';
import { createTemporaryDirectory } from '../../helpers/temporary-directory';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function repository(): Promise<SettingsRepository> {
  const dir = await createTemporaryDirectory('studio-settings');
  const database = await openDatabase(join(dir.path, 'studio.sqlite'));
  cleanups.push(() => dir.cleanup());
  cleanups.push(() => database.close());
  return new SettingsRepository(database);
}

describe('onboarding state', () => {
  const completeRecord = () => ({
    version: 1 as const,
    completedAt: '2026-01-01T00:00:00.000Z',
    dismissedAt: null,
    steps: {
      location: true,
      mediaPrivacy: true,
      connection: true,
      theme: true,
      defaults: true
    }
  });

  test('a brand-new install is incomplete until explicitly completed or dismissed', () => {
    expect(computeOnboardingState(null).completed).toBe(false);
  });

  test('round-trips a complete record-v1 through a setting-envelope v1', async () => {
    const settings = await repository();
    const record = completeRecord();
    settings.set('onboarding', record, 1);

    expect(readOnboarding(settings)).toEqual(record);
    expect(computeOnboardingState(readOnboarding(settings)).completed).toBe(true);
  });

  test('completes, dismisses, and reopens a current record-v1', async () => {
    const settings = await repository();
    const completed = updateOnboarding(
      settings,
      { complete: true, steps: completeRecord().steps },
      new Date('2026-01-01T00:00:00.000Z')
    );
    expect(readOnboarding(settings)).toEqual(completed);

    const dismissed = updateOnboarding(
      settings,
      { dismiss: true },
      new Date('2026-01-02T00:00:00.000Z')
    );
    expect(dismissed.completedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(dismissed.dismissedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(readOnboarding(settings)).toEqual(dismissed);

    const reopened = updateOnboarding(settings, { reopen: true });
    expect(reopened).toEqual({
      version: 1,
      completedAt: null,
      dismissedAt: null,
      steps: {
        location: false,
        mediaPrivacy: false,
        connection: false,
        theme: false,
        defaults: false
      }
    });
    expect(readOnboarding(settings)).toEqual(reopened);
  });

  test('preserves partial update semantics for current record-v1', async () => {
    const settings = await repository();
    const first = updateOnboarding(settings, { steps: { location: true } });
    const second = updateOnboarding(settings, { steps: { connection: true } });

    expect(first.steps).toEqual({
      location: true,
      mediaPrivacy: false,
      connection: false,
      theme: false,
      defaults: false
    });
    expect(second.steps).toEqual({
      location: true,
      mediaPrivacy: false,
      connection: true,
      theme: false,
      defaults: false
    });
    expect(second.completedAt).toBeNull();
    expect(second.dismissedAt).toBeNull();
    expect(readOnboarding(settings)).toEqual(second);
  });

  test('rejects wrong setting-envelope and embedded record versions without mutation', async () => {
    const settings = await repository();
    const invalidRecords = [
      { name: 'wrong setting-envelope version', value: completeRecord(), version: 2 },
      {
        name: 'wrong embedded record version',
        value: { ...completeRecord(), version: 2 },
        version: 1
      }
    ];

    for (const invalid of invalidRecords) {
      settings.set('onboarding', invalid.value, invalid.version);
      const before = settings.get('onboarding');

      expect(() => readOnboarding(settings), invalid.name).not.toThrow();
      expect(readOnboarding(settings)).toBeNull();
      expect(settings.get('onboarding')).toEqual(before);
    }
  });
  test('treats invalid persisted timestamps as absent without repairing the stored record', async () => {
    const settings = await repository();
    const invalidTimestamps = [
      '',
      'not a timestamp',
      '2026-02-30T00:00:00.000Z',
      '2026-01-01T00:00:00Z',
      'x'.repeat(65)
    ];

    for (const timestamp of invalidTimestamps) {
      for (const field of ['completedAt', 'dismissedAt'] as const) {
        const record = { ...completeRecord(), [field]: timestamp };
        settings.set('onboarding', record, 1);
        const before = settings.get('onboarding');

        expect(() => readOnboarding(settings), `${field}: ${timestamp}`).not.toThrow();
        expect(readOnboarding(settings)).toBeNull();
        expect(computeOnboardingState(readOnboarding(settings)).completed).toBe(false);
        expect(settings.get('onboarding')).toEqual(before);
      }
    }
  });

  test('rejects partial and malformed records without mutation or raw errors', async () => {
    const settings = await repository();
    const invalidRecords: unknown[] = [
      { version: 1, completedAt: null, dismissedAt: null },
      { version: 1, completedAt: null, dismissedAt: null, steps: { location: true } },
      { version: 1, completedAt: 1, dismissedAt: null, steps: completeRecord().steps },
      { version: 1, completedAt: null, dismissedAt: null, steps: null },
      [],
      null
    ];

    for (const value of invalidRecords) {
      settings.set('onboarding', value, 1);
      const before = settings.get('onboarding');

      expect(() => readOnboarding(settings)).not.toThrow();
      expect(readOnboarding(settings)).toBeNull();
      expect(settings.get('onboarding')).toEqual(before);
    }
  });
});

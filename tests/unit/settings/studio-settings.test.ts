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
  test('a brand-new install is incomplete until explicitly completed or dismissed', () => {
    const state = computeOnboardingState(null);
    expect(state.completed).toBe(false);
  });

  test('an explicit completion marker completes onboarding', () => {
    const state = computeOnboardingState({
      version: 1,
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
    expect(state.completed).toBe(true);
  });

  test('update records completion and reopen clears it', async () => {
    const settings = await repository();
    const completed = updateOnboarding(settings, {
      complete: true,
      steps: { location: true }
    });
    expect(completed.completedAt).not.toBeNull();
    expect(completed.steps.location).toBe(true);
    expect(readOnboarding(settings)?.completedAt).not.toBeNull();

    const reopened = updateOnboarding(settings, { reopen: true });
    expect(reopened.completedAt).toBeNull();
    expect(reopened.dismissedAt).toBeNull();
    // Reopening restarts the flow: previously-completed steps reset so firstIncompleteStep() lands
    // on the first step rather than the done screen.
    expect(reopened.steps).toEqual({
      location: false,
      mediaPrivacy: false,
      connection: false,
      theme: false,
      defaults: false
    });
  });

  test('normalizes older in-progress records without changing completed markers', async () => {
    const settings = await repository();
    settings.set('onboarding', {
      completedAt: '2026-01-01T00:00:00.000Z',
      dismissedAt: null,
      steps: { location: true, connection: true, theme: true, defaults: true }
    });
    const record = readOnboarding(settings);
    expect(record?.steps.mediaPrivacy).toBe(false);
    expect(computeOnboardingState(record).completed).toBe(true);
  });

  test('dismiss marks completion without a completedAt', async () => {
    const settings = await repository();
    const dismissed = updateOnboarding(settings, { dismiss: true });
    expect(dismissed.dismissedAt).not.toBeNull();
    const state = computeOnboardingState(readOnboarding(settings));
    expect(state.completed).toBe(true);
  });
});

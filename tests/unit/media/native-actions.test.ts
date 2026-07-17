import { describe, expect, test } from 'bun:test';
import {
  nativeMediaCapabilities,
  runNativeMediaAction
} from '../../../src/lib/server/media/native-actions';

describe('native media actions', () => {
  test('uses argument arrays for platform commands without shell interpolation', async () => {
    const commands: string[][] = [];
    const dependencies = {
      platform: 'darwin' as const,
      which: (command: string) => (command === 'open' ? '/usr/bin/open' : null),
      spawn: (command: string[]) => {
        commands.push(command);
        return { exited: Promise.resolve(0) };
      }
    };
    const path = '/managed/output; touch injected.png';
    await runNativeMediaAction(path, 'open-native', dependencies);
    await runNativeMediaAction(path, 'reveal', dependencies);
    expect(commands).toEqual([
      ['/usr/bin/open', path],
      ['/usr/bin/open', '-R', path]
    ]);
  });

  test('builds Windows selection and Linux containing-folder commands', async () => {
    const commands: string[][] = [];
    const spawn = (command: string[]) => {
      commands.push(command);
      return { exited: Promise.resolve(0) };
    };
    await runNativeMediaAction('C:\\media\\result.png', 'reveal', {
      platform: 'win32',
      which: () => 'C:\\Windows\\explorer.exe',
      spawn
    });
    await runNativeMediaAction('/media/job/result.png', 'reveal', {
      platform: 'linux',
      which: () => '/usr/bin/xdg-open',
      spawn
    });
    expect(commands).toEqual([
      ['C:\\Windows\\explorer.exe', '/select,C:\\media\\result.png'],
      ['/usr/bin/xdg-open', '/media/job']
    ]);
  });

  test('reports unsupported or missing platform commands honestly', async () => {
    expect(nativeMediaCapabilities({ platform: 'aix', which: () => null })).toMatchObject({
      openNative: false,
      reveal: false
    });
    expect(nativeMediaCapabilities({ platform: 'linux', which: () => null })).toMatchObject({
      openNative: false,
      reveal: false,
      revealLabel: 'Show in folder'
    });
    await expect(
      runNativeMediaAction('/media/output.png', 'open-native', {
        platform: 'linux',
        which: () => null
      })
    ).rejects.toThrow('not available');
  });

  test('maps process launch failures and nonzero exits to a path-free safe error', async () => {
    let caught: Error | null = null;
    try {
      await runNativeMediaAction('/media/private-user/output.png', 'open-native', {
        platform: 'linux',
        which: () => '/usr/bin/xdg-open',
        spawn: () => {
          throw new Error('/media/private-user/output.png failed');
        }
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBe('The native file action could not be completed.');
    expect(caught?.message).not.toContain('/media/');

    await expect(
      runNativeMediaAction('/media/private-user/output.png', 'reveal', {
        platform: 'linux',
        which: () => '/usr/bin/xdg-open',
        spawn: () => ({ exited: Promise.resolve(1) })
      })
    ).rejects.toMatchObject({
      code: 'native_action_failed',
      message: 'The native file action could not be completed.'
    });
  });
});

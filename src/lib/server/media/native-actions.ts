import { dirname } from 'node:path';
import type { NativeMediaCapabilities } from '../../features/library/contracts';
import { MediaActionError } from './verified-output';

type NativeMediaAction = 'open-native' | 'reveal';

export interface NativeMediaDependencies {
  platform?: NodeJS.Platform;
  which?: (command: string) => string | null;
  spawn?: (command: string[]) => { exited: Promise<number> };
}

function actionCommand(
  path: string,
  action: NativeMediaAction,
  dependencies: NativeMediaDependencies
): string[] | null {
  const platform = dependencies.platform ?? process.platform;
  const command =
    platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'explorer'
        : platform === 'linux'
          ? 'xdg-open'
          : null;
  if (!command) return null;
  const executable = (dependencies.which ?? Bun.which)(command);
  if (!executable) return null;
  if (action === 'open-native') return [executable, path];
  if (platform === 'darwin') return [executable, '-R', path];
  if (platform === 'win32') return [executable, `/select,${path}`];
  return [executable, dirname(path)];
}

export function nativeMediaCapabilities(
  dependencies: NativeMediaDependencies = {}
): NativeMediaCapabilities {
  const platform = dependencies.platform ?? process.platform;
  const available = actionCommand('/capability-probe', 'open-native', dependencies) !== null;
  return {
    openNative: available,
    reveal: available,
    revealLabel:
      platform === 'darwin'
        ? 'Reveal in Finder'
        : platform === 'win32'
          ? 'Show in File Explorer'
          : 'Show in folder'
  };
}

export async function runNativeMediaAction(
  path: string,
  action: NativeMediaAction,
  dependencies: NativeMediaDependencies = {}
): Promise<void> {
  const command = actionCommand(path, action, dependencies);
  if (!command) {
    throw new MediaActionError(
      'native_action_unavailable',
      409,
      'This native file action is not available on the current platform.'
    );
  }
  try {
    const processHandle = (dependencies.spawn ?? defaultSpawn)(command);
    if ((await processHandle.exited) !== 0) throw new Error('Native command failed.');
  } catch {
    throw new MediaActionError(
      'native_action_failed',
      400,
      'The native file action could not be completed.'
    );
  }
}

function defaultSpawn(command: string[]): { exited: Promise<number> } {
  const child = Bun.spawn(command, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  return { exited: child.exited };
}

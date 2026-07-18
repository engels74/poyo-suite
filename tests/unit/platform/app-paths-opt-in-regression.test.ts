import { describe, expect, test } from 'bun:test';
import { join, relative, resolve } from 'node:path';
import { resolveAppPaths } from '../../../src/lib/server/platform/app-paths';

const repositoryRoot = resolve(import.meta.dir, '../../..');

describe('project-local app path defaults', () => {
  test('defaults every platform branch to <repo>/data without nesting the database under data/data', () => {
    const expectedRoot = join(repositoryRoot, 'data');
    const expectedDatabase = join(expectedRoot, 'poyo-studio.sqlite');

    for (const [platform, homeDirectory] of [
      ['darwin', '/Users/studio'],
      ['linux', '/home/studio'],
      ['win32', 'C:\\Users\\studio']
    ] as const) {
      const paths = resolveAppPaths({ environment: {}, platform, homeDirectory });
      expect({ platform, root: paths.root, database: paths.database }).toEqual({
        platform,
        root: expectedRoot,
        database: expectedDatabase
      });
      expect(relative(expectedRoot, paths.database)).toBe('poyo-studio.sqlite');
      expect(paths.database).not.toBe(join(expectedRoot, 'data', 'poyo-studio.sqlite'));
    }
  });
});

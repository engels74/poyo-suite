import { describe, expect, test } from 'bun:test';

async function sourceFiles(
  pattern: string,
  cwd = '.'
): Promise<Array<{ path: string; text: string }>> {
  const paths = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd, onlyFiles: true }));
  return Promise.all(
    paths.map(async (path) => ({
      path: `${cwd}/${path}`,
      text: await Bun.file(`${cwd}/${path}`).text()
    }))
  );
}

describe('SEC-01/ARCH-01 static stack and browser-boundary enforcement', () => {
  test('uses Svelte 5 runes without legacy component event syntax', async () => {
    const components = await sourceFiles('**/*.svelte', 'src');
    for (const component of components) {
      expect(component.text, component.path).not.toMatch(/\bexport\s+let\b/);
      expect(component.text, component.path).not.toMatch(/\bon:[a-z][\w-]*\s*=/);
    }
    expect(await Bun.file('svelte.config.ts').text()).toContain('runes: true');
  });

  test('keeps Bun, adapter-bun and UnoCSS presetWind4 authoritative', async () => {
    const packageJson = JSON.parse(await Bun.file('package.json').text()) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const packageNames = Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    });
    for (const forbidden of [
      'tailwindcss',
      '@sveltejs/adapter-node',
      'express',
      'ts-node',
      'jest',
      'vitest'
    ]) {
      expect(packageNames).not.toContain(forbidden);
    }
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      expect(command, name).not.toMatch(/(?:^|\s)(?:npm|pnpm|yarn|node)(?:\s|$)/);
    }
    expect(await Bun.file('svelte.config.ts').text()).toContain('svelte-adapter-bun');
    expect(await Bun.file('uno.config.ts').text()).toContain('presetWind4');
    expect(await Bun.file('src/app.css').text()).not.toContain('@tailwind');
    expect(await Bun.file('tailwind.config.js').exists()).toBe(false);
    expect(await Bun.file('tailwind.config.ts').exists()).toBe(false);
  });

  test('does not import private server modules from client components or client hooks', async () => {
    const browserSources = [
      ...(await sourceFiles('**/*.svelte', 'src')),
      ...(await sourceFiles('hooks.client.ts', 'src')),
      ...(await sourceFiles('lib/features/**/*.ts', 'src'))
    ];
    for (const source of browserSources) {
      expect(source.text, source.path).not.toMatch(
        /import(?!\s+type\b)[^\n]*(?:\$lib\/server|lib\/server|\/server\/)/
      );
    }
  });

  test('keeps retired-input policy runtime-neutral and consumers on direct safe boundaries', async () => {
    const policy = await Bun.file('src/lib/features/registry/retired-inputs.ts').text();
    expect(policy).not.toMatch(/^\s*import\b/m);
    expect(policy).not.toMatch(
      /\bBun\b|image-registry|source-evidence|evidence|\$lib\/server|\/server\//
    );

    const controller = await Bun.file('src/lib/features/generation/studio-controller.ts').text();
    expect(controller).toContain("from '../registry/retired-inputs'");
    expect(controller).not.toMatch(
      /import(?!\s+type\b)[^\n]*from ['"]\.\.\/registry\/image-registry['"]/
    );

    for (const repository of [
      'src/lib/server/presets/repository.ts',
      'src/lib/server/jobs/repository.ts'
    ]) {
      const source = await Bun.file(repository).text();
      expect(source, repository).toContain("from '../../features/registry/retired-inputs'");
      expect(source, repository).not.toMatch(/import[^\n]*isRetiredImageInput[^\n]*image-registry/);
    }

    const workspace = await Bun.file('src/lib/components/studio/StudioWorkspace.svelte').text();
    expect(workspace).toContain('filterRetiredExpertOverrides');
    expect(workspace).toContain("from '$lib/features/generation/studio-controller'");
    expect(workspace).not.toContain('retired-inputs');
    expect(workspace).not.toContain('image-registry');
  });
});

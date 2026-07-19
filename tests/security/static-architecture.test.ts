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

  test('keeps shipped runtime free of host-specific integrations and secret APIs', async () => {
    const shippedSources = [
      ...(await sourceFiles('**/*.ts', 'src')),
      ...(await sourceFiles('**/*.svelte', 'src'))
    ];
    for (const source of shippedSources) {
      expect(source.text, source.path).not.toMatch(/\bBun\.(?:spawn|spawnSync|which|secrets)\b/);
      expect(source.text, source.path).not.toMatch(/\bprocess\.platform\b|from ['"]node:os['"]/);
      expect(source.text, source.path).not.toMatch(
        /['"](?:xdg-open|explorer)['"]|Reveal in Finder|Show in File Explorer|Show in folder|Open in app|Open folder/
      );
      expect(source.text, source.path).not.toMatch(
        /macOS|Windows|Linux|Keychain|operating-system|credential-backend|storage-root|output-location|open-native|open-folder|native_action/
      );
    }
    for (const removedRoute of [
      'src/routes/api/settings/credential-backend/+server.ts',
      'src/routes/api/settings/credential-backend/conflict/+server.ts',
      'src/routes/api/settings/storage-root/+server.ts',
      'src/routes/api/settings/output-location/+server.ts',
      'src/routes/api/media/[outputId]/open-native/+server.ts',
      'src/routes/api/media/[outputId]/reveal/+server.ts',
      'src/routes/api/library/[jobId]/open-folder/+server.ts'
    ]) {
      expect(await Bun.file(removedRoute).exists()).toBe(false);
    }
  });

  test('ships only the current request schema without compatibility consumers', async () => {
    expect(await Bun.file('src/lib/features/registry/retired-inputs.ts').exists()).toBe(false);
    const shippedSources = [
      ...(await sourceFiles('**/*.ts', 'src')),
      ...(await sourceFiles('**/*.svelte', 'src'))
    ];
    for (const source of shippedSources) {
      expect(source.text, source.path).not.toMatch(
        /retired-inputs|filterRetiredExpertOverrides|retired_input_requires_review/
      );
    }
  });

  test('keeps all shipped Poyo traffic behind the guarded factory and transport boundary', async () => {
    const sources = await sourceFiles('**/*.ts', 'src');
    for (const source of sources) {
      if (source.path.endsWith('/lib/server/poyo/factory.ts')) continue;
      if (source.path.endsWith('/lib/server/poyo/transport.ts')) continue;
      expect(source.text, source.path).not.toMatch(/new\s+Poyo(?:Client|Transport)\s*\(/);
      expect(source.text, source.path).not.toMatch(/fetch\([^\n]*POYO_API_BASE_URL/);
    }
    const factoryCallers = sources.filter(
      (source) =>
        !source.path.endsWith('/lib/server/poyo/factory.ts') &&
        source.text.includes('createPoyoClient({')
    );
    expect(factoryCallers.length).toBeGreaterThan(0);
    for (const caller of factoryCallers) {
      expect(caller.text, caller.path).toContain('publicIpv4Guard: platform.publicIpv4');
    }
  });
});

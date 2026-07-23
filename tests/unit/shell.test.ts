import { describe, expect, test } from 'bun:test';
import {
  getRouteTitle,
  isPathActive,
  isStudioPath,
  mobileNavigation,
  moreNavigation,
  navigationGroups
} from '../../src/lib/navigation';
import {
  injectThemeDefault,
  isThemePreference,
  nextThemePreference,
  resolveTheme
} from '../../src/lib/theme';

const requiredRoutes = [
  '/',
  '/studio/image',
  '/studio/video',
  '/jobs',
  '/gallery',
  '/models',
  '/presets',
  '/settings',
  '/settings/diagnostics'
] as const;

const routeFiles = requiredRoutes.map((route) =>
  route === '/' ? 'src/routes/+page.svelte' : `src/routes${route}/+page.svelte`
);

describe('studio shell navigation', () => {
  test('exposes every required route without a second creation rail', () => {
    const desktopHrefs = navigationGroups.flatMap((group) => group.items.map((item) => item.href));

    expect(desktopHrefs).toEqual([
      '/',
      '/studio/image',
      '/studio/video',
      '/jobs',
      '/gallery',
      '/models',
      '/presets'
    ]);
    expect(mobileNavigation.map((item) => item.href)).toEqual([
      '/',
      '/studio/image',
      '/studio/video',
      '/jobs',
      '/gallery'
    ]);
    expect(moreNavigation.map((item) => item.href)).toEqual(['/models', '/presets', '/settings']);
  });

  test('resolves active routes and route titles deterministically', () => {
    expect(isPathActive('/jobs/abc', '/jobs')).toBe(true);
    expect(isPathActive('/gallery', '/')).toBe(false);
    expect(isPathActive('/gallery/output', '/gallery')).toBe(true);
    expect(isStudioPath('/studio/image')).toBe(true);
    expect(isStudioPath('/models')).toBe(false);
    expect(getRouteTitle('/settings/diagnostics')).toBe('Diagnostics');
    expect(getRouteTitle('/unknown')).toBe('Poyo Local Studio');
  });

  test('creates a distinct Svelte route for every milestone destination', async () => {
    for (const file of routeFiles) {
      expect(await Bun.file(file).exists()).toBe(true);
      const source = await Bun.file(file).text();
      expect(source).toContain('<title>');
      expect(source).not.toContain('<h1');
    }
  });

  test('does not ship obsolete Library page routes', async () => {
    const obsoletePageRoutes = [
      'src/routes/library/+page.server.ts',
      'src/routes/library/+page.svelte',
      'src/routes/library/[jobId]/+page.server.ts',
      'src/routes/library/[jobId]/+page.svelte'
    ];

    for (const file of obsoletePageRoutes) {
      expect(await Bun.file(file).exists()).toBe(false);
    }
  });

  test('renders poll-blocked dashboard guidance from the existing failure domain', async () => {
    const dashboard = await Bun.file('src/routes/+page.svelte').text();
    expect(dashboard).toContain("job.failureDomain === 'poll'");
    expect(dashboard).not.toContain('job.poyoTaskId');
  });
});

describe('theme and accessibility foundations', () => {
  test('keeps light as the deterministic default and supports dark/system preferences', () => {
    expect(isThemePreference('light')).toBe(true);
    expect(isThemePreference('system')).toBe(true);
    expect(isThemePreference('sepia')).toBe(false);
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(nextThemePreference('light')).toBe('dark');
    expect(nextThemePreference('dark')).toBe('system');
    expect(nextThemePreference('system')).toBe('light');
  });

  test('injects the pre-hydration theme default resiliently onto the html tag', () => {
    // Plain tag as it currently ships in app.html.
    expect(injectThemeDefault('<!doctype html>\n<html lang="en-GB">\n  <head>', 'dark')).toBe(
      '<!doctype html>\n<html lang="en-GB" data-theme-default="dark">\n  <head>'
    );

    // Resilient to markup drift: an added attribute must not silently skip the injection.
    expect(injectThemeDefault('<html lang="en-US" class="app">', 'system')).toBe(
      '<html lang="en-US" class="app" data-theme-default="system">'
    );
    expect(injectThemeDefault('<html>', 'light')).toBe('<html data-theme-default="light">');

    // Idempotent: never double-inject if the attribute is already present.
    const injected = '<html lang="en-GB" data-theme-default="light">';
    expect(injectThemeDefault(injected, 'dark')).toBe(injected);

    // No <html> tag (a later stream chunk) is returned untouched, and the doctype is not matched.
    expect(injectThemeDefault('<div>body chunk</div>', 'dark')).toBe('<div>body chunk</div>');
    expect(injectThemeDefault('<!doctype html>', 'dark')).toBe('<!doctype html>');
  });

  test('includes skip links, one route heading and a polite route announcer', async () => {
    const shell = await Bun.file('src/lib/components/shell/AppShell.svelte').text();

    expect(shell).toContain('Skip to workspace');
    expect(shell).toContain('Skip to inspector');
    expect(shell.match(/<h1/g)?.length).toBe(1);
    expect(shell).toContain('aria-live="polite"');
    expect(shell).toContain('aria-label="Primary mobile navigation"');
  });

  test('uses a Bits UI focus-managed sheet and no Tailwind or remote fonts', async () => {
    const sheet = await Bun.file('src/lib/components/ui/Sheet.svelte').text();
    const appCss = await Bun.file('src/app.css').text();
    const manifest = await Bun.file('package.json').text();

    expect(sheet).toContain("from 'bits-ui'");
    expect(sheet).toContain('<Dialog.Title');
    expect(sheet).toContain('<Dialog.Description');
    expect(appCss).not.toContain('@import url');
    expect(appCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(appCss).toContain('@media (prefers-contrast: more)');
    expect(appCss).toContain('@media (max-width: 1023px)');
    expect(manifest.toLowerCase()).not.toContain('tailwind');
  });
});

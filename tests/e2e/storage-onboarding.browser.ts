import { expect, setDefaultTimeout, test } from 'bun:test';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { chromium } from 'playwright';
import {
  pageHasNoHorizontalOverflow,
  seriousAccessibilityViolations,
  trackBrowserIssues
} from '../helpers/browser-assertions';
import { startBrowserAppHarness } from '../helpers/browser-app-harness';

setDefaultTimeout(60_000);

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    for (const name of (await readdir(path)).toSorted()) {
      const child = join(path, name);
      const key = relative(root, child);
      const details = await lstat(child);
      if (details.isDirectory()) {
        snapshot[`${key}/`] = `directory:${details.mode & 0o777}`;
        await visit(child);
      } else if (details.isFile()) {
        snapshot[key] = new Bun.CryptoHasher('sha256')
          .update(new Uint8Array(await Bun.file(child).arrayBuffer()))
          .digest('hex');
      } else {
        snapshot[key] = 'special';
      }
    }
  }
  await visit(root);
  return snapshot;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

test('fresh onboarding and settings expose explicit local storage choices without Poyo calls', async () => {
  const harness = await startBrowserAppHarness({ freshOnboarding: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const issues = trackBrowserIssues(page);
  try {
    await page.goto(harness.url);
    await page.waitForURL((url) => url.pathname === '/welcome');
    await page.getByRole('heading', { name: 'Welcome to Poyo Local Studio' }).waitFor();
    expect(harness.mock.requests).toHaveLength(0);

    await page.getByRole('button', { name: 'Get started' }).click();
    const projectRoot = page.getByRole('radio', { name: /Project data folder/ });
    const platformRoot = page.getByRole('radio', {
      name: /Application Support|application data/i
    });
    expect(await projectRoot.isChecked()).toBe(true);
    await projectRoot.focus();
    await page.keyboard.press('ArrowDown');
    expect(await platformRoot.isChecked()).toBe(true);
    await page.keyboard.press('ArrowUp');
    expect(await projectRoot.isChecked()).toBe(true);
    await page.getByRole('button', { name: 'Continue' }).click();

    const fileBackend = page.getByRole('radio', { name: /Permission-protected file/ });
    expect(await fileBackend.isChecked()).toBe(true);
    await page.getByText('Selected local backend').waitFor();
    expect(
      await page.getByText('Permission-protected file', { exact: true }).count()
    ).toBeGreaterThan(0);
    expect(await page.getByText('No active credential', { exact: true }).count()).toBe(1);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(harness.mock.requests).toHaveLength(0);

    const onboardingStatus = await page.evaluate(async () => {
      const response = await fetch('/api/onboarding', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ complete: true })
      });
      return response.status;
    });
    expect(onboardingStatus).toBe(200);
    await page.goto(`${harness.url}/settings`);
    await page.getByRole('heading', { name: 'Studio operations' }).waitFor();
    await page.getByRole('heading', { name: 'Storage and downloads' }).scrollIntoViewIfNeeded();
    expect(await page.getByRole('radio', { name: /Project data folder/ }).isChecked()).toBe(true);
    expect(await page.getByRole('radio', { name: /Permission-protected file/ }).isChecked()).toBe(
      true
    );
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(harness.mock.requests).toHaveLength(0);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

test('environment authority is visible and disables both local storage mutations', async () => {
  const harness = await startBrowserAppHarness();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${harness.url}/settings`);
    await page.getByRole('heading', { name: 'Studio operations' }).waitFor();
    await page.getByText('Environment key active').waitFor();
    await page.getByText(/PLS_APP_DATA_DIR.*controls the root/).waitFor();
    expect(await page.getByRole('radio', { name: /Project data folder/ }).isDisabled()).toBe(true);
    expect(await page.getByRole('radio', { name: /Permission-protected file/ }).isDisabled()).toBe(
      true
    );

    const statuses = await page.evaluate(async () => {
      const [root, credential] = await Promise.all([
        fetch('/api/settings/storage-root', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targetRootKind: 'platform' })
        }),
        fetch('/api/settings/credential-backend', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ backend: 'os' })
        })
      ]);
      return { root: root.status, credential: credential.status };
    });
    expect(statuses).toEqual({ root: 409, credential: 409 });
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
    expect(harness.mock.requests).toHaveLength(0);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

test('a retained credential replacement conflict boots visibly and resolves only after a fresh action', async () => {
  const harness = await startBrowserAppHarness({
    freshOnboarding: true,
    credentialConflict: true
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    const response = await page.goto(`${harness.url}/settings`);
    expect(response?.status()).toBe(200);
    await page.getByRole('heading', { name: 'Studio operations' }).waitFor();
    await page.getByText(/attempted move.*paused because the destination changed/i).waitFor();
    expect(await page.getByRole('button', { name: 'Abandon stale move' }).count()).toBe(1);
    expect(
      await page.getByRole('button', { name: 'Re-authorize against current destination' }).count()
    ).toBe(1);
    expect((await page.textContent('body')) ?? '').not.toContain(harness.syntheticKey);
    expect((await page.textContent('body')) ?? '').not.toContain(
      'sk-browser_changed_destination_never_real_123456'
    );

    const status = await page.evaluate(async () => {
      const observed = await fetch('/api/settings/api-key');
      return { status: observed.status, payload: await observed.json() };
    });
    expect(status).toMatchObject({
      status: 200,
      payload: {
        apiKey: {
          selectedBackend: 'file',
          transition: { conflict: 'replacement-authorization-required' },
          localMutationAvailable: false
        }
      }
    });
    expect(JSON.stringify(status)).not.toContain(harness.temporaryPath);

    await page.getByRole('button', { name: 'Re-authorize against current destination' }).click();
    await page.getByText(/Fresh replacement authorization was verified/i).waitFor();
    await page.getByText('Operating-system credential store', { exact: true }).first().waitFor();
    expect(await page.getByText(/attempted move.*paused/i).count()).toBe(0);
    expect(await pathExists(join(harness.appData, 'secrets', 'poyo-api-key'))).toBe(false);
    if (!harness.fakeOsSecretPath) throw new Error('Expected fake OS credential path.');
    expect(await Bun.file(harness.fakeOsSecretPath).text()).toBe(harness.syntheticKey);
    expect(harness.mock.requests).toHaveLength(0);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

test('a source-less credential intent survives restart and can only be abandoned without store mutation', async () => {
  const harness = await startBrowserAppHarness({
    freshOnboarding: true,
    credentialConflict: 'source-less-intent'
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await harness.stopApp();
    await harness.startApp();
    const response = await page.goto(`${harness.url}/settings`);
    expect(response?.status()).toBe(200);
    await page.getByRole('heading', { name: 'Studio operations' }).waitFor();
    await page.getByText(/source authority could not be verified/i).waitFor();
    expect(await page.getByRole('button', { name: 'Abandon stale move' }).count()).toBe(1);
    expect(await page.getByRole('button', { name: /Re-authorize|Resume|Retry/ }).count()).toBe(0);

    const status = await page.evaluate(async () => {
      const observed = await fetch('/api/settings/api-key');
      return { status: observed.status, payload: await observed.json() };
    });
    expect(status).toMatchObject({
      status: 200,
      payload: {
        apiKey: {
          selectedBackend: 'file',
          transition: {
            phase: 'intent',
            conflict: 'pre-authority-ownership-unverified',
            actions: ['abandon']
          },
          localMutationAvailable: false
        }
      }
    });
    expect(JSON.stringify(status)).not.toContain('browser-source-less-intent');
    expect(JSON.stringify(status)).not.toContain(harness.syntheticKey);
    expect(await pathExists(join(harness.appData, 'secrets', 'poyo-api-key'))).toBe(false);
    if (!harness.fakeOsSecretPath) throw new Error('Expected fake OS credential path.');
    expect(await Bun.file(harness.fakeOsSecretPath).text()).toBe(harness.syntheticKey);

    await page.getByRole('button', { name: 'Abandon stale move' }).click();
    await page.getByText(/Both stored copies were left unchanged/i).waitFor();
    expect(await pathExists(join(harness.appData, 'secrets', 'poyo-api-key'))).toBe(false);
    expect(await Bun.file(harness.fakeOsSecretPath).text()).toBe(harness.syntheticKey);
    expect(harness.mock.requests).toHaveLength(0);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

test('a changed rollback cleanup survives restart and abandonment retains both stores', async () => {
  const harness = await startBrowserAppHarness({
    freshOnboarding: true,
    credentialConflict: 'changed-rollback'
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const changedTarget = 'sk-browser_changed_destination_never_real_123456';
  try {
    await harness.stopApp();
    await harness.startApp();
    const response = await page.goto(`${harness.url}/settings`);
    expect(response?.status()).toBe(200);
    await page.getByRole('heading', { name: 'Studio operations' }).waitFor();
    await page.getByText(/Rollback cleanup.*cannot be verified safely/i).waitFor();
    expect(await page.getByRole('button', { name: 'Abandon stale move' }).count()).toBe(1);
    expect(await page.getByRole('button', { name: /Re-authorize|Resume|Retry/ }).count()).toBe(0);

    const status = await page.evaluate(async () => {
      const observed = await fetch('/api/settings/api-key');
      return { status: observed.status, payload: await observed.json() };
    });
    expect(status).toMatchObject({
      status: 200,
      payload: {
        apiKey: {
          selectedBackend: 'file',
          transition: {
            phase: 'rollback-cleanup-pending',
            conflict: 'rollback-ownership-unverified',
            actions: ['abandon']
          },
          localMutationAvailable: false
        }
      }
    });
    expect(JSON.stringify(status)).not.toContain('browser-changed-rollback');
    expect(JSON.stringify(status)).not.toContain(harness.syntheticKey);
    expect(JSON.stringify(status)).not.toContain(changedTarget);

    const fileSecretPath = join(harness.appData, 'secrets', 'poyo-api-key');
    if (!harness.fakeOsSecretPath) throw new Error('Expected fake OS credential path.');
    expect(await Bun.file(fileSecretPath).text()).toBe(harness.syntheticKey);
    expect(await Bun.file(harness.fakeOsSecretPath).text()).toBe(changedTarget);
    await page.getByRole('button', { name: 'Abandon stale move' }).click();
    await page.getByText(/Both stored copies were left unchanged/i).waitFor();
    expect(await Bun.file(fileSecretPath).text()).toBe(harness.syntheticKey);
    expect(await Bun.file(harness.fakeOsSecretPath).text()).toBe(changedTarget);
    expect(harness.mock.requests).toHaveLength(0);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

test('external current and historical output folders qualify every root-move claim without paths', async () => {
  const harness = await startBrowserAppHarness({
    freshOnboarding: true,
    persistedExternalOutputs: true
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${harness.url}/settings`);
    await page.getByRole('heading', { name: 'Studio operations' }).waitFor();
    await page
      .getByText(/current custom output directory.*2 historical output directories/i)
      .first()
      .waitFor();
    expect(
      await page.getByRole('button', { name: 'Move all root-owned Studio data' }).count()
    ).toBe(1);
    expect(
      await page.getByRole('button', { name: 'Move all Studio data', exact: true }).count()
    ).toBe(0);

    const rootStatus = await page.evaluate(async () => {
      const response = await fetch('/api/settings/storage-root');
      return await response.json();
    });
    expect(rootStatus).toMatchObject({
      storageRoot: {
        exclusions: [
          { resource: 'current-output-directory', count: 1, copied: false },
          { resource: 'historical-output-directories', count: 2, copied: false }
        ]
      }
    });
    expect(JSON.stringify(rootStatus)).not.toContain(harness.temporaryPath);
    for (const path of [
      harness.persistedOutputPaths?.current,
      ...(harness.persistedOutputPaths?.historical ?? [])
    ]) {
      if (path) expect(JSON.stringify(rootStatus)).not.toContain(path);
    }

    await page.goto(`${harness.url}/welcome`);
    await page.getByRole('button', { name: 'Get started' }).click();
    await page
      .getByText(/current custom output directory.*2 historical output directories/i)
      .first()
      .waitFor();
    expect((await page.textContent('body')) ?? '').not.toContain('the complete local root');
    expect((await page.textContent('body')) ?? '').toContain('all root-owned Studio data');
    expect(harness.mock.requests).toHaveLength(0);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

test('completed onboarding can observe a cold frozen relocation without filesystem mutation', async () => {
  const harness = await startBrowserAppHarness({
    freshOnboarding: true,
    externalResources: true
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    const sameOriginHeaders = {
      'content-type': 'application/json',
      origin: harness.url,
      'sec-fetch-site': 'same-origin'
    };
    const onboarding = await fetch(`${harness.url}/api/onboarding`, {
      method: 'PUT',
      headers: sameOriginHeaders,
      body: JSON.stringify({ complete: true })
    });
    expect(onboarding.status).toBe(200);
    expect(await pathExists(join(harness.appData, 'secrets'))).toBe(false);

    const response = await fetch(`${harness.url}/api/settings/storage-root`, {
      method: 'POST',
      headers: sameOriginHeaders,
      body: JSON.stringify({ targetRootKind: 'platform' })
    });
    const result = { status: response.status, payload: await response.json() };
    expect(result.status).toBe(202);
    expect(result.payload).toMatchObject({
      relocation: { targetRootKind: 'platform', restartRequired: true },
      storageRoot: {
        exclusions: [
          { resource: 'database', environmentManaged: true, copied: false },
          { resource: 'media', environmentManaged: true, copied: false },
          { resource: 'logs', environmentManaged: true, copied: false }
        ]
      }
    });
    expect(JSON.stringify(result.payload)).not.toContain('transitionId');
    expect(JSON.stringify(result.payload)).not.toContain(harness.temporaryPath);

    if (!harness.externalPaths) throw new Error('Expected external resource fixtures.');
    const beforeReads = {
      source: await snapshotTree(harness.appData),
      target: await snapshotTree(harness.platformAppData),
      external: await snapshotTree(dirname(harness.externalPaths.database))
    };
    const dashboard = await page.goto(harness.url, { waitUntil: 'domcontentloaded' });
    expect(dashboard?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/');
    await page.getByRole('heading', { name: 'Dashboard', level: 1 }).waitFor();

    const settings = await page.goto(`${harness.url}/settings`, { waitUntil: 'domcontentloaded' });
    expect(settings?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/settings');
    const welcome = await page.goto(`${harness.url}/welcome`, { waitUntil: 'domcontentloaded' });
    expect(welcome?.status()).toBe(200);
    expect(new URL(page.url()).pathname).toBe('/welcome');

    const observations = await Promise.all(
      ['/api/health', '/api/settings', '/api/settings/storage-root'].map(async (path) => {
        const observed = await fetch(`${harness.url}${path}`, { redirect: 'manual' });
        return { status: observed.status, location: observed.headers.get('location') };
      })
    );
    expect(observations).toEqual([
      { status: 200, location: null },
      { status: 200, location: null },
      { status: 200, location: null }
    ]);
    expect({
      source: await snapshotTree(harness.appData),
      target: await snapshotTree(harness.platformAppData),
      external: await snapshotTree(dirname(harness.externalPaths.database))
    }).toEqual(beforeReads);
    expect(await pathExists(join(harness.appData, 'secrets'))).toBe(false);
    expect(harness.mock.requests).toHaveLength(0);

    await harness.stopApp();
    await harness.startApp();
    const restarted = await fetch(harness.url, { redirect: 'manual' });
    expect(restarted.status).toBe(200);
    expect(restarted.headers.get('location')).toBeNull();
    expect(await pathExists(harness.appData)).toBe(false);
    expect(harness.mock.requests).toHaveLength(0);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

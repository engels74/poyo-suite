import { expect, setDefaultTimeout, test } from 'bun:test';
import { chromium, type Page } from 'playwright';
import { startBrowserAppHarness } from '../helpers/browser-app-harness';
import {
  pageHasNoHorizontalOverflow,
  seriousAccessibilityViolations,
  trackBrowserIssues
} from '../helpers/browser-assertions';

setDefaultTimeout(60_000);

async function continueThroughAppearanceAndDefaults(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Choose your appearance' }).waitFor();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByRole('heading', { name: 'Review the defaults' }).waitFor();
  await page.getByText('Downloaded automatically', { exact: true }).waitFor();
  await page.getByText('Review before removing local files', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Use these defaults' }).click();
  await page.getByRole('heading', { name: 'You are ready to create' }).waitFor();
}

async function expectNoLegacyStorageControls(page: Page): Promise<void> {
  const controls = page.locator(
    'input[name*="storage-root"], input[name*="credential-backend"], input[value="os"]'
  );
  expect(await controls.count()).toBe(0);
}

async function expectNoLegacyStorageLanguage(page: Page): Promise<void> {
  const text = (await page.textContent('body')) ?? '';
  expect(text).not.toMatch(/operating-system|keychain|credential backend/i);
}

test('fresh onboarding keeps storage informational and completes through one local credential path', async () => {
  const harness = await startBrowserAppHarness({ freshOnboarding: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }
  });
  const page = await context.newPage();
  const issues = trackBrowserIssues(page);
  const requestedPaths: string[] = [];
  page.on('request', (request) => requestedPaths.push(new URL(request.url()).pathname));

  try {
    await page.goto(harness.url);
    await page.waitForURL((url) => url.pathname === '/welcome');
    await page.getByRole('heading', { name: 'Welcome to Poyo Local Studio' }).waitFor();
    await page
      .getByText(/credentials stay behind the local server, never in browser storage/i)
      .waitFor();
    expect((await page.textContent('body')) ?? '').not.toContain(harness.temporaryPath);

    await page.getByRole('button', { name: 'Get started' }).click();
    await page.getByRole('heading', { name: 'Your work stays local' }).waitFor();
    await page.getByText(/never local filesystem paths/i).waitFor();
    await page.getByText('Local by design', { exact: true }).waitFor();
    await expectNoLegacyStorageControls(page);
    await expectNoLegacyStorageLanguage(page);
    expect(await page.locator('input').count()).toBe(0);
    expect((await page.textContent('body')) ?? '').not.toContain(harness.temporaryPath);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('heading', { name: 'Protect local media metadata' }).waitFor();
    await page.getByText(/Remote URLs/i).waitFor();
    await page.getByText(/does not anonymize visible people, places, text, or audio/i).waitFor();
    const master = page.getByLabel('Sanitize local media before sharing with Poyo');
    const exif = page.getByLabel('Remove EXIF metadata');
    const xmp = page.getByLabel('Remove XMP metadata');
    expect(await master.isChecked()).toBe(true);
    expect(await exif.isChecked()).toBe(true);
    await xmp.uncheck();
    await master.uncheck();
    expect(await exif.isDisabled()).toBe(true);
    expect(await exif.isChecked()).toBe(true);
    await master.check();
    await page.getByRole('button', { name: 'Save and continue' }).click();

    await page.getByRole('heading', { name: 'Connect your Poyo API key' }).waitFor();
    expect(await page.locator('input[type="password"]').count()).toBe(1);
    await expectNoLegacyStorageControls(page);
    await expectNoLegacyStorageLanguage(page);
    await page.getByText(/never returned to the browser/i).waitFor();

    const blockedStatuses = await page.evaluate(async () => {
      const updates = [{ complete: true }, { dismiss: true }, { steps: { connection: true } }];
      return Promise.all(
        updates.map(async (body) => {
          const response = await fetch('/api/onboarding', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
          });
          return response.status;
        })
      );
    });
    expect(blockedStatuses).toEqual([409, 409, 409]);

    let connectivityAttempts = 0;
    await page.route('**/api/settings/api-key/connectivity', async (route) => {
      if (connectivityAttempts++ === 0) {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { message: 'The test credential was rejected.' }
          })
        });
        return;
      }
      await route.continue();
    });

    await page.getByLabel('Poyo API key').fill(harness.syntheticKey);
    await page.getByRole('button', { name: 'Store key' }).click();
    await page.getByText('Connection failed. Check the key and try again.').waitFor();
    expect(await page.getByRole('button', { name: 'Continue' }).isDisabled()).toBe(true);
    expect((await page.textContent('body')) ?? '').not.toContain(harness.syntheticKey);

    await page.getByRole('button', { name: 'Test again' }).click();
    await page.getByText('Connected · browser-suite@example.test').waitFor();
    expect(await page.getByRole('button', { name: 'Continue' }).isEnabled()).toBe(true);

    await page.getByLabel('Poyo API key').fill(`${harness.syntheticKey}-edited`);
    await page.getByText('Not tested', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Continue' }).isDisabled()).toBe(true);
    expect(await page.getByRole('button', { name: 'Test connection' }).isDisabled()).toBe(true);
    await page.getByLabel('Poyo API key').fill('');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.getByText('Connected · browser-suite@example.test').waitFor();

    await continueThroughAppearanceAndDefaults(page);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Enter the Studio' }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await page.reload();
    expect(new URL(page.url()).pathname).toBe('/');
    await page.goto(`${harness.url}/settings`);
    await page.getByRole('heading', { name: 'Settings' }).waitFor();
    expect(await page.getByLabel('Remove XMP metadata').isChecked()).toBe(false);

    expect(requestedPaths).not.toContain('/api/settings/storage-root');
    expect(requestedPaths).not.toContain('/api/settings/credential-backend');
    expect((await page.textContent('body')) ?? '').not.toContain(harness.syntheticKey);
    expect(issues.pageErrors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

test('environment-managed onboarding exposes authority without secrets or paths and can be dismissed', async () => {
  const harness = await startBrowserAppHarness();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  const issues = trackBrowserIssues(page);

  try {
    await page.goto(`${harness.url}/settings`);
    await page.getByRole('button', { name: 'Re-run first-run setup' }).click();
    await page.waitForURL((url) => url.pathname === '/welcome');
    await page.getByRole('button', { name: 'Get started' }).click();

    await page.getByRole('heading', { name: 'Your work stays local' }).waitFor();
    await page.getByText(/server administrator manages the local storage location/i).waitFor();
    expect((await page.textContent('body')) ?? '').not.toContain(harness.temporaryPath);
    await expectNoLegacyStorageControls(page);
    await expectNoLegacyStorageLanguage(page);
    await page.getByRole('button', { name: 'Continue' }).click();

    await page.getByRole('heading', { name: 'Protect local media metadata' }).waitFor();
    await page.getByRole('button', { name: 'Save and continue' }).click();

    await page.getByText('Environment key active', { exact: true }).waitFor();
    await page.getByText(/managed by the server environment/i).waitFor();
    expect(await page.locator('input[type="password"]').count()).toBe(0);
    await expectNoLegacyStorageControls(page);
    await expectNoLegacyStorageLanguage(page);
    expect((await page.textContent('body')) ?? '').not.toContain(harness.syntheticKey);

    await page.getByRole('button', { name: 'Test connection' }).click();
    await page.getByText('Connected · browser-suite@example.test').waitFor();
    await continueThroughAppearanceAndDefaults(page);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
    await page.getByRole('button', { name: 'Dismiss guide' }).click();
    await page.waitForURL((url) => url.pathname === '/');
    await page.reload();
    expect(new URL(page.url()).pathname).toBe('/');

    expect((await page.textContent('body')) ?? '').not.toContain(harness.syntheticKey);
    expect(issues.pageErrors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

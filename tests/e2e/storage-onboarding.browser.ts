import { expect, setDefaultTimeout, test } from 'bun:test';
import { chromium, type Page } from 'playwright';
import { startBrowserAppHarness } from '../helpers/browser-app-harness';
import {
  pageHasNoHorizontalOverflow,
  seriousAccessibilityViolations,
  trackBrowserIssues
} from '../helpers/browser-assertions';

setDefaultTimeout(60_000);

type BrowserHarness = Awaited<ReturnType<typeof startBrowserAppHarness>>;

async function submitPaidGeneration(page: Page, prompt: string) {
  return page.evaluate(async (paidPrompt) => {
    const actionId = crypto.randomUUID();
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actionId,
        entryKey: 'flux-schnell:text-to-image',
        values: { prompt: paidPrompt },
        expertOverrides: [],
        inputs: []
      }),
      signal: AbortSignal.timeout(10_000)
    });
    const body = (await response.json()) as { job?: { id?: string } };
    return { status: response.status, jobId: body.job?.id, actionId };
  }, prompt);
}

async function waitForPersistedJobState(
  page: Page,
  actionId: string,
  ready: (job: { attentionCode?: string | null; poyoTaskId?: string | null }) => boolean,
  failureMessage: string
): Promise<void> {
  const deadline = Date.now() + 10_000;
  const url = new URL('/api/jobs', page.url());
  url.searchParams.set('actionId', actionId);
  while (Date.now() < deadline) {
    try {
      const response = await page.request.get(url.toString(), { timeout: 1_000 });
      if (response.ok()) {
        const body = (await response.json()) as {
          job?: { attentionCode?: string | null; poyoTaskId?: string | null };
        };
        if (body.job && ready(body.job)) return;
      }
    } catch {}
    await Bun.sleep(25);
  }
  throw new Error(failureMessage);
}

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

async function exercisePublicIpv4Guard(harness: BrowserHarness, page: Page): Promise<void> {
  await page.getByText('IP guard off', { exact: true }).filter({ visible: true }).waitFor();
  expect(await page.getByText('8.8.4.4', { exact: true }).count()).toBeGreaterThan(0);
  await Promise.all([
    page.waitForURL('**/settings#public-ip-guard'),
    page.getByRole('link', { name: 'Configure exact IP guard' }).filter({ visible: true }).click()
  ]);
  expect(new URL(page.url()).hash).toBe('#public-ip-guard');

  const input = page.getByLabel('Normal/home public IPv4');
  await input.fill('192.168.1.2');
  await page.getByText(/globally routable public IPv4/).waitFor();
  expect(await page.getByRole('button', { name: 'Save address' }).isDisabled()).toBe(true);

  await page.getByRole('button', { name: 'Use current IP' }).click();
  expect(await input.inputValue()).toBe('8.8.4.4');
  await page.getByRole('button', { name: 'Save address' }).click();
  await page.getByText('Home public IPv4 saved.', { exact: true }).waitFor();
  const toggle = page.getByLabel('Block Poyo requests on the saved home IPv4');
  expect(await toggle.isEnabled()).toBe(true);
  await toggle.check();
  await page.getByText('Exact public IPv4 guard enabled.', { exact: true }).waitFor();

  const poyoCallsBeforeBlock = harness.mock.requests.length;
  const blocked = await page.request.post(`${harness.url}/api/account/balance`, {
    headers: { origin: harness.url, 'sec-fetch-site': 'same-origin' },
    data: {}
  });
  expect(blocked.status()).toBe(400);
  expect(harness.mock.requests.length).toBe(poyoCallsBeforeBlock);
  await page.goto(`${harness.url}/`);
  await page.getByText('Home IP detected', { exact: true }).filter({ visible: true }).waitFor();

  const poyoCallsBeforeGeneration = harness.mock.requests.length;
  const guardedGeneration = await submitPaidGeneration(page, 'Guarded paid generation fixture');
  expect(guardedGeneration.status).toBe(202);
  expect(guardedGeneration.jobId).toBeTruthy();
  await waitForPersistedJobState(
    page,
    guardedGeneration.actionId,
    (job) => job.attentionCode === 'ip_guard_blocked',
    'The guarded generation did not persist its IP-guard rejection.'
  );
  await page.goto(`${harness.url}/jobs/${guardedGeneration.jobId}`);
  await page.getByText('Blocked by IP guard.', { exact: true }).waitFor();
  expect(harness.mock.requests.length).toBe(poyoCallsBeforeGeneration);

  await page.goto(`${harness.url}/settings#public-ip-guard`);
  await toggle.uncheck();
  await page.getByText('Public IPv4 guard disabled.', { exact: true }).waitFor();
  harness.mock.setPublicIpv4('9.9.9.9');
  await page
    .getByRole('button', { name: 'Refresh outbound public IPv4 status' })
    .filter({ visible: true })
    .click();
  await page.getByText('9.9.9.9', { exact: true }).filter({ visible: true }).first().waitFor();
  await page.getByRole('button', { name: 'Use current IP' }).click();
  expect(await input.inputValue()).toBe('9.9.9.9');
  await input.fill('1.1.1.1');
  await page.getByText('Unsaved changes. Save this address before enabling the guard.').waitFor();
  expect(await toggle.isDisabled()).toBe(true);
  await page.getByRole('button', { name: 'Save address' }).click();
  await page.getByText('Home public IPv4 saved.', { exact: true }).waitFor();
  expect(await toggle.isEnabled()).toBe(true);
  await toggle.check();
  await page.getByText('Exact public IPv4 guard enabled.', { exact: true }).waitFor();
  await page.getByText('IP differs from home', { exact: true }).filter({ visible: true }).waitFor();

  harness.mock.queueOutcome('held');
  const submitsBeforeAllow = harness.mock.requests.filter(
    (request) => request.pathname === '/api/generate/submit'
  ).length;
  const allowedGeneration = await submitPaidGeneration(page, 'Allowed paid generation fixture');
  expect(allowedGeneration.status).toBe(202);
  expect(allowedGeneration.jobId).toBeTruthy();
  await waitForPersistedJobState(
    page,
    allowedGeneration.actionId,
    (job) => Boolean(job.poyoTaskId),
    'The allowed generation did not persist its Poyo task link.'
  );
  await page.goto(`${harness.url}/jobs/${allowedGeneration.jobId}`);
  await page.getByText('Poyo task linked', { exact: true }).waitFor();
  expect(
    harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
  ).toHaveLength(submitsBeforeAllow + 1);
  harness.mock.releaseHeldTasks();
  await page.goto(`${harness.url}/settings#public-ip-guard`);

  harness.mock.setPublicIpv4Delay(350);
  const refresh = page
    .getByRole('button', { name: 'Refresh outbound public IPv4 status' })
    .filter({ visible: true });
  await refresh.click();
  const checking = page
    .locator('[aria-live="polite"]')
    .filter({ hasText: 'Checking public IP' })
    .filter({ visible: true });
  await checking.waitFor();
  expect(await checking.getAttribute('aria-atomic')).toBe('true');
  expect(await refresh.isDisabled()).toBe(true);
  await page.getByText('IP differs from home', { exact: true }).filter({ visible: true }).waitFor();
  harness.mock.setPublicIpv4Delay(0);
  const poyoCallsBeforeAllow = harness.mock.requests.length;
  const allowed = await page.request.post(`${harness.url}/api/account/balance`, {
    headers: { origin: harness.url, 'sec-fetch-site': 'same-origin' },
    data: {}
  });
  expect(allowed.ok()).toBe(true);
  expect(harness.mock.requests.length).toBe(poyoCallsBeforeAllow + 1);

  harness.mock.setPublicIpv4Unavailable(true);
  await page
    .getByRole('button', { name: 'Refresh outbound public IPv4 status' })
    .filter({ visible: true })
    .click();
  await page
    .getByText('Public IP unavailable', { exact: true })
    .filter({ visible: true })
    .waitFor();
  const poyoCallsBeforeUnavailable = harness.mock.requests.length;
  const unavailable = await page.request.post(`${harness.url}/api/account/balance`, {
    headers: { origin: harness.url, 'sec-fetch-site': 'same-origin' },
    data: {}
  });
  expect(unavailable.status()).toBe(400);
  expect(harness.mock.requests.length).toBe(poyoCallsBeforeUnavailable);
  harness.mock.setPublicIpv4Unavailable(false);

  await harness.stopApp();
  await harness.startApp();
  await page.goto(`${harness.url}/settings#public-ip-guard`);
  expect(await page.getByLabel('Block Poyo requests on the saved home IPv4').isChecked()).toBe(
    true
  );

  await page.setViewportSize({ width: 760, height: 800 });
  await page.reload();
  await page.getByText('IP differs from home', { exact: true }).filter({ visible: true }).waitFor();
  expect(
    await page.getByRole('button', { name: 'Refresh outbound public IPv4 status' }).isVisible()
  ).toBe(true);

  const persistedToggle = page.getByLabel('Block Poyo requests on the saved home IPv4');
  const persistedInput = page.getByLabel('Normal/home public IPv4');
  await persistedInput.fill('');
  await page.getByText('Disable the guard before clearing the saved home public IPv4.').waitFor();
  expect(await page.getByRole('button', { name: 'Save address' }).isDisabled()).toBe(true);
  await persistedInput.fill('1.1.1.1');
  await persistedToggle.uncheck();
  await page.getByText('Public IPv4 guard disabled.', { exact: true }).waitFor();
  await persistedInput.fill('');
  await page.getByText('Unsaved change. Save to clear the stored home public IPv4.').waitFor();
  await page.getByRole('button', { name: 'Save address' }).click();
  await page.getByText('Home public IPv4 cleared.', { exact: true }).waitFor();
  expect(await persistedToggle.isDisabled()).toBe(true);
  await page.reload();
  expect(await page.getByLabel('Normal/home public IPv4').inputValue()).toBe('');
  expect(await page.getByLabel('Block Poyo requests on the saved home IPv4').isDisabled()).toBe(
    true
  );
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
    await page.getByText('Media protection ready', { exact: true }).waitFor();
    await page.getByText('Image · Ready', { exact: true }).waitFor();
    await page.getByText('Video · Ready', { exact: true }).waitFor();
    await page.getByText(/Remote URLs/i).waitFor();
    await page.getByText(/does not anonymize visible people, places, text, or audio/i).waitFor();
    const master = page.getByLabel('Sanitize local media before sharing with Poyo');
    const exif = page.getByLabel('Remove EXIF metadata');
    const xmp = page.getByLabel('Remove XMP metadata');
    expect(await master.isChecked()).toBe(true);
    expect(await exif.isChecked()).toBe(true);
    await xmp.uncheck();
    await master.uncheck();
    await page.getByText('Media protection is off', { exact: true }).waitFor();
    await page
      .getByText('Local files will be uploaded without metadata cleanup.', { exact: true })
      .waitFor();
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
    await page.getByText('Media protection ready', { exact: true }).waitFor();
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

test('environment-managed onboarding and the persisted exact IPv4 guard work without secret exposure', async () => {
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
    await page.getByText('Media protection ready', { exact: true }).waitFor();
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

    await exercisePublicIpv4Guard(harness, page);

    expect((await page.textContent('body')) ?? '').not.toContain(harness.syntheticKey);
    expect(issues.pageErrors).toEqual([]);
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

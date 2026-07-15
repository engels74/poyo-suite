import { Database } from 'bun:sqlite';
import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { type APIResponse, chromium, type Page } from 'playwright';
import { startBrowserAppHarness } from '../helpers/browser-app-harness';
import {
  pageHasNoHorizontalOverflow,
  seriousAccessibilityViolations,
  trackBrowserIssues
} from '../helpers/browser-assertions';

setDefaultTimeout(120_000);

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(message);
}

async function chooseImageTextWorkflow(page: Page): Promise<void> {
  const inspector = page.locator('#parameter-inspector');
  await inspector.getByLabel('Creative intent').selectOption('text-to-image');
  await inspector.getByLabel('Audited model').selectOption('flux-schnell:text-to-image');
  await inspector
    .getByRole('textbox', { name: /^Prompt/ })
    .fill('A quiet blue observatory above a calm northern sea');
  await inspector.getByText('Request validated locally.').waitFor();
}

async function chooseImageEditWorkflow(page: Page): Promise<void> {
  const inspector = page.locator('#parameter-inspector');
  await inspector.getByLabel('Creative intent').selectOption('image-edit');
  await inspector.getByLabel('Audited model').selectOption('flux-dev:image-edit');
  await inspector
    .getByRole('textbox', { name: /^Prompt/ })
    .fill('Transform the retained source into a quiet cyanotype');
  await inspector.getByLabel('Add local file').setInputFiles('tests/fixtures/media/tiny.png');
  await inspector.getByText('tiny.png').waitFor();
  await inspector.getByText('1 × 1 px').waitFor();
  await inspector.getByText('Local transfer and Poyo upload completed.').waitFor();
  await inspector.getByText('Request validated locally.').waitFor();
}

async function createMultiOutputImage(page: Page): Promise<void> {
  const inspector = page.locator('#parameter-inspector');
  await inspector.getByLabel('Creative intent').selectOption('text-to-image');
  await inspector.getByLabel('Audited model').selectOption('gpt-4o-image:text-to-image');
  await inspector
    .getByRole('textbox', { name: /^Prompt/ })
    .fill('Two cobalt paper sculptures for a related-output comparison');
  await inspector.getByLabel('N', { exact: true }).fill('2');
  await inspector.getByText('Request validated locally.').waitFor();
  await inspector.getByRole('button', { name: 'Generate image' }).click();
  await page.getByRole('heading', { name: 'Generation verified locally' }).waitFor({
    timeout: 15_000
  });
}

async function assertPrimaryRoutesAccessible(page: Page, baseUrl: string): Promise<void> {
  for (const route of [
    '/',
    '/studio/image',
    '/studio/video',
    '/jobs',
    '/library',
    '/models',
    '/presets',
    '/settings',
    '/settings/diagnostics'
  ]) {
    await page.goto(`${baseUrl}${route}`);
    await page.locator('h1').waitFor();
    expect(await page.locator('h1').count()).toBe(1);
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
  }
}

test('E2E-01..15 production studios, recovery, library, settings and accessibility', async () => {
  const harness = await startBrowserAppHarness();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce'
  });
  const page = await context.newPage();
  const issues = trackBrowserIssues(page);
  const browserRequests: string[] = [];
  const failedBrowserResponses: Array<{ status: number; url: string }> = [];
  page.on('request', (request) => browserRequests.push(request.url()));
  page.on('response', (response) => {
    if (response.status() >= 400)
      failedBrowserResponses.push({ status: response.status(), url: response.url() });
  });

  try {
    await page.goto(harness.url);
    await page.getByRole('heading', { name: 'Dashboard', level: 1 }).waitFor();
    expect(await page.getByText('Model registry').count()).toBeGreaterThan(0);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);

    const theme = page.getByRole('button', { name: /Light theme\. Activate next theme\./ }).first();
    await theme.click();
    await page.locator('html[data-theme="dark"]').waitFor();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    await page.reload();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');

    await page.goto(`${harness.url}/studio/image`);
    await chooseImageTextWorkflow(page);
    const inspector = page.locator('#parameter-inspector');
    await inspector.getByRole('button', { name: 'Save preset', exact: true }).click();
    await inspector.getByLabel('Preset name').fill('Northern observatory');
    await inspector.getByLabel('Description').fill('Synthetic browser-suite preset');
    await inspector.getByRole('button', { name: 'Save preset', exact: true }).first().click();
    await inspector.getByText('Saved preset “Northern observatory”.').waitFor();

    const imageGenerate = inspector.getByRole('button', {
      name: 'Generate image'
    });
    await imageGenerate.dblclick();
    await waitUntil(
      () =>
        harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
          .length === 1,
      'Image submission did not reach the mock server exactly once.'
    );
    await page.getByRole('heading', { name: 'Generation verified locally' }).waitFor({
      timeout: 15_000
    });
    expect(
      harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
    ).toHaveLength(1);
    const imageSubmit = harness.mock.requests.find(
      (request) => request.pathname === '/api/generate/submit'
    );
    expect(imageSubmit).toMatchObject({ authorizationScheme: 'Bearer' });
    expect(JSON.stringify(imageSubmit?.json)).toContain('flux-schnell');
    expect(JSON.stringify(imageSubmit?.json)).not.toContain(harness.syntheticKey);

    await page.goto(`${harness.url}/studio/image`);
    await chooseImageEditWorkflow(page);
    await page
      .locator('#parameter-inspector')
      .getByRole('button', { name: 'Generate image' })
      .click();
    await page.getByRole('heading', { name: 'Generation verified locally' }).waitFor({
      timeout: 15_000
    });
    expect(
      harness.mock.requests.filter((request) => request.pathname === '/api/common/upload/stream')
    ).toHaveLength(1);
    const database = new Database(harness.databasePath, { readonly: true });
    try {
      const input = database
        .query<
          {
            local_reference: string | null;
            managed_source_id: string | null;
            relative_path: string | null;
            upload_url: string | null;
          },
          []
        >(
          `SELECT ji.local_reference,ji.managed_source_id,ms.relative_path,ji.upload_url
           FROM job_inputs ji LEFT JOIN managed_sources ms ON ms.id=ji.managed_source_id
           ORDER BY ji.rowid DESC LIMIT 1`
        )
        .get();
      expect(input?.local_reference).toBeNull();
      expect(input?.managed_source_id).toBeTruthy();
      expect(input?.relative_path).toBeTruthy();
      expect(
        input?.relative_path &&
          (await Bun.file(`${harness.appData}/uploads/${input.relative_path}`).exists())
      ).toBe(true);
      expect(input?.upload_url).toContain('/media/source.png');
    } finally {
      database.close();
    }

    harness.mock.queueOutcome('held');
    await page.goto(`${harness.url}/studio/video`);
    const videoInspector = page.locator('#parameter-inspector');
    await videoInspector
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('A slow cinematic orbit around a glass sculpture at sunrise');
    await videoInspector.getByText('Request validated locally.').waitFor();
    await videoInspector.getByRole('button', { name: 'Generate video' }).click();
    await page.getByRole('heading', { name: 'Poyo is generating' }).waitFor({ timeout: 15_000 });
    expect(await page.getByText('42%').count()).toBeGreaterThan(0);

    await harness.stopApp();
    await page.getByText('Live updates reconnecting').waitFor({ timeout: 8_000 });
    await harness.startApp();
    await page.getByText('Live updates connected').waitFor({ timeout: 12_000 });
    harness.mock.releaseHeldTasks();
    await page.getByRole('heading', { name: 'Generation verified locally' }).waitFor({
      timeout: 15_000
    });
    expect(harness.mock.tasks.size).toBe(3);
    expect(
      harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
    ).toHaveLength(3);

    await page.goto(`${harness.url}/studio/image`);
    await createMultiOutputImage(page);

    await page.goto(`${harness.url}/jobs`);
    await page.getByRole('heading', { name: 'Generation history' }).waitFor();
    expect(await page.getByText('Flux Schnell', { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.getByText(/Grok Imagine Video/).count()).toBeGreaterThan(0);
    await page.getByRole('link', { name: 'Completed' }).click();
    expect(await page.getByText('4 tracked jobs').count()).toBe(1);

    await page.goto(`${harness.url}/library`);
    await page.getByRole('heading', { name: 'Generation groups' }).waitFor();
    expect(await page.getByText('4 grouped generations').count()).toBe(1);
    await page.getByRole('link', { name: 'List view' }).click();
    await page.waitForURL(/view=list/);
    expect(await page.getByRole('link', { name: 'List view' }).getAttribute('aria-current')).toBe(
      'page'
    );
    const favorite = page.getByRole('button', { name: 'Add to favorites' }).first();
    await favorite.click();
    await page.getByRole('button', { name: 'Remove from favorites' }).first().waitFor();
    await page.getByRole('link', { name: /Favorites/ }).click();
    await page.waitForURL(/favorite=true/);
    expect(await page.getByText('1 grouped generation').count()).toBe(1);

    await page.goto(`${harness.url}/library`);
    const comparisonGroup = page.locator('article').filter({
      hasText: 'Two cobalt paper sculptures for a related-output comparison'
    });
    await comparisonGroup.getByRole('link', { name: 'GPT-4o Image', exact: true }).click();
    await page.getByRole('heading', { name: 'Compare related outputs' }).waitFor();
    expect(
      await page.getByRole('combobox', { name: 'Output A', exact: true }).inputValue()
    ).not.toBe(await page.getByRole('combobox', { name: 'Output B', exact: true }).inputValue());
    await page
      .getByRole('button', {
        name: /Open full-screen media viewer for .* comparison output A/
      })
      .click();
    const viewer = page.getByRole('dialog', { name: /comparison output A/ });
    await viewer.waitFor();
    await viewer.getByRole('button', { name: 'Zoom in' }).click();
    await viewer.getByText('Zoom 125 percent.').waitFor();
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Remix image' }).first().waitFor();
    await page.getByRole('link', { name: 'Animate in Video Studio' }).first().click();
    const remixedVideoInspector = page.locator('#parameter-inspector');
    expect(await remixedVideoInspector.getByRole('textbox', { name: /^Prompt/ }).inputValue()).toBe(
      'Two cobalt paper sculptures for a related-output comparison'
    );
    await remixedVideoInspector.getByText('media.poyo-fixture.example').waitFor();

    await page.goto(`${harness.url}/studio/video`);
    const videoEditInspector = page.locator('#parameter-inspector');
    await videoEditInspector.getByLabel('Creative intent').selectOption('video-edit');
    await videoEditInspector.getByLabel('Audited model').selectOption('happy-horse:video-edit');
    await videoEditInspector
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Regrade the source video with cool evening light');
    await videoEditInspector
      .locator('input[type="file"][accept^="video/"]')
      .setInputFiles('tests/fixtures/media/tiny.mp4');
    await videoEditInspector.getByText('16 × 16 px · 0.20 s').waitFor();
    await videoEditInspector.getByText('Local transfer and Poyo upload completed.').waitFor();
    await videoEditInspector.getByText('sourceVideoDuration is below minimum.').waitFor();

    await page.goto(`${harness.url}/studio/image`);
    await chooseImageTextWorkflow(page);
    const lostResponsePrompt = 'A paid action whose local HTTP response is deliberately lost';
    await page
      .locator('#parameter-inspector')
      .getByRole('textbox', { name: /^Prompt/ })
      .fill(lostResponsePrompt);
    await page.locator('#parameter-inspector').getByText('Request validated locally.').waitFor();
    const submitsBeforeLostResponse = harness.mock.requests.filter(
      (request) => request.pathname === '/api/generate/submit'
    ).length;
    const lostResponseServer = {} as {
      completed?: boolean;
      request?: Promise<APIResponse>;
    };
    await page.route(
      '**/api/jobs',
      async (route) => {
        const serverRequest = route.fetch();
        lostResponseServer.request = serverRequest.then((response) => {
          lostResponseServer.completed = true;
          return response;
        });
        await Bun.sleep(75);
        await route.abort('failed');
      },
      { times: 1 }
    );
    await page
      .locator('#parameter-inspector')
      .getByRole('button', { name: 'Generate image' })
      .click();
    await page.getByText(/Automatic resubmission is blocked to avoid duplicate spend/).waitFor();
    expect(lostResponseServer.completed).not.toBe(true);
    await page
      .locator('#parameter-inspector')
      .getByRole('button', { name: 'Reset', exact: true })
      .click();
    await page.getByText(/Reset is blocked until the unknown paid action is reconciled/).waitFor();
    const pendingStorage = await page.evaluate(() =>
      sessionStorage.getItem('poyo-studio-pending-action:image')
    );
    expect(pendingStorage).toContain('actionId');
    expect(pendingStorage).not.toContain(lostResponsePrompt);
    const lostActionId = (JSON.parse(pendingStorage ?? '{}') as { actionId?: string }).actionId;
    expect(lostActionId).toBeString();
    await waitUntil(
      () =>
        failedBrowserResponses.some((response) => {
          const url = new URL(response.url);
          return (
            response.status === 404 &&
            url.pathname === '/api/jobs' &&
            url.searchParams.get('actionId') === lostActionId
          );
        }),
      'Recovery did not observe the intentionally early action lookup 404.'
    );
    expect(lostResponseServer.completed).not.toBe(true);
    if (!lostResponseServer.request)
      throw new Error('The intercepted server request was not recorded.');
    expect((await lostResponseServer.request).status()).toBe(202);
    await page.getByRole('link', { name: 'View job details' }).waitFor({ timeout: 15_000 });
    expect(
      await page.evaluate(() => sessionStorage.getItem('poyo-studio-pending-action:image'))
    ).toBeNull();
    const lostResponseDatabase = new Database(harness.databasePath, { readonly: true });
    try {
      expect(
        lostResponseDatabase
          .query<{ intents: number; jobs: number }, [string]>(
            `SELECT COUNT(*) intents,COUNT(DISTINCT job_id) jobs
             FROM submission_intents WHERE request_fingerprint=?`
          )
          .get(lostActionId ?? '')
      ).toEqual({ intents: 1, jobs: 1 });
    } finally {
      lostResponseDatabase.close();
    }
    await waitUntil(
      () =>
        harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
          .length ===
        submitsBeforeLostResponse + 1,
      'Recovered paid action was not submitted exactly once.'
    );

    const abandonedActionId = crypto.randomUUID();
    await page.evaluate(
      ({ actionId }) =>
        sessionStorage.setItem(
          'poyo-studio-pending-action:image',
          JSON.stringify({
            actionId,
            entryKey: 'flux-schnell:text-to-image',
            createdAt: Date.now()
          })
        ),
      { actionId: abandonedActionId }
    );
    await page.reload();
    await page
      .getByRole('button', { name: 'Acknowledge risk and start a new action' })
      .waitFor({ timeout: 10_000 });
    expect(
      failedBrowserResponses.filter((response) => {
        const url = new URL(response.url);
        return response.status === 404 && url.searchParams.get('actionId') === abandonedActionId;
      }).length
    ).toBeGreaterThanOrEqual(6);
    await page
      .locator('#parameter-inspector')
      .getByRole('button', { name: 'Reset', exact: true })
      .click();
    await page.getByText(/Reset is blocked until the unknown paid action is reconciled/).waitFor();
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('spend credits twice');
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'Acknowledge risk and start a new action' }).click();
    await page.getByText(/unresolved action was explicitly abandoned/).waitFor();
    expect(
      await page.evaluate(() => sessionStorage.getItem('poyo-studio-pending-action:image'))
    ).toBeNull();

    const submitsBeforeReplay = harness.mock.requests.filter(
      (request) => request.pathname === '/api/generate/submit'
    ).length;
    const paidActionReplay = await page.evaluate(async () => {
      const actionId = crypto.randomUUID();
      const body = {
        actionId,
        entryKey: 'flux-schnell:text-to-image',
        values: { prompt: 'Concurrent stable paid action' },
        expertOverrides: [],
        inputs: []
      };
      const post = (value: unknown) =>
        fetch('/api/jobs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value)
        });
      const [first, second] = await Promise.all([post(body), post(body)]);
      const firstBody = (await first.json()) as { job?: { id: string } };
      const secondBody = (await second.json()) as { job?: { id: string } };
      const altered = await post({
        ...body,
        values: { prompt: 'Altered after the immutable paid action' }
      });
      const hostile = await post({
        ...body,
        actionId: crypto.randomUUID(),
        normalizedPayload: { model: 'attacker-model', input: {} }
      });
      const hostileImageType = await post({
        ...body,
        actionId: crypto.randomUUID(),
        values: { prompt: { injected: true }, n: '4' }
      });
      const hostileVideoType = await post({
        actionId: crypto.randomUUID(),
        entryKey: 'happy-horse:text-to-video',
        values: { prompt: 'animate', duration: '5', enableSafetyChecker: 'false' },
        expertOverrides: [],
        inputs: []
      });
      return {
        firstStatus: first.status,
        secondStatus: second.status,
        firstId: firstBody.job?.id,
        secondId: secondBody.job?.id,
        alteredStatus: altered.status,
        hostileStatus: hostile.status,
        hostileImageTypeStatus: hostileImageType.status,
        hostileVideoTypeStatus: hostileVideoType.status
      };
    });
    expect(paidActionReplay).toMatchObject({
      firstStatus: 202,
      secondStatus: 202,
      alteredStatus: 409,
      hostileStatus: 400,
      hostileImageTypeStatus: 422,
      hostileVideoTypeStatus: 422
    });
    expect(paidActionReplay.firstId).toBe(paidActionReplay.secondId);
    await waitUntil(
      () =>
        harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
          .length ===
        submitsBeforeReplay + 1,
      'Stable concurrent action was not submitted exactly once.'
    );

    const ambiguousDatabase = new Database(harness.databasePath);
    let ambiguousJobId = '';
    try {
      ambiguousJobId =
        ambiguousDatabase
          .query<{ id: string }, []>(
            "SELECT id FROM jobs WHERE local_phase='complete' ORDER BY created_at DESC LIMIT 1"
          )
          .get()?.id ?? '';
      if (!ambiguousJobId) throw new Error('No completed job was available for ambiguity UI.');
      ambiguousDatabase
        .query(
          "UPDATE jobs SET local_phase='requires_attention',remote_status='unknown',attention_code='submission_unknown',failure_domain='submission',updated_at=datetime('now') WHERE id=?"
        )
        .run(ambiguousJobId);
      ambiguousDatabase
        .query("UPDATE submission_intents SET state='unknown' WHERE job_id=?")
        .run(ambiguousJobId);
    } finally {
      ambiguousDatabase.close();
    }
    await page.goto(`${harness.url}/jobs/${ambiguousJobId}`);
    await page.getByText('Submission outcome is unknown.').waitFor();
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('spend credits twice');
      await dialog.accept();
    });
    await page.getByRole('button', { name: 'Acknowledge risk and retry' }).click();
    await page.waitForURL(
      (url) => url.pathname.startsWith('/jobs/') && !url.pathname.endsWith(ambiguousJobId)
    );
    const retriedJobId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    const retryDatabase = new Database(harness.databasePath, { readonly: true });
    try {
      expect(
        retryDatabase
          .query<{ retry_of_job_id: string | null }, [string]>(
            'SELECT retry_of_job_id FROM jobs WHERE id=?'
          )
          .get(retriedJobId)?.retry_of_job_id
      ).toBe(ambiguousJobId);
    } finally {
      retryDatabase.close();
    }

    await page.goto(`${harness.url}/presets`);
    await page.getByRole('heading', { name: 'Saved presets' }).waitFor();
    await page.getByText('Northern observatory').waitFor();
    await page.getByRole('link', { name: 'Use preset' }).click();
    await page.getByText('Loaded preset “Northern observatory”.').waitFor();

    await page.goto(`${harness.url}/settings`);
    await page.getByText('Environment key active').waitFor();
    await page.getByRole('button', { name: /Test connection/ }).click();
    await page.getByText(/Passed/).waitFor();
    await page.getByLabel('Download successful outputs automatically').uncheck();
    await page.getByLabel('Polling interval (seconds)').fill('2');
    await page.getByLabel('Stale threshold (minutes)').fill('3');
    await page.getByRole('button', { name: 'Save operational settings' }).click();
    await page.getByText('Operational settings saved.').waitFor();
    await page.reload();
    expect(await page.getByLabel('Download successful outputs automatically').isChecked()).toBe(
      false
    );
    expect(await page.getByLabel('Polling interval (seconds)').inputValue()).toBe('2');
    expect(await page.getByLabel('Stale threshold (minutes)').inputValue()).toBe('3');
    expect(await page.getByText('Never delete automatically').count()).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Save automatic policy and preview' }).click();
    await page.getByText('Preview: 0 candidates').waitFor();
    await page.getByRole('heading', { name: 'Remote Poyo cleanup' }).scrollIntoViewIfNeeded();
    expect(await page.getByText(/No toggle, schedule, or simulated remote deletion/).count()).toBe(
      1
    );

    await page.goto(`${harness.url}/settings/diagnostics`);
    await page.getByRole('heading', { name: 'Application diagnostics' }).waitFor();
    expect(await page.getByText('127.0.0.1 · loopback only').count()).toBe(1);
    expect(await page.getByText('Disabled', { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.locator('body').textContent()).not.toContain(harness.syntheticKey);

    harness.mock.queueOutcome('failed');
    await page.goto(`${harness.url}/studio/image`);
    await chooseImageTextWorkflow(page);
    await page
      .locator('#parameter-inspector')
      .getByRole('button', { name: 'Generate image' })
      .click();
    await page.getByRole('heading', { name: 'Poyo generation failed' }).waitFor({
      timeout: 15_000
    });
    expect(await page.getByText(/authoritatively reported/).count()).toBe(1);
    expect(await page.getByText('Generation verified locally').count()).toBe(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${harness.url}/studio/image`);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
    await page.getByRole('button', { name: 'Edit setup' }).click();
    const dialog = page.getByRole('dialog', { name: 'Image setup' });
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Prompt' }).click();
    await dialog
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Keyboard accessible mobile prompt');
    expect(await dialog.getByRole('textbox', { name: /^Prompt/ }).isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    expect(await page.getByRole('button', { name: 'Edit setup' }).isVisible()).toBe(true);

    await page.setViewportSize({ width: 1440, height: 900 });
    await assertPrimaryRoutesAccessible(page, harness.url);

    const applicationPort = new URL(harness.url).port;
    const unexpectedBrowserRequests = browserRequests.filter((requestUrl) => {
      const url = new URL(requestUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      return url.hostname !== '127.0.0.1' || url.port !== applicationPort;
    });
    expect(unexpectedBrowserRequests).toEqual([]);
    const allowedFailedResponses = failedBrowserResponses.filter(({ status, url }) => {
      const path = new URL(url).pathname;
      return (
        (path === '/api/requests/preview' && status === 422) ||
        (path === '/api/jobs' && [400, 409, 422].includes(status)) ||
        (path === '/api/jobs' && status === 404 && new URL(url).searchParams.has('actionId'))
      );
    });
    expect(failedBrowserResponses).toEqual(allowedFailedResponses);
    expect(failedBrowserResponses.filter(({ status }) => status === 400)).toHaveLength(1);
    expect(failedBrowserResponses.filter(({ status }) => status === 409)).toHaveLength(1);
    expect(
      failedBrowserResponses.filter(
        ({ status, url }) => status === 422 && new URL(url).pathname === '/api/jobs'
      )
    ).toHaveLength(2);
    expect(
      issues.consoleErrors.filter((message) => message.includes('net::ERR_FAILED'))
    ).toHaveLength(1);
    const unexpectedConsoleErrors = issues.consoleErrors.filter(
      (message) =>
        !message.includes('ERR_INCOMPLETE_CHUNKED_ENCODING') &&
        !message.includes('TypeError: Failed to fetch') &&
        message !== 'TypeError: network error' &&
        !message.includes('status of 422 (Unprocessable Entity)') &&
        !message.includes('status of 409 (Conflict)') &&
        !message.includes('status of 400 (Bad Request)') &&
        !message.includes('status of 404 (Not Found)') &&
        !message.includes('net::ERR_FAILED')
    );
    expect(unexpectedConsoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  } catch (error) {
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/e2e-failure.png', fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

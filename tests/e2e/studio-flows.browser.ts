import { Database } from 'bun:sqlite';
import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import {
  type APIResponse,
  type Browser,
  type BrowserContext,
  chromium,
  type Dialog,
  type Page,
  type Route
} from 'playwright';
import { JobRepository } from '../../src/lib/server/jobs/repository';
import {
  type BrowserAppHarness,
  type CleanupStep,
  NamedStageTimeoutError,
  type StageTimer,
  type StageTracker,
  composeCleanupFailure,
  failAppHealthAfterRollback,
  runNamedStage,
  startBrowserAppHarness
} from '../helpers/browser-app-harness';
import {
  pageHasNoHorizontalOverflow,
  seriousAccessibilityViolations,
  trackBrowserIssues
} from '../helpers/browser-assertions';

setDefaultTimeout(120_000);
const serial = test.serial.bind(test);
const browserStageBoundMs = 15_000;
const productStageBoundMs = 5_000;
const cleanupStageBoundMs = 5_000;
const screenshotStageBoundMs = 2_000;

type StageRunner = <T>(
  name: string,
  boundMs: number,
  operation: () => T | Promise<T>,
  dispose?: () => void | Promise<void>
) => Promise<T>;

interface BrowserOwner {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  launchAttempted: boolean;
  pid: number | null;
  ownedPids: number[];
}

interface BrowserProcessControl {
  snapshot: () => Set<number>;
  isAlive: (pid: number) => boolean;
  kill: (pid: number) => void;
}

interface BrowserOwnerDependencies extends BrowserProcessControl {
  launch: () => Promise<Browser>;
}

function stageRunner(tracker: StageTracker): StageRunner {
  return (name, boundMs, operation, dispose) =>
    runNamedStage(tracker, name, boundMs, operation, dispose ? { dispose } : {});
}

function chromiumProcessSnapshot(): Set<number> {
  const result = Bun.spawnSync({
    cmd: ['ps', '-axo', 'pid=,command='],
    stdout: 'pipe',
    stderr: 'pipe'
  });
  if (result.exitCode !== 0) throw new Error('Unable to snapshot Chromium processes.');
  const output = new TextDecoder().decode(result.stdout);
  const pids = new Set<number>();
  for (const line of output.split('\n')) {
    if (!/ms-playwright|playwright_chromiumdev_profile/.test(line)) continue;
    const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
    if (Number.isSafeInteger(pid)) pids.add(pid);
  }
  return pids;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const browserProcessControl: BrowserProcessControl = {
  snapshot: chromiumProcessSnapshot,
  isAlive: processIsAlive,
  kill: (pid) => process.kill(pid, 'SIGKILL')
};

function refreshBrowserOwnership(
  owner: Partial<BrowserOwner>,
  baselinePids: Set<number>,
  snapshot: () => Set<number>
): void {
  const ownedPids = new Set(owner.ownedPids ?? []);
  for (const pid of snapshot()) {
    if (!baselinePids.has(pid)) ownedPids.add(pid);
  }
  owner.ownedPids = [...ownedPids].sort((left, right) => left - right);
  owner.pid = owner.ownedPids[0] ?? null;
}

function browserCleanupSteps(
  owner: Partial<BrowserOwner>,
  state: Record<string, unknown>,
  processes: BrowserProcessControl = browserProcessControl
): CleanupStep[] {
  const cleanupTracker: StageTracker = {};
  const cleanupStage = stageRunner(cleanupTracker);
  return [
    {
      name: 'browser context close',
      run: async () => {
        const context = owner.context;
        if (!context) return;
        try {
          await cleanupStage('browser context close', cleanupStageBoundMs, () => context.close());
          state.contextShutdown = 'graceful';
        } catch (contextCloseError) {
          state.contextCloseError = contextCloseError;
          state.contextShutdown = 'deferred-to-browser';
        }
      }
    },
    {
      name: 'browser connection close',
      run: async () => {
        const browser = owner.browser;
        if (!browser) return;
        try {
          await cleanupStage('browser connection close', cleanupStageBoundMs, () =>
            browser.close()
          );
          state.browserShutdown = 'graceful';
        } catch (gracefulError) {
          state.browserGracefulCloseError = gracefulError;
          const ownedPids = owner.ownedPids ?? [];
          for (const pid of ownedPids) {
            if (processes.isAlive(pid)) processes.kill(pid);
          }
          await cleanupStage('browser process kill wait', cleanupStageBoundMs, async () => {
            while (ownedPids.some(processes.isAlive)) await Bun.sleep(25);
          });
          state.browserShutdown = 'killed';
        }
      }
    },
    {
      name: 'browser process exit verification',
      run: async () => {
        const ownedPids = owner.ownedPids ?? [];
        if (owner.launchAttempted && ownedPids.length === 0)
          throw new Error('Launched browser has no owned PID evidence.');
        let liveOwnedPids = ownedPids.filter(processes.isAlive);
        if (liveOwnedPids.length > 0) {
          for (const pid of liveOwnedPids) processes.kill(pid);
          await cleanupStage(
            'browser residual process kill wait',
            cleanupStageBoundMs,
            async () => {
              while (liveOwnedPids.some(processes.isAlive)) await Bun.sleep(25);
            }
          );
          state.browserShutdown = 'killed-after-close';
          liveOwnedPids = ownedPids.filter(processes.isAlive);
        }
        if (liveOwnedPids.length > 0)
          throw new Error(`Owned browser processes remain live: ${liveOwnedPids.join(', ')}.`);
        state.browserExited = true;
      }
    }
  ];
}

async function startBrowserOwner(
  stage: StageRunner,
  overrides: Partial<BrowserOwnerDependencies> = {}
): Promise<BrowserOwner> {
  const dependencies: BrowserOwnerDependencies = {
    ...browserProcessControl,
    launch: () => chromium.launch({ headless: true, timeout: browserStageBoundMs }),
    ...overrides
  };
  const partial: Partial<BrowserOwner> = {};
  const baselinePids = dependencies.snapshot();
  try {
    // Bun 1.3.14 opens launchServer's TCP endpoint but cannot complete its WebSocket upgrade.
    // Preserve fresh per-test ownership with Playwright's Bun-compatible pipe transport.
    partial.launchAttempted = true;
    const browser = await dependencies.launch();
    partial.browser = browser;
    refreshBrowserOwnership(partial, baselinePids, dependencies.snapshot);
    const context = await stage('Playwright browser context create', productStageBoundMs, () =>
      browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: 'reduce'
      })
    );
    partial.context = context;
    refreshBrowserOwnership(partial, baselinePids, dependencies.snapshot);
    partial.page = await stage('Playwright browser page create', productStageBoundMs, () =>
      context.newPage()
    );
    refreshBrowserOwnership(partial, baselinePids, dependencies.snapshot);
    if ((partial.ownedPids ?? []).length === 0)
      throw new Error('Launched browser has no owned PID evidence.');
    return partial as BrowserOwner;
  } catch (primary) {
    let ownershipRefreshError: unknown;
    try {
      refreshBrowserOwnership(partial, baselinePids, dependencies.snapshot);
    } catch (error) {
      ownershipRefreshError = error;
    }
    const diagnostics: Record<string, unknown> = {
      stage: 'Playwright browser ownership startup',
      launchAttempted: partial.launchAttempted ?? false,
      browserPid: partial.pid ?? null,
      browserPids: partial.ownedPids ?? [],
      ownershipRefreshError
    };
    await composeCleanupFailure(
      primary,
      diagnostics,
      browserCleanupSteps(partial, diagnostics, dependencies)
    );
    throw primary;
  }
}

async function captureFailureScreenshot(
  page: Page | undefined,
  path: string
): Promise<{ status: 'fulfilled' | 'rejected'; reason?: unknown }> {
  if (!page) return { status: 'rejected', reason: new Error('No page was created.') };
  const tracker: StageTracker = {};
  try {
    await runNamedStage(tracker, 'failure screenshot', screenshotStageBoundMs, async () => {
      await mkdir('test-results', { recursive: true });
      await page.screenshot({ path, fullPage: true, timeout: screenshotStageBoundMs });
    });
    return { status: 'fulfilled' };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function errorDiagnostics(error: unknown): Record<string, unknown> {
  if (error && typeof error === 'object' && 'diagnostics' in error)
    return (error as { diagnostics: Record<string, unknown> }).diagnostics;
  return {};
}

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

async function assertSeedreamProSizeControls(page: Page, submitCount: () => number): Promise<void> {
  const inspector = page.locator('#parameter-inspector');
  await inspector.getByLabel('Creative intent').selectOption('text-to-image');
  await inspector.getByLabel('Audited model').selectOption('seedream-5.0-pro:text-to-image');
  expect(await inspector.getByLabel('Aspect Ratio').inputValue()).toBe('1:1');
  expect(await inspector.getByLabel('Resolution').inputValue()).toBe('2K');
  expect(await inspector.getByLabel('N', { exact: true }).count()).toBe(0);
  expect(await inspector.getByText('Size mode', { exact: true }).count()).toBe(0);
  expect(await inspector.getByText(/never both/i).count()).toBe(0);
  await inspector
    .getByRole('textbox', { name: /^Prompt/ })
    .fill('A luminous seed drifting over a midnight landscape');
  await inspector.getByText('Request validated locally.').waitFor();
  const submitsBeforeExpertRejection = submitCount();
  await inspector.getByText('Expert request', { exact: true }).click();
  await inspector.getByLabel('Unverified override object').fill('{"n":6}');
  await inspector
    .getByText(
      'Expert override n is retired for Seedream 5.0 Pro; current schema does not support it.'
    )
    .waitFor();
  expect(submitCount()).toBe(submitsBeforeExpertRejection);
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

type BrowserHarness = Awaited<ReturnType<typeof startBrowserAppHarness>>;

function mockSubmitCount(harness: BrowserHarness): number {
  return harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
    .length;
}

async function seedLegacySeedreamState(
  harness: BrowserHarness,
  stage: StageRunner
): Promise<{
  legacyJobId: string;
  legacyPresetId: string;
  supportingPresetId: string;
}> {
  await stage('legacy fixture app stop', browserStageBoundMs, harness.stopApp);
  const database = new Database(harness.databasePath);
  try {
    const timestamp = '2026-07-15T12:00:00.000Z';
    const legacyPresetId = crypto.randomUUID();
    const supportingPresetId = crypto.randomUUID();
    const insertPreset = database.query(
      `INSERT INTO presets(id,registry_version,entry_key,workflow,name,description,values_version,values_json,created_at,updated_at)
       VALUES (?,?,?,?,?,?,1,?,?,?)`
    );
    insertPreset.run(
      legacyPresetId,
      'legacy-image-registry',
      'seedream-5.0-pro:text-to-image',
      'text-to-image',
      'Legacy Pro preset',
      'Directly seeded browser recovery fixture',
      JSON.stringify({
        version: 1,
        modality: 'image',
        guided: { prompt: 'Legacy preset prompt', n: 6 },
        expertOverrides: [
          { key: 'n', value: 6 },
          { key: 'future_parameter', value: { source: 'preset' } }
        ],
        inputRoles: []
      }),
      timestamp,
      timestamp
    );
    insertPreset.run(
      supportingPresetId,
      'legacy-image-registry',
      'flux-schnell:text-to-image',
      'text-to-image',
      'Supporting count preset',
      'Retains a supported output count',
      JSON.stringify({
        version: 1,
        modality: 'image',
        guided: { prompt: 'Two retained Flux outputs', n: 2 },
        expertOverrides: [],
        inputRoles: []
      }),
      timestamp,
      timestamp
    );

    const repository = new JobRepository(database, () => new Date(timestamp));
    const legacyJob = repository.create({
      actionId: crypto.randomUUID(),
      entryKey: 'seedream-5.0-pro:text-to-image',
      workflow: 'text-to-image',
      publicModelId: 'seedream-5.0-pro',
      guidedRequest: { prompt: 'Legacy job prompt', n: 6 },
      normalizedPayload: {
        model: 'seedream-5.0-pro',
        input: {
          prompt: 'Legacy job prompt',
          size: '1:1',
          resolution: '1K',
          n: 6,
          enable_safety_checker: false
        }
      },
      expertDiff: [
        { key: 'n', value: 6, status: 'unverified' },
        { key: 'future_parameter', value: { source: 'job' }, status: 'unverified' }
      ]
    });
    database
      .query(
        `UPDATE jobs
         SET local_phase='complete',remote_status_raw='finished',remote_status='finished',completed_at=?,updated_at=?
         WHERE id=?`
      )
      .run(timestamp, timestamp, legacyJob.id);
    return { legacyJobId: legacyJob.id, legacyPresetId, supportingPresetId };
  } finally {
    database.close();
    await harness.startApp();
  }
}

async function assertRestoredProOrigin(
  page: Page,
  harness: BrowserHarness,
  stage: StageRunner,
  options: {
    path: string;
    loadedMessage: string;
    savedName: string;
    alreadyNavigated?: boolean;
  }
): Promise<void> {
  if (!options.alreadyNavigated)
    await stage(`${options.savedName} navigation`, productStageBoundMs, () =>
      page.goto(`${harness.url}${options.path}`, {
        timeout: productStageBoundMs,
        waitUntil: 'domcontentloaded'
      })
    );
  await stage(`${options.savedName} origin message`, productStageBoundMs, () =>
    page.getByText(options.loadedMessage).waitFor({ timeout: productStageBoundMs })
  );
  const inspector = page.locator('#parameter-inspector');
  const restoredExpertText = await stage(
    `${options.savedName} restored controls`,
    productStageBoundMs,
    async () => {
      expect(
        await inspector.getByLabel('Aspect Ratio').inputValue({ timeout: productStageBoundMs })
      ).toBe('1:1');
      expect(
        await inspector.getByLabel('Resolution').inputValue({ timeout: productStageBoundMs })
      ).toBe('2K');
      expect(await inspector.getByLabel('N', { exact: true }).count()).toBe(0);
      await inspector
        .getByText('Expert request', { exact: true })
        .click({ timeout: productStageBoundMs });
      return inspector
        .getByLabel('Unverified override object')
        .inputValue({ timeout: productStageBoundMs });
    }
  );
  expect(restoredExpertText).toContain('future_parameter');
  expect(restoredExpertText).not.toContain('"n"');

  await stage(`${options.savedName} initial preview render`, productStageBoundMs, () =>
    inspector.getByText('Request validated locally.').waitFor({ timeout: productStageBoundMs })
  );
  const prompt = inspector.getByRole('textbox', { name: /^Prompt/ });
  const nextPrompt = `${await prompt.inputValue()} reviewed`;
  const previewResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/requests/preview' &&
      response.request().method() === 'POST',
    { timeout: productStageBoundMs }
  );
  const submitsBeforePreview = mockSubmitCount(harness);
  await stage(`${options.savedName} preview request`, productStageBoundMs, () =>
    prompt.fill(nextPrompt, { timeout: productStageBoundMs })
  );
  const previewResponse = await stage(
    `${options.savedName} preview response`,
    productStageBoundMs,
    () => previewResponsePromise
  );
  expect(previewResponse.status()).toBe(200);
  const previewRequest = previewResponse.request().postDataJSON() as {
    values: Record<string, unknown>;
    expertOverrides: Array<{ key: string; value: unknown }>;
  };
  const previewBody = await stage(
    `${options.savedName} preview body`,
    productStageBoundMs,
    async () => (await previewResponse.json()) as { request: { input: Record<string, unknown> } }
  );
  expect(previewRequest.values).not.toHaveProperty('n');
  expect(previewRequest.expertOverrides.map((override) => override.key)).not.toContain('n');
  expect(previewBody.request.input).not.toHaveProperty('n');
  const [, reviewedPreviewText] = await stage(
    `${options.savedName} reviewed preview render`,
    productStageBoundMs,
    () =>
      Promise.all([
        inspector.getByText('Request validated locally.').waitFor({ timeout: productStageBoundMs }),
        inspector.locator('pre').last().textContent({ timeout: productStageBoundMs })
      ])
  );
  expect(reviewedPreviewText).not.toContain('"n"');
  expect(mockSubmitCount(harness)).toBe(submitsBeforePreview);

  await stage(`${options.savedName} preset form`, productStageBoundMs, async () => {
    await inspector
      .getByRole('button', { name: 'Save preset', exact: true })
      .click({ timeout: productStageBoundMs });
    await inspector
      .getByLabel('Preset name')
      .fill(options.savedName, { timeout: productStageBoundMs });
    await inspector
      .getByLabel('Description')
      .fill('Browser-isolated save filtering proof', { timeout: productStageBoundMs });
  });
  let injectionStarted = false;
  let previewRequestsBeforeCapture = 0;
  let resolveCapture!: (capture: {
    body: {
      values: {
        guided: Record<string, unknown>;
        expertOverrides: Array<{ key: string; value: unknown }>;
      };
    };
    previewRequestsBeforeCapture: number;
  }) => void;
  const capturedPreset = new Promise<{
    body: {
      values: {
        guided: Record<string, unknown>;
        expertOverrides: Array<{ key: string; value: unknown }>;
      };
    };
    previewRequestsBeforeCapture: number;
  }>((resolve) => {
    resolveCapture = resolve;
  });
  const previewListener = (request: { url(): string }) => {
    if (injectionStarted && new URL(request.url()).pathname === '/api/requests/preview')
      previewRequestsBeforeCapture += 1;
  };
  const presetRoute = async (route: Route) => {
    injectionStarted = false;
    resolveCapture({
      body: route.request().postDataJSON() as {
        values: {
          guided: Record<string, unknown>;
          expertOverrides: Array<{ key: string; value: unknown }>;
        };
      },
      previewRequestsBeforeCapture
    });
    await route.continue();
  };
  page.on('request', previewListener);
  let captured!: Awaited<typeof capturedPreset>;
  let presetCaptureFailure: unknown;
  try {
    await stage(`${options.savedName} preset route install`, productStageBoundMs, () =>
      page.route('**/api/presets', presetRoute, { times: 1 })
    );
    injectionStarted = true;
    captured = await stage(`${options.savedName} capturedPreset`, productStageBoundMs, async () => {
      await page.evaluate(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>('#image-expert-json');
        const name = document.querySelector<HTMLInputElement>('#image-preset-name');
        if (!textarea || !name) throw new Error('Preset editor controls are unavailable.');
        textarea.value = JSON.stringify({ n: 6, future_parameter: { mode: 'kept' } });
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        const form = name.parentElement?.parentElement;
        const save = Array.from(form?.querySelectorAll('button') ?? []).find(
          (button) => button.textContent?.trim() === 'Save preset'
        );
        if (!save) throw new Error('Final Save preset button is unavailable.');
        save.click();
      });
      return capturedPreset;
    });
  } catch (error) {
    presetCaptureFailure = error;
  } finally {
    injectionStarted = false;
    await composeCleanupFailure(
      presetCaptureFailure,
      { stage: `${options.savedName} preset capture cleanup` },
      [
        {
          name: `${options.savedName} preview listener removal`,
          run: () => {
            page.off('request', previewListener);
          }
        },
        {
          name: `${options.savedName} preset route removal`,
          run: () =>
            runNamedStage(
              {},
              `${options.savedName} preset route removal`,
              cleanupStageBoundMs,
              () => page.unroute('**/api/presets', presetRoute)
            )
        }
      ]
    );
  }
  expect(captured.previewRequestsBeforeCapture).toBe(0);
  expect(captured.body.values.guided).not.toHaveProperty('n');
  expect(captured.body.values.expertOverrides).toEqual([
    { key: 'future_parameter', value: { mode: 'kept' } }
  ]);
  await stage(`${options.savedName} save confirmation`, productStageBoundMs, () =>
    inspector
      .getByText(`Saved preset “${options.savedName}”.`)
      .waitFor({ timeout: productStageBoundMs })
  );

  await stage(`${options.savedName} persisted row`, productStageBoundMs, () => {
    const database = new Database(harness.databasePath, { readonly: true });
    try {
      const persisted = database
        .query<{ values_json: string }, [string]>(
          'SELECT values_json FROM presets WHERE name=? ORDER BY updated_at DESC LIMIT 1'
        )
        .get(options.savedName);
      if (!persisted) throw new Error(`Saved preset ${options.savedName} was not persisted.`);
      const values = JSON.parse(persisted.values_json) as {
        guided: Record<string, unknown>;
        expertOverrides: Array<{ key: string; value: unknown }>;
      };
      expect(values.guided).not.toHaveProperty('n');
      expect(values.expertOverrides).toEqual([
        { key: 'future_parameter', value: { mode: 'kept' } }
      ]);
    } finally {
      database.close();
    }
  });
}

async function assertSupportingPresetCount(
  page: Page,
  harness: BrowserHarness,
  stage: StageRunner,
  presetId: string
): Promise<void> {
  await stage('supporting preset navigation', productStageBoundMs, () =>
    page.goto(`${harness.url}/studio/image?preset=${presetId}`, {
      timeout: productStageBoundMs,
      waitUntil: 'domcontentloaded'
    })
  );
  await stage('supporting preset restore', productStageBoundMs, () =>
    page
      .getByText('Loaded preset “Supporting count preset”.')
      .waitFor({ timeout: productStageBoundMs })
  );
  const inspector = page.locator('#parameter-inspector');
  await stage('supporting preset controls', productStageBoundMs, async () => {
    expect(
      await inspector.getByLabel('N', { exact: true }).inputValue({ timeout: productStageBoundMs })
    ).toBe('2');
  });
  await stage('supporting preset initial preview', productStageBoundMs, () =>
    inspector.getByText('Request validated locally.').waitFor({ timeout: productStageBoundMs })
  );
  const prompt = inspector.getByRole('textbox', { name: /^Prompt/ });
  const previewResponsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/requests/preview',
    { timeout: productStageBoundMs }
  );
  await stage('supporting preset preview request', productStageBoundMs, async () =>
    prompt.fill(`${await prompt.inputValue()} reviewed`, { timeout: productStageBoundMs })
  );
  const previewResponse = await stage(
    'supporting preset preview response',
    productStageBoundMs,
    () => previewResponsePromise
  );
  expect(previewResponse.status()).toBe(200);
  const request = previewResponse.request().postDataJSON() as {
    values: Record<string, unknown>;
  };
  const response = await stage(
    'supporting preset preview body',
    productStageBoundMs,
    async () => (await previewResponse.json()) as { request: { input: Record<string, unknown> } }
  );
  expect(request.values.n).toBe(2);
  expect(response.request.input.n).toBe(2);
  expect(mockSubmitCount(harness)).toBe(0);

  const savedName = 'Supporting count resaved';
  await stage('supporting preset save', productStageBoundMs, async () => {
    await inspector
      .getByRole('button', { name: 'Save preset', exact: true })
      .click({ timeout: productStageBoundMs });
    await inspector.getByLabel('Preset name').fill(savedName, { timeout: productStageBoundMs });
    await inspector
      .getByRole('button', { name: 'Save preset', exact: true })
      .first()
      .click({ timeout: productStageBoundMs });
    await inspector
      .getByText(`Saved preset “${savedName}”.`)
      .waitFor({ timeout: productStageBoundMs });
  });
  await stage('supporting preset persisted row', productStageBoundMs, () => {
    const database = new Database(harness.databasePath, { readonly: true });
    try {
      const row = database
        .query<{ values_json: string }, [string]>('SELECT values_json FROM presets WHERE name=?')
        .get(savedName);
      expect(row && (JSON.parse(row.values_json) as { guided: { n?: number } }).guided.n).toBe(2);
    } finally {
      database.close();
    }
  });
}

serial('HARNESS-01 controlled failure diagnostics are causal and self-cleaning', async () => {
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const timer: StageTimer = {
    set: (callback, milliseconds) => {
      const token = setTimeout(() => {
        pendingTimers.delete(token);
        callback();
      }, milliseconds);
      pendingTimers.add(token);
      return token;
    },
    clear: (token) => {
      const timeout = token as ReturnType<typeof setTimeout>;
      clearTimeout(timeout);
      pendingTimers.delete(timeout);
    },
    pendingCount: () => pendingTimers.size
  };
  const tracker: StageTracker = { lastStage: 'synthetic-completed-stage' };
  const target = new EventTarget();
  let listenerInvocations = 0;
  const listener = () => {
    listenerInvocations += 1;
  };
  target.addEventListener('synthetic', listener);
  const sentinelOuterGuardError = new Error('sentinel outer guard failure');
  let outerToken: ReturnType<typeof setTimeout> | undefined;
  let timeoutFailure: unknown;
  try {
    const outerGuard = new Promise<never>((_, reject) => {
      outerToken = setTimeout(() => reject(sentinelOuterGuardError), 500);
    });
    try {
      await Promise.race([
        runNamedStage(
          tracker,
          'synthetic-never-resolving-stage',
          10,
          () => new Promise<never>(() => {}),
          {
            timer,
            dispose: () => target.removeEventListener('synthetic', listener)
          }
        ),
        outerGuard
      ]);
    } catch (error) {
      timeoutFailure = error;
    }
  } finally {
    if (outerToken !== undefined) clearTimeout(outerToken);
  }
  expect(timeoutFailure).not.toBe(sentinelOuterGuardError);
  expect(timeoutFailure).toBeInstanceOf(NamedStageTimeoutError);
  const timeoutError = timeoutFailure as NamedStageTimeoutError;
  expect(timeoutError.name).toBe('NamedStageTimeoutError');
  expect(timeoutError.stage).toBe('synthetic-never-resolving-stage');
  expect(timeoutError.lastStage).toBe('synthetic-completed-stage');
  expect(timeoutError.boundMs).toBe(10);
  expect(timeoutError.cause).toBeInstanceOf(DOMException);
  expect((timeoutError.cause as DOMException).name).toBe('TimeoutError');
  expect(timer.pendingCount()).toBe(0);
  target.dispatchEvent(new Event('synthetic'));
  expect(listenerInvocations).toBe(0);

  const sentinelPrimaryError = new Error('sentinel primary stage failure');
  const sentinelCleanupError = new Error('sentinel cleanup failure');
  const diagnostics = {
    stage: 'synthetic-primary-stage',
    lastStage: 'synthetic-completed-stage',
    boundMs: 10
  };
  let successfulCleanupInvocations = 0;
  let failedCleanupInvocations = 0;
  let aggregateFailure: unknown;
  try {
    await composeCleanupFailure(sentinelPrimaryError, diagnostics, [
      {
        name: 'synthetic-cleanup-success',
        run: () => {
          successfulCleanupInvocations += 1;
        }
      },
      {
        name: 'synthetic-cleanup-failure',
        run: () => {
          failedCleanupInvocations += 1;
          throw sentinelCleanupError;
        }
      }
    ]);
  } catch (error) {
    aggregateFailure = error;
  }
  expect(aggregateFailure).toBeInstanceOf(AggregateError);
  const aggregate = aggregateFailure as AggregateError & {
    diagnostics: Record<string, unknown> & { cleanup: Array<Record<string, unknown>> };
  };
  expect(aggregate.cause).toBe(sentinelPrimaryError);
  expect(successfulCleanupInvocations).toBe(1);
  expect(failedCleanupInvocations).toBe(1);
  expect(aggregate.errors).toHaveLength(1);
  expect(aggregate.errors[0]).toBe(sentinelCleanupError);
  expect(aggregate.diagnostics.stage).toBe(diagnostics.stage);
  expect(aggregate.diagnostics.lastStage).toBe(diagnostics.lastStage);
  expect(aggregate.diagnostics.boundMs).toBe(diagnostics.boundMs);
  expect(aggregate.diagnostics.cleanup[0]).toEqual({
    name: 'synthetic-cleanup-success',
    status: 'fulfilled'
  });
  expect(aggregate.diagnostics.cleanup[1]?.name).toBe('synthetic-cleanup-failure');
  expect(aggregate.diagnostics.cleanup[1]?.status).toBe('rejected');
  expect(aggregate.diagnostics.cleanup[1]?.reason).toBe(sentinelCleanupError);

  let cleanupOnlyInvocations = 0;
  let cleanupOnlyFailure: unknown;
  try {
    await composeCleanupFailure(undefined, diagnostics, [
      {
        name: 'synthetic-cleanup-failure',
        run: () => {
          cleanupOnlyInvocations += 1;
          throw sentinelCleanupError;
        }
      }
    ]);
  } catch (error) {
    cleanupOnlyFailure = error;
  }
  expect(cleanupOnlyFailure).toBeInstanceOf(AggregateError);
  const cleanupOnlyAggregate = cleanupOnlyFailure as AggregateError & {
    diagnostics: { cleanup: Array<Record<string, unknown>> };
  };
  expect(cleanupOnlyInvocations).toBe(1);
  expect(cleanupOnlyAggregate.cause).toBe(sentinelCleanupError);
  expect(cleanupOnlyAggregate.errors).toHaveLength(1);
  expect(cleanupOnlyAggregate.errors[0]).toBe(sentinelCleanupError);
  expect(cleanupOnlyAggregate.diagnostics.cleanup[0]?.name).toBe('synthetic-cleanup-failure');
  expect(cleanupOnlyAggregate.diagnostics.cleanup[0]?.status).toBe('rejected');
  expect(cleanupOnlyAggregate.diagnostics.cleanup[0]?.reason).toBe(sentinelCleanupError);

  const launchPid = 41_000;
  const launchAlive = new Set([launchPid]);
  const launchOrder: string[] = [];
  const lateLaunchError = new Error('synthetic late browser launch rejection');
  let launchStarted = false;
  let launchExitVerified = false;
  let launchFailure: unknown;
  try {
    await startBrowserOwner(stageRunner({}), {
      launch: async () => {
        launchStarted = true;
        launchOrder.push('launch-started');
        await Bun.sleep(10);
        launchOrder.push('launch-rejected');
        throw lateLaunchError;
      },
      snapshot: () => new Set(launchStarted ? [launchPid] : []),
      isAlive: (pid) => {
        const alive = launchAlive.has(pid);
        if (!alive && !launchExitVerified) {
          launchExitVerified = true;
          launchOrder.push('exit-verified');
        }
        return alive;
      },
      kill: (pid) => {
        launchAlive.delete(pid);
        launchOrder.push('owned-killed');
      }
    });
  } catch (error) {
    launchFailure = error;
    launchOrder.push('caller-rejected');
  }
  expect(launchFailure).toBeInstanceOf(AggregateError);
  const launchAggregate = launchFailure as AggregateError & {
    diagnostics: Record<string, unknown> & { cleanup: Array<Record<string, unknown>> };
  };
  expect(launchAggregate.cause).toBe(lateLaunchError);
  expect(launchAggregate.diagnostics.browserPids).toEqual([launchPid]);
  expect(launchAggregate.diagnostics.browserShutdown).toBe('killed-after-close');
  expect(launchAggregate.diagnostics.browserExited).toBe(true);
  expect(launchAggregate.diagnostics.cleanup.map((outcome) => outcome.status)).toEqual([
    'fulfilled',
    'fulfilled',
    'fulfilled'
  ]);
  expect(launchOrder).toEqual([
    'launch-started',
    'launch-rejected',
    'owned-killed',
    'exit-verified',
    'caller-rejected'
  ]);

  async function partialBrowserFailure(kind: 'context' | 'page', ownedPid: number) {
    const alive = new Set([ownedPid]);
    const killed: number[] = [];
    let launched = false;
    let browserCloseInvocations = 0;
    let contextCloseInvocations = 0;
    let contextCreateInvocations = 0;
    let pageCreateInvocations = 0;
    const context = {
      close: async () => {
        contextCloseInvocations += 1;
      },
      newPage: async () => {
        pageCreateInvocations += 1;
        throw new Error('synthetic page acquisition failure');
      }
    } as unknown as BrowserContext;
    const browser = {
      close: async () => {
        browserCloseInvocations += 1;
        throw new Error('synthetic graceful browser close failure');
      },
      newContext: async () => {
        contextCreateInvocations += 1;
        if (kind === 'context') throw new Error('synthetic context acquisition failure');
        return context;
      }
    } as unknown as Browser;
    let failure: unknown;
    try {
      await startBrowserOwner(stageRunner({}), {
        launch: async () => {
          launched = true;
          return browser;
        },
        snapshot: () => new Set(launched ? [ownedPid] : []),
        isAlive: (pid) => alive.has(pid),
        kill: (pid) => {
          killed.push(pid);
          alive.delete(pid);
        }
      });
    } catch (error) {
      failure = error;
    }
    return {
      failure,
      killed,
      alive,
      browserCloseInvocations,
      contextCloseInvocations,
      contextCreateInvocations,
      pageCreateInvocations
    };
  }

  const contextFailure = await partialBrowserFailure('context', 41_001);
  const pageFailure = await partialBrowserFailure('page', 41_002);
  for (const [kind, result, ownedPid] of [
    ['context', contextFailure, 41_001],
    ['page', pageFailure, 41_002]
  ] as const) {
    expect(result.failure).toBeInstanceOf(AggregateError);
    const browserAggregate = result.failure as AggregateError & {
      diagnostics: Record<string, unknown> & { cleanup: Array<Record<string, unknown>> };
    };
    expect(browserAggregate.diagnostics.browserPids).toEqual([ownedPid]);
    expect(browserAggregate.diagnostics.browserShutdown).toBe('killed');
    expect(browserAggregate.diagnostics.browserExited).toBe(true);
    expect(browserAggregate.diagnostics.cleanup.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled'
    ]);
    expect(result.killed).toEqual([ownedPid]);
    expect(result.alive.size).toBe(0);
    expect(result.browserCloseInvocations).toBe(1);
    expect(result.contextCreateInvocations).toBe(1);
    expect(result.contextCloseInvocations).toBe(kind === 'page' ? 1 : 0);
    expect(result.pageCreateInvocations).toBe(kind === 'page' ? 1 : 0);
  }

  const browserWithoutPid = {
    close: async () => {},
    newContext: async () => {
      throw new Error('synthetic context failure without PID evidence');
    }
  } as unknown as Browser;
  let missingOwnershipFailure: unknown;
  try {
    await startBrowserOwner(stageRunner({}), {
      launch: async () => browserWithoutPid,
      snapshot: () => new Set(),
      isAlive: () => false,
      kill: () => {
        throw new Error('PID-less browser cleanup must not attempt a kill.');
      }
    });
  } catch (error) {
    missingOwnershipFailure = error;
  }
  expect(missingOwnershipFailure).toBeInstanceOf(AggregateError);
  const missingOwnershipAggregate = missingOwnershipFailure as AggregateError & {
    diagnostics: { cleanup: Array<{ name: string; status: string; reason?: unknown }> };
  };
  const ownershipVerification = missingOwnershipAggregate.diagnostics.cleanup.find(
    (outcome) => outcome.name === 'browser process exit verification'
  );
  expect(ownershipVerification).toBeDefined();
  if (!ownershipVerification) throw new Error('Ownership verification outcome is unavailable.');
  expect(ownershipVerification.status).toBe('rejected');
  expect((ownershipVerification.reason as Error).message).toBe(
    'Launched browser has no owned PID evidence.'
  );

  async function controlledDirectAppStart(label: string) {
    const order: string[] = [];
    let failure: unknown;
    try {
      try {
        await runNamedStage({}, `${label} app health`, 10, () => new Promise<never>(() => {}));
      } catch (primary) {
        await composeCleanupFailure(primary, { stage: `${label} app startup` }, [
          {
            name: `${label} app rollback`,
            run: async () => {
              order.push('rollback-started');
              await Bun.sleep(5);
              order.push('rollback-finished');
            }
          }
        ]);
      }
    } catch (error) {
      failure = error;
      order.push('caller-rejected');
    }
    return { failure, order };
  }

  for (const label of ['initial', 'legacy fixture restart']) {
    const startup = await controlledDirectAppStart(label);
    expect(startup.failure).toBeInstanceOf(AggregateError);
    expect((startup.failure as AggregateError).cause).toBeInstanceOf(NamedStageTimeoutError);
    expect(startup.order).toEqual(['rollback-started', 'rollback-finished', 'caller-rejected']);
  }

  let appHealthTimeout: unknown;
  try {
    await runNamedStage(
      {},
      'controlled production app health',
      10,
      () => new Promise<never>(() => {})
    );
  } catch (error) {
    appHealthTimeout = error;
  }
  expect(appHealthTimeout).toBeInstanceOf(NamedStageTimeoutError);
  const lastProbeError = new Error('synthetic last health probe failure');
  const appHealthOrder: string[] = [];
  let drainedServerOutput = '';
  let appHealthFailure: unknown;
  try {
    await failAppHealthAfterRollback(appHealthTimeout, {
      appPid: 42_001,
      lastProbeError,
      stopApp: async () => {
        appHealthOrder.push('rollback-started');
        await Bun.sleep(5);
        drainedServerOutput = 'post-drain server output';
        appHealthOrder.push('rollback-finished');
      },
      serverOutput: () => {
        appHealthOrder.push('server-output-attached');
        return drainedServerOutput;
      }
    });
  } catch (error) {
    appHealthFailure = error;
    appHealthOrder.push('caller-rejected');
  }
  expect(appHealthFailure).toBeInstanceOf(AggregateError);
  const appHealthAggregate = appHealthFailure as AggregateError & {
    diagnostics: Record<string, unknown> & { cleanup: Array<Record<string, unknown>> };
  };
  expect(appHealthAggregate.cause).toBe(appHealthTimeout);
  expect(appHealthAggregate.diagnostics.lastProbeError).toBe(lastProbeError);
  expect(appHealthAggregate.diagnostics.serverOutput).toBe('post-drain server output');
  expect(appHealthAggregate.diagnostics.cleanup.map((outcome) => outcome.status)).toEqual([
    'fulfilled',
    'fulfilled'
  ]);
  expect(appHealthOrder).toEqual([
    'rollback-started',
    'rollback-finished',
    'server-output-attached',
    'caller-rejected'
  ]);
});

serial('E2E-01..15 production studios, recovery, library, settings and accessibility', async () => {
  const tracker: StageTracker = {};
  const stage = stageRunner(tracker);
  let harness!: BrowserAppHarness;
  let owner!: BrowserOwner;
  let page!: Page;
  let primary: unknown;
  let screenshot: { status: 'fulfilled' | 'rejected'; reason?: unknown } | undefined;
  const browserRequests: string[] = [];
  const failedBrowserResponses: Array<{ status: number; url: string }> = [];
  const requestListener = (request: { url(): string }) => browserRequests.push(request.url());
  const responseListener = (response: { status(): number; url(): string }) => {
    if (response.status() >= 400)
      failedBrowserResponses.push({ status: response.status(), url: response.url() });
  };

  try {
    harness = await startBrowserAppHarness();
    owner = await startBrowserOwner(stage);
    page = owner.page;
    page.on('request', requestListener);
    page.on('response', responseListener);
    const issues = trackBrowserIssues(page);
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
    await assertSeedreamProSizeControls(
      page,
      () =>
        harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
          .length
    );
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
    primary = error;
    screenshot = await captureFailureScreenshot(page, 'test-results/e2e-failure.png');
  } finally {
    const diagnostics: Record<string, unknown> = {
      stage: tracker.currentStage,
      lastStage: tracker.lastStage,
      boundMs: tracker.boundMs,
      pageUrl: page?.url?.() ?? null,
      requestCount: browserRequests.length,
      failedResponses: failedBrowserResponses,
      mockSubmitCount: harness ? mockSubmitCount(harness) : null,
      appPid: harness?.processPid?.() ?? null,
      browserPid: owner?.pid ?? null,
      screenshot,
      primaryDiagnostics: errorDiagnostics(primary)
    };
    const steps: CleanupStep[] = [
      {
        name: 'page request listener removal',
        run: () => {
          page?.off('request', requestListener);
        }
      },
      {
        name: 'page response listener removal',
        run: () => {
          page?.off('response', responseListener);
        }
      },
      ...browserCleanupSteps(owner ?? {}, diagnostics),
      {
        name: 'browser app harness cleanup',
        run: async () => {
          if (harness) await harness.cleanup();
        }
      },
      {
        name: 'lifecycle diagnostics',
        run: () => {
          diagnostics.appState = harness?.processState?.() ?? null;
          diagnostics.browserExited = (owner?.ownedPids ?? []).every((pid) => !processIsAlive(pid));
          diagnostics.serverOutput = harness?.serverOutput?.() ?? '';
        }
      }
    ];
    await composeCleanupFailure(primary, diagnostics, steps);
  }
});

serial(
  'E2E-16 legacy Seedream Pro authoring scrubs retired n and stale reruns require review',
  async () => {
    const tracker: StageTracker = {};
    const stage = stageRunner(tracker);
    let harness!: BrowserAppHarness;
    let owner!: BrowserOwner;
    let page!: Page;
    let primary: unknown;
    let screenshot: { status: 'fulfilled' | 'rejected'; reason?: unknown } | undefined;
    const failedResponses: Array<{ status: number; path: string }> = [];
    const responseListener = (response: { status(): number; url(): string }) => {
      if (response.status() >= 400)
        failedResponses.push({ status: response.status(), path: new URL(response.url()).pathname });
    };

    try {
      harness = await startBrowserAppHarness();
      const fixtures = await seedLegacySeedreamState(harness, stage);
      owner = await startBrowserOwner(stage);
      page = owner.page;
      page.on('response', responseListener);
      const issues = trackBrowserIssues(page);
      expect(mockSubmitCount(harness)).toBe(0);

      await assertRestoredProOrigin(page, harness, stage, {
        path: `/studio/image?preset=${fixtures.legacyPresetId}`,
        loadedMessage: 'Loaded preset “Legacy Pro preset”.',
        savedName: 'Legacy preset scrubbed copy'
      });

      await stage('Job Detail navigation', productStageBoundMs, async () => {
        await page.goto(`${harness.url}/jobs/${fixtures.legacyJobId}`, {
          timeout: productStageBoundMs,
          waitUntil: 'domcontentloaded'
        });
        await page
          .getByRole('heading', { name: 'Seedream 5.0 Pro' })
          .waitFor({ timeout: productStageBoundMs });
      });
      const readRerunSnapshot = () => {
        const database = new Database(harness.databasePath, { readonly: true });
        try {
          const counts = database
            .query<{ events: number; intents: number; jobs: number }, []>(
              `SELECT
               (SELECT COUNT(*) FROM jobs) jobs,
               (SELECT COUNT(*) FROM submission_intents) intents,
               (SELECT COUNT(*) FROM job_events) events`
            )
            .get();
          const source = database
            .query<
              {
                actual_payload_json: string;
                attention_code: string | null;
                expert_diff_json: string | null;
                guided_request_json: string;
                local_phase: string;
                remote_status: string;
                updated_at: string;
              },
              [string]
            >(
              `SELECT actual_payload_json,attention_code,expert_diff_json,guided_request_json,
                    local_phase,remote_status,updated_at
             FROM jobs WHERE id=?`
            )
            .get(fixtures.legacyJobId);
          return { counts, source };
        } finally {
          database.close();
        }
      };
      const before = await stage('rerun baseline snapshot', productStageBoundMs, readRerunSnapshot);
      const submitsBeforeRerun = mockSubmitCount(harness);
      const dialogListener = async (dialog: Dialog) => {
        expect(dialog.message()).toContain('new paid job');
        await dialog.accept();
      };
      page.on('dialog', dialogListener);
      const rerunResponse = await stage(
        'Job Detail rerun response',
        productStageBoundMs,
        async () => {
          const rerunResponsePromise = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === `/api/jobs/${fixtures.legacyJobId}/rerun` &&
              response.request().method() === 'POST',
            { timeout: productStageBoundMs }
          );
          await page
            .getByRole('button', { name: 'Run again' })
            .click({ timeout: productStageBoundMs });
          return rerunResponsePromise;
        },
        () => {
          page.off('dialog', dialogListener);
        }
      );
      expect(rerunResponse.status()).toBe(409);
      expect(
        await stage('Job Detail rerun body', productStageBoundMs, () => rerunResponse.json())
      ).toEqual({
        error: {
          code: 'retired_input_requires_review',
          message:
            'This Seedream 5 Pro job contains the retired n setting. Use Edit in studio to review current settings before creating a new paid job.'
        }
      });
      await stage('Job Detail rerun feedback', productStageBoundMs, async () => {
        await page
          .getByText(
            'This Seedream 5 Pro job contains the retired n setting. Use Edit in studio to review current settings before creating a new paid job.'
          )
          .waitFor({ timeout: productStageBoundMs });
        expect(
          await page
            .getByRole('link', { name: 'Edit in studio' })
            .isEnabled({ timeout: productStageBoundMs })
        ).toBe(true);
      });
      const rerunActionId = await stage(
        'Job Detail rerun action storage',
        productStageBoundMs,
        () =>
          page.evaluate(
            (jobId) => sessionStorage.getItem(`poyo-paid-action:rerun:${jobId}`),
            fixtures.legacyJobId
          )
      );
      expect(rerunActionId).toBeString();
      await stage('Job Detail rerun zero-effect persistence', productStageBoundMs, () => {
        expect(readRerunSnapshot()).toEqual(before);
        const rerunDatabase = new Database(harness.databasePath, { readonly: true });
        try {
          expect(
            rerunDatabase
              .query<{ count: number }, [string]>(
                'SELECT COUNT(*) count FROM submission_intents WHERE request_fingerprint=?'
              )
              .get(rerunActionId ?? '')?.count
          ).toBe(0);
        } finally {
          rerunDatabase.close();
        }
      });
      expect(mockSubmitCount(harness)).toBe(submitsBeforeRerun);

      await stage('Edit in studio navigation', productStageBoundMs, () =>
        Promise.all([
          page.waitForURL(
            (url) =>
              url.pathname === '/studio/image' &&
              url.searchParams.get('fromJob') === fixtures.legacyJobId,
            { timeout: productStageBoundMs }
          ),
          page.getByRole('link', { name: 'Edit in studio' }).click({ timeout: productStageBoundMs })
        ])
      );
      await assertRestoredProOrigin(page, harness, stage, {
        path: `/studio/image?fromJob=${fixtures.legacyJobId}`,
        loadedMessage: 'Loaded preset “Copy of Seedream 5.0 Pro”.',
        savedName: 'Legacy job scrubbed copy',
        alreadyNavigated: true
      });

      await assertSupportingPresetCount(page, harness, stage, fixtures.supportingPresetId);
      expect(mockSubmitCount(harness)).toBe(0);
      expect(
        failedResponses.filter(
          (response) =>
            !(
              (response.path === '/api/requests/preview' && response.status === 422) ||
              (response.path === `/api/jobs/${fixtures.legacyJobId}/rerun` &&
                response.status === 409)
            )
        )
      ).toEqual([]);
      expect(
        issues.consoleErrors.filter(
          (message) =>
            !message.includes('status of 422 (Unprocessable Entity)') &&
            !message.includes('status of 409 (Conflict)')
        )
      ).toEqual([]);
      expect(issues.pageErrors).toEqual([]);
    } catch (error) {
      primary = error;
      screenshot = await captureFailureScreenshot(
        page,
        'test-results/e2e-seedream-legacy-failure.png'
      );
    } finally {
      const diagnostics: Record<string, unknown> = {
        stage: tracker.currentStage,
        lastStage: tracker.lastStage,
        boundMs: tracker.boundMs,
        pageUrl: page?.url?.() ?? null,
        failedResponseCount: failedResponses.length,
        failedResponses,
        mockRequestCount: harness?.mock?.requests.length ?? null,
        mockSubmitCount: harness ? mockSubmitCount(harness) : null,
        appPid: harness?.processPid?.() ?? null,
        browserPid: owner?.pid ?? null,
        screenshot,
        primaryDiagnostics: errorDiagnostics(primary)
      };
      const steps: CleanupStep[] = [
        {
          name: 'page response listener removal',
          run: () => {
            page?.off('response', responseListener);
          }
        },
        ...browserCleanupSteps(owner ?? {}, diagnostics),
        {
          name: 'browser app harness cleanup',
          run: async () => {
            if (harness) await harness.cleanup();
          }
        },
        {
          name: 'lifecycle diagnostics',
          run: () => {
            diagnostics.appState = harness?.processState?.() ?? null;
            diagnostics.browserExited = (owner?.ownedPids ?? []).every(
              (pid) => !processIsAlive(pid)
            );
            diagnostics.serverOutput = harness?.serverOutput?.() ?? '';
          }
        }
      ];
      await composeCleanupFailure(primary, diagnostics, steps);
    }
  }
);

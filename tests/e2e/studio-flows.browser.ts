import { Database } from 'bun:sqlite';
import { expect, setDefaultTimeout, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import {
  type APIResponse,
  type Browser,
  type BrowserContext,
  chromium,
  type Locator,
  type Page
} from 'playwright';
import supportedPricingSignatures from '../fixtures/pricing/supported-signatures.json';
import {
  type BrowserAppHarness,
  type CleanupStep,
  composeCleanupFailure,
  failAppHealthAfterRollback,
  NamedStageTimeoutError,
  runNamedStage,
  type StageTimer,
  type StageTracker,
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
const processSnapshotAttempts = 8;
const processSnapshotRetryDelayMs = 100;
const multiOutputPrompt = [
  'Two cobalt paper sculptures for a related-output comparison',
  'A second line proves that the complete persisted prompt remains available in job details.',
  `Unbroken containment token: ${'cobalt'.repeat(120)}`
].join('\n');
const videoNavigationPrompt = [
  'A slow cinematic orbit around a glass sculpture at sunrise.',
  'This second long prompt verifies that parameter-only job navigation resets prompt controls.',
  `Unbroken navigation token: ${'orbit'.repeat(60)}`
].join('\n');

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
  processDiscoveryErrors: unknown[];
}

interface BrowserProcessControl {
  snapshot: () => Set<number>;
  isAlive: (pid: number) => boolean;
  kill: (pid: number) => void;
}

interface BrowserOwnerDependencies extends BrowserProcessControl {
  launch: () => Promise<Browser>;
}

interface ProcessSnapshotCommandResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

type ProcessSnapshotSpawn = (command: string[]) => ProcessSnapshotCommandResult;

function stageRunner(tracker: StageTracker): StageRunner {
  return (name, boundMs, operation, dispose) =>
    runNamedStage(tracker, name, boundMs, operation, dispose ? { dispose } : {});
}

function chromiumPids(output: string): Set<number> {
  const pids = new Set<number>();
  for (const line of output.split('\n')) {
    if (!/ms-playwright|playwright_chromiumdev_profile/.test(line)) continue;
    const pid = Number(/^\s*(\d+)/.exec(line)?.[1]);
    if (Number.isSafeInteger(pid)) pids.add(pid);
  }
  return pids;
}

const spawnProcessSnapshot: ProcessSnapshotSpawn = (command) => {
  const result = Bun.spawnSync({ cmd: command, stdout: 'pipe', stderr: 'pipe' });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
};

function chromiumProcessSnapshot(spawn: ProcessSnapshotSpawn = spawnProcessSnapshot): Set<number> {
  const decoder = new TextDecoder();
  const diagnostics: Array<Record<string, unknown>> = [];
  const ps = ['ps', '-axo', 'pid=,command='];
  for (let attempt = 1; attempt <= processSnapshotAttempts; attempt += 1) {
    try {
      const result = spawn(ps);
      if (result.exitCode === 0) {
        const pids = chromiumPids(decoder.decode(result.stdout));
        if (pids.size > 0) return pids;
        diagnostics.push({ command: ps.join(' '), attempt, exitCode: 0, matches: 0 });
        break;
      }
      diagnostics.push({
        command: ps.join(' '),
        attempt,
        exitCode: result.exitCode,
        stderr: decoder.decode(result.stderr).trim()
      });
    } catch (error) {
      diagnostics.push({ command: ps.join(' '), attempt, spawnError: String(error) });
    }
    if (attempt < processSnapshotAttempts)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, processSnapshotRetryDelayMs);
  }

  const pgrep = ['pgrep', '-fl', 'ms-playwright|playwright_chromiumdev_profile'];
  try {
    const result = spawn(pgrep);
    const stdout = decoder.decode(result.stdout);
    const stderr = decoder.decode(result.stderr).trim();
    if (result.exitCode === 0) return chromiumPids(stdout);
    if (result.exitCode === 1 && stdout.trim() === '' && stderr === '') return new Set();
    diagnostics.push({
      command: pgrep.join(' '),
      attempt: 1,
      exitCode: result.exitCode,
      stderr
    });
  } catch (error) {
    diagnostics.push({ command: pgrep.join(' '), attempt: 1, spawnError: String(error) });
  }

  throw new Error(`Unable to snapshot Chromium processes: ${JSON.stringify(diagnostics)}`);
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

async function browserReportedPids(browser: Browser): Promise<Set<number>> {
  if (typeof browser.newBrowserCDPSession !== 'function') return new Set();
  const session = await browser.newBrowserCDPSession();
  try {
    const result = (await session.send('SystemInfo.getProcessInfo')) as {
      processInfo?: Array<{ id?: unknown }>;
    };
    return new Set(
      (result.processInfo ?? [])
        .map((process) => process.id)
        .filter(
          (pid): pid is number => Number.isSafeInteger(pid) && typeof pid === 'number' && pid > 0
        )
    );
  } finally {
    await session.detach();
  }
}

function addOwnedPids(owner: Partial<BrowserOwner>, pids: Iterable<number>): void {
  const ownedPids = new Set(owner.ownedPids ?? []);
  for (const pid of pids) ownedPids.add(pid);
  owner.ownedPids = [...ownedPids].sort((left, right) => left - right);
  owner.pid = owner.ownedPids[0] ?? null;
}

function refreshBrowserOwnership(
  owner: Partial<BrowserOwner>,
  baselinePids: Set<number>,
  snapshot: () => Set<number>
): void {
  const discovered: number[] = [];
  for (const pid of snapshot()) {
    if (!baselinePids.has(pid)) discovered.push(pid);
  }
  addOwnedPids(owner, discovered);
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
  const partial: Partial<BrowserOwner> = { processDiscoveryErrors: [] };
  const baselinePids = dependencies.snapshot();
  try {
    // Bun 1.3.14 opens launchServer's TCP endpoint but cannot complete its WebSocket upgrade.
    // Preserve fresh per-test ownership with Playwright's Bun-compatible pipe transport.
    partial.launchAttempted = true;
    const browser = await dependencies.launch();
    partial.browser = browser;
    try {
      addOwnedPids(partial, await browserReportedPids(browser));
    } catch (error) {
      partial.processDiscoveryErrors?.push(error);
    }
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
      processDiscoveryErrors: partial.processDiscoveryErrors,
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

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 10_000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error(message);
}

async function selectRadioValue(scope: Locator, value: string): Promise<void> {
  const selector = `input[type="radio"][value="${value}"]`;
  await scope.locator(selector).evaluate((element) => (element as HTMLInputElement).click());
  await waitUntil(
    async () => scope.locator(selector).isChecked(),
    `Radio choice ${value} did not become selected.`
  );
}

type InspectorSectionLabel = 'Setup' | 'Prompt' | 'Inputs' | 'Output' | 'Review';

function generationCommands(page: Page): Locator {
  return page.locator('section[aria-label="Generation commands"]');
}

async function showInspectorSection(
  inspector: Locator,
  label: InspectorSectionLabel
): Promise<Locator> {
  const tab = inspector.getByRole('tab', {
    name: new RegExp(`^${label}(?:, needs attention)?$`)
  });
  const panelId = await tab.getAttribute('aria-controls');
  if (!panelId) throw new Error(`Inspector tab ${label} does not control a panel.`);
  const panel = inspector.locator(`#${panelId}`);
  await tab.click();
  await waitUntil(
    async () => (await tab.getAttribute('aria-selected')) === 'true' && (await panel.isVisible()),
    `Inspector section ${label} did not become selected.`
  );
  return panel;
}

async function waitForValidRequest(page: Page): Promise<void> {
  await generationCommands(page).getByText('Ready to generate', { exact: true }).waitFor();
}

async function assertModelPickerUserPath(page: Page): Promise<void> {
  const showSetup = page.getByRole('button', { name: 'Show setup' });
  if ((await showSetup.count()) > 0 && (await showSetup.isVisible())) await showSetup.click();
  const editSetup = page.getByRole('button', { name: 'Edit setup' });
  if ((await editSetup.count()) > 0 && (await editSetup.isVisible())) await editSetup.click();
  const picker = page.locator('fieldset:visible').filter({ hasText: 'Audited model' }).first();
  await picker.waitFor();
  const details = picker.locator('details');
  const summary = details.locator('summary');
  expect(await details.getAttribute('open')).toBeNull();
  await summary.focus();
  await summary.press('Enter');
  if ((await details.getAttribute('open')) === null) await summary.press('Space');
  await waitUntil(
    async () => (await details.getAttribute('open')) !== null,
    'The model picker did not open from the keyboard.'
  );
  expect(await picker.locator('section h3').count()).toBeGreaterThan(0);
  const selected = picker.locator('input[type="radio"]:checked');
  const selectedBefore = await selected.getAttribute('value');
  const alternateValue = await picker
    .locator('input[type="radio"]:not(:checked)')
    .first()
    .getAttribute('value');
  if (!alternateValue) throw new Error('The model picker did not expose an alternate model.');
  const focusAlternate = () =>
    picker.locator('input[type="radio"]').evaluateAll((elements, value) => {
      const alternate = elements.find(
        (element) => element instanceof HTMLInputElement && element.value === value
      );
      if (!(alternate instanceof HTMLInputElement)) return false;
      alternate.focus();
      return alternate === document.activeElement;
    }, alternateValue);
  await waitUntil(focusAlternate, 'The alternate model radio could not receive focus.');
  await page.keyboard.press('Space');
  if ((await details.getAttribute('open')) !== null) {
    await waitUntil(focusAlternate, 'The alternate model radio could not regain focus.');
    await page.keyboard.press('Space');
  }
  await waitUntil(
    async () => (await details.getAttribute('open')) === null,
    'The model picker did not close after keyboard selection.'
  );
  expect(await picker.locator('input[type="radio"]:checked').getAttribute('value')).not.toBe(
    selectedBefore
  );
  expect(await summary.evaluate((element) => element === document.activeElement)).toBe(true);
}

async function assertVideoSafetyCapabilityMarkers(page: Page): Promise<void> {
  const picker = page.locator('fieldset:visible').filter({ hasText: 'Audited model' }).first();
  const details = picker.locator('details');
  await details.locator('summary').click();
  await picker.getByText('Safety checker available · off by default', { exact: true }).waitFor();
  const markers = picker.locator('label [data-model-capability="safety-checker"]');
  expect(await markers.count()).toBeGreaterThan(0);
  expect(
    await markers.evaluateAll((elements) =>
      elements.every(
        (element) => element.textContent?.trim() === 'Safety checker available; off by default'
      )
    )
  ).toBe(true);
  await details.locator('summary').click();
}

function pngCrc(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, pngCrc(chunk.slice(4, 8 + data.length)));
  return chunk;
}

function solidPng(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = new Uint8Array((width * 4 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const start = row * (width * 4 + 1);
    for (let column = 0; column < width; column += 1) {
      const pixel = start + 1 + column * 4;
      rows.set([44, 91, 132, 255], pixel);
    }
  }
  const chunks = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', new Uint8Array())
  ];
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function chooseImageTextWorkflow(page: Page): Promise<void> {
  const inspector = page.locator('#parameter-inspector');
  await selectRadioValue(inspector, 'text-to-image');
  await selectRadioValue(inspector, 'flux-schnell:text-to-image');
  const promptPanel = await showInspectorSection(inspector, 'Prompt');
  await promptPanel
    .getByRole('textbox', { name: /^Prompt/ })
    .fill('A quiet blue observatory above a calm northern sea');
  await waitForValidRequest(page);
}

async function assertSeedreamProSizeControls(page: Page, submitCount: () => number): Promise<void> {
  const inspector = page.locator('#parameter-inspector');
  await selectRadioValue(inspector, 'text-to-image');
  await selectRadioValue(inspector, 'seedream-5.0-pro:text-to-image');
  const outputPanel = await showInspectorSection(inspector, 'Output');
  expect(
    await outputPanel
      .getByRole('group', { name: 'Aspect Ratio' })
      .getByRole('radio', { name: 'Automatic (1:1)' })
      .isChecked()
  ).toBe(true);
  expect(
    await outputPanel
      .getByRole('group', { name: 'Resolution' })
      .getByRole('radio', { name: 'Automatic (1K)' })
      .isChecked()
  ).toBe(true);
  expect(await outputPanel.getByLabel('N', { exact: true }).count()).toBe(0);
  expect(await outputPanel.getByText('Size mode', { exact: true }).count()).toBe(0);
  expect(await outputPanel.getByText(/never both/i).count()).toBe(0);
  const promptPanel = await showInspectorSection(inspector, 'Prompt');
  await promptPanel
    .getByRole('textbox', { name: /^Prompt/ })
    .fill('A luminous seed drifting over a midnight landscape');
  await waitForValidRequest(page);
  const submitsBeforeExpertRejection = submitCount();
  const reviewPanel = await showInspectorSection(inspector, 'Review');
  await reviewPanel.getByText('Expert request', { exact: true }).click();
  await reviewPanel.getByLabel('Unverified override object').fill('{"n":6}');
  await generationCommands(page)
    .getByText('Expert override n is not supported by the current Seedream 5.0 Pro schema.')
    .waitFor();
  expect(submitCount()).toBe(submitsBeforeExpertRejection);
}

async function chooseImageEditWorkflow(page: Page): Promise<void> {
  const inspector = page.locator('#parameter-inspector');
  await selectRadioValue(inspector, 'image-edit');
  await selectRadioValue(inspector, 'flux-dev:image-edit');
  const promptPanel = await showInspectorSection(inspector, 'Prompt');
  await promptPanel
    .getByRole('textbox', { name: /^Prompt/ })
    .fill('Transform the retained source into a quiet cyanotype');
  const inputsPanel = await showInspectorSection(inspector, 'Inputs');
  await inputsPanel.getByLabel('Media cleanup status').getByText('Image cleanup · Ready').waitFor();
  await inputsPanel.getByLabel('Add local file').setInputFiles({
    name: 'portrait-near-nine-sixteen.png',
    mimeType: 'image/png',
    buffer: Buffer.from(solidPng(900, 1601))
  });
  await inputsPanel.getByText('portrait-near-nine-sixteen.png').waitFor();
  await inputsPanel.getByText('900 × 1601 px').waitFor();
  const outputPanel = await showInspectorSection(inspector, 'Output');
  await outputPanel.getByRole('radio', { name: 'Automatic (9:16 from 900 × 1601)' }).waitFor();
  await showInspectorSection(inspector, 'Inputs');
  await inputsPanel.getByText('Local transfer and Poyo upload completed.').waitFor();
  await inputsPanel.getByText('Checked · No selected metadata found', { exact: true }).waitFor();
  await waitForValidRequest(page);
}

async function createMultiOutputImage(page: Page): Promise<void> {
  const inspector = page.locator('#parameter-inspector');
  await selectRadioValue(inspector, 'text-to-image');
  await selectRadioValue(inspector, 'gpt-4o-image:text-to-image');
  const promptPanel = await showInspectorSection(inspector, 'Prompt');
  await promptPanel.getByRole('textbox', { name: /^Prompt/ }).fill(multiOutputPrompt);
  const outputPanel = await showInspectorSection(inspector, 'Output');
  await outputPanel.getByLabel('N', { exact: true }).fill('2');
  await waitForValidRequest(page);
  await generationCommands(page).getByRole('button', { name: 'Generate image' }).click();
  await page.getByRole('heading', { name: 'Generated image result' }).waitFor({
    timeout: 15_000
  });
}

async function assertSafeStudioJobLink(page: Page, link: Locator): Promise<void> {
  const href = await link.getAttribute('href');
  if (!href) throw new Error('The studio job action did not expose its destination.');
  expect(await link.getAttribute('target')).toBe('_blank');
  expect(await link.getAttribute('rel')).toBe('noopener noreferrer');

  const originalUrl = page.url();
  const popupPromise = page.waitForEvent('popup');
  await link.click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  expect(popup.url()).toBe(new URL(href, originalUrl).href);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(page.url()).toBe(originalUrl);
  await popup.close();
}

async function assertPrimaryRoutesAccessible(page: Page, baseUrl: string): Promise<void> {
  for (const route of [
    '/',
    '/studio/image',
    '/studio/video',
    '/jobs',
    '/gallery',
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

  const encode = (value: string) => new TextEncoder().encode(value);
  let transientAttempts = 0;
  const transientSnapshot = chromiumProcessSnapshot((_command) => {
    transientAttempts += 1;
    if (transientAttempts < 5) {
      return {
        exitCode: 11,
        stdout: encode(''),
        stderr: encode('resource temporarily unavailable')
      };
    }
    return {
      exitCode: 0,
      stdout: encode('  43123 /tmp/ms-playwright/chromium --headless\n'),
      stderr: encode('')
    };
  });
  expect([...transientSnapshot]).toEqual([43123]);
  expect(transientAttempts).toBe(5);

  let fallbackAttempts = 0;
  const fallbackSnapshot = chromiumProcessSnapshot((command) => {
    fallbackAttempts += 1;
    if (command[0] === 'ps') {
      return { exitCode: 11, stdout: encode(''), stderr: encode('fork exhausted') };
    }
    return {
      exitCode: 0,
      stdout: encode('43124 /tmp/playwright_chromiumdev_profile/Default\n'),
      stderr: encode('')
    };
  });
  expect([...fallbackSnapshot]).toEqual([43124]);
  expect(fallbackAttempts).toBe(processSnapshotAttempts + 1);

  let emptyPsAttempts = 0;
  const emptyPsFallback = chromiumProcessSnapshot((command) => {
    emptyPsAttempts += 1;
    return command[0] === 'ps'
      ? { exitCode: 0, stdout: encode('  99 /usr/bin/unrelated\n'), stderr: encode('') }
      : {
          exitCode: 0,
          stdout: encode('43125 /tmp/playwright_chromiumdev_profile/Default\n'),
          stderr: encode('')
        };
  });
  expect([...emptyPsFallback]).toEqual([43125]);
  expect(emptyPsAttempts).toBe(2);

  let snapshotFailure: unknown;
  try {
    chromiumProcessSnapshot((command) => ({
      exitCode: command[0] === 'ps' ? 11 : 2,
      stdout: encode(''),
      stderr: encode(command[0] === 'ps' ? 'fork exhausted' : 'pgrep unavailable')
    }));
  } catch (error) {
    snapshotFailure = error;
  }
  expect(snapshotFailure).toBeInstanceOf(Error);
  expect((snapshotFailure as Error).message).toContain('exitCode');
  expect((snapshotFailure as Error).message).toContain('fork exhausted');
  expect((snapshotFailure as Error).message).toContain('pgrep unavailable');

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

  for (const label of ['initial', 'fixture restart']) {
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

serial(
  'JOB-17 direct and batch response boundaries fail closed without false retries',
  async () => {
    const harness = await startBrowserAppHarness();
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(`${harness.url}/studio/image`);
      await chooseImageTextWorkflow(page);
      const inspector = page.locator('#parameter-inspector');
      const commands = generationCommands(page);
      const generate = commands.getByRole('button', { name: 'Generate image' });

      await page.route(
        '**/api/jobs',
        (route) => route.fulfill({ status: 400, contentType: 'text/plain', body: 'rejected' }),
        { times: 1 }
      );
      await generate.click();
      await commands.getByText('The local server rejected the request.').waitFor();
      expect(await generate.isEnabled()).toBe(true);

      await page.route(
        '**/api/jobs',
        (route) =>
          route.fulfill({ status: 202, contentType: 'text/plain', body: 'accepted but malformed' }),
        { times: 1 }
      );
      await generate.click();
      await commands.getByText(/response did not confirm the paid job/).waitFor();
      const lockedBadge = commands
        .locator('span.rounded-full')
        .filter({ hasText: 'Action locked' });
      await lockedBadge.waitFor();
      expect(await lockedBadge.innerText()).toBe('Action locked');
      expect((await lockedBadge.getAttribute('class'))?.split(' ')).toContain('text-warning');
      expect(await commands.getByText('Ready to generate', { exact: true }).count()).toBe(0);
      expect(await generate.isDisabled()).toBe(true);
      const abandonDirect = commands.getByRole('button', {
        name: 'Acknowledge risk and start a new action'
      });
      await abandonDirect.waitFor({ timeout: 10_000 });
      page.once('dialog', (dialog) => dialog.accept());
      await abandonDirect.click();

      const addBatchItem = async (prompt: string) => {
        const promptPanel = await showInspectorSection(inspector, 'Prompt');
        await promptPanel.getByRole('textbox', { name: /^Prompt/ }).fill(prompt);
        await waitForValidRequest(page);
        await commands.getByRole('button', { name: 'Add to batch' }).click();
        await commands.getByText('Added item 1 to the local batch.').waitFor();
        await commands.getByRole('button', { name: 'Review batch (1)' }).click();
        return page.getByRole('dialog', { name: 'Image batch' });
      };
      const removeBatchItem = async (dialog: Locator) => {
        await dialog.getByRole('button', { name: 'Remove' }).click();
        await page.keyboard.press('Escape');
      };

      let dialog = await addBatchItem('Definitive batch rejection');
      await page.route(
        '**/api/jobs',
        (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'unavailable' }),
        { times: 1 }
      );
      await dialog.getByRole('button', { name: 'Submit 1 separate billed job' }).click();
      await dialog.getByText('failed', { exact: true }).waitFor();
      expect(await dialog.getByText('unknown', { exact: true }).count()).toBe(0);
      await removeBatchItem(dialog);

      dialog = await addBatchItem('Malformed successful batch response');
      await page.route(
        '**/api/jobs',
        (route) => route.fulfill({ status: 202, contentType: 'text/plain', body: 'malformed' }),
        { times: 1 }
      );
      await dialog.getByRole('button', { name: 'Submit 1 separate billed job' }).click();
      await dialog.getByText('unknown', { exact: true }).waitFor();
      page.once('dialog', (confirmation) => confirmation.accept());
      await dialog.getByRole('button', { name: 'Abandon action' }).click();
      await removeBatchItem(dialog);

      dialog = await addBatchItem('Lost batch response');
      await page.route('**/api/jobs', (route) => route.abort('failed'), { times: 1 });
      await dialog.getByRole('button', { name: 'Submit 1 separate billed job' }).click();
      await dialog.getByText('unknown', { exact: true }).waitFor();
      page.once('dialog', (confirmation) => confirmation.accept());
      await dialog.getByRole('button', { name: 'Abandon action' }).click();
      await removeBatchItem(dialog);
    } finally {
      await context.close();
      await browser.close();
      await harness.cleanup();
    }
  }
);
serial('BATCH-06 stale paid video recovery never replays retired requests', async () => {
  const harness = await startBrowserAppHarness();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const retiredEntryKey = 'wan2.7-image-to-video:frame-to-video';
  const retiredActionId = '019b0000-0000-7000-8000-000000000041';
  const currentActionId = '019b0000-0000-7000-8000-000000000042';
  const previewEntryKeys: string[] = [];
  let paidSubmissionCount = 0;
  const estimate = {
    classification: 'estimate',
    credits: 60,
    signature:
      'version=pricing-signature-v1|registry=video-2026-07-20.1|model=wan2.7-image-to-video|workflow=image-to-video|unit=per-second|duration=5|resolution=720p',
    basis: { unit: 'per-second', creditsPerUnit: 12, units: 5 },
    provenance: 'published',
    sourceVerifiedAt: '2026-07-20T00:00:00.000Z',
    expiresAt: '2026-07-21T00:00:00.000Z',
    freshness: 'fresh',
    availability: 'available'
  };
  const batch = {
    version: 1,
    modality: 'video',
    items: [
      {
        id: 'retired-paid-item',
        modality: 'video',
        displayName: 'Retired Wan 2.7 paid action',
        sizeMode: 'aspect-ratio',
        automaticFields: ['aspectRatio'],
        request: {
          actionId: retiredActionId,
          entryKey: retiredEntryKey,
          values: {
            prompt: 'Do not replay this retired paid request',
            duration: 2,
            resolution: '720p'
          },
          expertOverrides: [],
          inputs: []
        },
        estimate,
        state: 'submitting',
        job: null,
        outputs: [],
        error: null,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z'
      },
      {
        id: 'current-draft-item',
        modality: 'video',
        displayName: 'Current Wan 2.7 sibling',
        sizeMode: 'resolution',
        automaticFields: ['resolution'],
        request: {
          actionId: currentActionId,
          entryKey: 'wan2.7-image-to-video:image-to-video',
          values: { duration: 2, resolution: '720p' },
          expertOverrides: [],
          inputs: []
        },
        estimate,
        state: 'draft',
        job: null,
        outputs: [],
        error: null,
        createdAt: '2026-07-22T00:00:00.000Z',
        updatedAt: '2026-07-22T00:00:00.000Z'
      }
    ]
  };
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/jobs' && request.method() === 'POST') paidSubmissionCount += 1;
    if (url.pathname !== '/api/requests/preview' || request.method() !== 'POST') return;
    try {
      const body = JSON.parse(request.postData() ?? '') as { entryKey?: unknown };
      if (typeof body.entryKey === 'string') previewEntryKeys.push(body.entryKey);
    } catch {
      // The preview endpoint itself remains responsible for malformed request handling.
    }
  });
  await page.addInitScript((storedBatch) => {
    localStorage.setItem('poyo-studio-batch:video', JSON.stringify(storedBatch));
  }, batch);
  try {
    await page.goto(`${harness.url}/studio/video`);
    const commands = generationCommands(page);
    await commands.getByRole('button', { name: 'Review batch (2)' }).waitFor();
    await commands.getByRole('button', { name: 'Review batch (2)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Video batch' });
    await dialog.getByText('unknown', { exact: true }).waitFor();
    expect(await dialog.getByText('Retired Wan 2.7 paid action', { exact: true }).count()).toBe(1);
    expect(await dialog.getByText('Current Wan 2.7 sibling', { exact: true }).count()).toBe(1);
    expect(await dialog.getByRole('button', { name: 'Check action' }).count()).toBe(1);
    expect(await dialog.getByRole('button', { name: 'Abandon action' }).count()).toBe(1);
    expect(paidSubmissionCount).toBe(0);
    expect(previewEntryKeys).not.toContain(retiredEntryKey);
    await waitUntil(
      () =>
        page.evaluate(
          ({ actionId, entryKey }) => {
            const raw = localStorage.getItem('poyo-studio-batch:video');
            const stored = raw
              ? (JSON.parse(raw) as { items?: Array<{ request?: Record<string, unknown> }> })
              : null;
            const item = stored?.items?.find(
              (candidate) => candidate.request?.actionId === actionId
            );
            return item?.request?.entryKey === entryKey;
          },
          { actionId: retiredActionId, entryKey: retiredEntryKey }
        ),
      'The restored paid action was rewritten in browser storage.'
    );
  } finally {
    await context.close();
    await browser.close();
    await harness.cleanup();
  }
});

serial('G005 observed costs and outstanding spend remain clearly classified', async () => {
  const harness = await startBrowserAppHarness();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const compactText = async (locator: Locator) =>
    (await locator.innerText()).replaceAll(/\s+/g, ' ').trim();
  const estimateVector = supportedPricingSignatures.find(
    (vector) => vector.modelId === 'seedream-5.0-pro' && vector.workflow === 'text-to-image'
  );
  if (!estimateVector || !('n' in estimateVector.normalizedInput)) {
    throw new Error('Reviewed Seedream 5 Pro pricing vector is missing.');
  }
  const estimateCredits = estimateVector.expectedCredits;
  const estimateUnits = estimateVector.normalizedInput.n;
  const estimateSignature = estimateVector.estimateSignature;
  let estimateMode: 'available' | 'unavailable' = 'available';
  try {
    await page.route('**/api/requests/preview', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      if (response.ok()) {
        body.estimate =
          estimateMode === 'available'
            ? {
                classification: 'estimate',
                credits: estimateCredits,
                signature: estimateSignature,
                basis: {
                  unit: estimateVector.unit,
                  creditsPerUnit: estimateVector.creditsPerUnit,
                  units: estimateUnits
                },
                provenance: 'blend',
                sourceVerifiedAt: '2026-07-20T00:00:00.000Z',
                expiresAt: '2026-07-21T00:00:00.000Z',
                freshness: 'fresh',
                availability: 'available'
              }
            : {
                classification: 'estimate',
                credits: null,
                signature: null,
                basis: null,
                provenance: 'published',
                sourceVerifiedAt: null,
                expiresAt: null,
                freshness: 'stale',
                availability: 'unavailable'
              };
      }
      await route.fulfill({ response, json: body });
    });

    await page.goto(`${harness.url}/studio/image`);
    const commands = generationCommands(page);
    expect(await compactText(commands)).toContain(
      'Estimated credits: unavailable · complete setup to generate'
    );
    expect(await commands.getByRole('button', { name: 'Generate image' }).isDisabled()).toBe(true);

    const inspector = page.locator('#parameter-inspector');
    await selectRadioValue(inspector, estimateVector.workflow);
    await selectRadioValue(inspector, `${estimateVector.modelId}:${estimateVector.workflow}`);
    const selectedPrompt = await showInspectorSection(inspector, 'Prompt');
    await selectedPrompt
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('A quiet blue observatory above a calm northern sea');
    await waitForValidRequest(page);
    expect(await compactText(commands)).toContain(
      `Estimated credits: ${estimateCredits} · ${estimateUnits} output × ${estimateVector.creditsPerUnit} cr · published + observed · fresh`
    );
    expect(await compactText(commands)).toContain('Outstanding projection: 0 credits · 0 actions');
    expect(await commands.getByRole('button', { name: 'Generate image' }).isEnabled()).toBe(true);

    await commands.getByRole('button', { name: 'Add to batch' }).click();
    await waitUntil(
      () =>
        page.evaluate(
          (signature) =>
            localStorage.getItem('poyo-studio-batch:image')?.includes(signature) ?? false,
          estimateSignature
        ),
      'The production-shaped estimate was not persisted with the batch.'
    );
    await page.reload();
    await commands.getByRole('button', { name: 'Review batch (1)' }).waitFor();
    await commands.getByRole('button', { name: 'Review batch (1)' }).click();
    const batch = page.getByRole('dialog', { name: 'Image batch' });
    await batch.waitFor();
    expect(await compactText(batch)).toContain(
      `Estimated ready batch: ${estimateCredits} credits · 1 item`
    );
    expect(await compactText(batch)).toContain('Actual batch total: no settled Poyo task charges');
    await page.keyboard.press('Escape');

    estimateMode = 'unavailable';
    const prompt = await showInspectorSection(page.locator('#parameter-inspector'), 'Prompt');
    await prompt
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('The same valid action with unavailable pricing');
    await waitUntil(
      async () =>
        (await compactText(commands)).includes(
          'Estimated credits: unavailable · generation remains enabled'
        ),
      'The fixed preview route did not switch the valid request to unavailable pricing.'
    );
    expect(await compactText(commands)).toContain(
      'Estimated credits: unavailable · generation remains enabled'
    );
    expect(await commands.getByRole('button', { name: 'Generate image' }).isEnabled()).toBe(true);

    await commands.getByRole('button', { name: 'Generate image' }).click();
    await page
      .getByRole('heading', { name: 'Generated image result' })
      .waitFor({ timeout: 15_000 });
    await waitUntil(
      async () => (await compactText(commands)).includes('Charged: 3 credits · Poyo task'),
      'The first exact Poyo task charge did not reach the command dock.'
    );
    expect(await compactText(commands)).toContain('Outstanding projection: 0 credits · 0 actions');

    harness.mock.queueOutcome('held');
    await prompt.getByRole('textbox', { name: /^Prompt/ }).fill('A second unpriced queued action');
    await waitForValidRequest(page);
    await commands.getByRole('button', { name: 'Generate image' }).click();
    await waitUntil(async () => {
      const text = await compactText(commands);
      return !text.includes('Charged:') && /Outstanding projection: .* · 1 action/.test(text);
    }, 'A newer active action did not replace the prior charge and enter the outstanding projection.');
    harness.mock.releaseHeldTasks();
    await waitUntil(
      async () => (await compactText(commands)).includes('Charged: 3 credits · Poyo task'),
      'The second exact Poyo task charge did not replace the active projection.',
      15_000
    );
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await harness.cleanup();
  }
});

serial('STUDIO-UX setup tabs and command guards stay usable across surfaces', async () => {
  const harness = await startBrowserAppHarness({
    freshOnboarding: true,
    completedOnboarding: true
  });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${harness.url}/studio/image`);
    const inspector = page.locator('#parameter-inspector');
    await selectRadioValue(inspector, 'text-to-image');
    await selectRadioValue(inspector, 'seedream-4.5:text-to-image');
    const tabs = inspector.getByRole('tab');
    expect(await tabs.count()).toBe(5);
    expect(await inspector.locator('[role="tabpanel"]').count()).toBe(5);
    expect(await inspector.getByRole('tabpanel').count()).toBe(1);

    const setupTab = inspector.getByRole('tab', { name: /^Setup(?:, needs attention)?$/ });
    await setupTab.focus();
    await page.keyboard.press('ArrowLeft');
    const reviewTab = inspector.getByRole('tab', { name: /^Review(?:, needs attention)?$/ });
    expect(await reviewTab.getAttribute('aria-selected')).toBe('true');
    await waitUntil(
      () => reviewTab.evaluate((element) => element === document.activeElement),
      'ArrowLeft did not move focus to the wrapped Review tab.'
    );
    await page.keyboard.press('ArrowRight');
    expect(await setupTab.getAttribute('aria-selected')).toBe('true');
    await page.keyboard.press('End');
    expect(await reviewTab.getAttribute('aria-selected')).toBe('true');
    await page.keyboard.press('Home');
    expect(await setupTab.getAttribute('aria-selected')).toBe('true');

    const promptPanel = await showInspectorSection(inspector, 'Prompt');
    const prompt = promptPanel.getByRole('textbox', { name: /^Prompt/ });
    const commands = generationCommands(page);
    await prompt.fill('A value that survives setup section navigation');
    await page
      .getByText(
        'The guided request is valid. Review the exact normalized payload or generate when ready.',
        { exact: true }
      )
      .waitFor();
    const keyRequiredBadge = commands
      .locator('span.rounded-full')
      .filter({ hasText: 'API key required' });
    await keyRequiredBadge.waitFor();
    expect(await keyRequiredBadge.innerText()).toBe('API key required');
    expect((await keyRequiredBadge.getAttribute('class'))?.split(' ')).toContain('text-warning');
    expect(await commands.getByText('Ready to generate', { exact: true }).count()).toBe(0);
    expect(await commands.getByRole('button', { name: 'Generate image' }).isDisabled()).toBe(true);

    const outputPanel = await showInspectorSection(inspector, 'Output');
    await selectRadioValue(outputPanel, 'custom');
    await outputPanel.getByLabel('Custom width').waitFor();
    const outputTab = inspector.getByRole('tab', { name: 'Output, needs attention' });
    expect(await outputTab.count()).toBe(1);
    await waitUntil(
      () => commands.getByRole('button', { name: 'Add to batch' }).isDisabled(),
      'Add to batch stayed enabled for missing custom dimensions.'
    );
    expect(await commands.getByRole('button', { name: 'Generate image' }).isDisabled()).toBe(true);
    await outputPanel.getByLabel('Custom width').fill('1024');
    expect(await outputTab.count()).toBe(1);
    await waitUntil(
      () => commands.getByRole('button', { name: 'Add to batch' }).isDisabled(),
      'Add to batch stayed enabled for partial custom dimensions.'
    );
    await outputPanel.getByLabel('Custom height').fill('1024');
    await waitUntil(
      async () => (await outputTab.count()) === 0,
      'A valid custom size did not clear the Output tab issue marker.'
    );
    await page
      .getByText(
        'The guided request is valid. Review the exact normalized payload or generate when ready.',
        { exact: true }
      )
      .waitFor();

    await showInspectorSection(inspector, 'Output');
    await showInspectorSection(inspector, 'Prompt');
    expect(await prompt.inputValue()).toBe('A value that survives setup section navigation');

    expect(await commands.getByRole('button', { name: 'Add to batch' }).isEnabled()).toBe(true);
    expect(await commands.getByRole('button', { name: 'Generate image' }).isDisabled()).toBe(true);

    await page.getByRole('button', { name: 'Hide setup' }).click();
    expect(await commands.isVisible()).toBe(true);
    expect(await inspector.isVisible()).toBe(false);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await commands.isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Edit setup' }).click();
    const dialog = page.getByRole('dialog', { name: 'Image setup' });
    await dialog.waitFor();
    const mobilePromptTab = dialog.getByRole('tab', { name: /^Prompt(?:, needs attention)?$/ });
    expect(await mobilePromptTab.getAttribute('aria-selected')).toBe('true');
    expect(await dialog.getByRole('textbox', { name: /^Prompt/ }).inputValue()).toBe(
      'A value that survives setup section navigation'
    );
    expect(await page.locator('#image-desktop-prompt-tab').count()).toBe(1);
    expect(await page.locator('#image-mobile-prompt-tab').count()).toBe(1);
    expect(await page.locator('input[name="image-desktop-creative-intent"]').count()).toBe(2);
    expect(await page.locator('input[name="image-mobile-creative-intent"]').count()).toBe(2);
    await page.keyboard.press('Escape');
    expect(await commands.isVisible()).toBe(true);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await harness.cleanup();
  }
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
    harness = await startBrowserAppHarness({
      mediaToolShims: {
        exiftool: 'ready',
        imagemagick: 'ready',
        ffmpeg: 'ready',
        ffprobe: 'ready'
      }
    });
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
    await assertModelPickerUserPath(page);
    await assertSeedreamProSizeControls(
      page,
      () =>
        harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
          .length
    );
    await page.goto(`${harness.url}/studio/image`);
    await chooseImageTextWorkflow(page);
    await page.goto(harness.url);
    await page.goto(`${harness.url}/studio/image`);
    const inspector = page.locator('#parameter-inspector');
    const restoredPromptPanel = await showInspectorSection(inspector, 'Prompt');
    expect(await restoredPromptPanel.getByRole('textbox', { name: /^Prompt/ }).inputValue()).toBe(
      'A quiet blue observatory above a calm northern sea'
    );
    expect(
      await inspector.locator('input[type="radio"][value="flux-schnell:text-to-image"]').isChecked()
    ).toBe(true);
    await inspector.getByRole('button', { name: 'Save as preset', exact: true }).click();
    await inspector.getByLabel('Preset name').fill('Northern observatory');
    await inspector.getByLabel('Description').fill('Synthetic browser-suite preset');
    expect(
      await inspector.getByRole('button', { name: 'Save as preset', exact: true }).count()
    ).toBe(1);
    const savePreset = inspector.getByRole('button', { name: 'Save preset', exact: true });
    expect(await savePreset.count()).toBe(1);
    await savePreset.click();
    await inspector.getByText('Saved preset “Northern observatory”.').waitFor();

    const imageGenerate = generationCommands(page).getByRole('button', {
      name: 'Generate image'
    });
    await imageGenerate.dblclick();
    await waitUntil(
      () =>
        harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
          .length === 1,
      'Image submission did not reach the mock server exactly once.'
    );
    await page.getByRole('heading', { name: 'Generated image result' }).waitFor({
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
    const storedImageDraft = await page.evaluate(() =>
      localStorage.getItem('poyo-studio-draft:image')
    );
    expect(storedImageDraft).toContain('retained-source.invalid');
    expect(storedImageDraft).not.toContain('portrait-near-nine-sixteen.png');
    expect(storedImageDraft).not.toContain('/media/source.png');
    expect(storedImageDraft).not.toContain('sanitization');
    await page.reload();
    const restoredImageInspector = page.locator('#parameter-inspector');
    await generationCommands(page)
      .getByText(/Restored your last setup/)
      .waitFor();
    const restoredInputsPanel = await showInspectorSection(restoredImageInspector, 'Inputs');
    await restoredInputsPanel.getByText('900 × 1601 px').waitFor();
    expect(await restoredInputsPanel.getByText(/Privacy (?:cleanup|check) complete/).count()).toBe(
      0
    );
    const restoredOutputPanel = await showInspectorSection(restoredImageInspector, 'Output');
    await restoredOutputPanel
      .getByRole('radio', { name: 'Automatic (9:16 from 900 × 1601)' })
      .waitFor();
    await waitForValidRequest(page);
    await generationCommands(page).getByRole('button', { name: 'Generate image' }).click();
    await page.getByRole('heading', { name: 'Generated image result' }).waitFor({
      timeout: 15_000
    });
    expect(
      harness.mock.requests.filter((request) => request.pathname === '/api/common/upload/stream')
    ).toHaveLength(2);
    const localUploads = harness.mock.requests.filter(
      (request) => request.pathname === '/api/common/upload/stream'
    );
    const imageEditSubmit = harness.mock.requests
      .filter((request) => request.pathname === '/api/generate/submit')
      .at(-1);
    expect(imageEditSubmit?.json).toMatchObject({ input: { size: '9:16' } });
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
      const managedPath = input?.relative_path
        ? `${harness.appData}/uploads/${input.relative_path}`
        : null;
      if (!managedPath) throw new Error('Managed source path was not persisted.');
      expect(await Bun.file(managedPath).exists()).toBe(true);
      const managedChecksum = new Bun.CryptoHasher('sha256')
        .update(await Bun.file(managedPath).bytes())
        .digest('hex');
      for (const upload of localUploads) {
        if (!upload.multipart) throw new Error('Local Poyo upload was not multipart.');
        expect(upload.multipart.file.name).toBe(`${input?.managed_source_id}.png`);
        expect(upload.multipart.fileName).toBe(`${input?.managed_source_id}.png`);
        expect(upload.multipart.file.checksum).toBe(managedChecksum);
        expect(JSON.stringify(upload.multipart)).not.toContain('portrait-near-nine-sixteen.png');
      }
      expect(input?.upload_url).toContain('/media/source.png');
    } finally {
      database.close();
    }

    const imageSubmitCountAfterEdit = harness.mock.requests.filter(
      (request) => request.pathname === '/api/generate/submit'
    ).length;
    const repeatedGenerate = generationCommands(page).getByRole('button', {
      name: 'Generate image'
    });
    expect(await repeatedGenerate.isEnabled()).toBe(true);
    harness.mock.queueOutcome('held');
    const restoredPrompt = await showInspectorSection(restoredImageInspector, 'Prompt');
    await restoredPrompt
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Earlier held generation finishes last');
    await waitForValidRequest(page);
    await repeatedGenerate.click();
    await waitUntil(
      () =>
        harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
          .length ===
        imageSubmitCountAfterEdit + 1,
      'The first repeated generation was not submitted.'
    );
    await page.getByRole('heading', { name: 'Poyo is generating' }).waitFor();
    expect(await page.getByRole('progressbar').getAttribute('value')).toBe('42');
    expect(await repeatedGenerate.isEnabled()).toBe(true);
    await assertSafeStudioJobLink(
      page,
      page.getByRole('link', { name: 'View job details', exact: true })
    );

    harness.mock.queueOutcome('success');
    await restoredPrompt
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Later generation finishes first');
    await waitForValidRequest(page);
    await repeatedGenerate.click();
    await waitUntil(
      () =>
        harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
          .length ===
        imageSubmitCountAfterEdit + 2,
      'The second repeated generation was not submitted.'
    );

    const jobForPrompt = (prompt: string) => {
      const jobs = new Database(harness.databasePath, { readonly: true });
      try {
        return jobs
          .query<{ id: string; local_phase: string }, [string]>(
            "SELECT id,local_phase FROM jobs WHERE json_extract(guided_request_json,'$.prompt')=? ORDER BY created_at DESC LIMIT 1"
          )
          .get(prompt);
      } finally {
        jobs.close();
      }
    };
    await waitUntil(
      () => jobForPrompt('Later generation finishes first')?.local_phase === 'complete',
      'The later generation did not complete first.',
      15_000
    );
    const laterJobId = jobForPrompt('Later generation finishes first')?.id;
    if (!laterJobId) throw new Error('The later completed generation was not persisted.');
    await page.getByRole('heading', { name: 'Generated image result' }).waitFor();
    await waitUntil(
      async () =>
        (
          await page.getByRole('link', { name: 'View job', exact: true }).getAttribute('href')
        )?.includes(laterJobId) ?? false,
      'The latest successful preview did not promote the later generation.'
    );
    await assertSafeStudioJobLink(page, page.getByRole('link', { name: 'View job', exact: true }));

    harness.mock.releaseHeldTasks();
    await waitUntil(
      () => jobForPrompt('Earlier held generation finishes last')?.local_phase === 'complete',
      'The held generation did not complete after release.',
      15_000
    );
    const earlierJobId = jobForPrompt('Earlier held generation finishes last')?.id;
    if (!earlierJobId) throw new Error('The held completed generation was not persisted.');
    await waitUntil(
      async () =>
        (
          await page.getByRole('link', { name: 'View job', exact: true }).getAttribute('href')
        )?.includes(earlierJobId) ?? false,
      'The result preview did not follow actual completion order.'
    );

    harness.mock.queueOutcome('held');
    await restoredPrompt
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Held generation survives a newer failed job');
    await waitForValidRequest(page);
    await repeatedGenerate.click();
    await page.getByRole('heading', { name: 'Poyo is generating' }).waitFor();

    harness.mock.queueOutcome('failed');
    await restoredPrompt
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Newer generation fails before held completion');
    await waitForValidRequest(page);
    await repeatedGenerate.click();
    await page.getByRole('heading', { name: 'Poyo generation failed' }).waitFor({
      timeout: 15_000
    });

    harness.mock.releaseHeldTasks();
    await waitUntil(
      () => jobForPrompt('Held generation survives a newer failed job')?.local_phase === 'complete',
      'The held generation did not complete after the newer job failed.',
      15_000
    );
    const survivingJobId = jobForPrompt('Held generation survives a newer failed job')?.id;
    if (!survivingJobId) throw new Error('The surviving held generation was not persisted.');
    await page.getByRole('heading', { name: 'Generated image result' }).waitFor();
    await waitUntil(
      async () =>
        (
          await page.getByRole('link', { name: 'View job', exact: true }).getAttribute('href')
        )?.includes(survivingJobId) ?? false,
      'The failed active job continued to hide the completed held result.'
    );

    harness.mock.queueOutcome('held');
    await page.goto(`${harness.url}/studio/video`);
    await page.setViewportSize({ width: 390, height: 844 });
    await assertModelPickerUserPath(page);
    await assertVideoSafetyCapabilityMarkers(page);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    const videoInspector = page.locator('#parameter-inspector');
    await selectRadioValue(videoInspector, 'grok-imagine:text-to-video');
    const videoPromptPanel = await showInspectorSection(videoInspector, 'Prompt');
    await videoPromptPanel.getByRole('textbox', { name: /^Prompt/ }).fill(videoNavigationPrompt);
    await waitForValidRequest(page);
    await generationCommands(page).getByRole('button', { name: 'Generate video' }).click();
    await page.getByRole('heading', { name: 'Poyo is generating' }).waitFor({ timeout: 15_000 });
    expect(await page.getByText('42%').count()).toBeGreaterThan(0);

    await harness.stopApp();
    await page.getByText('Live updates reconnecting').waitFor({ timeout: 8_000 });
    await harness.startApp();
    await page.getByText('Live updates connected').waitFor({ timeout: 12_000 });
    harness.mock.releaseHeldTasks();
    await page.getByRole('heading', { name: 'Generated video result' }).waitFor({
      timeout: 15_000
    });
    const videoJobHref = await page
      .getByRole('link', { name: 'View job', exact: true })
      .getAttribute('href');
    if (!videoJobHref) throw new Error('The generated video did not expose its job detail link.');
    const videoJobId = new URL(videoJobHref, harness.url).searchParams.get('selected');
    if (!videoJobId) throw new Error('The generated video job link did not identify its job.');
    await assertSafeStudioJobLink(page, page.getByRole('link', { name: 'View job', exact: true }));
    expect(harness.mock.tasks.size).toBe(imageSubmitCountAfterEdit + 5);
    expect(
      harness.mock.requests.filter((request) => request.pathname === '/api/generate/submit')
    ).toHaveLength(imageSubmitCountAfterEdit + 5);

    await page.goto(`${harness.url}/studio/image`);
    await createMultiOutputImage(page);

    await page.goto(`${harness.url}/jobs`);
    await page.getByRole('heading', { name: 'Generation history' }).waitFor();
    expect(await page.getByText('Flux Schnell', { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.getByText(/Grok Imagine Video/).count()).toBeGreaterThan(0);
    await page.getByRole('link', { name: 'Completed' }).click();
    await page.waitForURL(
      (url) => url.pathname === '/jobs' && url.searchParams.get('status') === 'completed'
    );
    await page.getByText('7 tracked jobs').waitFor();

    await page.goto(`${harness.url}/gallery`);
    await page.getByRole('heading', { name: 'Generation gallery' }).waitFor();
    await page.getByText('7 grouped generations').waitFor();
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

    await page.goto(`${harness.url}/gallery`);
    const comparisonGroup = page.locator('article').filter({
      hasText: 'Two cobalt paper sculptures for a related-output comparison'
    });
    await comparisonGroup
      .getByRole('button', { name: 'View image GPT-4o Image', exact: true })
      .filter({ hasText: 'GPT-4o Image' })
      .click();
    await page
      .getByRole('dialog', { name: 'GPT-4o Image' })
      .getByRole('link', { name: 'Open job' })
      .click();
    await page.getByRole('heading', { name: 'Compare related outputs' }).waitFor();
    const imageDetailUrl = page.url();
    const promptContent = page.locator('#job-prompt');
    const promptToggle = page.getByRole('button', { name: 'Show full prompt' });
    expect((await promptContent.getAttribute('class'))?.split(' ')).toContain('line-clamp-4');
    expect(await promptContent.textContent()).toBe(multiOutputPrompt);
    expect(await promptToggle.getAttribute('aria-expanded')).toBe('false');
    expect(await seriousAccessibilityViolations(page)).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });

    await owner.context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(harness.url).origin
    });
    const copyPrompt = page.getByRole('button', { name: 'Copy full prompt' });
    await copyPrompt.click();
    await page.getByText('Prompt copied.').waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(multiOutputPrompt);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('Synthetic clipboard rejection.');
          }
        }
      });
    });
    await copyPrompt.click();
    await page.getByText('The browser did not allow clipboard access.').waitFor();
    await page.evaluate(() => {
      Reflect.deleteProperty(navigator, 'clipboard');
    });
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(multiOutputPrompt);

    await promptToggle.click();
    const showLess = page.getByRole('button', { name: 'Show less' });
    expect(await showLess.getAttribute('aria-expanded')).toBe('true');
    expect((await promptContent.getAttribute('class'))?.split(' ')).not.toContain('line-clamp-4');
    expect(await promptContent.textContent()).toBe(multiOutputPrompt);
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
    await showLess.click();
    expect(await promptToggle.getAttribute('aria-expanded')).toBe('false');
    expect((await promptContent.getAttribute('class'))?.split(' ')).toContain('line-clamp-4');
    await promptToggle.click();

    const videoJobUrl = new URL(`/jobs/${videoJobId}`, harness.url);
    await page.evaluate(() => Reflect.set(window, '__jobDetailNavigationSentinel', 'preserved'));
    await page.evaluate((href) => {
      const link = document.createElement('a');
      link.href = href;
      link.textContent = 'Navigate directly to another job';
      link.dataset.testid = 'direct-job-navigation';
      document.body.append(link);
    }, videoJobUrl.toString());
    await page.getByTestId('direct-job-navigation').click();
    await page.waitForURL((url) => url.pathname === videoJobUrl.pathname);
    expect(await page.evaluate(() => Reflect.get(window, '__jobDetailNavigationSentinel'))).toBe(
      'preserved'
    );
    await page.getByRole('heading', { name: /Grok Imagine Video/, level: 1 }).waitFor();
    const navigatedPrompt = page.locator('#job-prompt');
    const navigatedPromptToggle = page.getByRole('button', { name: 'Show full prompt' });
    expect(await navigatedPrompt.textContent()).toBe(videoNavigationPrompt);
    expect((await navigatedPrompt.getAttribute('class'))?.split(' ')).toContain('line-clamp-4');
    expect(await navigatedPromptToggle.getAttribute('aria-expanded')).toBe('false');
    expect(await page.getByRole('button', { name: 'Copy full prompt' }).count()).toBe(1);
    expect(await page.getByText('Prompt copied.').count()).toBe(0);
    expect(await page.getByText('The browser did not allow clipboard access.').count()).toBe(0);
    expect(await page.getByRole('link', { name: /in a new tab/ }).count()).toBe(0);

    await page.goto(imageDetailUrl);
    await page.getByRole('heading', { name: 'Compare related outputs' }).waitFor();

    expect(
      await page.getByRole('combobox', { name: 'Output A', exact: true }).inputValue()
    ).not.toBe(await page.getByRole('combobox', { name: 'Output B', exact: true }).inputValue());

    const quickOpen = page.getByRole('link', {
      name: /Open .* comparison output A in a new tab/
    });
    const quickOpenHref = await quickOpen.getAttribute('href');
    if (!quickOpenHref) throw new Error('The comparison preview did not expose a quick-open URL.');
    expect(new URL(quickOpenHref, harness.url).pathname).toMatch(/^\/api\/media\//);
    const quickOpenPopup = page.waitForEvent('popup');
    await quickOpen.click();
    const quickOpenPage = await quickOpenPopup;
    await quickOpenPage.waitForLoadState('domcontentloaded');
    expect(new URL(quickOpenPage.url()).pathname).toMatch(/^\/api\/media\//);
    expect(await quickOpenPage.evaluate(() => window.opener === null)).toBe(true);
    expect(page.url()).toBe(imageDetailUrl);
    await quickOpenPage.close();

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
    const browserResult = page.waitForEvent('popup');
    await page.getByRole('link', { name: 'Open in browser' }).first().click();
    const resultPage = await browserResult;
    await resultPage.waitForLoadState('domcontentloaded');
    expect(new URL(resultPage.url()).pathname).toMatch(/^\/api\/media\//);
    await resultPage.close();

    const downloadHref = await page
      .getByRole('link', { name: 'Download copy' })
      .first()
      .getAttribute('href');
    if (!downloadHref) throw new Error('Download action did not expose a media route.');
    const downloadResponse = await page.request.get(new URL(downloadHref, harness.url).toString());
    expect(downloadResponse.status()).toBe(200);
    expect(downloadResponse.headers()['content-disposition']).toContain('attachment;');
    await page.getByRole('link', { name: 'Remix image' }).first().waitFor();
    await page.getByRole('link', { name: 'Animate in Video Studio' }).first().click();
    const remixedVideoInspector = page.locator('#parameter-inspector');
    const remixedPromptPanel = await showInspectorSection(remixedVideoInspector, 'Prompt');
    expect(await remixedPromptPanel.getByRole('textbox', { name: /^Prompt/ }).inputValue()).toBe(
      multiOutputPrompt
    );
    const remixedInputsPanel = await showInspectorSection(remixedVideoInspector, 'Inputs');
    await remixedInputsPanel.getByText('media.poyo-fixture.example').waitFor();

    await page.goto(`${harness.url}/studio/video`);
    const videoEditInspector = page.locator('#parameter-inspector');
    await selectRadioValue(videoEditInspector, 'video-edit');
    await selectRadioValue(videoEditInspector, 'happy-horse:video-edit');
    const videoEditPromptPanel = await showInspectorSection(videoEditInspector, 'Prompt');
    await videoEditPromptPanel
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Regrade the source video with cool evening light');
    const videoEditInputsPanel = await showInspectorSection(videoEditInspector, 'Inputs');
    await videoEditInputsPanel
      .locator('input[type="file"][accept^="video/"]')
      .setInputFiles('tests/fixtures/media/tiny.mp4');
    await videoEditInputsPanel.getByText('16 × 16 px · 0.20 s').waitFor();
    await videoEditInputsPanel.getByText('Local transfer and Poyo upload completed.').waitFor();
    await videoEditInputsPanel.getByText(/^(?:Cleaned|Checked) ·/).waitFor();
    await generationCommands(page).getByText('sourceVideoDuration is below minimum.').waitFor();

    await page.goto(`${harness.url}/studio/image`);
    await chooseImageTextWorkflow(page);
    const lostResponsePrompt = 'A paid action whose local HTTP response is deliberately lost';
    const lostResponseInspector = page.locator('#parameter-inspector');
    const lostResponsePromptPanel = await showInspectorSection(lostResponseInspector, 'Prompt');
    await lostResponsePromptPanel
      .getByRole('textbox', { name: /^Prompt/ })
      .fill(lostResponsePrompt);
    await waitForValidRequest(page);
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
    await generationCommands(page).getByRole('button', { name: 'Generate image' }).click();
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
    await page.getByLabel('Remove XMP metadata').uncheck();
    await page.getByLabel('Polling interval (seconds)').fill('2');
    await page.getByLabel('Stale threshold (minutes)').fill('3');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText('Settings saved.').waitFor();
    await page.reload();
    expect(await page.getByLabel('Download successful outputs automatically').isChecked()).toBe(
      false
    );
    expect(await page.getByLabel('Polling interval (seconds)').inputValue()).toBe('2');
    expect(await page.getByLabel('Stale threshold (minutes)').inputValue()).toBe('3');
    expect(await page.getByLabel('Remove XMP metadata').isChecked()).toBe(false);
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

    await page.goto(`${harness.url}/settings`);
    await page.getByLabel('Download successful outputs automatically').check();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText('Settings saved.').waitFor();

    await page.goto(`${harness.url}/studio/image`);
    const imageBatchInspector = page.locator('#parameter-inspector');
    const imageBatchCommands = generationCommands(page);
    await selectRadioValue(imageBatchInspector, 'text-to-image');
    await selectRadioValue(imageBatchInspector, 'seedream-5.0-pro:text-to-image');
    let imageBatchPromptPanel = await showInspectorSection(imageBatchInspector, 'Prompt');
    await imageBatchPromptPanel
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Batch landscape study');
    let imageBatchOutputPanel = await showInspectorSection(imageBatchInspector, 'Output');
    await selectRadioValue(
      imageBatchOutputPanel.getByRole('group', { name: 'Aspect Ratio' }),
      '16:9'
    );
    await waitForValidRequest(page);
    await imageBatchCommands.getByRole('button', { name: 'Add to batch' }).click();
    await imageBatchCommands.getByText('Added item 1 to the local batch.').waitFor();
    imageBatchPromptPanel = await showInspectorSection(imageBatchInspector, 'Prompt');
    await imageBatchPromptPanel
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Batch portrait study');
    imageBatchOutputPanel = await showInspectorSection(imageBatchInspector, 'Output');
    await selectRadioValue(
      imageBatchOutputPanel.getByRole('group', { name: 'Aspect Ratio' }),
      '9:16'
    );
    await waitForValidRequest(page);
    await imageBatchCommands.getByRole('button', { name: 'Add to batch' }).click();
    harness.mock.queueOutcome('success');
    harness.mock.queueOutcome('failed');
    await imageBatchCommands.getByRole('button', { name: 'Review batch (2)' }).click();
    let imageBatchDialog = page.getByRole('dialog', { name: 'Image batch' });
    await imageBatchDialog.getByText('Batch landscape study · 16:9 · 1K').waitFor();
    await imageBatchDialog.getByText('Batch portrait study · 9:16 · 1K').waitFor();
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('replace the current setup draft');
      await dialog.accept();
    });
    await imageBatchDialog.getByRole('button', { name: 'Edit' }).first().click();
    await page.keyboard.press('Escape');
    imageBatchPromptPanel = await showInspectorSection(imageBatchInspector, 'Prompt');
    await imageBatchPromptPanel
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Batch landscape study revised');
    await waitForValidRequest(page);
    await imageBatchCommands.getByRole('button', { name: 'Update batch item' }).click();
    await imageBatchCommands.getByText('Updated the batch item.').waitFor();
    await imageBatchCommands.getByRole('button', { name: 'Review batch (2)' }).click();
    imageBatchDialog = page.getByRole('dialog', { name: 'Image batch' });
    await imageBatchDialog.getByText('Batch landscape study revised · 16:9 · 1K').waitFor();
    await imageBatchDialog.getByRole('button', { name: 'Duplicate' }).first().click();
    await page.getByRole('dialog', { name: 'Image batch' }).getByText('Item 3').waitFor();
    await page
      .getByRole('dialog', { name: 'Image batch' })
      .getByRole('button', { name: 'Remove' })
      .last()
      .click();
    await imageBatchDialog.getByRole('button', { name: 'Submit 2 separate billed jobs' }).click();
    await imageBatchDialog.getByText('complete', { exact: true }).waitFor({ timeout: 15_000 });
    await imageBatchDialog.getByText('failed', { exact: true }).waitFor({ timeout: 15_000 });
    expect(
      await imageBatchDialog.getByRole('link', { name: /Open result/ }).count()
    ).toBeGreaterThan(0);
    await page.reload();
    await generationCommands(page).getByRole('button', { name: 'Review batch (2)' }).click();
    imageBatchDialog = page.getByRole('dialog', { name: 'Image batch' });
    await imageBatchDialog.getByText('complete', { exact: true }).waitFor();
    await imageBatchDialog.getByText('failed', { exact: true }).waitFor();
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('new paid Poyo job');
      await dialog.accept();
    });
    await imageBatchDialog.getByRole('button', { name: 'Retry item' }).click();
    await waitUntil(
      async () => (await imageBatchDialog.getByText('complete', { exact: true }).count()) === 2,
      'Both image batch items did not complete after retry.',
      15_000
    );
    for (let remaining = 2; remaining > 0; remaining -= 1) {
      await imageBatchDialog.getByRole('button', { name: 'Remove' }).first().click();
    }
    await page.keyboard.press('Escape');
    await imageBatchInspector.getByRole('button', { name: 'Reset', exact: true }).click();
    await showInspectorSection(imageBatchInspector, 'Setup');
    await selectRadioValue(imageBatchInspector, 'image-edit');
    await selectRadioValue(imageBatchInspector, 'flux-dev:image-edit');
    imageBatchPromptPanel = await showInspectorSection(imageBatchInspector, 'Prompt');
    await imageBatchPromptPanel
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Reference batch portrait treatment');
    const imageBatchInputsPanel = await showInspectorSection(imageBatchInspector, 'Inputs');
    await imageBatchInputsPanel
      .getByLabel('Reference remote URL')
      .fill('https://media.poyo-fixture.example/reference.png');
    await imageBatchInputsPanel.getByRole('button', { name: 'Add URL' }).click();
    imageBatchOutputPanel = await showInspectorSection(imageBatchInspector, 'Output');
    await selectRadioValue(
      imageBatchOutputPanel.getByRole('group', { name: 'Aspect Ratio' }),
      '9:16'
    );
    await waitForValidRequest(page);
    await imageBatchCommands.getByRole('button', { name: 'Add to batch' }).click();
    imageBatchPromptPanel = await showInspectorSection(imageBatchInspector, 'Prompt');
    await imageBatchPromptPanel
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Reference batch landscape treatment');
    imageBatchOutputPanel = await showInspectorSection(imageBatchInspector, 'Output');
    await selectRadioValue(
      imageBatchOutputPanel.getByRole('group', { name: 'Aspect Ratio' }),
      '16:9'
    );
    await waitForValidRequest(page);
    await imageBatchCommands.getByRole('button', { name: 'Add to batch' }).click();
    await imageBatchCommands.getByRole('button', { name: 'Review batch (2)' }).click();
    const imageEditBatchDialog = page.getByRole('dialog', { name: 'Image batch' });
    await imageEditBatchDialog
      .getByRole('button', { name: 'Submit 2 separate billed jobs' })
      .click();
    await waitUntil(
      async () => (await imageEditBatchDialog.getByText('complete', { exact: true }).count()) === 2,
      'Both reference image batch items did not complete.',
      20_000
    );
    for (let remaining = 2; remaining > 0; remaining -= 1) {
      await imageEditBatchDialog.getByRole('button', { name: 'Remove' }).first().click();
    }
    await page.keyboard.press('Escape');
    await imageBatchInspector.getByRole('button', { name: 'Reset', exact: true }).click();
    await chooseImageTextWorkflow(page);
    imageBatchPromptPanel = await showInspectorSection(imageBatchInspector, 'Prompt');
    await imageBatchPromptPanel
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Batch item with a deliberately interrupted local submission');
    await waitForValidRequest(page);
    await imageBatchCommands.getByRole('button', { name: 'Add to batch' }).click();
    await page.route('**/api/jobs', async (route) => route.abort('failed'), { times: 1 });
    await imageBatchCommands.getByRole('button', { name: 'Review batch (1)' }).click();
    const interruptedBatchDialog = page.getByRole('dialog', { name: 'Image batch' });
    await interruptedBatchDialog
      .getByRole('button', { name: 'Submit 1 separate billed job' })
      .click();
    await interruptedBatchDialog.getByText('unknown', { exact: true }).waitFor();
    await interruptedBatchDialog.getByRole('button', { name: 'Check action' }).click();
    await interruptedBatchDialog.getByText(/paid action stays locked/).waitFor();
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toContain('spend credits twice');
      await dialog.accept();
    });
    await interruptedBatchDialog.getByRole('button', { name: 'Abandon action' }).click();
    await interruptedBatchDialog.getByText(/explicitly abandoned/).waitFor();
    await interruptedBatchDialog.getByRole('button', { name: 'Retry item' }).click();
    await interruptedBatchDialog.getByText('complete', { exact: true }).waitFor({
      timeout: 15_000
    });
    await interruptedBatchDialog.getByRole('button', { name: 'Remove' }).click();
    await page.keyboard.press('Escape');

    await page.goto(`${harness.url}/studio/video`);
    const videoBatchInspector = page.locator('#parameter-inspector');
    const videoBatchCommands = generationCommands(page);
    await videoBatchInspector.getByRole('button', { name: 'Reset', exact: true }).click();
    await selectRadioValue(videoBatchInspector, 'text-to-video');
    const videoBatchPromptPanel = await showInspectorSection(videoBatchInspector, 'Prompt');
    await videoBatchPromptPanel
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Video batch orbit one');
    await waitForValidRequest(page);
    await videoBatchCommands.getByRole('button', { name: 'Add to batch' }).click();
    await videoBatchPromptPanel
      .getByRole('textbox', { name: /^Prompt/ })
      .fill('Video batch orbit two');
    await waitForValidRequest(page);
    await videoBatchCommands.getByRole('button', { name: 'Add to batch' }).click();
    await videoBatchCommands.getByRole('button', { name: 'Review batch (2)' }).click();
    const videoBatchDialog = page.getByRole('dialog', { name: 'Video batch' });
    harness.mock.queueOutcome('held');
    harness.mock.queueOutcome('held');
    await videoBatchDialog.getByRole('button', { name: 'Submit 2 separate billed jobs' }).click();
    await waitUntil(
      async () => (await videoBatchDialog.getByText('running', { exact: true }).count()) === 2,
      'Both video batch items did not reach a durable running state before restart.',
      15_000
    );
    await harness.stopApp();
    await page.getByText('Live updates reconnecting').waitFor({ timeout: 8_000 });
    await harness.startApp();
    harness.mock.releaseHeldTasks();
    await page.getByText('Live updates connected').waitFor({ timeout: 12_000 });
    await waitUntil(
      async () => (await videoBatchDialog.getByText('complete', { exact: true }).count()) === 2,
      'Both video batch items did not complete.',
      20_000
    );

    harness.mock.queueOutcome('failed');
    await page.goto(`${harness.url}/studio/image`);
    const failureInspector = page.locator('#parameter-inspector');
    await failureInspector.getByRole('button', { name: 'Reset', exact: true }).click();
    const failurePromptPanel = await showInspectorSection(failureInspector, 'Prompt');
    expect(await failurePromptPanel.getByRole('textbox', { name: /^Prompt/ }).inputValue()).toBe(
      ''
    );
    await chooseImageTextWorkflow(page);
    await generationCommands(page).getByRole('button', { name: 'Generate image' }).click();
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
    await dialog.getByRole('tab', { name: /^Prompt(?:, needs attention)?$/ }).click();
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
    ).toHaveLength(2);
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

import { expect, setDefaultTimeout, test } from 'bun:test';
import { chromium, type Locator, type Page } from 'playwright';
import {
  startBrowserAppHarness,
  type BrowserMediaToolName,
  type BrowserMediaToolShimState
} from '../helpers/browser-app-harness';

setDefaultTimeout(60_000);

const readyTools = {
  exiftool: 'ready',
  imagemagick: 'ready',
  ffmpeg: 'ready',
  ffprobe: 'ready'
} as const satisfies Record<BrowserMediaToolName, BrowserMediaToolShimState>;

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000
): Promise<void> {
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

async function showInputs(inspector: Locator): Promise<Locator> {
  const tab = inspector.getByRole('tab', { name: /^Inputs(?:, needs attention)?$/ });
  const panelId = await tab.getAttribute('aria-controls');
  if (!panelId) throw new Error('The Inputs tab did not expose its panel.');
  const panel = inspector.locator(`#${panelId}`);
  await tab.click();
  await panel.waitFor();
  return panel;
}

async function chooseWorkflow(page: Page, workflow: string, entryKey: string): Promise<Locator> {
  const inspector = page.locator('#parameter-inspector');
  await selectRadioValue(inspector, workflow);
  await selectRadioValue(inspector, entryKey);
  return showInputs(inspector);
}

async function uploadImage(inputs: Locator, name: string): Promise<void> {
  await inputs
    .getByLabel('Add local file')
    .first()
    .setInputFiles({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(await Bun.file('tests/fixtures/media/tiny.png').arrayBuffer())
    });
  await inputs.getByText('Local transfer and Poyo upload completed.', { exact: true }).waitFor();
}

async function uploadVideo(inputs: Locator, name: string): Promise<void> {
  await inputs.locator('input[type="file"][accept^="video/"]').setInputFiles({
    name,
    mimeType: 'video/mp4',
    buffer: Buffer.from(await Bun.file('tests/fixtures/media/tiny.mp4').arrayBuffer())
  });
  await inputs.getByText('Local transfer and Poyo upload completed.', { exact: true }).waitFor();
}

test('partial capability stays configurable and is represented once for a mixed workflow', async () => {
  const harness = await startBrowserAppHarness({
    freshOnboarding: true,
    mediaToolShims: { ...readyTools, ffmpeg: 'outdated' }
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });

  try {
    await page.goto(harness.url);
    await page.waitForURL((url) => url.pathname === '/welcome');
    await page.getByRole('button', { name: 'Get started' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Protect local media metadata' }).waitFor();

    await page.getByText('Media cleanup partially available', { exact: true }).waitFor();
    await page.getByText('Image · Available', { exact: true }).waitFor();
    await page.getByText('Video · Unavailable', { exact: true }).waitFor();
    const master = page.getByLabel('Sanitize supported local media when available');
    expect(await master.isEnabled()).toBe(true);
    expect(await page.getByLabel('Remove EXIF metadata').isEnabled()).toBe(true);
    await page.getByText('Tool details', { exact: true }).click();
    await page.getByText('8.0.2 found · 8.1+ needed', { exact: true }).waitFor();
    await page.getByText(/Update FFmpeg 8\.0\.2 to 8\.1\+/).waitFor();
    expect(await page.getByRole('button', { name: 'Save and continue' }).isEnabled()).toBe(true);
  } finally {
    await browser.close();
    await harness.cleanup();
  }

  const studioHarness = await startBrowserAppHarness({
    mediaToolShims: { ...readyTools, ffmpeg: 'outdated' }
  });
  const studioBrowser = await chromium.launch({ headless: true });
  const studioPage = await studioBrowser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await studioPage.goto(`${studioHarness.url}/settings#media-privacy`);
    await studioPage.getByText('Media cleanup partially available', { exact: true }).waitFor();
    expect(
      await studioPage.getByLabel('Sanitize supported local media when available').isEnabled()
    ).toBe(true);

    await studioPage.goto(`${studioHarness.url}/studio/video`);
    const inputs = await chooseWorkflow(
      studioPage,
      'motion-control',
      'kling-2.6-motion-control:motion-control'
    );
    const status = inputs.getByLabel('Media cleanup status');
    expect(await status.count()).toBe(1);
    const text = await status.innerText();
    expect(text).toContain('Image cleanup · Ready');
    expect(text).toContain(
      'Video cleanup · Optional tools unavailable — upload continues without cleanup'
    );
  } finally {
    await studioBrowser.close();
    await studioHarness.cleanup();
  }
});

test('no tools keep Settings discoverable and image/video uploads enabled with compact receipts', async () => {
  const harness = await startBrowserAppHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    const health = await page.request.get(`${harness.url}/api/health`);
    expect(health.status()).toBe(200);
    expect((await health.json()).status).toBe('ok');

    await page.goto(`${harness.url}/settings#media-privacy`);
    await page.getByText('Optional media cleanup unavailable', { exact: true }).waitFor();
    await page.getByText(/Local uploads still work without cleanup/).waitFor();
    expect(await page.getByText('Image · Unavailable', { exact: true }).count()).toBe(1);
    expect(await page.getByText('Video · Unavailable', { exact: true }).count()).toBe(1);
    for (const label of [
      'Sanitize supported local media when available',
      'Remove EXIF metadata',
      'Remove IPTC metadata',
      'Remove XMP metadata',
      'Remove Photoshop/8BIM metadata',
      'Remove color profile'
    ]) {
      expect(await page.getByLabel(label).isDisabled()).toBe(true);
    }

    await page.goto(`${harness.url}/studio/image`);
    const imageInputs = await chooseWorkflow(page, 'image-edit', 'gpt-4o-image-edit:image-edit');
    const imageStatus = imageInputs.getByLabel('Media cleanup status');
    expect(await imageStatus.count()).toBe(1);
    expect(await imageStatus.innerText()).toContain(
      'Image cleanup · Optional tools unavailable — upload continues without cleanup'
    );
    const imageFile = imageInputs.getByLabel('Add local file').first();
    expect(await imageFile.isEnabled()).toBe(true);
    const bytes = await Bun.file('tests/fixtures/media/tiny.png').arrayBuffer();
    await imageFile.setInputFiles([
      { name: 'first-private-image.png', mimeType: 'image/png', buffer: Buffer.from(bytes) },
      { name: 'second-private-image.png', mimeType: 'image/png', buffer: Buffer.from(bytes) }
    ]);
    await imageInputs
      .getByText('Local transfer and Poyo upload completed.', { exact: true })
      .waitFor();
    await waitUntil(
      async () =>
        (await imageInputs
          .getByText('Not cleaned · Optional tools unavailable', { exact: true })
          .count()) === 2,
      'Each image did not retain one compact unavailable-tools receipt.'
    );

    await page.goto(`${harness.url}/studio/video`);
    const videoInputs = await chooseWorkflow(page, 'video-edit', 'happy-horse:video-edit');
    expect(await videoInputs.getByLabel('Add local file').first().isEnabled()).toBe(true);
    await uploadVideo(videoInputs, 'private-video.mp4');
    await videoInputs
      .getByText('Not cleaned · Optional tools unavailable', { exact: true })
      .waitFor();
    expect(
      harness.mock.requests.filter((request) => request.pathname === '/api/common/upload/stream')
    ).toHaveLength(3);
  } finally {
    await browser.close();
    await harness.cleanup();
  }
});

test('all-ready hermetic tools exercise applied image/video receipts without trivial details', async () => {
  const harness = await startBrowserAppHarness({ mediaToolShims: readyTools });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(`${harness.url}/studio/image`);
    const imageInputs = await chooseWorkflow(page, 'image-edit', 'flux-dev:image-edit');
    expect(await imageInputs.getByLabel('Media cleanup status').innerText()).toContain(
      'Image cleanup · Ready'
    );
    await uploadImage(imageInputs, 'clean-image.png');
    await imageInputs.getByText('Checked · No selected metadata found', { exact: true }).waitFor();
    const imageRow = imageInputs
      .getByText('clean-image.png', { exact: true })
      .locator('..')
      .locator('..');
    expect(await imageRow.locator('details').count()).toBe(0);
    expect(await imageRow.getByText(/orientation was not changed/i).count()).toBe(0);

    await page.goto(`${harness.url}/studio/video`);
    const videoInputs = await chooseWorkflow(page, 'video-edit', 'happy-horse:video-edit');
    await uploadVideo(videoInputs, 'clean-video.mp4');
    await videoInputs.getByText('Cleaned · 1 category removed', { exact: true }).waitFor();
    await videoInputs.getByText('Details', { exact: true }).last().click();
    await videoInputs.getByText('Removed: Container tags.', { exact: true }).waitFor();
  } finally {
    await browser.close();
    await harness.cleanup();
  }
});

test('preference off uses a distinct backend receipt even when tools are ready', async () => {
  const harness = await startBrowserAppHarness({ mediaToolShims: readyTools });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(`${harness.url}/settings#media-privacy`);
    await page.getByLabel('Sanitize supported local media when available').uncheck();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText('Settings saved.', { exact: true }).waitFor();

    await page.goto(`${harness.url}/studio/image`);
    const inputs = await chooseWorkflow(page, 'image-edit', 'flux-dev:image-edit');
    expect(await inputs.getByLabel('Media cleanup status').innerText()).toContain(
      'Media cleanup · Off'
    );
    await uploadImage(inputs, 'cleanup-off.png');
    await inputs.getByText('Not cleaned · Cleanup off', { exact: true }).waitFor();
  } finally {
    await browser.close();
    await harness.cleanup();
  }
});

test('fresh server readiness overrides a stale ready page and falls back before cleanup starts', async () => {
  const harness = await startBrowserAppHarness({ mediaToolShims: readyTools });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(`${harness.url}/studio/image`);
    const inputs = await chooseWorkflow(page, 'image-edit', 'flux-dev:image-edit');
    expect(await inputs.getByLabel('Media cleanup status').innerText()).toContain(
      'Image cleanup · Ready'
    );
    await harness.mediaTools.setTool('exiftool', 'outdated');
    const uploadsBefore = harness.mock.requests.filter(
      (request) => request.pathname === '/api/common/upload/stream'
    ).length;

    await uploadImage(inputs, 'stale-page-raw-fallback.png');
    await inputs.getByText('Not cleaned · Optional tools unavailable', { exact: true }).waitFor();
    expect(
      harness.mock.requests.filter((request) => request.pathname === '/api/common/upload/stream')
    ).toHaveLength(uploadsBefore + 1);
  } finally {
    await browser.close();
    await harness.cleanup();
  }
});

test('a post-selection prerequisite race remains fail-closed and never uploads raw bytes', async () => {
  const harness = await startBrowserAppHarness({ mediaToolShims: readyTools });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(`${harness.url}/studio/image`);
    const inputs = await chooseWorkflow(page, 'image-edit', 'flux-dev:image-edit');
    await harness.mediaTools.setTool('exiftool', 'ready-then-outdated');
    const uploadsBefore = harness.mock.requests.filter(
      (request) => request.pathname === '/api/common/upload/stream'
    ).length;

    await inputs.getByLabel('Add local file').setInputFiles({
      name: 'post-selection-race.png',
      mimeType: 'image/png',
      buffer: Buffer.from(await Bun.file('tests/fixtures/media/tiny.png').arrayBuffer())
    });

    await inputs
      .getByRole('alert')
      .getByText(
        'Optional ExifTool cleanup became unavailable, so this upload stopped safely. Found 13.54; version 13.55 or newer is supported.',
        { exact: true }
      )
      .waitFor();
    expect(await inputs.getByText('post-selection-race.png', { exact: true }).count()).toBe(0);
    expect(
      harness.mock.requests.filter((request) => request.pathname === '/api/common/upload/stream')
    ).toHaveLength(uploadsBefore);
  } finally {
    await browser.close();
    await harness.cleanup();
  }
});

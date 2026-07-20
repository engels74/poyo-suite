import { expect, setDefaultTimeout, test } from 'bun:test';
import { chromium, type Locator, type Page } from 'playwright';
import { startBrowserAppHarness } from '../helpers/browser-app-harness';

setDefaultTimeout(60_000);

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

async function chooseImageEdit(page: Page, entryKey: string): Promise<Locator> {
  const inspector = page.locator('#parameter-inspector');
  await selectRadioValue(inspector, 'image-edit');
  await selectRadioValue(inspector, entryKey);
  return showInputs(inspector);
}

test('partial readiness is actionable during onboarding without blocking continuation', async () => {
  const harness = await startBrowserAppHarness({
    freshOnboarding: true,
    mediaToolShims: {
      exiftool: 'ready',
      imagemagick: 'ready',
      ffmpeg: 'outdated',
      ffprobe: 'ready'
    }
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });

  try {
    await page.goto(harness.url);
    await page.waitForURL((url) => url.pathname === '/welcome');
    await page.getByRole('button', { name: 'Get started' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Protect local media metadata' }).waitFor();

    await page.getByText('Media protection needs setup', { exact: true }).waitFor();
    await page.getByText('Image · Ready', { exact: true }).waitFor();
    await page.getByText('Video · Needs setup', { exact: true }).waitFor();
    await page.getByText('Tool details', { exact: true }).click();
    await page.getByText('8.0.2 found · 8.1+ needed', { exact: true }).waitFor();
    await page.getByText(/FFmpeg 8\.0\.2 is available; 8\.1 or newer is required\./).waitFor();
    expect(await page.getByRole('button', { name: 'Save and continue' }).isEnabled()).toBe(true);
  } finally {
    await browser.close();
    await harness.cleanup();
  }
});

test('missing tools gate protected files, then sanitization-off permits two receipt-bearing uploads', async () => {
  const harness = await startBrowserAppHarness({
    mediaToolShims: {
      exiftool: 'missing',
      imagemagick: 'missing',
      ffmpeg: 'missing',
      ffprobe: 'missing'
    }
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(`${harness.url}/studio/image`);
    let inputs = await chooseImageEdit(page, 'flux-dev:image-edit');
    await inputs.getByText('Some local uploads need setup', { exact: true }).waitFor();
    expect(await inputs.getByLabel('Add local file').isDisabled()).toBe(true);
    expect(await inputs.getByLabel('Reference remote URL').isEnabled()).toBe(true);
    expect(await inputs.getByRole('button', { name: 'Add URL' }).isEnabled()).toBe(true);

    await page.goto(`${harness.url}/settings#media-privacy`);
    const sanitization = page.getByLabel('Sanitize local media before sharing with Poyo');
    await sanitization.uncheck();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText('Settings saved.', { exact: true }).waitFor();

    await page.goto(`${harness.url}/studio/image`);
    inputs = await chooseImageEdit(page, 'gpt-4o-image-edit:image-edit');
    await inputs.getByText('Local media protection is off', { exact: true }).waitFor();
    const localFile = inputs.getByLabel('Add local file').first();
    expect(await localFile.isEnabled()).toBe(true);
    const bytes = await Bun.file('tests/fixtures/media/tiny.png').arrayBuffer();
    await localFile.setInputFiles([
      { name: 'first-private-image.png', mimeType: 'image/png', buffer: Buffer.from(bytes) },
      { name: 'second-private-image.png', mimeType: 'image/png', buffer: Buffer.from(bytes) }
    ]);

    await inputs.getByText('Local transfer and Poyo upload completed.', { exact: true }).waitFor();
    await inputs.getByText('first-private-image.png', { exact: true }).waitFor();
    await inputs.getByText('second-private-image.png', { exact: true }).waitFor();
    await waitUntil(
      async () =>
        (await inputs.getByText('No metadata cleanup applied', { exact: true }).count()) === 2,
      'The two uploaded sources did not retain distinct no-cleanup receipts.'
    );
  } finally {
    await browser.close();
    await harness.cleanup();
  }
});

test('a preserved-only receipt reports verified metadata and unchanged orientation', async () => {
  const harness = await startBrowserAppHarness();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(`${harness.url}/settings#media-privacy`);
    await page.getByLabel('Remove EXIF metadata').uncheck();
    await page.getByLabel('Remove XMP metadata').uncheck();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await page.getByText('Settings saved.', { exact: true }).waitFor();

    const sourcePath = `${harness.temporaryPath}/preserved-metadata.png`;
    await Bun.write(sourcePath, Bun.file('tests/fixtures/media/tiny.png'));
    const metadataWrite = Bun.spawnSync({
      cmd: [
        'exiftool',
        '-overwrite_original',
        '-Orientation#=6',
        '-XMP-dc:Creator=Private Author',
        sourcePath
      ],
      stdout: 'pipe',
      stderr: 'pipe'
    });
    expect(metadataWrite.exitCode).toBe(0);

    await page.goto(`${harness.url}/studio/image`);
    const inputs = await chooseImageEdit(page, 'flux-dev:image-edit');
    await inputs.getByLabel('Add local file').setInputFiles({
      name: 'preserved-metadata.png',
      mimeType: 'image/png',
      buffer: Buffer.from(await Bun.file(sourcePath).arrayBuffer())
    });

    await inputs.getByText('Local transfer and Poyo upload completed.', { exact: true }).waitFor();
    await inputs
      .getByText('Privacy check complete · 2 metadata categories preserved', { exact: true })
      .waitFor();
    await inputs.getByText('What changed', { exact: true }).click();
    await inputs.getByText('Preserved: EXIF, XMP.', { exact: true }).waitFor();
    await inputs.getByText('Image orientation was not changed.', { exact: true }).waitFor();
  } finally {
    await browser.close();
    await harness.cleanup();
  }
});

test('upload enforcement re-probes after a ready page load and rejects an outdated tool', async () => {
  const harness = await startBrowserAppHarness({ mediaToolShims: {} });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(`${harness.url}/studio/image`);
    const inputs = await chooseImageEdit(page, 'flux-dev:image-edit');
    await inputs.getByText('Local media protection ready', { exact: true }).waitFor();
    const localFile = inputs.getByLabel('Add local file');
    expect(await localFile.isEnabled()).toBe(true);
    if (!harness.mediaTools) throw new Error('The media-tool shim controller was not created.');
    await harness.mediaTools.setTool('exiftool', 'outdated');
    const poyoUploadsBefore = harness.mock.requests.filter(
      (request) => request.pathname === '/api/common/upload/stream'
    ).length;

    await localFile.setInputFiles({
      name: 'stale-readiness-image.png',
      mimeType: 'image/png',
      buffer: Buffer.from(await Bun.file('tests/fixtures/media/tiny.png').arrayBuffer())
    });

    await inputs
      .getByRole('alert')
      .getByText('ExifTool 13.54 is below the required version 13.55.', { exact: true })
      .waitFor();
    expect(await inputs.getByText('stale-readiness-image.png', { exact: true }).count()).toBe(0);
    expect(
      harness.mock.requests.filter((request) => request.pathname === '/api/common/upload/stream')
    ).toHaveLength(poyoUploadsBefore);
  } finally {
    await browser.close();
    await harness.cleanup();
  }
});

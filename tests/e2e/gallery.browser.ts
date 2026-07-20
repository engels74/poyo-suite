import { Database } from 'bun:sqlite';
import { expect, setDefaultTimeout, test } from 'bun:test';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Locator } from 'playwright';
import { JobRepository } from '../../src/lib/server/jobs/repository';
import { LibraryRepository } from '../../src/lib/server/library/repository';
import { resolveAppPaths } from '../../src/lib/server/platform/app-paths';
import {
  pageHasNoHorizontalOverflow,
  seriousAccessibilityViolations,
  trackBrowserIssues
} from '../helpers/browser-assertions';
import { type BrowserAppHarness, startBrowserAppHarness } from '../helpers/browser-app-harness';

setDefaultTimeout(120_000);

const labels = {
  newest: 'Gallery Newest Image',
  video: 'Gallery Middle Video',
  long: `Gallery Long Image ${'with extended metadata '.repeat(5).trim()}`,
  unavailable: 'Gallery Unavailable Output'
} as const;

interface SeededItem {
  jobId: string;
  outputId: string;
  label: string;
}

interface SeededGallery {
  newest: SeededItem;
  video: SeededItem;
  long: SeededItem;
  unavailable: SeededItem;
}

async function seedGallery(harness: BrowserAppHarness): Promise<SeededGallery> {
  await harness.stopApp();
  const paths = resolveAppPaths({
    environment: { PLS_APP_DATA_DIR: harness.appData }
  });
  let now = new Date('2026-07-20T20:04:00.000Z');
  const database = new Database(harness.databasePath, { strict: true });
  const repository = new JobRepository(database, () => now);

  async function seed(options: {
    label: string;
    createdAt: string;
    mediaKind: 'image' | 'video';
    available: boolean;
    fixture: string;
    fileName: string;
    prompt: string;
  }): Promise<SeededItem> {
    now = new Date(options.createdAt);
    const workflow = options.mediaKind === 'video' ? 'text-to-video' : 'text-to-image';
    const job = repository.create({
      actionId: crypto.randomUUID(),
      workflow,
      publicModelId: options.label,
      prompt: options.prompt,
      guidedRequest: { prompt: options.prompt, aspectRatio: '1:1' },
      normalizedPayload: {
        model: options.label,
        input: { prompt: options.prompt }
      },
      expectedMediaKind: options.mediaKind,
      expectedOutputCount: 1
    });
    const bytes = await Bun.file(options.fixture).bytes();
    repository.applyStatus(
      job.id,
      {
        taskId: `task-${job.id}`,
        statusRaw: 'finished',
        status: 'finished',
        creditsAmount: 1,
        files: [
          {
            url: `https://cdn.poyo.test/${options.fileName}`,
            fileType: options.mediaKind,
            label: null,
            format: options.mediaKind === 'video' ? 'mp4' : 'png',
            contentType: options.mediaKind === 'video' ? 'video/mp4' : 'image/png',
            fileName: options.fileName,
            fileSize: bytes.byteLength
          }
        ],
        createdTime: options.createdAt,
        progress: 100,
        errorMessage: null
      },
      1_000
    );
    const output = repository.outputs(job.id)[0];
    if (!output) throw new Error(`Missing seeded output for ${options.label}.`);
    if (options.available) {
      const outputDirectory = join(paths.media, job.id);
      const localPath = join(outputDirectory, options.fileName);
      await mkdir(outputDirectory, { recursive: true });
      await cp(options.fixture, localPath);
      const attempt = repository.startDownload(output.id);
      const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
      const signature = Array.from(bytes.slice(0, 12), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('');
      repository.verifyDownload(output.id, attempt, {
        path: localPath,
        size: bytes.byteLength,
        checksum,
        signature,
        contentType: options.mediaKind === 'video' ? 'video/mp4' : 'image/png',
        pixelWidth: options.mediaKind === 'image' ? 1 : 16,
        pixelHeight: options.mediaKind === 'image' ? 1 : 16,
        aspectRatio: '1:1'
      });
      repository.finishIfDownloaded(job.id);
    } else {
      const attempt = repository.startDownload(output.id);
      repository.failDownload(output.id, attempt, { code: 'fixture_unavailable' });
    }

    return { jobId: job.id, outputId: output.id, label: options.label };
  }

  try {
    const newest = await seed({
      label: labels.newest,
      createdAt: '2026-07-20T20:04:00.000Z',
      mediaKind: 'image',
      available: true,
      fixture: 'tests/fixtures/media/tiny.png',
      fileName: 'gallery-newest.png',
      prompt: 'A precise cobalt image for the first Gallery position.'
    });
    const video = await seed({
      label: labels.video,
      createdAt: '2026-07-20T20:03:00.000Z',
      mediaKind: 'video',
      available: true,
      fixture: 'tests/fixtures/media/tiny.mp4',
      fileName: 'gallery-middle.mp4',
      prompt: 'A controlled local video between two images.'
    });
    const long = await seed({
      label: labels.long,
      createdAt: '2026-07-20T20:02:00.000Z',
      mediaKind: 'image',
      available: true,
      fixture: 'tests/fixtures/media/tiny.png',
      fileName: 'gallery-long-metadata.png',
      prompt: `Long Gallery prompt ${'that checks wrapping without exposing private state '.repeat(10)}`
    });
    const unavailable = await seed({
      label: labels.unavailable,
      createdAt: '2026-07-20T20:01:00.000Z',
      mediaKind: 'image',
      available: false,
      fixture: 'tests/fixtures/media/tiny.png',
      fileName: 'gallery-unavailable.png',
      prompt: 'An unavailable output remains a canonical job fallback.'
    });
    new LibraryRepository(database).replaceTags(newest.jobId, ['ISTANBUL']);
    return { newest, video, long, unavailable };
  } finally {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;');
    database.close();
  }
}

async function activeElementIsWithin(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.contains(document.activeElement));
}

async function expectSelection(
  dialog: Locator,
  options: { label: string; position: string; mediaKind: 'image' | 'video'; stage?: string }
): Promise<void> {
  const heading = dialog.getByRole('heading');
  await heading.waitFor();
  const currentLabel = await heading.textContent();
  if (currentLabel !== options.label) {
    const viewport = await dialog.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
    throw new Error(
      `Expected viewer title ${options.label}; found ${currentLabel ?? 'none'} at ${viewport} (${options.stage ?? 'unspecified stage'}).`
    );
  }
  await dialog.getByText(options.position, { exact: false }).first().waitFor();
  const mediaSelector = options.mediaKind === 'image' ? 'img' : 'video';
  const mediaCount = await dialog.locator(mediaSelector).count();
  if (mediaCount !== 1) {
    throw new Error(
      `Expected one ${options.mediaKind} for ${options.label}; viewer media was ${await dialog.locator('img, video').evaluateAll((elements) => elements.map((element) => element.tagName).join(',') || 'empty')}.`
    );
  }
  expect(await dialog.locator(options.mediaKind === 'image' ? 'video' : 'img').count()).toBe(0);
}

test('Gallery viewer preserves context across mixed media, focus, actions and responsive states', async () => {
  const harness = await startBrowserAppHarness();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context:
    | Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>>
    | undefined;

  try {
    const seeded = await seedGallery(harness);
    await harness.startApp();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const issues = trackBrowserIssues(page);
    const failedRequests: string[] = [];
    page.on('requestfailed', (request) => {
      failedRequests.push(
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`
      );
    });

    await page.goto(`${harness.url}/gallery`);
    await page.getByRole('heading', { name: 'Gallery', level: 1 }).waitFor();
    await page.getByRole('heading', { name: 'Generation gallery' }).waitFor();
    expect(await page.title()).toContain('Gallery · Poyo Local Studio');
    expect(await page.getByRole('link', { name: 'Gallery', exact: true }).count()).toBeGreaterThan(
      0
    );
    expect(await page.getByText('Library', { exact: true }).count()).toBe(0);

    const articles = page.locator('article');
    expect(await articles.count()).toBe(4);
    const articleText = await articles.allTextContents();
    expect(articleText[0]).toContain(labels.newest);
    expect(articleText[1]).toContain(labels.video);
    expect(articleText[2]).toContain('Gallery Long Image');
    expect(articleText[3]).toContain(labels.unavailable);

    const tagChip = page.getByRole('link', { name: 'ISTANBUL', exact: true });
    const tagHref = await tagChip.getAttribute('href');
    if (!tagHref) throw new Error('Expected the seeded gallery tag link.');
    expect(new URL(tagHref, harness.url).searchParams.get('tag')).toBe('ISTANBUL');

    await Promise.all([
      page.waitForURL((url) => url.searchParams.get('tag') === 'ISTANBUL'),
      tagChip.click()
    ]);
    await page.waitForFunction(() => document.querySelectorAll('article').length === 1);
    expect(await articles.count()).toBe(1);
    expect((await articles.first().textContent()) ?? '').toContain(labels.newest);

    const activeTagHref = await tagChip.getAttribute('href');
    if (!activeTagHref) throw new Error('Expected the active gallery tag link.');
    expect(new URL(activeTagHref, harness.url).searchParams.has('tag')).toBe(false);
    await Promise.all([page.waitForURL((url) => !url.searchParams.has('tag')), tagChip.click()]);
    await page.waitForFunction(() => document.querySelectorAll('article').length === 4);
    expect(await articles.count()).toBe(4);

    expect(
      await articles
        .filter({ hasText: labels.newest })
        .getByRole('button', { name: `View image ${labels.newest}`, exact: true })
        .count()
    ).toBe(2);
    expect(
      await articles
        .filter({ hasText: labels.video })
        .getByRole('button', { name: `View video ${labels.video}`, exact: true })
        .count()
    ).toBe(2);
    expect(
      await articles
        .filter({ hasText: labels.long })
        .getByRole('button', { name: `View image ${labels.long}`, exact: true })
        .count()
    ).toBe(2);
    expect(await page.getByRole('link', { name: 'Grid view' }).getAttribute('aria-current')).toBe(
      'page'
    );
    expect(await page.getByRole('link', { name: 'Favorites' }).count()).toBe(1);
    expect(await page.getByLabel('Media kind').count()).toBe(1);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);

    const newestArticle = articles.filter({ hasText: labels.newest });
    const videoArticle = articles.filter({ hasText: labels.video });
    const longArticle = articles.filter({ hasText: labels.long });
    const unavailableArticle = articles.filter({ hasText: labels.unavailable });
    expect(await newestArticle.getByText('Image', { exact: true }).count()).toBe(1);
    expect(await videoArticle.getByText('Video', { exact: true }).count()).toBe(1);
    expect(await longArticle.getByText('Image', { exact: true }).count()).toBe(1);
    expect(await unavailableArticle.getByText('Image', { exact: true }).count()).toBe(1);
    expect(await newestArticle.locator('img').getAttribute('loading')).toBe('lazy');
    const overviewVideo = videoArticle.locator('video');
    expect(await overviewVideo.getAttribute('preload')).toBe('none');
    expect(await overviewVideo.evaluate((video: HTMLVideoElement) => video.controls)).toBe(false);

    await page.evaluate((favoritePath) => {
      const originalFetch = window.fetch;
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const requestUrl = input instanceof Request ? input.url : input.toString();
        if (new URL(requestUrl, window.location.href).pathname === favoritePath) {
          window.fetch = originalFetch;
          return new Response(null, { status: 503 });
        }
        return originalFetch(input, init);
      }) as typeof window.fetch;
    }, `/api/library/${seeded.newest.jobId}/favorite`);
    const favoriteButton = newestArticle.getByRole('button', { name: 'Add to favorites' });
    await favoriteButton.click();
    await page.getByRole('status').filter({ hasText: 'Favorite update failed.' }).waitFor();
    expect(await favoriteButton.isEnabled()).toBe(true);
    expect(await favoriteButton.getAttribute('aria-pressed')).toBe('false');
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);

    const originalTrigger = newestArticle
      .getByRole('button', { name: `View image ${labels.newest}`, exact: true })
      .first();
    await originalTrigger.focus();
    await page.keyboard.press('Enter');
    expect(new URL(page.url()).pathname).toBe('/gallery');
    await page.getByRole('dialog', { name: labels.newest }).waitFor();
    const dialog = page.getByRole('dialog');
    expect(await dialog.getAttribute('aria-modal')).toBe('true');
    await page.waitForFunction(() =>
      document.querySelector('[role="dialog"]')?.contains(document.activeElement)
    );
    expect(await activeElementIsWithin(dialog)).toBe(true);
    expect(await dialog.locator('img').getAttribute('class')).toContain('object-contain');
    await expectSelection(dialog, { label: labels.newest, position: '1 of 3', mediaKind: 'image' });
    const liveStatus = dialog.getByRole('status');
    expect(await liveStatus.getAttribute('aria-live')).toBe('polite');
    expect((await liveStatus.textContent())?.trim()).toBe(`image, item 1 of 3: ${labels.newest}`);
    const creationTime = dialog.getByTestId('gallery-viewer-footer').locator('time');
    expect(await creationTime.getAttribute('datetime')).toBe('2026-07-20T20:04:00.000Z');
    expect((await creationTime.textContent())?.trim()).toBe('20 Jul 2026, 20:04');
    expect(await seriousAccessibilityViolations(page)).toEqual([]);

    for (let index = 0; index < 12; index += 1) {
      await page.keyboard.press('Tab');
      expect(await activeElementIsWithin(dialog)).toBe(true);
    }

    const previous = dialog.getByRole('button', { name: 'Previous item' });
    const next = dialog.getByRole('button', { name: 'Next item' });
    expect(await previous.isDisabled()).toBe(true);
    expect(await next.isEnabled()).toBe(true);
    await next.click();
    await expectSelection(dialog, {
      label: labels.video,
      position: '2 of 3',
      mediaKind: 'video',
      stage: 'next button'
    });
    expect((await liveStatus.textContent())?.trim()).toBe(`video, item 2 of 3: ${labels.video}`);
    expect(await creationTime.getAttribute('datetime')).toBe('2026-07-20T20:03:00.000Z');
    expect((await creationTime.textContent())?.trim()).toBe('20 Jul 2026, 20:03');
    const video = dialog.locator('video');
    expect(await video.evaluate((element: HTMLVideoElement) => element.controls)).toBe(true);
    expect(await video.getAttribute('playsinline')).not.toBeNull();
    expect(await video.getAttribute('preload')).toBe('metadata');
    expect(await video.evaluate((element: HTMLVideoElement) => element.autoplay)).toBe(false);
    expect(
      await video.evaluate((element) => {
        const event = new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
          cancelable: true
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      })
    ).toBe(false);
    await next.click();
    await expectSelection(dialog, { label: labels.long, position: '3 of 3', mediaKind: 'image' });
    expect(await next.isDisabled()).toBe(true);
    const lastJobHref = await dialog.getByRole('link', { name: 'Open job' }).getAttribute('href');
    await next.evaluate((button: HTMLButtonElement) => button.click());
    expect(await dialog.getByRole('link', { name: 'Open job' }).getAttribute('href')).toBe(
      lastJobHref
    );
    await previous.click();
    await previous.click();
    await expectSelection(dialog, { label: labels.newest, position: '1 of 3', mediaKind: 'image' });

    const modifiedArrowTarget = dialog.getByRole('button', { name: 'Close' });
    expect(
      await modifiedArrowTarget.evaluate((button) => {
        const event = new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        });
        button.dispatchEvent(event);
        return event.defaultPrevented;
      })
    ).toBe(false);
    await expectSelection(dialog, { label: labels.newest, position: '1 of 3', mediaKind: 'image' });
    await next.click();
    expect(
      await modifiedArrowTarget.evaluate((button) => {
        const event = new KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          altKey: true,
          bubbles: true,
          cancelable: true
        });
        button.dispatchEvent(event);
        return event.defaultPrevented;
      })
    ).toBe(false);
    await expectSelection(dialog, { label: labels.video, position: '2 of 3', mediaKind: 'video' });
    await previous.click();

    await page.keyboard.press('ArrowRight');
    await expectSelection(dialog, {
      label: labels.video,
      position: '2 of 3',
      mediaKind: 'video',
      stage: 'arrow navigation'
    });
    await page.keyboard.press('ArrowRight');
    await expectSelection(dialog, { label: labels.long, position: '3 of 3', mediaKind: 'image' });
    await page.keyboard.press('ArrowRight');
    await expectSelection(dialog, { label: labels.long, position: '3 of 3', mediaKind: 'image' });
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expectSelection(dialog, { label: labels.newest, position: '1 of 3', mediaKind: 'image' });
    const close = dialog.getByRole('button', { name: 'Close' });
    await close.focus();
    await page.keyboard.press('ArrowRight');
    await expectSelection(dialog, {
      label: labels.video,
      position: '2 of 3',
      mediaKind: 'video',
      stage: 'close-control arrow navigation'
    });
    const openJob = dialog.getByRole('link', { name: 'Open job' });
    await openJob.focus();
    await page.keyboard.press('ArrowRight');
    await expectSelection(dialog, { label: labels.long, position: '3 of 3', mediaKind: 'image' });

    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    expect(await originalTrigger.evaluate((element) => document.activeElement === element)).toBe(
      true
    );
    await originalTrigger.click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Close' }).click();
    expect(await originalTrigger.evaluate((element) => document.activeElement === element)).toBe(
      true
    );

    await page.getByRole('link', { name: 'List view' }).click();
    await page.waitForURL((url) => url.searchParams.get('view') === 'list');
    const listTrigger = page
      .locator('article')
      .filter({ hasText: labels.newest })
      .getByRole('button', { name: `View image ${labels.newest}`, exact: true })
      .first();
    expect(
      await page
        .locator('article')
        .filter({ hasText: labels.newest })
        .getByRole('button', { name: `View image ${labels.newest}`, exact: true })
        .count()
    ).toBe(3);
    await listTrigger.click();
    await page.keyboard.press('Escape');
    expect(await listTrigger.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.getByRole('link', { name: 'Grid view' }).click();
    await page.waitForURL((url) => url.searchParams.get('view') === 'grid');

    const middleTrigger = page
      .locator('article')
      .filter({ hasText: labels.video })
      .getByRole('button', { name: `View video ${labels.video}`, exact: true })
      .first();
    await middleTrigger.click();
    await expectSelection(dialog, {
      label: labels.video,
      position: '2 of 3',
      mediaKind: 'video',
      stage: 'direct desktop trigger'
    });
    expect(await dialog.getByRole('link', { name: 'Open job' }).getAttribute('href')).toBe(
      `/jobs/${seeded.video.jobId}`
    );
    const fullSize = dialog.getByRole('link', { name: 'Open full size' });
    expect(await fullSize.getAttribute('href')).toBe(`/api/media/${seeded.video.outputId}`);
    expect(await fullSize.getAttribute('target')).toBe('_blank');
    expect(await fullSize.getAttribute('rel')).toContain('noreferrer');
    const download = dialog.getByRole('link', { name: 'Download' });
    expect(await download.getAttribute('href')).toBe(
      `/api/media/${seeded.video.outputId}/download`
    );
    expect(await download.getAttribute('download')).not.toBeNull();
    expect(await download.getAttribute('data-sveltekit-reload')).not.toBeNull();

    await previous.click();
    const newestFullSize = dialog.getByRole('link', { name: 'Open full size' });
    const popupPromise = page.waitForEvent('popup');
    await newestFullSize.click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    expect(new URL(popup.url()).pathname).toBe(`/api/media/${seeded.newest.outputId}`);
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    expect(new URL(page.url()).pathname).toBe('/gallery');
    await popup.close();

    const downloadResult = await page.evaluate(async (href) => {
      const response = await fetch(href);
      await response.arrayBuffer();
      return {
        status: response.status,
        disposition: response.headers.get('content-disposition'),
        cache: response.headers.get('cache-control'),
        resourcePolicy: response.headers.get('cross-origin-resource-policy')
      };
    }, `/api/media/${seeded.newest.outputId}/download`);
    expect(downloadResult.status).toBe(200);
    expect(downloadResult.disposition).toContain('attachment');
    expect(downloadResult.disposition).toContain('gallery-newest.png');
    expect(downloadResult.cache).toBe('private, no-store');
    expect(downloadResult.resourcePolicy).toBe('same-origin');
    const renderedHtml = await page.content();
    expect(renderedHtml).not.toContain(harness.appData);
    expect(renderedHtml).not.toContain(harness.syntheticKey);
    await page.keyboard.press('Escape');

    const legacyOverview = await fetch(`${harness.url}/library?view=list&q=cobalt`, {
      redirect: 'manual'
    });
    expect(legacyOverview.status).toBe(308);
    expect(legacyOverview.headers.get('location')).toBe('/gallery?view=list&q=cobalt');
    await page.goto(`${harness.url}/library?view=list&q=cobalt`);
    expect(new URL(page.url()).pathname).toBe('/gallery');
    expect(new URL(page.url()).searchParams.get('view')).toBe('list');
    expect(new URL(page.url()).searchParams.get('q')).toBe('cobalt');
    const legacyDetail = await fetch(`${harness.url}/library/${seeded.video.jobId}`, {
      redirect: 'manual'
    });
    expect(legacyDetail.status).toBe(308);
    expect(legacyDetail.headers.get('location')).toBe(`/jobs/${seeded.video.jobId}`);
    await page.goto(`${harness.url}/library/${seeded.video.jobId}`);
    expect(new URL(page.url()).pathname).toBe(`/jobs/${seeded.video.jobId}`);
    await page.getByRole('heading', { name: labels.video, level: 1 }).waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${harness.url}/gallery`);
    await page
      .locator('article')
      .filter({ hasText: labels.newest })
      .getByRole('button', { name: `View image ${labels.newest}`, exact: true })
      .first()
      .click();
    await expectSelection(dialog, { label: labels.newest, position: '1 of 3', mediaKind: 'image' });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    const mobileVideoTrigger = page
      .locator('article')
      .filter({ hasText: labels.video })
      .getByRole('button', { name: `View video ${labels.video}`, exact: true })
      .first();
    expect(await mobileVideoTrigger.getAttribute('data-output-id')).toBe(seeded.video.outputId);
    await mobileVideoTrigger.click();
    const mobilePrevious = dialog.getByRole('button', { name: 'Previous item' });
    const mobileNext = dialog.getByRole('button', { name: 'Next item' });
    await expectSelection(dialog, {
      label: labels.video,
      position: '2 of 3',
      mediaKind: 'video',
      stage: 'direct mobile trigger'
    });
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect(dialogBox?.y ?? -1).toBeGreaterThanOrEqual(0);
    expect((dialogBox?.width ?? 391) <= 390).toBe(true);
    expect((dialogBox?.height ?? 845) <= 844).toBe(true);
    for (const control of [
      mobilePrevious,
      mobileNext,
      dialog.getByRole('button', { name: 'Close' })
    ]) {
      const box = await control.boundingBox();
      expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(36);
    }
    for (const actionName of ['Open job', 'Open full size', 'Download']) {
      await dialog.getByRole('link', { name: actionName }).scrollIntoViewIfNeeded();
      expect(await dialog.getByRole('link', { name: actionName }).isVisible()).toBe(true);
    }
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
    await page.keyboard.press('ArrowRight');
    await expectSelection(dialog, { label: labels.long, position: '3 of 3', mediaKind: 'image' });
    expect(await dialog.evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(
      true
    );
    const headerBox = await dialog.locator('header').boundingBox();
    const stageBox = await dialog.getByTestId('gallery-viewer-stage').boundingBox();
    const footerBox = await dialog.getByTestId('gallery-viewer-footer').boundingBox();
    expect((headerBox?.y ?? 0) + (headerBox?.height ?? 0) <= (stageBox?.y ?? 0) + 1).toBe(true);
    expect((stageBox?.y ?? 0) + (stageBox?.height ?? 0) <= (footerBox?.y ?? 0) + 1).toBe(true);
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 1440, height: 900 });
    const themeToggle = page.locator('button[data-theme-preference="light"]').first();
    await themeToggle.click();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    await page
      .locator('article')
      .filter({ hasText: 'Gallery Long Image' })
      .getByRole('button', { name: /^View image Gallery Long Image/ })
      .first()
      .click();
    await expectSelection(dialog, { label: labels.long, position: '3 of 3', mediaKind: 'image' });
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
    expect(await dialog.getByRole('button', { name: 'Close' }).isVisible()).toBe(true);
    await page.keyboard.press('Escape');

    const fallbackFocusTarget = page.getByRole('link', { name: 'Grid view' });
    const disconnectedTrigger = page
      .locator('article')
      .filter({ hasText: labels.newest })
      .getByRole('button', { name: `View image ${labels.newest}`, exact: true })
      .first();
    await fallbackFocusTarget.focus();
    await disconnectedTrigger.evaluate((element: HTMLButtonElement) => element.click());
    await dialog.waitFor();
    await page.waitForFunction(() =>
      document.querySelector('[role="dialog"]')?.contains(document.activeElement)
    );
    await disconnectedTrigger.evaluate((element) => element.remove());
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    expect(
      await fallbackFocusTarget.evaluate((element) => document.activeElement === element)
    ).toBe(true);

    expect(await unavailableArticle.locator('button[aria-label^="View "]').count()).toBe(0);
    expect(
      await unavailableArticle.getByRole('link', { name: 'Open job' }).getAttribute('href')
    ).toBe(`/jobs/${seeded.unavailable.jobId}`);
    await page.goto(`${harness.url}/gallery?q=no-such-gallery-result`);
    await page.getByRole('heading', { name: 'No matching generations' }).waitFor();
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);

    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  } finally {
    await context?.close();
    await browser?.close();
    await harness.cleanup();
  }
});

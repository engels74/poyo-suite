import { Database } from 'bun:sqlite';
import { expect, setDefaultTimeout, test } from 'bun:test';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright';
import { JobRepository } from '../../src/lib/server/jobs/repository';
import { LibraryRepository } from '../../src/lib/server/library/repository';
import { resolveAppPaths } from '../../src/lib/server/platform/app-paths';
import { type BrowserAppHarness, startBrowserAppHarness } from '../helpers/browser-app-harness';
import {
  pageHasNoHorizontalOverflow,
  seriousAccessibilityViolations,
  trackBrowserIssues
} from '../helpers/browser-assertions';

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
    pixelWidth?: number;
    pixelHeight?: number;
    aspectRatio?: string;
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
        pixelWidth: options.pixelWidth ?? (options.mediaKind === 'image' ? 1 : 16),
        pixelHeight: options.pixelHeight ?? (options.mediaKind === 'image' ? 1 : 16),
        aspectRatio: options.aspectRatio ?? '1:1'
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
      fixture: 'tests/fixtures/media/gallery-landscape.png',
      fileName: 'gallery-newest.png',
      pixelWidth: 640,
      pixelHeight: 360,
      aspectRatio: '16:9',
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
      fixture: 'tests/fixtures/media/gallery-portrait.png',
      fileName: 'gallery-long-metadata.png',
      pixelWidth: 240,
      pixelHeight: 360,
      aspectRatio: '2:3',
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
async function viewerTransform(image: Locator): Promise<{ zoom: number; x: number; y: number }> {
  return image.evaluate((element) => {
    const style = element.getAttribute('style') ?? '';
    const match = style.match(
      /translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*0px\) scale\(([-\d.]+)\)/
    );
    if (!match) throw new Error(`Expected viewer transform style, found ${style || 'none'}.`);
    return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
  });
}
async function openGalleryOutput(
  page: Page,
  label: string,
  mediaKind: 'image' | 'video'
): Promise<Locator> {
  await page
    .locator('article')
    .filter({ hasText: label })
    .getByRole('button', { name: `View ${mediaKind} ${label}`, exact: true })
    .first()
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  return dialog;
}

async function collapseAndRestoreViewport(
  viewport: Locator
): Promise<{ height: number; loadingFlashed: boolean }> {
  const originalHeight = await viewport.evaluate(
    (element) => element.getBoundingClientRect().height
  );
  const restoredHeight = Math.max(64, Math.floor(originalHeight * 0.63));
  if (Math.abs(restoredHeight - originalHeight) < 1)
    throw new Error('Expected a deliberately different restored viewport height.');

  await viewport.evaluate(() => {
    const state = { flashed: false };
    const observer = new MutationObserver(() => {
      if (document.querySelector('[data-testid="gallery-viewer-loading"]')) state.flashed = true;
    });
    observer.observe(document.body, { childList: true, subtree: true });
    (
      window as Window & {
        __galleryLoadingFlashObserver?: { observer: MutationObserver; state: typeof state };
      }
    ).__galleryLoadingFlashObserver = { observer, state };
  });
  await viewport.evaluate((element) => {
    element.style.height = '0px';
  });
  await viewport
    .page()
    .waitForFunction(
      () =>
        document
          .querySelector('[data-testid="gallery-viewer-viewport"]')
          ?.getAttribute('data-layout-pending') === 'true'
    );
  await viewport.evaluate((element, height) => {
    element.style.height = `${height}px`;
  }, restoredHeight);
  await viewport.page().waitForFunction((height) => {
    const element = document.querySelector<HTMLElement>('[data-testid="gallery-viewer-viewport"]');
    return (
      element !== null &&
      Math.abs(element.getBoundingClientRect().height - height) <= 1 &&
      element.getAttribute('data-layout-pending') === 'false'
    );
  }, restoredHeight);
  const loadingFlashed = await viewport.evaluate(() => {
    const observer = (
      window as Window & {
        __galleryLoadingFlashObserver?: {
          observer: MutationObserver;
          state: { flashed: boolean };
        };
      }
    ).__galleryLoadingFlashObserver;
    observer?.observer.disconnect();
    return observer?.state.flashed ?? false;
  });
  return { height: restoredHeight, loadingFlashed };
}

async function expectContainedGeometry(media: Locator): Promise<void> {
  const geometry = await media.evaluate((element) => {
    const computedStyle = getComputedStyle(element);
    const width = Number.parseFloat(computedStyle.width);
    const height = Number.parseFloat(computedStyle.height);
    const source =
      element instanceof HTMLImageElement
        ? { width: element.naturalWidth, height: element.naturalHeight }
        : element instanceof HTMLVideoElement
          ? { width: element.videoWidth, height: element.videoHeight }
          : null;
    const viewportRect = element.parentElement?.getBoundingClientRect();
    if (!viewportRect) throw new Error('Expected media to be attached to the viewer viewport.');
    return {
      width,
      height,
      source,
      viewportWidth: viewportRect.width,
      viewportHeight: viewportRect.height
    };
  });
  expect(geometry.source).not.toBeNull();
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.width).toBeLessThanOrEqual(geometry.viewportWidth + 1);
  expect(geometry.height).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  expect(
    Math.min(
      Math.abs(geometry.width - geometry.viewportWidth),
      Math.abs(geometry.height - geometry.viewportHeight)
    )
  ).toBeLessThanOrEqual(1);
  expect(geometry.width / geometry.height).toBeCloseTo(
    (geometry.source?.width ?? 0) / (geometry.source?.height ?? 1),
    4
  );
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
test('Library enters onboarding before setup and is unavailable after completion', async () => {
  const freshHarness = await startBrowserAppHarness({ freshOnboarding: true });
  const completedHarness = await startBrowserAppHarness({ completedOnboarding: true });

  try {
    await freshHarness.startApp();
    const beforeOnboarding = await fetch(`${freshHarness.url}/library`, { redirect: 'manual' });
    expect(beforeOnboarding.status).toBe(307);
    expect(beforeOnboarding.headers.get('location')).toBe('/welcome');

    await completedHarness.startApp();
    for (const pathname of ['/library', '/library/test-job']) {
      const response = await fetch(`${completedHarness.url}${pathname}?view=list&q=cobalt`, {
        redirect: 'manual'
      });
      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
    }
  } finally {
    await Promise.all([freshHarness.cleanup(), completedHarness.cleanup()]);
  }
});

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
    const image = dialog.locator('img');
    const viewport = dialog.getByTestId('gallery-viewer-viewport');
    expect(await image.getAttribute('class')).toContain('gallery-viewer-media');
    expect(await image.getAttribute('class')).toContain('gallery-viewer-media-ready');
    expect(await image.getAttribute('class')).not.toContain('object-contain');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
    expect(await image.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
      '0s'
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForFunction(() => !matchMedia('(prefers-reduced-motion: reduce)').matches);
    expect(await image.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
      '0.12s'
    );
    await expectSelection(dialog, { label: labels.newest, position: '1 of 3', mediaKind: 'image' });
    const liveStatus = dialog.getByTestId('gallery-viewer-item-status');
    expect(await liveStatus.getAttribute('aria-live')).toBe('polite');
    expect((await liveStatus.textContent())?.trim()).toBe(`image, item 1 of 3: ${labels.newest}`);
    const creationTime = dialog.getByTestId('gallery-viewer-footer').locator('time');
    expect(await creationTime.getAttribute('datetime')).toBe('2026-07-20T20:04:00.000Z');
    expect((await creationTime.textContent())?.trim()).toBe('20 Jul 2026, 20:04');
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="gallery-viewer-viewport"]')
          ?.getAttribute('data-zoom-mode') === 'fit'
    );
    expect(await viewport.getAttribute('data-media-kind')).toBe('image');
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('fit');
    expect(await viewport.getAttribute('data-zoom-value')).toBe('1');
    const viewportBox = await viewport.boundingBox();
    const imageBox = await image.boundingBox();
    expect(viewportBox).not.toBeNull();
    expect(imageBox).not.toBeNull();
    expect((imageBox?.width ?? Infinity) <= (viewportBox?.width ?? 0) + 1).toBe(true);
    expect((imageBox?.height ?? Infinity) <= (viewportBox?.height ?? 0) + 1).toBe(true);
    expect(
      Math.min(
        Math.abs((imageBox?.width ?? 0) - (viewportBox?.width ?? 0)),
        Math.abs((imageBox?.height ?? 0) - (viewportBox?.height ?? 0))
      )
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        (imageBox?.x ?? 0) +
          (imageBox?.width ?? 0) / 2 -
          ((viewportBox?.x ?? 0) + (viewportBox?.width ?? 0) / 2)
      )
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        (imageBox?.y ?? 0) +
          (imageBox?.height ?? 0) / 2 -
          ((viewportBox?.y ?? 0) + (viewportBox?.height ?? 0) / 2)
      )
    ).toBeLessThanOrEqual(1);

    const zoomIn = dialog.getByRole('button', { name: 'Zoom in' });
    const zoomOut = dialog.getByRole('button', { name: 'Zoom out' });
    const fit = dialog.getByRole('button', { name: 'Fit image' });
    const actual = dialog.getByRole('button', { name: 'Actual size' });
    expect(await fit.getAttribute('aria-pressed')).toBe('true');
    expect(await actual.getAttribute('aria-pressed')).toBe('false');
    expect(await zoomIn.isEnabled()).toBe(true);
    expect(await zoomOut.isEnabled()).toBe(true);
    for (const target of [
      dialog.getByRole('button', { name: 'Previous item' }),
      dialog.getByRole('button', { name: 'Next item' }),
      dialog.getByRole('button', { name: 'Close' }),
      zoomOut,
      fit,
      actual,
      zoomIn,
      dialog.getByRole('link', { name: 'Open job' }),
      dialog.getByRole('link', { name: 'Open full size' }),
      dialog.getByRole('link', { name: 'Download' })
    ]) {
      await target.scrollIntoViewIfNeeded();
      const box = await target.boundingBox();
      expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(40);
    }
    await actual.click();
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('actual');
    expect(await fit.getAttribute('aria-pressed')).toBe('false');
    expect(await actual.getAttribute('aria-pressed')).toBe('true');
    expect(
      (await dialog.getByTestId('gallery-viewer-interaction-status').textContent())?.trim()
    ).toBe('Actual size, 100 percent');
    expect(Number(await viewport.getAttribute('data-zoom-value'))).toBeGreaterThan(0);
    await page.waitForFunction(() => {
      const imageElement = document.querySelector<HTMLImageElement>(
        '[data-testid="gallery-viewer-viewport"] img'
      );
      if (!imageElement) return false;
      const rect = imageElement.getBoundingClientRect();
      return Math.abs(rect.width - 640) <= 1 && Math.abs(rect.height - 360) <= 1;
    });
    const actualBox = await image.boundingBox();
    expect(Math.abs((actualBox?.width ?? 0) - 640)).toBeLessThanOrEqual(1);
    expect(Math.abs((actualBox?.height ?? 0) - 360)).toBeLessThanOrEqual(1);
    await zoomIn.click();
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('custom');
    expect(await fit.getAttribute('aria-pressed')).toBe('false');
    expect(await actual.getAttribute('aria-pressed')).toBe('false');
    await zoomOut.click();
    await fit.click();
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('fit');
    expect(await fit.getAttribute('aria-pressed')).toBe('true');
    expect(await actual.getAttribute('aria-pressed')).toBe('false');
    expect(await viewport.getAttribute('data-zoom-value')).toBe('1');
    await image.dblclick();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="gallery-viewer-viewport"]')
          ?.getAttribute('data-zoom-mode') === 'custom'
    );
    await image.dblclick();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="gallery-viewer-viewport"]')
          ?.getAttribute('data-zoom-mode') === 'fit'
    );

    const wheelPrevented = await viewport.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width * 0.75,
        clientY: rect.top + rect.height * 0.75,
        deltaY: -10_000
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(wheelPrevented).toBe(true);
    await page.waitForFunction(
      () =>
        Number(
          document
            .querySelector('[data-testid="gallery-viewer-viewport"]')
            ?.getAttribute('data-zoom-value')
        ) > 1
    );
    const wheelTransform = await viewerTransform(image);
    expect(wheelTransform.zoom).toBeGreaterThan(1);
    expect(wheelTransform.x).toBeLessThanOrEqual(0);
    expect(wheelTransform.y).toBeLessThanOrEqual(0);
    expect(Math.min(wheelTransform.x, wheelTransform.y)).toBeLessThan(0);
    const zoomBeforeModifiedWheel = Number(await viewport.getAttribute('data-zoom-value'));
    const modifiedWheelPrevented = await viewport.evaluate((element) =>
      [{ altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }].map(
        (modifier) => {
          const event = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: -120,
            ...modifier
          });
          element.dispatchEvent(event);
          return event.defaultPrevented;
        }
      )
    );
    expect(modifiedWheelPrevented).toEqual([false, false, false, false]);
    expect(Number(await viewport.getAttribute('data-zoom-value'))).toBe(zoomBeforeModifiedWheel);
    const footerWheelPrevented = await dialog
      .getByTestId('gallery-viewer-footer')
      .evaluate((element) => {
        const event = new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: -120
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
    expect(footerWheelPrevented).toBe(false);

    for (let index = 0; index < 20; index += 1) await zoomIn.click();
    const clampedTransform = await viewerTransform(image);
    expect(clampedTransform.zoom).toBeLessThanOrEqual(8);
    const dragStart = await viewport.boundingBox();
    if (!dragStart) throw new Error('Expected a viewer viewport for drag coverage.');
    await page.mouse.move(dragStart.x + dragStart.width / 2, dragStart.y + dragStart.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      dragStart.x + dragStart.width + 2_000,
      dragStart.y + dragStart.height + 2_000
    );
    await page.mouse.up();
    const draggedTransform = await viewerTransform(image);
    const draggedImageBox = await image.boundingBox();
    const draggedViewportBox = await viewport.boundingBox();
    const maxX = Math.max(
      0,
      ((draggedImageBox?.width ?? 0) - (draggedViewportBox?.width ?? 0)) / 2
    );
    const maxY = Math.max(
      0,
      ((draggedImageBox?.height ?? 0) - (draggedViewportBox?.height ?? 0)) / 2
    );
    expect(Math.abs(draggedTransform.x)).toBeLessThanOrEqual(maxX + 1);
    expect(Math.abs(draggedTransform.y)).toBeLessThanOrEqual(maxY + 1);
    expect(await viewport.evaluate((element) => document.activeElement === element)).toBe(true);
    const zoomAfterPointerInteraction = Number(await viewport.getAttribute('data-zoom-value'));
    await page.keyboard.press('-');
    expect(Number(await viewport.getAttribute('data-zoom-value'))).toBeLessThan(
      zoomAfterPointerInteraction
    );
    await fit.click();
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('fit');

    await viewport.focus();
    await page.keyboard.press('+');
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('custom');
    const plusZoom = Number(await viewport.getAttribute('data-zoom-value'));
    await page.keyboard.press('-');
    expect(Number(await viewport.getAttribute('data-zoom-value'))).toBeLessThan(plusZoom);
    await page.keyboard.press('+');
    const restoredPlusZoom = Number(await viewport.getAttribute('data-zoom-value'));
    await page.keyboard.press('Shift+-');
    expect(Number(await viewport.getAttribute('data-zoom-value'))).toBeLessThan(restoredPlusZoom);
    await page.keyboard.press('0');
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('fit');
    await page.keyboard.press('1');
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('actual');
    await page.keyboard.press('0');
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('fit');
    for (let index = 0; index < 20; index += 1) await page.keyboard.press('+');
    const beforeKeyboardPan = await viewerTransform(image);
    await page.keyboard.press('ArrowRight');
    expect(await dialog.getByRole('heading').textContent()).toBe(labels.newest);
    expect((await viewerTransform(image)).x).toBeLessThan(beforeKeyboardPan.x);
    const afterNormalHorizontalPan = await viewerTransform(image);
    await page.keyboard.press('Shift+ArrowLeft');
    const afterFastHorizontalPan = await viewerTransform(image);
    expect(afterFastHorizontalPan.x - afterNormalHorizontalPan.x).toBeCloseTo(96, 5);
    const beforeVerticalPan = afterFastHorizontalPan;
    await page.keyboard.press('ArrowDown');
    const afterNormalVerticalPan = await viewerTransform(image);
    expect(afterNormalVerticalPan.y).toBeLessThan(beforeVerticalPan.y);
    await page.keyboard.press('Shift+ArrowUp');
    const afterFastVerticalPan = await viewerTransform(image);
    expect(afterFastVerticalPan.y - afterNormalVerticalPan.y).toBeCloseTo(96, 5);
    let horizontalClamp = await viewerTransform(image);
    let reachedHorizontalClamp = false;
    for (let index = 0; index < 100; index += 1) {
      const before = horizontalClamp;
      await page.keyboard.press('Shift+ArrowRight');
      horizontalClamp = await viewerTransform(image);
      if (Math.abs(horizontalClamp.x - before.x) < 1e-6) {
        reachedHorizontalClamp = true;
        break;
      }
    }
    expect(reachedHorizontalClamp).toBe(true);
    const clampedShiftOwned = await viewport.evaluate((element) => {
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    const afterClampedShift = await viewerTransform(image);
    expect(clampedShiftOwned).toBe(true);
    expect(afterClampedShift.x).toBeCloseTo(horizontalClamp.x, 6);
    await fit.click();
    const shiftArrowPassesThrough = await viewport.evaluate((element) => {
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        shiftKey: true,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(event);
      return !event.defaultPrevented;
    });
    expect(shiftArrowPassesThrough).toBe(true);
    await page.keyboard.press('+');
    const beforeEditableKey = Number(await viewport.getAttribute('data-zoom-value'));
    const editable = dialog.locator('textarea[data-gallery-keyboard-test]');
    await dialog.evaluate((element) => {
      const textarea = document.createElement('textarea');
      textarea.dataset.galleryKeyboardTest = '';
      element.append(textarea);
      textarea.focus();
    });
    await page.keyboard.press('+');
    expect(Number(await viewport.getAttribute('data-zoom-value'))).toBe(beforeEditableKey);
    await editable.evaluate((element) => element.remove());
    await viewport.focus();
    await dialog.getByRole('button', { name: 'Next item' }).click();
    await expectSelection(dialog, {
      label: labels.video,
      position: '2 of 3',
      mediaKind: 'video',
      stage: 'item-change reset'
    });
    await dialog.getByRole('button', { name: 'Previous item' }).click();
    await expectSelection(dialog, {
      label: labels.newest,
      position: '1 of 3',
      mediaKind: 'image',
      stage: 'item-change reset return'
    });
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('fit');
    expect(await viewport.getAttribute('data-zoom-value')).toBe('1');
    await viewport.focus();
    await page.keyboard.press('ArrowRight');
    await expectSelection(dialog, {
      label: labels.video,
      position: '2 of 3',
      mediaKind: 'video',
      stage: 'viewport arrow fallback'
    });
    await dialog.getByRole('button', { name: 'Previous item' }).click();
    await expectSelection(dialog, {
      label: labels.newest,
      position: '1 of 3',
      mediaKind: 'image',
      stage: 'return from viewport arrow fallback'
    });

    await page.setViewportSize({ width: 1100, height: 720 });
    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="gallery-viewer-viewport"]')
          ?.getAttribute('data-zoom-mode') === 'fit' &&
        document
          .querySelector('[data-testid="gallery-viewer-viewport"]')
          ?.getAttribute('data-zoom-value') === '1'
    );
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
    await page.waitForFunction(() => {
      const viewportElement = document.querySelector<HTMLElement>(
        '[data-testid="gallery-viewer-viewport"]'
      );
      const imageElement = viewportElement?.querySelector<HTMLImageElement>('img');
      if (!viewportElement || !imageElement) return false;
      const viewportRect = viewportElement.getBoundingClientRect();
      const imageRect = imageElement.getBoundingClientRect();
      return (
        imageRect.width <= viewportRect.width + 1 && imageRect.height <= viewportRect.height + 1
      );
    });
    const resizedViewportBox = await viewport.boundingBox();
    const resizedImageBox = await image.boundingBox();
    expect((resizedImageBox?.width ?? Infinity) <= (resizedViewportBox?.width ?? 0) + 1).toBe(true);
    expect((resizedImageBox?.height ?? Infinity) <= (resizedViewportBox?.height ?? 0) + 1).toBe(
      true
    );

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
    const videoViewport = dialog.getByTestId('gallery-viewer-viewport');
    expect(await videoViewport.getAttribute('data-media-kind')).toBe('video');
    expect(await videoViewport.getAttribute('data-zoom-mode')).toBe('none');
    expect(await dialog.getByRole('toolbar', { name: 'Image zoom controls' }).count()).toBe(0);
    expect(
      await videoViewport.evaluate((element) => getComputedStyle(element).touchAction)
    ).not.toBe('none');
    expect(
      await videoViewport.evaluate((element) => {
        const event = new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerType: 'mouse',
          button: 0,
          buttons: 1,
          isPrimary: true
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      })
    ).toBe(false);
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
    await page.waitForFunction(() =>
      document.querySelector('[role="dialog"]')?.contains(document.activeElement)
    );

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
    await page.waitForFunction(
      (outputId) => document.activeElement?.getAttribute('data-output-id') === outputId,
      seeded.newest.outputId
    );
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

    for (const pathname of ['/library', `/library/${seeded.video.jobId}`]) {
      const response = await fetch(`${harness.url}${pathname}?view=list&q=cobalt`, {
        redirect: 'manual'
      });
      expect(response.status).toBe(404);
      expect(response.headers.get('location')).toBeNull();
    }

    await page.goto(`${harness.url}/jobs/${seeded.video.jobId}`);
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
      dialog.getByRole('button', { name: 'Close' }),
      dialog.getByRole('link', { name: 'Open job' }),
      dialog.getByRole('link', { name: 'Open full size' }),
      dialog.getByRole('link', { name: 'Download' })
    ]) {
      await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(44);
      expect(await control.isVisible()).toBe(true);
    }
    expect(await seriousAccessibilityViolations(page)).toEqual([]);
    await page.keyboard.press('ArrowRight');
    await expectSelection(dialog, { label: labels.long, position: '3 of 3', mediaKind: 'image' });
    await page.setViewportSize({ width: 320, height: 480 });
    const mobileToolbar = dialog.getByRole('toolbar', { name: 'Image zoom controls' });
    expect(await mobileToolbar.isVisible()).toBe(true);
    for (const controlName of ['Zoom out', 'Fit image', 'Actual size', 'Zoom in']) {
      const control = dialog.getByRole('button', { name: controlName });
      await control.scrollIntoViewIfNeeded();
      expect(await control.isVisible()).toBe(true);
      const box = await control.boundingBox();
      expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(44);
    }
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
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
    const consoleErrorsBeforeMediaFailure = issues.consoleErrors.length;
    await dialog.locator('img').evaluate((element: HTMLImageElement) => {
      element.src = '/api/media/browser-gallery-viewer-missing';
    });
    const mediaError = dialog.getByTestId('gallery-viewer-error');
    await mediaError.waitFor();
    expect(issues.consoleErrors.slice(consoleErrorsBeforeMediaFailure)).toEqual([
      'Failed to load resource: the server responded with a status of 404 (Not Found)'
    ]);
    issues.consoleErrors.splice(consoleErrorsBeforeMediaFailure);
    expect((await mediaError.textContent())?.trim()).toBe('Media could not be loaded');
    expect(await dialog.getByTestId('gallery-viewer-viewport').getAttribute('aria-busy')).toBe(
      'false'
    );
    expect(await dialog.getByTestId('gallery-viewer-viewport').getAttribute('data-zoom-mode')).toBe(
      'none'
    );
    expect(await dialog.getByRole('button', { name: 'Fit image' }).isDisabled()).toBe(true);
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
test('Gallery viewer retains ready media identity through collapse, reflow, cancellation, and stale callbacks', async () => {
  const harness = await startBrowserAppHarness();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context:
    | Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>>
    | undefined;

  try {
    const seeded = await seedGallery(harness);
    await harness.startApp();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const issues = trackBrowserIssues(page);
    await page.goto(`${harness.url}/gallery`);
    await page.getByRole('heading', { name: 'Gallery', level: 1 }).waitFor();

    let releaseImageRequest: (() => void) | undefined;
    const imageRequestReleased = new Promise<void>((resolve) => {
      releaseImageRequest = resolve;
    });
    await page.route(`**/api/media/${seeded.newest.outputId}`, async (route) => {
      await imageRequestReleased;
      await route.continue();
    });

    await page
      .locator('article')
      .filter({ hasText: labels.newest })
      .getByRole('button', { name: `View image ${labels.newest}`, exact: true })
      .first()
      .click();

    const dialog = page.getByRole('dialog');
    const viewport = dialog.getByTestId('gallery-viewer-viewport');
    const image = dialog.locator('img');
    await dialog.getByTestId('gallery-viewer-loading').waitFor();
    expect(await image.count()).toBe(1);
    expect(await viewport.getAttribute('aria-busy')).toBe('true');

    releaseImageRequest?.();
    await page.waitForFunction(() => {
      const viewport = document.querySelector('[data-testid="gallery-viewer-viewport"]');
      return (
        viewport?.getAttribute('data-zoom-mode') === 'fit' &&
        !document.querySelector('[data-testid="gallery-viewer-loading"]')
      );
    });

    await image.evaluate((element) => {
      (window as Window & { __galleryReadyImage?: HTMLImageElement }).__galleryReadyImage =
        element as HTMLImageElement;
    });
    await dialog.getByRole('button', { name: 'Zoom in' }).click();
    const imageBeforeCollapse = await viewerTransform(image);

    const restoredImage = await collapseAndRestoreViewport(viewport);
    expect(
      await viewport.evaluate((element) => element.getBoundingClientRect().height)
    ).toBeCloseTo(restoredImage.height, 0);
    expect(restoredImage.loadingFlashed).toBe(false);
    expect(await viewport.getAttribute('data-layout-pending')).toBe('false');
    expect(
      await image.evaluate(
        (element) =>
          element ===
          (window as Window & { __galleryReadyImage?: HTMLImageElement }).__galleryReadyImage
      )
    ).toBe(true);
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('custom');
    expect(await dialog.getByTestId('gallery-viewer-loading').count()).toBe(0);
    await expectContainedGeometry(image);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);

    const dragStart = await viewport.boundingBox();
    if (!dragStart) throw new Error('Expected image viewport before resize cancellation.');
    await page.mouse.move(dragStart.x + dragStart.width / 2, dragStart.y + dragStart.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      dragStart.x + dragStart.width / 2 + 24,
      dragStart.y + dragStart.height / 2
    );
    await collapseAndRestoreViewport(viewport);
    await page.mouse.up();
    const afterCancelledDrag = await viewerTransform(image);
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('custom');
    expect(afterCancelledDrag.zoom).toBeCloseTo(imageBeforeCollapse.zoom, 6);

    const recoveredDragStart = await viewport.boundingBox();
    if (!recoveredDragStart) throw new Error('Expected image viewport after resize cancellation.');
    await page.mouse.move(
      recoveredDragStart.x + recoveredDragStart.width / 2,
      recoveredDragStart.y + recoveredDragStart.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
      recoveredDragStart.x + recoveredDragStart.width / 2,
      recoveredDragStart.y + recoveredDragStart.height / 2 - 48
    );
    await page.mouse.up();
    const afterRecoveredDrag = await viewerTransform(image);
    expect(afterRecoveredDrag.y).not.toBeCloseTo(afterCancelledDrag.y, 3);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);

    await page.setViewportSize({ width: 360, height: 720 });
    await page.waitForFunction(() => {
      const viewport = document.querySelector<HTMLElement>(
        '[data-testid="gallery-viewer-viewport"]'
      );
      return viewport !== null && viewport.getBoundingClientRect().width > 0;
    });
    expect(
      await image.evaluate(
        (element) =>
          element ===
          (window as Window & { __galleryReadyImage?: HTMLImageElement }).__galleryReadyImage
      )
    ).toBe(true);
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('custom');
    expect(await dialog.getByTestId('gallery-viewer-loading').count()).toBe(0);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);
    const footerReflow = await dialog.getByTestId('gallery-viewer-footer').evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      actionRows: element.querySelector('nav')?.getBoundingClientRect().height ?? 0
    }));
    expect(footerReflow.scrollWidth).toBeLessThanOrEqual(footerReflow.clientWidth);
    expect(footerReflow.actionRows).toBeGreaterThan(0);
    for (const actionName of ['Open job', 'Open full size', 'Download']) {
      await dialog.getByRole('link', { name: actionName }).scrollIntoViewIfNeeded();
      expect(await dialog.getByRole('link', { name: actionName }).isVisible()).toBe(true);
    }

    const staleImage = await image.evaluate((element) => {
      (window as Window & { __galleryStaleImage?: HTMLImageElement }).__galleryStaleImage =
        element as HTMLImageElement;
      return element.isConnected;
    });
    expect(staleImage).toBe(true);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page
      .locator('article')
      .filter({ hasText: labels.newest })
      .getByRole('button', { name: `View image ${labels.newest}`, exact: true })
      .first()
      .click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="gallery-viewer-viewport"]')
          ?.getAttribute('data-zoom-mode') === 'fit'
    );
    expect(
      await dialog
        .locator('img')
        .evaluate(
          (element) =>
            element !==
            (window as Window & { __galleryStaleImage?: HTMLImageElement }).__galleryStaleImage
        )
    ).toBe(true);
    await page.evaluate(() => {
      const stale = (window as Window & { __galleryStaleImage?: HTMLImageElement })
        .__galleryStaleImage;
      stale?.dispatchEvent(new Event('load'));
      stale?.dispatchEvent(new Event('error'));
    });
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('fit');
    expect(await dialog.getByTestId('gallery-viewer-error').count()).toBe(0);
    expect(await dialog.getByTestId('gallery-viewer-loading').count()).toBe(0);

    let releaseVideoRequest: (() => void) | undefined;
    const videoRequestReleased = new Promise<void>((resolve) => {
      releaseVideoRequest = resolve;
    });
    await page.route(`**/api/media/${seeded.video.outputId}`, async (route) => {
      await videoRequestReleased;
      await route.continue();
    });
    await dialog.getByRole('button', { name: 'Next item' }).click();
    const video = dialog.locator('video');
    await video.waitFor();
    await dialog.getByTestId('gallery-viewer-loading').waitFor();
    await video.evaluate((element) => {
      (window as Window & { __galleryReadyVideo?: HTMLVideoElement }).__galleryReadyVideo =
        element as HTMLVideoElement;
    });
    releaseVideoRequest?.();
    await page.waitForFunction(() => {
      const viewport = document.querySelector('[data-testid="gallery-viewer-viewport"]');
      return (
        viewport?.getAttribute('data-media-kind') === 'video' &&
        viewport.getAttribute('aria-busy') === 'false' &&
        !document.querySelector('[data-testid="gallery-viewer-loading"]')
      );
    });

    const restoredVideo = await collapseAndRestoreViewport(viewport);
    expect(
      await viewport.evaluate((element) => element.getBoundingClientRect().height)
    ).toBeCloseTo(restoredVideo.height, 0);
    expect(restoredVideo.loadingFlashed).toBe(false);
    expect(await viewport.getAttribute('data-layout-pending')).toBe('false');
    expect(
      await video.evaluate(
        (element) =>
          element ===
          (window as Window & { __galleryReadyVideo?: HTMLVideoElement }).__galleryReadyVideo
      )
    ).toBe(true);
    expect(await viewport.getAttribute('data-media-kind')).toBe('video');
    expect(await viewport.getAttribute('aria-busy')).toBe('false');
    expect(await dialog.getByTestId('gallery-viewer-loading').count()).toBe(0);
    await expectContainedGeometry(video);
    expect(await pageHasNoHorizontalOverflow(page)).toBe(true);

    const staleVideo = await video.evaluate((element) => {
      (window as Window & { __galleryStaleVideo?: HTMLVideoElement }).__galleryStaleVideo =
        element as HTMLVideoElement;
      return element.isConnected;
    });
    expect(staleVideo).toBe(true);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.evaluate(() => {
      const stale = (window as Window & { __galleryStaleVideo?: HTMLVideoElement })
        .__galleryStaleVideo;
      stale?.dispatchEvent(new Event('loadedmetadata'));
      stale?.dispatchEvent(new Event('error'));
    });
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  } finally {
    await context?.close();
    await browser?.close();
    await harness.cleanup();
  }
});
test('Gallery viewer reaches Ready from a cached image attachment without its target load event', async () => {
  const harness = await startBrowserAppHarness();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context:
    | Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>>
    | undefined;

  try {
    const seeded = await seedGallery(harness);
    await harness.startApp();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const issues = trackBrowserIssues(page);
    await page.goto(`${harness.url}/gallery`);
    const mediaUrl = `${harness.url}/api/media/${seeded.newest.outputId}`;
    const decoded = await page.evaluate(async (url) => {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight };
    }, mediaUrl);
    expect(decoded.complete).toBe(true);
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
    await page.evaluate((url) => {
      const state = { blocked: 0, url };
      const listener = (event: Event) => {
        const target = event.target;
        if (target instanceof HTMLImageElement && target.src === state.url) {
          state.blocked += 1;
          event.stopImmediatePropagation();
        }
      };
      (
        window as Window & {
          __galleryCachedLoadBlocker?: { listener: EventListener; state: typeof state };
        }
      ).__galleryCachedLoadBlocker = { listener, state };
      document.addEventListener('load', listener, true);
    }, mediaUrl);

    const dialog = await openGalleryOutput(page, labels.newest, 'image');
    const image = dialog.locator('img');
    expect(await image.count()).toBe(1);
    const viewport = dialog.getByTestId('gallery-viewer-viewport');
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('[role="dialog"] img');
      return (
        image?.complete === true &&
        image.naturalWidth > 0 &&
        image.naturalHeight > 0 &&
        document
          .querySelector('[data-testid="gallery-viewer-viewport"]')
          ?.getAttribute('aria-busy') === 'false'
      );
    });
    expect(await image.evaluate((element: HTMLImageElement) => element.complete)).toBe(true);
    expect(
      await image.evaluate((element: HTMLImageElement) => element.naturalWidth)
    ).toBeGreaterThan(0);
    expect(
      await image.evaluate((element: HTMLImageElement) => element.naturalHeight)
    ).toBeGreaterThan(0);
    expect(await viewport.getAttribute('data-zoom-mode')).toBe('fit');
    expect(await dialog.getByTestId('gallery-viewer-loading').count()).toBe(0);
    await page.waitForFunction(
      () =>
        (
          window as Window & {
            __galleryCachedLoadBlocker?: { state: { blocked: number } };
          }
        ).__galleryCachedLoadBlocker?.state.blocked === 1
    );
    await page.evaluate(() => {
      const blocker = (
        window as Window & {
          __galleryCachedLoadBlocker?: { listener: EventListener };
        }
      ).__galleryCachedLoadBlocker;
      if (blocker) document.removeEventListener('load', blocker.listener, true);
    });
    expect(issues.consoleErrors).toEqual([]);
    expect(issues.pageErrors).toEqual([]);
  } finally {
    await context?.close();
    await browser?.close();
    await harness.cleanup();
  }
});

test('Gallery production video pauses once before each production-owned exit detaches it', async () => {
  const harness = await startBrowserAppHarness();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context:
    | Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newContext']>>
    | undefined;

  try {
    await seedGallery(harness);
    await harness.startApp();
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

    for (const action of ['next', 'close', 'escape', 'outside'] as const) {
      const page = await context.newPage();
      const issues = trackBrowserIssues(page);
      await page.goto(`${harness.url}/gallery`);
      const dialog = await openGalleryOutput(page, labels.video, 'video');
      const video = dialog.locator('video');
      await page.waitForFunction(() => {
        const viewport = document.querySelector('[data-testid="gallery-viewer-viewport"]');
        const video = document.querySelector<HTMLVideoElement>('[role="dialog"] video');
        return (
          viewport?.getAttribute('aria-busy') === 'false' &&
          video !== null &&
          video.readyState >= HTMLMediaElement.HAVE_METADATA
        );
      });
      const started = await video.evaluate(async (element: HTMLVideoElement) => {
        const records: { connected: boolean; paused: boolean }[] = [];
        const originalPause = element.pause.bind(element);
        element.pause = () => {
          records.push({ connected: element.isConnected, paused: element.paused });
          originalPause();
        };
        element.muted = true;
        element.currentTime = Math.min(element.duration / 2, element.duration - 0.05);
        await element.play();
        (
          window as Window & { __galleryProductionPauseRecords?: typeof records }
        ).__galleryProductionPauseRecords = records;
        return {
          duration: element.duration,
          currentTime: element.currentTime,
          paused: element.paused
        };
      });
      expect(started.duration).toBeGreaterThan(0.1);
      expect(started.currentTime).toBeGreaterThan(0);
      expect(started.currentTime).toBeLessThan(started.duration);
      expect(started.paused).toBe(false);

      if (action === 'next') {
        await dialog.getByRole('button', { name: 'Next item' }).click();
        await expectSelection(dialog, {
          label: labels.long,
          position: '3 of 3',
          mediaKind: 'image',
          stage: 'production next pause'
        });
      } else if (action === 'close') {
        await dialog.getByRole('button', { name: 'Close' }).click();
        await dialog.waitFor({ state: 'detached' });
      } else if (action === 'escape') {
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
      } else {
        const box = await dialog.boundingBox();
        if (!box) throw new Error('Expected dialog bounds before outside-overlay dismissal.');
        await page.mouse.click(Math.max(1, box.x - 8), Math.max(1, box.y - 8));
        await dialog.waitFor({ state: 'detached' });
      }

      const pauses = await page.evaluate(
        () =>
          (
            window as Window & {
              __galleryProductionPauseRecords?: { connected: boolean; paused: boolean }[];
            }
          ).__galleryProductionPauseRecords ?? []
      );
      expect(pauses).toEqual([{ connected: true, paused: false }]);
      expect(issues.consoleErrors).toEqual([]);
      expect(issues.pageErrors).toEqual([]);
      await page.close();
    }
  } finally {
    await context?.close();
    await browser?.close();
    await harness.cleanup();
  }
});

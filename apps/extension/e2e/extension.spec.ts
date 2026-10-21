// Loads the built dev extension into Chromium and drives it against the local test site.
// Run `pnpm test:e2e` (it builds first).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import type { CheckResult, LibraryItem, Request, Response } from '../src/messages';

const SITE = 'http://localhost:4173';
const EXTENSION = fileURLToPath(new URL('../dist', import.meta.url));

const test = base.extend<{ context: BrowserContext; worker: Worker; ext: Page }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
  },
  // An extension page to send messages from, the same way the popup does.
  ext: async ({ context, worker }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
    await expect(page.getByText('Test Site (comics)')).toBeVisible();
    // The on-page prompt is registered once the dev configs are installed.
    await expect
      .poll(() => worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).length))
      .toBe(1);
    await use(page);
  },
});

async function call<T>(ext: Page, request: Request): Promise<T> {
  const response = await ext.evaluate((r) => chrome.runtime.sendMessage(r) as Promise<Response>, request);
  if (!response.ok) throw new Error(response.error);
  return response.data as T;
}

/** What the popup's "Open reader" button does. */
async function openReader(worker: Worker, page: Page): Promise<void> {
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({ target: { tabId: tab!.id! }, files: ['content.js'] });
  }, page.url());
}

/** What the popup does before offering "Open reader" on a site without a source. */
async function probe(worker: Worker, page: Page): Promise<unknown> {
  return worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.scripting.executeScript({ target: { tabId: tab!.id! }, files: ['probe.js'] });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab!.id! },
      func: () => (window as { __onidokuDetection?: unknown }).__onidokuDetection,
    });
    return result!.result;
  }, page.url());
}

/** Opens one of the extension's pages in a new tab. */
async function extPage(context: BrowserContext, ext: Page, path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(ext.url().replace('options.html', path));
  return page;
}

test.beforeEach(async ({ request }) => {
  await request.get(`${SITE}/__admin/reset`);
});

test('adds a series, reads it in the reader, and tracks progress', async ({ context, worker, ext }) => {
  await call(ext, { type: 'addSeries', url: `${SITE}/series/moon-garden` });
  const unread = async () => (await call<LibraryItem[]>(ext, { type: 'library' }))[0]!.unread;
  expect(await unread()).toBe(5);

  const page = await context.newPage();
  await page.goto(`${SITE}/series/moon-garden/chapter/1`);
  await openReader(worker, page);

  // Playwright locators pierce the reader's shadow DOM.
  await expect(page.locator('.overlay .webtoon img')).toHaveCount(6);
  await expect(page.locator('.overlay .title')).toHaveText('Moon Garden – Chapter 1');
  await expect.poll(unread).toBe(4);

  await page.keyboard.press('n');
  await expect(page).toHaveURL(`${SITE}/series/moon-garden/chapter/2`);
  await expect(page.locator('.overlay .title')).toHaveText('Moon Garden – Chapter 2');
  await expect.poll(unread).toBe(3);

  await page.keyboard.press('s');
  await page.locator('.overlay').getByRole('button', { name: 'left → right' }).click();
  await page.keyboard.press('Escape'); // closes the settings panel, not the reader
  await expect(page.locator('.overlay .counter')).toHaveText('1 / 6');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.overlay .counter')).toHaveText('2 / 6');

  await page.keyboard.press('Escape');
  await expect(page.locator('.overlay')).toHaveCount(0);
});

test('reads novel chapters as text', async ({ context, worker }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/novel/quiet-orbit/chapter/1`);
  await openReader(worker, page);
  await expect(page.locator('.overlay article.text p')).toHaveCount(12);
  await page.locator('.overlay').getByRole('button', { name: 'A+' }).click();
  await expect(page.locator('.overlay article.text')).toHaveCSS('font-size', '20px');
});

test('falls back to guessing pages on sites without a config', async ({ context, worker, ext }) => {
  await call(ext, { type: 'removeConfig', id: 'testsite.manga' });
  const page = await context.newPage();
  await page.goto(`${SITE}/series/iron-tide/chapter/2`);
  await openReader(worker, page);
  await expect(page.locator('.overlay .webtoon img')).toHaveCount(6);
});

test('detects novel chapters on sites without a config and reads them as text', async ({ context, worker, ext }) => {
  await call(ext, { type: 'removeConfig', id: 'testsite.novel' });
  const page = await context.newPage();
  await page.goto(`${SITE}/novel/quiet-orbit/chapter/1`);
  expect(await probe(worker, page)).toEqual({ kind: 'text', signals: ['url', 'heading', 'links'] });

  await openReader(worker, page);
  await expect(page.locator('.overlay article.text p')).toHaveCount(12);
  await page.keyboard.press('n');
  await expect(page).toHaveURL(`${SITE}/novel/quiet-orbit/chapter/2`);
  await expect(page.locator('.overlay article.text p')).toHaveCount(12);
});

test('reads single-page apps: blob: images, opaque chapter ids and in-app navigation', async ({ context, worker }) => {
  const page = await context.newPage();
  await page.goto(`${SITE}/app/star-ferry/chapter/3f2e9a1c`);
  await expect(page.locator('#app img')).toHaveCount(6);
  expect(await probe(worker, page)).toEqual({ kind: 'images', signals: ['url', 'heading', 'links'] });

  await openReader(worker, page);
  const pages = page.locator('.overlay .webtoon img');
  await expect(pages).toHaveCount(6);
  await expect(pages.first()).toHaveAttribute('src', /^blob:/);
  const firstChapter = await pages.first().getAttribute('src');

  // The app's HTML is an empty shell, so the reader follows the app's own link and reads what it renders.
  await page.keyboard.press('n');
  await expect(page).toHaveURL(`${SITE}/app/star-ferry/chapter/b81d04e7`);
  await expect(pages).toHaveCount(6);
  await expect(pages.first()).not.toHaveAttribute('src', firstChapter!);
  await expect(pages.first()).toHaveAttribute('src', /^blob:/);
});

test('suggests featured sources until they are installed', async ({ ext }) => {
  await expect(ext.locator('#featured li')).toHaveCount(2);
  await expect(ext.locator('#featured')).toContainText('Standard Ebooks');
  const raw = JSON.parse(readFileSync(new URL('../../../configs/featured/standardebooks.json', import.meta.url), 'utf8'));
  await call(ext, { type: 'installConfig', raw });
  await expect(ext.locator('#featured li')).toHaveCount(1);
});

test('update check finds newly published chapters', async ({ context, worker, ext, request }) => {
  const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}));
  await call(ext, { type: 'addSeries', url: `${SITE}/series/iron-tide` });
  expect(await call<CheckResult>(ext, { type: 'checkNow' })).toEqual({ updated: 0, failures: [] });
  // Unread chapters alone don't light up the toolbar: only new ones do.
  expect(await badge()).toBe('');

  await request.get(`${SITE}/__admin/add-chapter?series=iron-tide`);
  expect(await call<CheckResult>(ext, { type: 'checkNow' })).toEqual({ updated: 1, failures: [] });

  const [item] = await call<LibraryItem[]>(ext, { type: 'library' });
  expect(item!.unread).toBe(4);
  expect(item!.fresh).toBe(1);
  expect(item!.entry.chapters.at(-1)?.title).toBe('Chapter 4');
  expect(await badge()).toBe('1');

  // Opening the series shows which chapter is new and clears the badge.
  const details = await extPage(context, ext, `details.html?id=${encodeURIComponent(item!.entry.series.id)}`);
  await expect(details.locator('li', { hasText: 'Chapter 4' }).locator('.new-tag')).toHaveText('new');
  await expect.poll(badge).toBe('');
});

test('moves a library kept in chrome.storage over to IndexedDB', async ({ context, worker, ext }) => {
  await call(ext, { type: 'addSeries', url: `${SITE}/series/iron-tide` });
  const [{ entry }] = (await call<LibraryItem[]>(ext, { type: 'library' })) as [LibraryItem];
  // An older copy of a series already moved must not overwrite it; others come over.
  const old = { ...entry, readUpTo: entry.chapters[1]!.url };
  const legacy = { ...entry, series: { ...entry.series, id: `${entry.series.id}-legacy`, title: 'Legacy Tide' } };
  await worker.evaluate((library) => chrome.storage.local.set({ library }), { [old.series.id]: old, [legacy.series.id]: legacy });

  // A restarted worker opens the database afresh, which is when the move happens.
  const cdp = await context.newCDPSession(ext);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');

  const items = await call<LibraryItem[]>(ext, { type: 'library' });
  expect(items.map((i) => i.entry.series.title).sort()).toEqual(['Iron Tide', 'Legacy Tide']);
  expect(items.find((i) => i.entry.series.id === entry.series.id)!.entry.readUpTo).toBeUndefined();
  expect(await ext.evaluate(() => chrome.storage.local.get('library'))).toEqual({});
});

test.describe('on-page prompt', () => {
  // Requesting `ext` waits until the prompt script is registered.
  test.beforeEach(async ({ ext: _ext }) => {});

  test('offers to add a series, then to continue reading', async ({ context, ext }) => {
    const page = await context.newPage();
    await page.goto(`${SITE}/series/moon-garden`);
    const prompt = page.locator('.od-prompt');
    await expect(prompt).toContainText('Test Site (comics)');

    await prompt.getByRole('button', { name: 'add to library' }).click();
    await expect(prompt.getByRole('button', { name: 'continue: Chapter 1' })).toBeVisible();
    await expect(prompt).toContainText('5 unread');
    expect(await call<LibraryItem[]>(ext, { type: 'library' })).toHaveLength(1);

    await prompt.getByRole('button', { name: 'continue: Chapter 1' }).click();
    await expect(page).toHaveURL(`${SITE}/series/moon-garden/chapter/1`);
  });

  test('saves progress on chapter pages and opens the reader', async ({ context, ext }) => {
    await call(ext, { type: 'addSeries', url: `${SITE}/series/moon-garden` });
    const page = await context.newPage();
    await page.goto(`${SITE}/series/moon-garden/chapter/3`);
    const prompt = page.locator('.od-prompt');
    await expect(prompt).toContainText('progress saved · 2 unread');

    await prompt.getByRole('button', { name: 'open reader' }).click();
    await expect(page.locator('.overlay .webtoon img')).toHaveCount(6);
    await expect(prompt).toHaveCount(0);
  });

  test('adds the series from a chapter page', async ({ context, ext }) => {
    const page = await context.newPage();
    await page.goto(`${SITE}/novel/quiet-orbit/chapter/2`);
    const prompt = page.locator('.od-prompt');
    await prompt.getByRole('button', { name: 'add series' }).click();
    await expect(prompt).toContainText('progress saved · 2 unread');
    const [item] = await call<LibraryItem[]>(ext, { type: 'library' });
    expect(item!.entry.series.title).toBe('Quiet Orbit');
  });

  test('stays hidden on the site for the tab once dismissed', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`${SITE}/series/moon-garden`);
    await page.locator('.od-prompt').getByRole('button', { name: '×' }).click();
    await expect(page.locator('.od-prompt')).toHaveCount(0);

    await page.goto(`${SITE}/series/iron-tide`);
    await page.waitForTimeout(500); // give the prompt time to (not) appear
    await expect(page.locator('.od-prompt')).toHaveCount(0);
  });

  test('does not appear on pages no config matches', async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`${SITE}/`);
    await page.waitForTimeout(500);
    await expect(page.locator('.od-prompt')).toHaveCount(0);
  });
});

test.describe('details page', () => {
  const ID = 'testsite.manga:http://localhost:4173/series/moon-garden';

  async function openDetails(context: BrowserContext, ext: Page): Promise<Page> {
    await call(ext, { type: 'addSeries', url: `${SITE}/series/moon-garden` });
    await call(ext, { type: 'markRead', url: `${SITE}/series/moon-garden/chapter/2` });
    const page = await context.newPage();
    await page.goto(ext.url().replace('options.html', `details.html?id=${encodeURIComponent(ID)}`));
    return page;
  }

  test('shows series details, progress and chapters', async ({ context, ext }) => {
    const page = await openDetails(context, ext);
    await expect(page.getByRole('heading', { name: 'Moon Garden' })).toBeVisible();
    await expect(page.locator('.meta')).toContainText('Ana Ruiz, Ken Ito · Ongoing');
    await expect(page.locator('.chips li')).toHaveText(['Fantasy', 'Slice of life']);
    await expect(page.locator('.description')).toContainText('Moon Garden is a generated manga series');
    await expect(page.getByText('2 of 5 read')).toBeVisible();
    await expect(page.locator('.chapters li')).toHaveCount(5);
    await expect(page.locator('.chapters li.read')).toHaveCount(2);
    await expect(page.locator('.chapters li').first()).toContainText('Chapter 5');

    await page.getByRole('button', { name: 'newest first' }).click();
    await expect(page.locator('.chapters li').first()).toContainText('Chapter 1');

    await page.getByPlaceholder('filter chapters').fill('4');
    await expect(page.locator('.chapters li')).toHaveCount(1);
  });

  test('marks chapters read and unread', async ({ context, ext }) => {
    const page = await openDetails(context, ext);
    const row = (title: string) => page.locator('.chapters li', { hasText: title });

    await row('Chapter 4').getByRole('button', { name: 'mark read', exact: true }).click();
    await expect(page.getByText('4 of 5 read')).toBeVisible();

    await row('Chapter 3').getByRole('button', { name: 'mark unread', exact: true }).click();
    await expect(page.getByText('2 of 5 read')).toBeVisible();

    await row('Chapter 1').getByRole('button', { name: 'mark unread', exact: true }).click();
    await expect(page.getByText('0 of 5 read')).toBeVisible();
    await expect(page.getByRole('button', { name: 'start reading: Chapter 1' })).toBeVisible();
  });

  test('marks up next, marks all read with undo, and removes with undo', async ({ context, ext }) => {
    const page = await openDetails(context, ext);
    await expect(page.locator('.progress-text')).toHaveText('2 of 5 read · 3 unread');
    await expect(page.locator('.chapters li.up-next')).toContainText('Chapter 3');
    await page.getByRole('button', { name: 'jump to up next' }).click();
    await expect(page.locator('.chapters li.up-next .chapter-title')).toBeFocused();

    await page.getByRole('button', { name: 'mark all read' }).click();
    await expect(page.locator('.progress-text')).toHaveText('5 of 5 read · all caught up');
    await page.locator('#toast').getByRole('button', { name: 'undo' }).click();
    await expect(page.locator('.progress-text')).toHaveText('2 of 5 read · 3 unread');

    await page.getByRole('button', { name: 'remove from library' }).click();
    await expect(page.locator('.confirm-remove')).toContainText('your progress (2 of 5 read) goes with it.');
    await expect(page.getByRole('button', { name: 'cancel' })).toBeFocused();
    await page.getByRole('button', { name: 'remove', exact: true }).click();
    await expect(page.locator('.not-in-library')).toBeVisible();
    await page.locator('#toast').getByRole('button', { name: 'undo' }).click();
    await expect(page.locator('.progress-text')).toHaveText('2 of 5 read · 3 unread');
  });

  test('continue opens the next chapter in the reader', async ({ context, ext }) => {
    const page = await openDetails(context, ext);
    await page.getByRole('button', { name: 'continue: Chapter 3' }).click();
    await expect(page).toHaveURL(`${SITE}/series/moon-garden/chapter/3`);
    await expect(page.locator('.overlay .title')).toHaveText('Moon Garden – Chapter 3');
  });

  test('finds new chapters on demand', async ({ context, ext, request }) => {
    const page = await openDetails(context, ext);
    await request.get(`${SITE}/__admin/add-chapter?series=moon-garden`);
    await page.getByRole('button', { name: 'check for new chapters' }).click();
    await expect(page.getByText('1 new chapter')).toBeVisible();
    await expect(page.locator('.chapters li')).toHaveCount(6);
  });

  test('author and genre links list their titles on every source', async ({ context, ext }) => {
    const page = await openDetails(context, ext);
    await page.getByRole('link', { name: 'Ana Ruiz' }).click();
    await expect(page).toHaveURL(/search\.html\?author=Ana\+Ruiz/);
    await expect(page.locator('.mode-pill')).toContainText('Ana Ruiz');
    // Opens on the first source with results.
    const comics = page.locator('.result-group.single');
    await expect(comics.locator('h2')).toHaveText('Test Site (comics)');
    await expect(comics).toContainText('1 result');
    await expect(comics.locator('.tile-title')).toHaveText(['Moon Garden']);
    await expect(comics.getByRole('button', { name: 'in library' })).toBeVisible();

    await page.goBack();
    await page.locator('.chips').getByRole('link', { name: 'Slice of life' }).click();
    await page.getByRole('tab', { name: /Test Site \(comics\)/ }).click();
    await expect(page.locator('.result-group.single .tile-title')).toHaveText(['Moon Garden']);

    await page.locator('.mode-pill').getByRole('button', { name: '×' }).click();
    await expect(page.locator('.mode-pill')).toBeHidden();
    await expect(page).toHaveURL(/search\.html$/);
  });

  test('opens from the on-page prompt', async ({ context, ext }) => {
    await call(ext, { type: 'addSeries', url: `${SITE}/series/moon-garden` });
    const page = await context.newPage();
    await page.goto(`${SITE}/series/moon-garden`);
    const [details] = await Promise.all([
      context.waitForEvent('page'),
      page.locator('.od-prompt').getByRole('button', { name: 'details' }).click(),
    ]);
    await expect(details.getByRole('heading', { name: 'Moon Garden' })).toBeVisible();
  });
});

test.describe('sites that load content after the page (htmx-style)', () => {
  test.beforeEach(async ({ ext: _ext }) => {});

  test('adds the full chapter list, not just the preview', async ({ ext }) => {
    await call(ext, { type: 'addSeries', url: `${SITE}/lazy/long-road` });
    const [item] = await call<LibraryItem[]>(ext, { type: 'library' });
    expect(item!.entry.chapters).toHaveLength(8);
  });

  test('reads lazily loaded pages and moves between chapters using the library', async ({ context, worker, ext }) => {
    await call(ext, { type: 'addSeries', url: `${SITE}/lazy/long-road` });
    const page = await context.newPage();
    await page.goto(`${SITE}/lazy/long-road/chapter/3`);
    await openReader(worker, page);
    await expect(page.locator('.overlay .webtoon img')).toHaveCount(6);
    await expect(page.locator('.overlay').getByRole('button', { name: 'next ›' })).toBeEnabled();

    await page.keyboard.press('n');
    await expect(page).toHaveURL(`${SITE}/lazy/long-road/chapter/4`);
    await expect(page.locator('.overlay .title')).toHaveText('Long Road – Chapter 4');
  });

  test('the prompt can add the series from a chapter page', async ({ context, ext }) => {
    const page = await context.newPage();
    await page.goto(`${SITE}/lazy/long-road/chapter/5`);
    await page.locator('.od-prompt').getByRole('button', { name: 'add series' }).click();
    await expect(page.locator('.od-prompt')).toContainText('progress saved · 3 unread');
  });
});

test.describe('library, search and sources pages', () => {
  test('sources list their icon, developer, version and capabilities', async ({ ext }) => {
    const row = ext.locator('.configs li', { hasText: 'Test Site (comics)' });
    await expect(row.locator('img.source-icon')).toHaveAttribute('src', `${SITE}/static/logo.svg`);
    await expect(row).toContainText('localhost:4173 · v1 · by onidoku · nothing in your library yet');
    await expect(row.locator('.hint')).toHaveAttribute('title', 'testsite.manga');
    await expect(row.locator('.tag')).toHaveText(['search', 'explore']);
  });

  test('removing a source is confirmed in place, says what it affects, and can be undone', async ({ ext }) => {
    await call(ext, { type: 'addSeries', url: `${SITE}/series/moon-garden` });
    const row = ext.locator('.configs li', { hasText: 'Test Site (comics)' });
    await expect(row).toContainText('1 series in your library');

    await row.getByRole('button', { name: 'remove Test Site (comics)' }).click();
    await expect(row).toContainText('its 1 series stay in your library');
    await row.getByRole('button', { name: 'cancel' }).click();
    await expect(row.getByRole('button', { name: 'remove Test Site (comics)' })).toBeVisible();

    await row.getByRole('button', { name: 'remove Test Site (comics)' }).click();
    await row.getByRole('button', { name: 'remove Test Site (comics)' }).click();
    await expect(ext.locator('.configs li', { hasText: 'Test Site (comics)' })).toHaveCount(0);
    await expect(ext.locator('#message')).toContainText('removed Test Site (comics).');

    await ext.locator('#message').getByRole('button', { name: 'undo' }).click();
    await expect(ext.locator('.configs li', { hasText: 'Test Site (comics)' })).toHaveCount(1);
  });

  test('adds a site by pasting JSON, checking it while typing', async ({ ext }) => {
    const raw = JSON.parse(readFileSync(new URL('../../../configs/featured/standardebooks.json', import.meta.url), 'utf8'));
    await ext.goto(`${ext.url().split('#')[0]}#add-json`);
    const dialog = ext.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: 'paste site JSON' })).toHaveAttribute('aria-selected', 'true');
    await dialog.locator('#json').fill('{ "schema": 1 }');
    await expect(dialog.locator('#json-check')).toContainText('invalid site config');
    await dialog.locator('#json').fill(JSON.stringify(raw));
    await expect(dialog.locator('#json-check')).toContainText('✓ Standard Ebooks');
    await dialog.getByRole('button', { name: 'install' }).click();
    await expect(dialog).toBeHidden();
    await expect(ext.locator('.configs li', { hasText: 'Standard Ebooks' })).toHaveCount(1);
  });

  test('searches sources and adds a result to the library', async ({ context, ext }) => {
    const page = await extPage(context, ext, 'search.html');
    await page.getByRole('searchbox', { name: 'search' }).fill('moon');
    await page.getByRole('button', { name: 'search', exact: true }).click();

    await expect(page.getByRole('tab', { name: /Test Site \(novels\)/ })).toContainText('0');
    await expect(page.getByRole('tab', { name: 'all' })).toHaveCount(0);
    const group = page.locator('.result-group.single');
    await expect(group.locator('h2')).toHaveText('Test Site (comics)');
    await expect(group).toContainText('1 result');
    await expect(page).not.toHaveURL(/source=/); // chosen automatically, not by the user

    await page.getByRole('tab', { name: /Test Site \(comics\)/ }).click();
    await expect(page).toHaveURL(/source=testsite\.manga/);

    // The add button stays out of the way until the title is hovered.
    const tile = group.locator('.tile', { hasText: 'Moon Garden' });
    await expect(tile.locator('.tile-action')).toHaveCSS('opacity', '0');
    await tile.hover();
    await expect(tile.locator('.tile-action')).toHaveCSS('opacity', '1');
    await group.getByRole('button', { name: 'add to library' }).click();
    await expect(group.getByRole('button', { name: 'in library' })).toBeVisible();
    const [item] = await call<LibraryItem[]>(ext, { type: 'library' });
    expect(item!.entry.series.title).toBe('Moon Garden');
  });

  test('explores a source\'s lists and adds a title', async ({ context, ext }) => {
    const page = await extPage(context, ext, 'explore.html?source=testsite.manga');
    await expect(page.locator('.picker-item[aria-selected=true]')).toContainText('Test Site (comics)');
    await expect(page.locator('.tile-title')).toHaveText(['Moon Garden', 'Iron Tide']);
    await expect(page.locator('.load-more')).toContainText('2 titles · end of list');

    await page.getByRole('tab', { name: 'Latest' }).click();
    await expect(page.locator('.tile-title')).toHaveText(['Iron Tide', 'Moon Garden']);
    await page.locator('.tile', { hasText: 'Iron Tide' }).getByRole('button', { name: 'add to library' }).click();
    await expect(page.locator('.tile', { hasText: 'Iron Tide' }).getByRole('button', { name: 'in library' })).toBeVisible();

    await page.getByRole('tab', { name: 'Test Site (novels)' }).click();
    await expect(page).toHaveURL(/source=testsite\.novel/);
    await expect(page.locator('.tile-title')).toHaveText(['Quiet Orbit']);
  });

  test('opens any title in the details view, then adds and removes it there', async ({ context, ext }) => {
    const page = await extPage(context, ext, 'explore.html?source=testsite.manga');
    await page.locator('.tile-button', { hasText: 'Iron Tide' }).click();
    await expect(page.getByRole('heading', { name: 'Iron Tide' })).toBeVisible();
    await expect(page.locator('.not-in-library')).toContainText('not in your library · 3 chapters');
    await expect(page.locator('.chapters li')).toHaveCount(3);
    await expect(page.getByRole('button', { name: 'start reading: Chapter 1' })).toBeVisible();
    expect(await call<LibraryItem[]>(ext, { type: 'library' })).toHaveLength(0);

    await page.getByRole('button', { name: 'add to library' }).click();
    await expect(page.getByText('0 of 3 read')).toBeVisible();
    await expect(page).toHaveURL(/details\.html\?id=testsite\.manga/);
    expect((await call<LibraryItem[]>(ext, { type: 'library' }))[0]!.entry.series.title).toBe('Iron Tide');

    await page.getByRole('button', { name: 'remove from library' }).click();
    await page.getByRole('button', { name: 'remove', exact: true }).click();
    await expect(page.locator('.not-in-library')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Iron Tide' })).toBeVisible();
    expect(await call<LibraryItem[]>(ext, { type: 'library' })).toHaveLength(0);

    await page.reload(); // the address still finds it, now as a preview
    await expect(page.locator('.not-in-library')).toContainText('3 chapters');
  });

  test('the popup lists series to continue and links to every page', async ({ context, ext }) => {
    await call(ext, { type: 'addSeries', url: `${SITE}/series/moon-garden` });
    const page = await extPage(context, ext, 'popup.html');
    await expect(page.locator('.pop-list li')).toContainText(['Moon Garden5 unread · next: Chapter 1']);
    await expect(page.locator('#page')).toBeHidden(); // nothing to do on a non-site page
    await expect(page.locator('.pop-tab')).toHaveText(['library', 'explore', 'search', 'sources']);
    const [library] = await Promise.all([context.waitForEvent('page'), page.getByRole('button', { name: 'open library ›' }).click()]);
    await expect(library).toHaveURL(/library\.html$/);
  });

  test('hides 18+ sources from search unless enabled', async ({ context, ext }) => {
    const manga = await call<{ id: string }[]>(ext, { type: 'listConfigs' }).then((all) => all.find((c) => c.id === 'testsite.manga')!);
    await call(ext, { type: 'installConfig', raw: { ...manga, nsfw: true } });
    const page = await extPage(context, ext, 'search.html?q=moon');
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.getByText('1 18+ source is hidden')).toBeVisible();

    await call(ext, { type: 'saveSettings', settings: { showNsfw: true } });
    await page.reload();
    await expect(page.getByRole('tab')).toHaveCount(3);
    // The 18+ mark is for the Sources page; results don't repeat it.
    await expect(page.locator('.result-group.single .tag.nsfw')).toHaveCount(0);
  });

  test('library filters, sorts and removes several series at once', async ({ context, ext }) => {
    for (const path of ['/series/moon-garden', '/series/iron-tide', '/novel/quiet-orbit']) {
      await call(ext, { type: 'addSeries', url: `${SITE}${path}` });
    }
    await call(ext, { type: 'markRead', url: `${SITE}/series/iron-tide/chapter/3` });
    const page = await extPage(context, ext, 'library.html');
    const titles = page.locator('.tile-title');
    await expect(titles).toHaveCount(3);
    await expect(page.locator('.tile', { hasText: 'Moon Garden' }).locator('.badge')).toHaveText('5');

    await page.locator('.filter-chips').getByRole('button', { name: /^unread/ }).click();
    await expect(titles).toHaveCount(2);
    await page.locator('.filter-chips').getByRole('button', { name: /^all/ }).click();

    await page.getByRole('combobox', { name: 'sort' }).selectOption('title');
    await expect(titles).toHaveText(['Iron Tide', 'Moon Garden', 'Quiet Orbit']);

    await page.getByRole('searchbox', { name: 'filter library' }).fill('mystery'); // a genre
    await expect(titles).toHaveText(['Quiet Orbit']);
    await page.getByRole('searchbox', { name: 'filter library' }).fill('');

    await page.getByRole('combobox', { name: 'source' }).selectOption({ label: 'Test Site (comics)' });
    await expect(titles).toHaveCount(2);
    await page.getByRole('combobox', { name: 'source' }).selectOption({ label: 'all sources' });

    await page.getByRole('button', { name: 'select', exact: true }).click();
    await page.locator('.tile', { hasText: 'Iron Tide' }).locator('.tile-button').click();
    await page.locator('.tile', { hasText: 'Quiet Orbit' }).locator('.tile-button').click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'remove 2 from library' }).click();
    await expect(titles).toHaveText(['Moon Garden']);
    expect(await call<LibraryItem[]>(ext, { type: 'library' })).toHaveLength(1);
  });

  test('opens details from the library', async ({ context, ext }) => {
    await call(ext, { type: 'addSeries', url: `${SITE}/series/moon-garden` });
    const page = await extPage(context, ext, 'library.html');
    await page.locator('.tile-button', { hasText: 'Moon Garden' }).click();
    await expect(page.getByRole('heading', { name: 'Moon Garden' })).toBeVisible();
    await expect(page.locator('.source-link')).toContainText('open on Test Site (comics)');
    await page.getByRole('link', { name: 'library' }).click();
    await expect(page.locator('.tile-title')).toHaveText(['Moon Garden']);
  });

  test('exports a backup and restores it', async ({ context, ext }) => {
    await call(ext, { type: 'addSeries', url: `${SITE}/series/moon-garden` });
    await call(ext, { type: 'markRead', url: `${SITE}/series/moon-garden/chapter/2` });
    const page = await extPage(context, ext, 'library.html');
    await page.getByText('backup', { exact: true }).click(); // opens the menu
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'export backup' }).click()]);
    const file = await download.path();

    await call(ext, { type: 'removeSeries', id: 'testsite.manga:http://localhost:4173/series/moon-garden' });
    await expect(page.getByText('your library is empty', { exact: true })).toBeVisible();

    await page.locator('input[type=file]').setInputFiles(file);
    await expect(page.getByText('restored 1 series and 0 sources')).toBeVisible();
    await expect(page.locator('.tile', { hasText: 'Moon Garden' }).locator('.badge')).toHaveText('3');
  });
});

test.describe('media servers', () => {
  const KOMGA = `${SITE}/komga`;
  const KAVITA = `${SITE}/kavita`;
  const KOMGA_ID = 'komga.localhost-4173-komga';
  const KAVITA_ID = 'kavita.localhost-4173-kavita';

  /** Opens a chapter from an extension page, as the details page does: that tab becomes the reader. */
  async function openServerChapter(context: BrowserContext, ext: Page, url: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(ext.url());
    // The page navigates away while the message is in flight, so its reply never arrives.
    void page.evaluate((r) => chrome.runtime.sendMessage(r), { type: 'openChapter', url, reader: true } satisfies Request).catch(() => undefined);
    await expect(page).toHaveURL(/\/reader\.html\?url=/);
    return page;
  }

  /** True once every page image has actually decoded (they're fetched with the server login). */
  async function imagesLoaded(page: Page): Promise<boolean> {
    return page.locator('.overlay .webtoon img').evaluateAll((imgs) => imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0));
  }

  test('adds a Komga server on the sources page, then reads and syncs progress', async ({ context, ext, request }) => {
    await ext.getByRole('button', { name: '+ add source' }).click();
    const dialog = ext.getByRole('dialog');
    await expect(dialog.getByRole('tab', { name: 'media server' })).toHaveAttribute('aria-selected', 'true');
    await dialog.locator('#server-kind').selectOption('komga');
    await dialog.locator('#server-url').fill(`${KOMGA}/`);
    await dialog.locator('#server-key').fill('wrong-key');
    await dialog.getByRole('button', { name: 'connect' }).click();
    // Errors show in the dialog, next to the form, which stays open.
    await expect(dialog.locator('#dialog-message')).toContainText('rejected the login');

    await dialog.locator('#server-key').fill('komga-test-key');
    await dialog.getByRole('button', { name: 'connect' }).click();
    await expect(dialog).toBeHidden();
    await expect(ext.locator('#message')).toHaveText('connected to Komga (localhost:4173) as reader@example.org. its series are now in search and explore.');
    await expect(ext.locator('#servers')).toContainText('Komga (localhost:4173)');
    // Servers have their own section, not the list of installed site sources.
    await expect(ext.locator('#configs')).not.toContainText('Komga');

    // Book 1 is already read on the server, so the series starts with one unread.
    await call(ext, { type: 'addSeries', url: `${KOMGA}/series/S1` });
    const entry = async () => (await call<LibraryItem[]>(ext, { type: 'library' })).find((i) => i.entry.series.siteId === KOMGA_ID)!;
    expect((await entry()).unread).toBe(1);
    expect((await entry()).next?.title).toBe('Departure');

    const reader = await openServerChapter(context, ext, `${KOMGA}/book/B2`);
    await expect(reader.locator('.overlay .title')).toHaveText('Departure');
    await expect(reader.locator('.overlay .webtoon img')).toHaveCount(2);
    // Includes the page Komga has to convert, which the browser couldn't show as stored.
    await expect.poll(() => imagesLoaded(reader)).toBe(true);
    await expect.poll(async () => (await entry()).unread).toBe(0);
    await expect
      .poll(async () => (await (await request.get(`${KOMGA}/api/v1/books/B2`, { headers: { 'X-API-Key': 'komga-test-key' } })).json()).readProgress?.completed)
      .toBe(true);

    // Previous book loads in place, keeping the address in sync.
    await reader.keyboard.press('p');
    await expect(reader.locator('.overlay .title')).toHaveText('Arrival');
    await expect(reader).toHaveURL(new RegExp(`url=${encodeURIComponent(`${KOMGA}/book/B1`)}`));
    await expect(reader.locator('.overlay .webtoon img')).toHaveCount(3);
  });

  test('reads a Kavita EPUB as text and finds series through search and explore', async ({ context, ext }) => {
    await call(ext, { type: 'addServer', server: { kind: 'kavita', url: KAVITA, apiKey: 'kavita-test-key', name: 'Kavita at home' } });
    const hits = await call<{ title: string; url: string }[]>(ext, { type: 'search', siteId: KAVITA_ID, query: 'paper' });
    expect(hits.map((h) => h.title)).toEqual(['Paper Stars']);
    const explored = await call<{ hits: { title: string }[] }>(ext, { type: 'explore', siteId: KAVITA_ID, list: 2, page: 1 });
    expect(explored.hits.map((h) => h.title)).toEqual(['Moon Lantern', 'Paper Stars']);

    await call(ext, { type: 'addSeries', url: hits[0]!.url });
    const reader = await openServerChapter(context, ext, `${KAVITA}/library/2/series/2/chapter/21?part=1`);
    await expect(reader).toHaveTitle('One · onidoku');
    // The chapter's own heading repeats its title, so only the text and the list show.
    await expect(reader.locator('.overlay article.text p')).toHaveText(['Paper stars only shine indoors.']);
    await expect(reader.locator('.overlay article.text ol li')).toHaveText(['Fold', 'Wait']);
    await reader.keyboard.press('n');
    await expect(reader).toHaveTitle('Two · onidoku');
    await expect(reader.locator('.overlay article.text p')).toHaveText(['She folded one more before sleeping.']);
  });

  test('splits a Komga EPUB into chapters and keeps its formatting', async ({ context, ext }) => {
    await call(ext, { type: 'addServer', server: { kind: 'komga', url: KOMGA, apiKey: 'komga-test-key' } });
    await call(ext, { type: 'addSeries', url: `${KOMGA}/series/S2` });
    const item = (await call<LibraryItem[]>(ext, { type: 'library' })).find((i) => i.entry.series.siteId === KOMGA_ID)!;
    expect(item.entry.chapters.map((c) => c.title)).toEqual(['Chapter One: Night', 'Chapter Two: Morning', 'Chapter Three: Noon']);

    const reader = await openServerChapter(context, ext, `${KOMGA}/book/B3?part=1`);
    const text = reader.locator('.overlay article.text');
    await expect(text.locator('h1')).toHaveText('Chapter One: Night');
    await expect(text.locator('blockquote')).toHaveText('Hush, said the shelves.');
    await expect(text.locator('ul li')).toHaveText(['Lamps', 'Books', 'Old ones']);
    // The book's image loads with the server login.
    await expect.poll(() => text.locator('figure img').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await reader.keyboard.press('n');
    await expect(text.locator('pre')).toHaveText('catalog --sort\n  by-title');
    await expect(text).not.toContainText('Nobody noticed');
  });

  test('shows server covers in the library and finds new books in update checks', async ({ context, ext, request }) => {
    await call(ext, { type: 'addServer', server: { kind: 'komga', url: KOMGA, apiKey: 'komga-test-key' } });
    await call(ext, { type: 'addSeries', url: `${KOMGA}/series/S1` });

    const library = await context.newPage();
    await library.goto(ext.url().replace('options.html', 'library.html'));
    const cover = library.locator('.tile img').first();
    await expect.poll(() => cover.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await cover.getAttribute('src')).toMatch(/^blob:/);

    await request.get(`${SITE}/__admin/komga/add-book?series=S1`);
    const result = await call<CheckResult>(ext, { type: 'checkNow' });
    expect(result.failures).toEqual([]);
    expect(result.updated).toBe(1);
  });

  test('keeps server logins out of backups', async ({ ext }) => {
    await call(ext, { type: 'addServer', server: { kind: 'kavita', url: KAVITA, apiKey: 'kavita-test-key' } });
    const backup = await call<{ sources: { id: string }[] }>(ext, { type: 'exportBackup' });
    expect(JSON.stringify(backup)).not.toContain('kavita-test-key');
    expect(backup.sources.map((s) => s.id)).not.toContain(KAVITA_ID);
  });
});

test.describe('paperback sources', () => {
  const REPO = `${SITE}/paperback`;
  const ID = 'pb.testcomics';
  const manga = (id: string) => `https://paperback.invalid/${ID}/manga/${id}`;
  const chapter = (id: string, n: number) => `https://paperback.invalid/${ID}/chapter/${id}/c${n}`;

  async function install(ext: Page): Promise<void> {
    await call(ext, { type: 'installPaperback', repo: REPO, sourceId: 'TestComics' });
  }

  async function imagesLoaded(page: Page): Promise<boolean> {
    return page.locator('.overlay .webtoon img').evaluateAll((imgs) => imgs.length > 0 && imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0));
  }

  test('installs a source from a repo on the sources page, then searches and explores it', async ({ ext }) => {
    // Installing asks for access to all sites; the test browser can't answer prompts.
    await ext.evaluate(() => (chrome.permissions.request = async () => true));
    await ext.getByRole('button', { name: '+ add source' }).click();
    const dialog = ext.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Paperback repo' }).click();
    await dialog.locator('#paperback-url').fill(`${SITE}/nothing-here`);
    await dialog.getByRole('button', { name: 'list sources' }).click();
    await expect(dialog.locator('#dialog-message')).toContainText('no Paperback repo at that address');

    await dialog.locator('#paperback-url').fill(`${REPO}/versioning.json`);
    await dialog.getByRole('button', { name: 'list sources' }).click();
    const listed = dialog.locator('#paperback-listing li', { hasText: 'Test Comics (Paperback)' });
    await expect(listed).toContainText('localhost:4173 · v1.0.0 · by onidoku tests');
    await listed.getByRole('button', { name: 'install' }).click();
    await expect(listed).toContainText('installed');
    await expect(ext.locator('#message')).toHaveText('installed Test Comics (Paperback). it’s now in search and explore.');
    // With one left to install, there's no "install all"; install it on its own.
    await expect(dialog.getByRole('button', { name: /install all/ })).toHaveCount(0);
    // Its own section, not the list of site configs.
    await expect(ext.locator('#paperback')).toContainText('from localhost:4173/paperback');
    await expect(ext.locator('#configs')).not.toContainText('Test Comics');

    const hits = await call<{ title: string; url: string; cover?: string }[]>(ext, { type: 'search', siteId: ID, query: 'iron' });
    expect(hits).toEqual([expect.objectContaining({ title: 'Iron Tide', url: manga('iron-tide'), cover: `${SITE}/covers/iron-tide.svg` })]);
    const popular = await call<{ hits: { title: string }[]; hasMore: boolean }>(ext, { type: 'explore', siteId: ID, list: 0, page: 1 });
    expect(popular).toMatchObject({ hits: [{ title: 'Long Road' }, { title: 'Moon Garden' }], hasMore: true });
    const next = await call<{ hits: { title: string }[] }>(ext, { type: 'explore', siteId: ID, list: 0, page: 2 });
    expect(next.hits.map((h) => h.title)).toEqual(['Iron Tide']);
  });

  test('offers to add a repo found on a page, and opens its "add to Paperback" link in onidoku', async ({ context, worker }) => {
    // What turning on "offer the reader on any site" registers; the test browser can't grant access to all sites.
    await worker.evaluate(() => chrome.scripting.registerContentScripts([{ id: 'detect-test', js: ['detect.js'], matches: ['http://localhost:4173/paperback/*'], runAt: 'document_idle' }]));
    const page = await context.newPage();
    await page.goto(`${SITE}/paperback/`);
    await expect(page.locator('.od-prompt')).toContainText('this page has a Paperback repo: Test Repo.');

    const listed = async (options: Page) => {
      await expect(options).toHaveURL(/options\.html#add-paperback=/);
      await expect(options.locator('#paperback-url')).toHaveValue(REPO);
      await expect(options.locator('#paperback-listing li', { hasText: 'Test Comics (Paperback)' })).toContainText('install');
      await options.close();
    };
    let opened = context.waitForEvent('page');
    await page.getByRole('button', { name: 'add to onidoku' }).click();
    await listed(await opened);
    await expect(page.locator('.od-prompt')).toHaveCount(0);

    opened = context.waitForEvent('page');
    await page.getByRole('link', { name: 'Add to Paperback' }).click();
    await listed(await opened);
  });

  test('installs every source of a repo at once', async ({ ext }) => {
    await ext.evaluate(() => (chrome.permissions.request = async () => true));
    await ext.getByRole('button', { name: '+ add source' }).click();
    const dialog = ext.getByRole('dialog');
    await dialog.getByRole('tab', { name: 'Paperback repo' }).click();
    await dialog.locator('#paperback-url').fill(REPO);
    await dialog.getByRole('button', { name: 'list sources' }).click();
    await expect(dialog.locator('.listing-all')).toContainText('2 sources, 2 not installed or out of date.');
    await dialog.getByRole('button', { name: 'install all 2' }).click();
    await expect(ext.locator('#message')).toHaveText('installed 2 sources from localhost:4173/paperback.');
    await expect(dialog.locator('#paperback-listing .config-actions', { hasText: /^installed$/ })).toHaveCount(2);
    await expect(dialog.locator('.listing-all')).toHaveCount(0);
    await expect(ext.locator('#paperback li')).toHaveCount(2);
    // Each runs as its own source.
    const hits = await call<{ title: string }[]>(ext, { type: 'search', siteId: 'pb.testcomicslite', query: 'moon' });
    expect(hits.map((h) => h.title)).toEqual(['Moon Garden']);
  });

  test('reads chapters on the reader page, with the headers the site requires', async ({ context, ext }) => {
    await install(ext);
    await call(ext, { type: 'addSeries', url: manga('moon-garden') });
    const item = (await call<LibraryItem[]>(ext, { type: 'library' })).find((i) => i.entry.series.siteId === ID)!;
    expect(item.entry.series).toMatchObject({ title: 'Moon Garden', authors: ['Ana Ruiz', 'Ken Ito'], genres: ['Fantasy', 'Slice of life'] });
    expect(item.entry.chapters.map((c) => c.title).slice(0, 2)).toEqual(['Chapter 1: The Beginning', 'Chapter 2']);

    // The details page links to the title's own page, the URL the source shares.
    const details = await extPage(context, ext, `details.html?id=${encodeURIComponent(item.entry.series.id)}`);
    await expect(details.locator('.source-link')).toHaveAttribute('href', `${SITE}/series/moon-garden`);
    await details.close();

    const reader = await context.newPage();
    await reader.goto(ext.url());
    void reader.evaluate((r) => chrome.runtime.sendMessage(r), { type: 'openChapter', url: chapter('moon-garden', 1), reader: true } satisfies Request).catch(() => undefined);
    await expect(reader).toHaveURL(/\/reader\.html\?url=/);
    await expect(reader.locator('.overlay .webtoon img')).toHaveCount(6);
    // The test site refuses these images without its referer, which the source's interceptor adds.
    await expect.poll(() => imagesLoaded(reader)).toBe(true);
    await expect.poll(async () => (await call<LibraryItem[]>(ext, { type: 'library' })).find((i) => i.entry.series.siteId === ID)!.unread).toBe(4);

    // The next chapter loads in place.
    await reader.keyboard.press('n');
    await expect(reader).toHaveURL(new RegExp(`url=${encodeURIComponent(chapter('moon-garden', 2))}`));
    await expect.poll(() => imagesLoaded(reader)).toBe(true);
  });

  test('finds new chapters in update checks, and cleans up when removed', async ({ ext, worker, request }) => {
    await install(ext);
    await call(ext, { type: 'addSeries', url: manga('iron-tide') });
    await request.get(`${SITE}/__admin/add-chapter?series=iron-tide`);
    const result = await call<CheckResult>(ext, { type: 'checkNow' });
    expect(result.failures).toEqual([]);
    expect(result.updated).toBe(1);

    expect(await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length))).toBeGreaterThan(0);
    await call(ext, { type: 'removeConfig', id: ID });
    expect(await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules().then((r) => r.length))).toBe(0);
    const stored = await worker.evaluate(() => chrome.storage.local.get(null));
    expect(Object.keys(stored).filter((k) => k.startsWith('paperback') && k !== 'paperbackImageRules')).toEqual(['paperbackSources']);
    expect(stored.paperbackSources).toEqual([]);
    // Its series stay in the library, unreadable until it's back.
    expect((await call<LibraryItem[]>(ext, { type: 'library' })).map((i) => i.entry.series.title)).toContain('Iron Tide');
  });
});

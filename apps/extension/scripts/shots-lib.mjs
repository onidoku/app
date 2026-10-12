// Shared by the screenshot scripts (site-shots.mjs, store-shots.mjs): a release build of the extension, loaded
// into Chromium with a demo library from Pepper&Carrot (CC BY 4.0) and Standard Ebooks (public domain).
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

export const PC = 'https://www.peppercarrot.com';
export const SE = 'https://standardebooks.org';
export const BOOKS = [
  'jane-austen/pride-and-prejudice',
  'mary-shelley/frankenstein',
  'bram-stoker/dracula',
  'f-scott-fitzgerald/the-great-gatsby',
  'oscar-wilde/the-picture-of-dorian-gray',
  'robert-louis-stevenson/treasure-island',
  'h-g-wells/the-time-machine',
  'arthur-conan-doyle/the-adventures-of-sherlock-holmes',
];
export const COMIC_CHAPTER = `${PC}/en/webcomic/ep01_Potion-of-Flight.html`;
export const NOVEL_CHAPTER = `${SE}/ebooks/${BOOKS[0]}/text/chapter-1`;
export const READER_PREFS = {
  mode: 'webtoon', fit: 'height', stripWidth: 720, gap: false, backdrop: 'black', fontSize: 20, lineHeight: 1.75,
  font: 'serif', textWidth: 64, justify: false, theme: 'dark', autoHide: false,
};

/** Builds the release extension and opens it in Chromium, pre-granted the two demo sites. */
export async function launchExtension({ deviceScaleFactor = 2 } = {}) {
  execFileSync('node', ['build.mjs'], { stdio: 'inherit' });
  const ext = join(tmpdir(), 'onidoku-shots-ext');
  await rm(ext, { recursive: true, force: true });
  await cp('dist', ext, { recursive: true });
  const manifest = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
  manifest.host_permissions = [`${PC}/*`, `${SE}/*`];
  await writeFile(join(ext, 'manifest.json'), JSON.stringify(manifest));

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor,
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const base = `chrome-extension://${new URL(worker.url()).host}/`;
  const ctl = await context.newPage();
  await ctl.goto(`${base}options.html`);
  async function call(request) {
    const res = await ctl.evaluate((r) => chrome.runtime.sendMessage(r), request);
    if (!res.ok) throw new Error(`${request.type}: ${res.error}`);
    return res.data;
  }
  return { context, worker, base, call };
}

/** Installs the featured sources and fills the library, with some series part-read. */
export async function setupLibrary(call) {
  for (const f of ['peppercarrot-en.json', 'standardebooks.json'])
    await call({ type: 'installConfig', raw: JSON.parse(await readFile(new URL(`../../../configs/featured/${f}`, import.meta.url), 'utf8')) });
  if ((await call({ type: 'library' })).length === 0) {
    await call({ type: 'addSeries', url: `${PC}/en/webcomics/peppercarrot.html` });
    for (const b of BOOKS) await call({ type: 'addSeries', url: `${SE}/ebooks/${b}` });
  }
  // The last one marked is read most recently, so it leads "continue reading".
  const PROGRESS = [['frankenstein', 6], ['the-great-gatsby', 4], ['pride-and-prejudice', 14], ['dracula', 9], ['peppercarrot', 30]];
  for (const [slug, read] of PROGRESS) {
    const item = (await call({ type: 'library' })).find((s) => s.entry.series.url.includes(slug));
    await call({ type: 'markRead', url: item.entry.chapters[read - 1].url });
    await new Promise((r) => setTimeout(r, 50)); // distinct "last read" times, so the order holds
  }
  const library = await call({ type: 'library' });
  console.log('library:', library.map((s) => `${s.entry.series.title} (${s.unread} unread)`).join(', '));
  return library;
}

/** Opens the reader on onidoku's own page with the given reader settings. */
export async function openReader({ context, worker, base }, url, prefs) {
  await worker.evaluate((p) => chrome.storage.local.set({ readerPrefs: p }), prefs);
  const page = await context.newPage();
  await page.goto(`${base}reader.html?${new URLSearchParams({ url })}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  return page;
}

const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

/** Serves a folder on a free localhost port (fonts don't load from file:// pages). */
export async function serve(dir) {
  const server = createServer(async (req, res) => {
    const file = join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
    try {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

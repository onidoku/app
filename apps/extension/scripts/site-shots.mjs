// Screenshots for the website (the onidoku.github.io repo, checked out next to this one, or $ONIDOKU_SITE),
// taken from a release build of the extension reading Pepper&Carrot (CC BY 4.0) and Standard Ebooks (public domain).
// Run `pnpm --filter @onidoku/extension shots [name...]` (needs network access, `playwright install chromium`
// and `cwebp`). Names limit it to some shots, e.g. `shots library popup`.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const SITE = process.env.ONIDOKU_SITE ?? fileURLToPath(new URL('../../../../onidoku.github.io/', import.meta.url));
if (!existsSync(join(SITE, 'index.html'))) throw new Error(`No website checkout at ${SITE} (set ONIDOKU_SITE)`);
const OUT = join(SITE, 'img');
const PC = 'https://www.peppercarrot.com';
const SE = 'https://standardebooks.org';
const BOOKS = [
  'jane-austen/pride-and-prejudice',
  'mary-shelley/frankenstein',
  'bram-stoker/dracula',
  'f-scott-fitzgerald/the-great-gatsby',
  'oscar-wilde/the-picture-of-dorian-gray',
  'robert-louis-stevenson/treasure-island',
  'h-g-wells/the-time-machine',
  'arthur-conan-doyle/the-adventures-of-sherlock-holmes',
];
const only = process.argv.slice(2);
const want = (name) => only.length === 0 || only.includes(name);

execFileSync('node', ['build.mjs'], { stdio: 'inherit' });
// A copy of the release build, pre-granted the two sites so no permission prompt appears.
const ext = join(tmpdir(), 'onidoku-shots-ext');
await rm(ext, { recursive: true, force: true });
await cp('dist', ext, { recursive: true });
const manifest = JSON.parse(await readFile(join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = [`${PC}/*`, `${SE}/*`];
await writeFile(join(ext, 'manifest.json'), JSON.stringify(manifest));
await mkdir(OUT, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
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

for (const f of ['peppercarrot-en.json', 'standardebooks.json'])
  await call({ type: 'installConfig', raw: JSON.parse(await readFile(new URL(`../../../configs/featured/${f}`, import.meta.url), 'utf8')) });

const library = await call({ type: 'library' });
if (library.length === 0) {
  await call({ type: 'addSeries', url: `${PC}/en/webcomics/peppercarrot.html` });
  for (const b of BOOKS) await call({ type: 'addSeries', url: `${SE}/ebooks/${b}` });
}
// Some reading progress, so the library has series in every state. The last one set is read most recently.
const PROGRESS = [['frankenstein', 6], ['the-great-gatsby', 4], ['pride-and-prejudice', 14], ['dracula', 9], ['peppercarrot', 30]];
for (const [slug, read] of PROGRESS) {
  const item = (await call({ type: 'library' })).find((s) => s.entry.series.url.includes(slug));
  await call({ type: 'markRead', url: item.entry.chapters[read - 1].url });
}
/** Saves a screenshot as WebP: the 2x PNGs are several MB each. */
async function save(page, name, options = {}) {
  const png = join(tmpdir(), `onidoku-${name}.png`);
  await page.screenshot({ path: png, ...options });
  execFileSync('cwebp', ['-quiet', '-q', '82', png, '-o', join(OUT, `${name}.webp`)]);
  await rm(png);
}

console.log('library:', (await call({ type: 'library' })).map((s) => `${s.entry.series.title} (${s.unread} unread)`).join(', '));

/** Screenshot an extension page in light and dark. */
async function shoot(name, path, { width = 1120, height = 720, ready, full = false } = {}) {
  if (!want(name)) return;
  for (const scheme of ['light', 'dark']) {
    const page = await context.newPage();
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width, height });
    await page.goto(base + path);
    if (ready) await ready(page);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(800);
    await save(page, `${name}-${scheme}`, { fullPage: full });
    await page.close();
  }
  console.log('shot', name);
}

await shoot('library', 'library.html', { ready: (p) => p.locator('img').first().waitFor() });
await shoot('popup', 'popup.html', { width: 360, height: 580 });
await shoot('explore', `explore.html?source=standardebooks`, { ready: (p) => p.locator('img').nth(4).waitFor() });
await shoot('sources', 'options.html');

/** The reader on onidoku's own page, with the given reader settings. */
async function reader(name, url, prefs) {
  if (!want(name)) return;
  await worker.evaluate((p) => chrome.storage.local.set({ readerPrefs: p }), prefs);
  const page = await context.newPage();
  await page.goto(`${base}reader.html?${new URLSearchParams({ url })}`);
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  await save(page, name);
  await page.close();
  console.log('shot', name);
}

const PREFS = { mode: 'webtoon', fit: 'height', stripWidth: 720, gap: false, backdrop: 'black', fontSize: 20, lineHeight: 1.75, font: 'serif', textWidth: 64, justify: false, theme: 'dark', autoHide: false };
await reader('reader-comic', `${PC}/en/webcomic/ep01_Potion-of-Flight.html`, PREFS);
await reader('reader-novel', `${SE}/ebooks/${BOOKS[0]}/text/chapter-1`, { ...PREFS, theme: 'sepia' });

await context.close();

// The social preview card (og:image): the site's own hero, so run this after the shots above.
if (want('og')) {
  const types = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
  const server = createServer(async (req, res) => {
    const file = join(SITE, new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
    try {
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  }).listen(0);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: 'dark' });
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.addStyleTag({ content: '.nav { display: none } .hero { padding-top: 64px }' });
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: join(OUT, 'og.png') });
  await browser.close();
  server.close();
  console.log('shot og');
}

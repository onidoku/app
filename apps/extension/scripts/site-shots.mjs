// Screenshots for the website (the onidoku.github.io repo, checked out next to this one, or $ONIDOKU_SITE),
// taken from a release build of the extension reading Pepper&Carrot (CC BY 4.0) and Standard Ebooks (public domain).
// Run `pnpm --filter @onidoku/extension shots [name...]` (needs network access, `playwright install chromium`
// and `cwebp`). Names limit it to some shots, e.g. `shots library popup`.
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { COMIC_CHAPTER, NOVEL_CHAPTER, READER_PREFS, launchExtension, openReader, serve, setupLibrary } from './shots-lib.mjs';

const SITE = process.env.ONIDOKU_SITE ?? fileURLToPath(new URL('../../../../onidoku.github.io/', import.meta.url));
if (!existsSync(join(SITE, 'index.html'))) throw new Error(`No website checkout at ${SITE} (set ONIDOKU_SITE)`);
const OUT = join(SITE, 'img');
const only = process.argv.slice(2);
const want = (name) => only.length === 0 || only.includes(name);

await mkdir(OUT, { recursive: true });
const ext = await launchExtension();
const { context, base, call } = ext;
await setupLibrary(call);

/** Saves a screenshot as WebP: the 2x PNGs are several MB each. */
async function save(page, name, options = {}) {
  const png = join(tmpdir(), `onidoku-${name}.png`);
  await page.screenshot({ path: png, ...options });
  execFileSync('cwebp', ['-quiet', '-q', '82', png, '-o', join(OUT, `${name}.webp`)]);
  await rm(png);
}

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

async function reader(name, url, prefs) {
  if (!want(name)) return;
  const page = await openReader(ext, url, prefs);
  await save(page, name);
  await page.close();
  console.log('shot', name);
}

await reader('reader-comic', COMIC_CHAPTER, READER_PREFS);
await reader('reader-novel', NOVEL_CHAPTER, { ...READER_PREFS, theme: 'sepia' });

await context.close();

// The social preview card (og:image): the site's own hero, so run this after the shots above.
if (want('og')) {
  const site = await serve(SITE);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, colorScheme: 'dark' });
  await page.goto(site.url);
  await page.addStyleTag({ content: '.nav { display: none } .hero { padding-top: 64px }' });
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: join(OUT, 'og.png') });
  await browser.close();
  site.close();
  console.log('shot og');
}

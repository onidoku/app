// Store screenshots and promo tiles: real screenshots of the release extension, dropped into the branded
// slides in store/promo/ with callouts on the UI elements they point at.
//   pnpm --filter @onidoku/extension store-shots          capture the extension, then render
//   pnpm --filter @onidoku/extension store-shots --render  re-render from the last capture (after design edits)
// Writes store/screenshots/firefox/ (2400x1800, AMO's maximum) and store/screenshots/chrome/ (1280x800, plus
// the 440x280 and 1400x560 promo tiles). Needs network access and `playwright install chromium`.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { COMIC_CHAPTER, NOVEL_CHAPTER, READER_PREFS, launchExtension, openReader, serve, setupLibrary } from './shots-lib.mjs';

const PROMO = fileURLToPath(new URL('../store/promo/', import.meta.url));
const SHOTS = join(PROMO, 'shots');
const OUT = fileURLToPath(new URL('../store/screenshots/', import.meta.url));

if (!process.argv.includes('--render')) await capture();
await render();

/** Screenshots of the extension, and where the highlighted elements are in each (CSS px). */
async function capture() {
  await rm(SHOTS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });
  const ext = await launchExtension();
  const { context, base, call } = ext;
  await setupLibrary(call);
  const data = {};

  // Finds elements in the page and in shadow roots (the reader lives in one), and returns their bounding box.
  const rectOf = (page, selector, { index = 0, union = false } = {}) =>
    page.evaluate(
      ([selector, index, union]) => {
        const found = [];
        const search = (root) => {
          found.push(...root.querySelectorAll(selector));
          for (const e of root.querySelectorAll('*')) if (e.shadowRoot) search(e.shadowRoot);
        };
        search(document);
        const els = union ? found : [found[index]];
        if (!els[0]) throw new Error(`no element for ${selector}`);
        const rs = els.map((e) => e.getBoundingClientRect());
        const x = Math.min(...rs.map((r) => r.left));
        const y = Math.min(...rs.map((r) => r.top));
        return [x, y, Math.max(...rs.map((r) => r.right)) - x, Math.max(...rs.map((r) => r.bottom)) - y].map(Math.round);
      },
      [selector, index, union],
    );

  async function save(name, page, rects = {}, { element } = {}) {
    const target = element ? page.locator(element).first() : page;
    await target.screenshot({ path: join(SHOTS, `${name}.png`) });
    const size = element ? await page.locator(element).first().boundingBox() : page.viewportSize();
    const out = {};
    for (const [key, [selector, opts]] of Object.entries(rects)) out[key] = await rectOf(page, selector, opts);
    data[name] = { w: Math.round(size.width), h: Math.round(size.height), rects: out };
    console.log('captured', name, JSON.stringify(out));
  }

  async function page(path, { width = 1120, height = 700, scheme = 'light', ready } = {}) {
    const p = await context.newPage();
    await p.emulateMedia({ colorScheme: scheme });
    await p.setViewportSize({ width, height });
    await p.goto(base + path);
    if (ready) await ready(p);
    await p.waitForLoadState('networkidle').catch(() => {});
    await p.waitForTimeout(900);
    return p;
  }

  // Reader: a long-strip comic, and a novel with the settings panel open.
  let p = await openReader(ext, COMIC_CHAPTER, READER_PREFS);
  await save('reader-comic', p, { strip: ['.view img', { index: 1 }] });
  await p.close();
  p = await openReader(ext, NOVEL_CHAPTER, { ...READER_PREFS, theme: 'sepia' });
  await p.keyboard.press('s');
  await p.waitForTimeout(700);
  await save('reader-settings', p, { theme: ['.panel .field', { index: 0 }], type: ['.panel .field:nth-of-type(n+3):nth-of-type(-n+6)', { union: true }] });
  await p.close();

  p = await page('library.html', { ready: (p) => p.locator('img.cover').first().waitFor() });
  await save('library', p, { shelf: ['section.shelf'], chips: ['.filter-chips button', { union: true }], tile: ['li.tile .tile-cover'] });
  await p.close();

  for (const scheme of ['light', 'dark']) {
    p = await page('popup.html', { width: 360, height: 580, scheme });
    await save(`popup-${scheme}`, p, { refresh: ['.pop-bar-actions button'], first: ['#library > *', { index: 0 }] });
    await p.close();
  }

  p = await page('explore.html?source=standardebooks', { ready: (p) => p.locator('.tile img').nth(6).waitFor() });
  // The note about Pepper&Carrot having no explore lists isn't relevant here.
  await p.addStyleTag({ content: 'main > p.hint { display: none }' });
  await p.waitForTimeout(300);
  await save('explore', p, { tabs: ['.tabs button', { union: true }], done: ['.tile.in-library .tile-action.done', { index: 0 }] });
  await p.close();

  p = await page('options.html');
  await p.click('#add-server-open');
  await p.waitForTimeout(600);
  await save('server-dialog', p, {}, { element: 'dialog[open]' });
  await p.close();

  await context.close();
  await writeFile(join(SHOTS, 'data.json'), JSON.stringify(data, null, 2));
}

/** Renders each slide for each store. */
async function render() {
  const site = await serve(PROMO);
  const browser = await chromium.launch();
  const jobs = [
    // AMO: up to 2400x1800, PNG recommended. 4:3 layout at 2x.
    ...['hero', 'reader', 'library', 'alerts', 'sources', 'privacy'].map((slide, i) => ({
      slide, file: `firefox/${String(i + 1).padStart(2, '0')}-${slide}.png`, width: 1200, height: 900, scale: 2,
    })),
    // Chrome Web Store: exactly 1280x800, at most 5. Edge takes the same files.
    ...['hero', 'reader', 'library', 'alerts', 'sources'].map((slide, i) => ({
      slide, file: `chrome/${String(i + 1).padStart(2, '0')}-${slide}.png`, width: 1280, height: 800, scale: 1,
    })),
    { slide: 'tile', file: 'chrome/promo-small-440x280.png', width: 440, height: 280, scale: 1 },
    { slide: 'hero', file: 'chrome/promo-marquee-1400x560.png', width: 1400, height: 560, scale: 1 },
  ];
  await rm(OUT, { recursive: true, force: true });
  for (const dir of ['firefox', 'chrome']) await mkdir(join(OUT, dir), { recursive: true });
  for (const { slide, file, width, height, scale } of jobs) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
    page.on('pageerror', (e) => console.error(slide, e.message));
    await page.goto(`${site.url}slides.html?slide=${slide}`);
    await page.waitForSelector('body[data-ready]');
    await page.screenshot({ path: join(OUT, file) });
    await page.close();
    console.log('rendered', file);
  }
  await browser.close();
  site.close();
}

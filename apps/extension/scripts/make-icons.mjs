// Renders the extension icons from art/logo.svg (and art/logo-small.svg, the same cat zoomed in a
// little so the glasses stay big, for toolbar sizes) using Playwright's Chromium. Run after editing the SVGs:
//   pnpm --filter @onidoku/extension icons
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const art = (f) => readFileSync(new URL(`../art/${f}`, import.meta.url), 'utf8');
const COPY = { 'static/icons/logo.svg': 'logo-small.svg' };
const SIZES = { 16: 'logo-small.svg', 32: 'logo-small.svg', 48: 'logo.svg', 64: 'logo.svg', 96: 'logo.svg', 128: 'logo.svg' };
// Extra renders for store listings and the README; not shipped in the extension.
const STORE = { 'store/images/icon-512.png': 512, 'store/images/icon-300.png': 300 };

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

for (const [size, file] of Object.entries(SIZES)) {
  writeFileSync(new URL(`../static/icons/icon-${size}.png`, import.meta.url), await render(art(file), Number(size)));
}
for (const [out, size] of Object.entries(STORE)) {
  writeFileSync(new URL(`../${out}`, import.meta.url), await render(art('logo.svg'), size));
}
for (const [out, file] of Object.entries(COPY)) writeFileSync(new URL(`../${out}`, import.meta.url), art(file));
await browser.close();
console.log('Icons written to static/icons/ and store/images/');

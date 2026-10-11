import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');
const target = process.argv.find((a) => a.startsWith('--target='))?.slice('--target='.length) ?? 'chrome';
if (!['chrome', 'firefox'].includes(target)) throw new Error(`Unknown --target=${target} (use chrome or firefox)`);
const outdir = target === 'firefox' ? 'dist-firefox' : 'dist';
const paperback = target === 'chrome';
const PAPERBACK_PERMISSIONS = ['offscreen', 'declarativeNetRequestWithHostAccess', 'cookies'];
const PAPERBACK_PAGES = ['paperback-sandbox', 'paperback-host'];

/** One source manifest; the browser-specific differences are applied here. */
function manifestFor(manifest) {
  if (dev) {
    manifest.name += ' (dev)';
    // Pre-grant the local test site so automated tests never hit a permission prompt.
    manifest.host_permissions = ['http://localhost:4173/*'];
  }
  if (target === 'firefox') {
    delete manifest.minimum_chrome_version;
    // Paperback sources are Chrome-only: Firefox has no offscreen documents, and AMO doesn't
    // accept add-ons that run downloaded code.
    delete manifest.sandbox;
    delete manifest.content_security_policy;
    manifest.permissions = manifest.permissions.filter((p) => !PAPERBACK_PERMISSIONS.includes(p));
    // Firefox's MV3 background is an event page rather than a service worker.
    manifest.background = { scripts: ['background.js'] };
    manifest.browser_specific_settings = {
      gecko: {
        id: 'onidoku@proton.me',
        strict_min_version: '140.0',
        // Everything stays in the browser; nothing is sent to us.
        data_collection_permissions: { required: ['none'] },
      },
      // Android only understands data_collection_permissions from 142.
      gecko_android: { strict_min_version: '142.0' },
    };
  }
  return manifest;
}

// Release builds ship with no site configs at all; users add them. Dev builds preinstall the
// configs for the local test site so the extension is usable immediately.
async function devConfigs() {
  if (!dev) return [];
  const dir = new URL('../../configs/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.startsWith('testsite.') && f.endsWith('.json'));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(new URL(f, dir), 'utf8'))));
}

// Sources for public-domain and openly licensed sites (configs/featured/), offered on the Sources
// page in every build. Nothing is installed until the user picks one.
async function featuredConfigs() {
  const dir = new URL('../../configs/featured/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(new URL(f, dir), 'utf8'))));
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp('static', outdir, { recursive: true });
if (!paperback) for (const page of PAPERBACK_PAGES) await rm(`${outdir}/${page}.html`);

const manifestPath = `${outdir}/manifest.json`;
await writeFile(manifestPath, JSON.stringify(manifestFor(JSON.parse(await readFile(manifestPath, 'utf8'))), null, 2));

const ctx = await esbuild.context({
  entryPoints: {
    background: 'src/background.ts',
    content: 'src/content.ts',
    prompt: 'src/prompt.ts',
    detect: 'src/detect.ts',
    probe: 'src/probe.ts',
    popup: 'src/popup.ts',
    details: 'src/details.ts',
    options: 'src/options.ts',
    library: 'src/library.ts',
    search: 'src/search.ts',
    explore: 'src/explore.ts',
    'reader-page': 'src/reader-page.ts',
    // The sandboxed frame Paperback sources run in, and the offscreen page holding those frames.
    ...(paperback ? Object.fromEntries(PAPERBACK_PAGES.map((page) => [page, `src/${page}.ts`])) : {}),
  },
  outdir,
  bundle: true,
  // Content scripts injected with scripting.executeScript can't be ES modules, so use IIFE everywhere.
  format: 'iife',
  target: ['chrome120', 'firefox140'],
  // Picks browser-specific modules from package.json "imports" (e.g. #parse-html).
  conditions: target === 'firefox' ? ['firefox'] : [],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  define: {
    __DEV__: JSON.stringify(dev),
    __DEV_CONFIGS__: JSON.stringify(await devConfigs()),
    __FEATURED_CONFIGS__: JSON.stringify(await featuredConfigs()),
    __PAPERBACK__: JSON.stringify(paperback),
  },
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('Watching src/ (restart for changes in static/). Reload the extension in chrome://extensions after edits.');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}

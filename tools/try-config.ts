// Runs a site config against a live URL from the terminal, to check selectors before
// installing the config in the browser.
//
//   pnpm try-config configs/featured/standardebooks.json https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice
//   pnpm try-config configs/featured/standardebooks.json --search "pride and prejudice"
//   pnpm try-config my-site.json --browse genres "Slice of life"
//   pnpm try-config my-site.json --browse authors some-author --link https://example.com/author/some-author
//   pnpm try-config configs/featured/standardebooks.json --explore Popular [--page 2]
//
// Sites with bot protection may refuse Node's requests (HTTP 403) even though they work in the
// browser. Save the page from the browser (Ctrl+S) and pass it with --html <file>; the URL is
// still needed to pick the page kind and resolve relative links.
import { readFile } from 'node:fs/promises';
import { DOMParser } from 'linkedom';
import { browseSeries, browseUrl, exploreSeries, exploreUrl, fetchRetrying, httpError, extractList, extractSearch, loadChapter, loadSeries, parseSiteConfig, searchSeries, searchUrl, SiteConfigError, SiteRegistry, type HtmlIO } from '@onidoku/core';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const args = process.argv.slice(2);
const htmlFlag = args.indexOf('--html');
const htmlPath = htmlFlag >= 0 ? args.splice(htmlFlag, 2)[1] : undefined;
const searchFlag = args.indexOf('--search');
const query = searchFlag >= 0 ? args.splice(searchFlag, 2)[1] : undefined;
const browseFlag = args.indexOf('--browse');
const [browseKind, browseName] = browseFlag >= 0 ? args.splice(browseFlag, 3).slice(1) : [];
const linkFlag = args.indexOf('--link');
const browseLink = linkFlag >= 0 ? args.splice(linkFlag, 2)[1] : undefined;
const exploreFlag = args.indexOf('--explore');
const exploreName = exploreFlag >= 0 ? args.splice(exploreFlag, 2)[1] : undefined;
const pageFlag = args.indexOf('--page');
const explorePage = pageFlag >= 0 ? Number(args.splice(pageFlag, 2)[1]) || 1 : 1;
const [configPath, url] = args;
if (browseFlag >= 0 && (!browseName || (browseKind !== 'authors' && browseKind !== 'genres'))) {
  console.error('Usage: pnpm try-config <config.json> --browse authors|genres <name> [--link <url>] [--html saved.html]');
  process.exit(2);
}
if (exploreFlag >= 0 && !exploreName) {
  console.error('Usage: pnpm try-config <config.json> --explore <list name> [--page <n>] [--html saved.html]');
  process.exit(2);
}
if (!configPath || (!url && !query && !browseName && !exploreName) || (htmlFlag >= 0 && !htmlPath) || (searchFlag >= 0 && !query)) {
  console.error('Usage: pnpm try-config <config.json> <series-or-chapter-url> [--html saved-page.html]');
  console.error('       pnpm try-config <config.json> --search <query>');
  process.exit(2);
}

const sample = <T>(items: T[], n = 3): (T | string)[] =>
  items.length <= n * 2 ? items : [...items.slice(0, n), `… ${items.length - n * 2} more …`, ...items.slice(-n)];

async function main(): Promise<void> {
  const config = parseSiteConfig(JSON.parse(await readFile(configPath!, 'utf8')));
  console.log(`${config.name} v${config.version} by ${config.developer}${config.nsfw ? ' · 18+' : ''}`);
  const io: HtmlIO = { fetchHtml, parseHtml: (html) => new DOMParser().parseFromString(html, 'text/html') as unknown as Document };

  if (browseName) {
    const kind = browseKind as 'authors' | 'genres';
    const results = htmlPath
      ? extractList(io.parseHtml(await readFile(htmlPath, 'utf8'), ''), browseUrl(config, kind, browseName, browseLink) ?? '', config, config.browse![kind]!)
      : (await browseSeries(config, kind, browseName, io, browseLink)).results;
    console.log(`\n${browseUrl(config, kind, browseName, browseLink)}\n${results.length} titles:`);
    for (const r of sample(results)) console.log(typeof r === 'string' ? `  ${r}` : `  ${r.title}  ${r.url}${r.cover ? '' : '  (no cover)'}`);
    return;
  }

  if (exploreName) {
    const index = config.explore?.findIndex((l) => l.name.toLowerCase() === exploreName.toLowerCase()) ?? -1;
    if (index < 0) throw new Error(`No explore list named "${exploreName}". Lists: ${config.explore?.map((l) => l.name).join(', ') || 'none'}`);
    const listUrl = exploreUrl(config, index, explorePage)!;
    const results = htmlPath
      ? extractList(io.parseHtml(await readFile(htmlPath, 'utf8'), ''), listUrl, config, config.explore![index]!)
      : (await exploreSeries(config, index, explorePage, io)).results;
    console.log(`\n${listUrl}\n${results.length} titles:`);
    for (const r of sample(results)) console.log(typeof r === 'string' ? `  ${r}` : `  ${r.title}  ${r.url}${r.cover ? '' : '  (no cover)'}`);
    return;
  }

  if (query !== undefined) {
    const results = htmlPath
      ? extractSearch(io.parseHtml(await readFile(htmlPath, 'utf8'), ''), searchUrl(config, query) ?? '', config)
      : await searchSeries(query, config, io);
    console.log(`\n${results.length} results for "${query}":`);
    for (const r of results) console.log(`  ${r.title}  ${r.url}${r.cover ? '' : '  (no cover)'}`);
    return;
  }

  const match = new SiteRegistry([config]).match(url!);
  if (!match) {
    throw new Error(`URL matches neither glob:\n  series:  ${config.series.url}\n  chapter: ${config.chapter.url}`);
  }

  // --html replaces only the main page; anything the config loads via `from` is still fetched.
  const doc = io.parseHtml(htmlPath ? await readFile(htmlPath, 'utf8') : await fetchHtml(url!), url!);
  console.log(`${config.name} · ${match.kind} page\n`);

  if (match.kind === 'series') {
    const { series, chapters } = await loadSeries(url!, config, io, doc);
    console.log({ ...series, chapters: chapters.length });
    console.log('\nChapters (oldest first):');
    for (const c of sample(chapters)) console.log(typeof c === 'string' ? `  ${c}` : `  ${c.title}  ${c.url}`);
    return;
  }

  const { body, ...chapter } = await loadChapter(url!, config, io, doc);
  console.log(chapter);
  if (body.kind === 'images') {
    console.log(`\n${body.pages.length} pages:`);
    for (const page of sample(body.pages)) console.log(`  ${page}`);
  } else {
    console.log(`\n${body.paragraphs.length} paragraphs:`);
    for (const p of sample(body.paragraphs, 2)) console.log(`  ${p.length > 140 ? `${p.slice(0, 140)}…` : p}`);
  }
}

async function fetchHtml(pageUrl: string): Promise<string> {
  const res = await fetchRetrying(() => fetch(pageUrl, { headers: { 'user-agent': USER_AGENT, referer: new URL(pageUrl).origin } }));
  if (res.status === 403 || res.status === 503) {
    throw new Error(`HTTP ${res.status}: the site is likely blocking non-browser requests. Save the page and use --html.`);
  }
  if (!res.ok) throw httpError(res, pageUrl);
  return res.text();
}

main().catch((err) => {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  if (err instanceof SiteConfigError) for (const issue of err.issues) console.error(`  - ${issue}`);
  process.exit(1);
});

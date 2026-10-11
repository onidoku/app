// Checks that the bundled test configs actually work against the test site, end to end,
// without a browser or network: the same core code the extension runs.
import { describe, expect, it } from 'vitest';
import { DOMParser } from 'linkedom';
import {
  checkForUpdates,
  extractChapter,
  extractSeries,
  Library,
  loadChapter,
  loadSeries,
  MemoryLibraryStore,
  parseSiteConfig,
  browseSeries,
  exploreSeries,
  searchSeries,
  SiteRegistry,
} from '@onidoku/core';
import manga from '../../configs/testsite.manga.json';
import novel from '../../configs/testsite.novel.json';
import lazy from '../../configs/testsite.lazy.json';
// @ts-expect-error plain JS module without types
import { createSite } from './site.mjs';

const BASE = 'http://localhost:4173';
const registry = new SiteRegistry([parseSiteConfig(manga), parseSiteConfig(novel), parseSiteConfig(lazy)]);
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html') as unknown as Document;

function open(site: ReturnType<typeof createSite>, path: string) {
  const url = `${BASE}${path}`;
  const res = site.handle(new URL(url));
  expect(res.status, url).toBe(200);
  const match = registry.match(url);
  expect(match, `no config matches ${url}`).toBeDefined();
  return { url, doc: parse(res.body), match: match! };
}

describe('test site + bundled configs', () => {
  it('extracts a comic series and its chapters', () => {
    const { url, doc, match } = open(createSite(), '/series/moon-garden');
    expect(match.kind).toBe('series');
    const { series, chapters } = extractSeries(doc, url, match.config);
    expect(series.title).toBe('Moon Garden');
    expect(series.cover).toBe(`${BASE}/covers/moon-garden.svg`);
    expect(series).toMatchObject({ authors: ['Ana Ruiz', 'Ken Ito'], genres: ['Fantasy', 'Slice of life'], status: 'Ongoing' });
    expect(series.description).toMatch(/^Moon Garden is a generated manga series/);
    expect(chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5']);
  });

  it('extracts comic pages and chapter navigation', () => {
    const site = createSite();
    const first = open(site, '/series/moon-garden/chapter/1');
    const chapter = extractChapter(first.doc, first.url, first.match.config);
    expect(chapter.body.kind === 'images' && chapter.body.pages).toHaveLength(6);
    expect(chapter.prev).toBeUndefined();
    expect(chapter.next).toBe(`${BASE}/series/moon-garden/chapter/2`);

    // Every page image the config finds must actually be served.
    for (const page of chapter.body.kind === 'images' ? chapter.body.pages : []) {
      expect(site.handle(new URL(page)).status, page).toBe(200);
    }

    const last = open(site, '/series/moon-garden/chapter/5');
    expect(extractChapter(last.doc, last.url, last.match.config).next).toBeUndefined();
  });

  it('extracts novel text', () => {
    const { url, doc, match } = open(createSite(), '/novel/quiet-orbit/chapter/2');
    const chapter = extractChapter(doc, url, match.config);
    expect(match.config.id).toBe('testsite.novel');
    expect(chapter.body.kind === 'text' && chapter.body.paragraphs).toHaveLength(12);
  });

  it('finds a chapter published after the series was added', async () => {
    const site = createSite();
    const library = new Library(new MemoryLibraryStore());
    const { url, doc, match } = open(site, '/series/moon-garden');
    const { series, chapters } = extractSeries(doc, url, match.config);
    await library.add(series, chapters);

    site.handle(new URL(`${BASE}/__admin/add-chapter?series=moon-garden`));
    const { updates, failures } = await checkForUpdates({
      library,
      registry,
      fetchHtml: async (u) => site.handle(new URL(u)).body,
      parseHtml: parse,
      delayMs: 0,
    });

    expect(failures).toEqual([]);
    expect(updates[0]?.added).toEqual([{ url: `${BASE}/series/moon-garden/chapter/6`, title: 'Chapter 6' }]);
  });
});

describe('search', () => {
  const io = (site: ReturnType<typeof createSite>) => ({ fetchHtml: async (u: string) => site.handle(new URL(u)).body as string, parseHtml: parse });

  it('finds series of the config\'s kind only', async () => {
    const site = createSite();
    const manga = registry.get('testsite.manga')!;
    expect(await searchSeries('moon', manga, io(site))).toEqual([
      { url: `${BASE}/series/moon-garden`, title: 'Moon Garden', cover: `${BASE}/covers/moon-garden.svg` },
    ]);
    expect(await searchSeries('quiet', manga, io(site))).toEqual([]);
    expect((await searchSeries('quiet', registry.get('testsite.novel')!, io(site)))[0]?.url).toBe(`${BASE}/novel/quiet-orbit`);
  });

  it('every result can be added to the library', async () => {
    const site = createSite();
    const lazyConfig = registry.get('testsite.lazy')!;
    const [result] = await searchSeries('long', lazyConfig, io(site));
    const { series } = await loadSeries(result!.url, lazyConfig, io(site));
    expect(series.title).toBe('Long Road');
  });
});

describe('browse by author and genre', () => {
  const io = (site: ReturnType<typeof createSite>) => ({ fetchHtml: async (u: string) => site.handle(new URL(u)).body as string, parseHtml: parse });

  it('follows author links captured from the series page', async () => {
    const site = createSite();
    const manga = registry.get('testsite.manga')!;
    const { series } = await loadSeries(`${BASE}/series/moon-garden`, manga, io(site));
    expect(series.links?.authors?.['Ana Ruiz']).toBe(`${BASE}/author/ana-ruiz`);
    const { results } = await browseSeries(manga, 'authors', 'Ana Ruiz', io(site), series.links!.authors!['Ana Ruiz']);
    expect(results.map((r) => r.title)).toEqual(['Moon Garden']);
  });

  it('builds genre lists from the name', async () => {
    const { results } = await browseSeries(registry.get('testsite.novel')!, 'genres', 'Sci-fi', io(createSite()));
    expect(results.map((r) => r.url)).toEqual([`${BASE}/novel/quiet-orbit`]);
  });

  it('explores popular titles page by page until a page is empty', async () => {
    const site = createSite();
    const manga = registry.get('testsite.manga')!;
    const first = await exploreSeries(manga, 0, 1, io(site));
    expect(first.url).toBe(`${BASE}/popular?kind=manga&page=1`);
    expect(first.results.map((r) => r.title)).toEqual(['Moon Garden', 'Iron Tide']);
    expect(first.hasMore).toBe(true);
    const second = await exploreSeries(manga, 0, 2, io(site));
    expect(second).toMatchObject({ results: [], hasMore: false });
    const latest = await exploreSeries(manga, 1, 1, io(site));
    expect(latest.results.map((r) => r.title)).toEqual(['Iron Tide', 'Moon Garden']);
  });
});

describe('lazy-loading pages (chapters.from / chapter.from)', () => {
  const lazyConfig = parseSiteConfig(lazy);
  const ioFor = (site: ReturnType<typeof createSite>) => ({
    fetchHtml: async (u: string) => {
      const res = site.handle(new URL(u));
      if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${u}`);
      return res.body as string;
    },
    parseHtml: parse,
  });

  it('the series page alone only shows the newest chapters', () => {
    const { url, doc } = open(createSite(), '/lazy/long-road');
    expect(extractSeries(doc, url, lazyConfig).chapters.map((c) => c.title)).toEqual(['Chapter 7', 'Chapter 8']);
  });

  it('loadSeries follows the "show all" button to get every chapter', async () => {
    const { chapters } = await loadSeries(`${BASE}/lazy/long-road`, lazyConfig, ioFor(createSite()));
    expect(chapters).toHaveLength(8);
    expect(chapters[0]).toEqual({ url: `${BASE}/lazy/long-road/chapter/1`, title: 'Chapter 1' });
  });

  it('loadChapter fetches pages from the template URL', async () => {
    const chapter = await loadChapter(`${BASE}/lazy/long-road/chapter/3`, lazyConfig, ioFor(createSite()));
    expect(chapter.body.kind === 'images' && chapter.body.pages).toEqual(
      Array.from({ length: 6 }, (_, i) => `${BASE}/pages/long-road/3/${i + 1}.svg`),
    );
    expect(chapter.seriesUrl).toBe(`${BASE}/lazy/long-road`);
    expect(chapter.next).toBeUndefined(); // no links on the page; the reader asks the library instead
  });

  it('update checks see chapters beyond the preview', async () => {
    const site = createSite();
    const library = new Library(new MemoryLibraryStore());
    const { series, chapters } = await loadSeries(`${BASE}/lazy/long-road`, lazyConfig, ioFor(site));
    await library.add(series, chapters);
    site.handle(new URL(`${BASE}/__admin/add-chapter?series=long-road`));
    const { updates } = await checkForUpdates({ library, registry, ...ioFor(site), delayMs: 0 });
    expect(updates[0]?.added.map((c) => c.title)).toEqual(['Chapter 9']);
  });
});

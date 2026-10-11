import { describe, expect, it } from 'vitest';
import { paperbackSourceCode, paperbackVersioning, PAPERBACK_SOURCE_ID } from '../../../apps/test-site/paperback.mjs';
import { createSite } from '../../../apps/test-site/site.mjs';
import {
  checkForUpdates,
  exploreSeries,
  Library,
  loadChapter,
  loadSeries,
  MemoryLibraryStore,
  PAPERBACK_ORIGIN,
  PaperbackInstance,
  paperbackConfigId,
  paperbackRepoUrl,
  paperbackSections,
  paperbackSiteConfig,
  paperbackUrls,
  parsePaperbackRepo,
  searchSeries,
  SiteRegistry,
  toHttpRequest,
  type HtmlIO,
  type PaperbackBridge,
  type PbHttpRequest,
  type SiteConfig,
} from '../src';
import { BASE, parse } from './helpers';

const REPO = `${BASE}/paperback`;

/** Runs the test site's Paperback source in-process, answering its requests from the fake site. */
function setup() {
  const site = createSite();
  const requests: PbHttpRequest[] = [];
  const state = new Map<string, unknown>();
  const bridge: PaperbackBridge = {
    userAgent: 'test-agent',
    async fetch(request) {
      requests.push(request);
      const res = site.handle(new URL(request.url), { method: request.method, headers: request.headers, body: request.body ?? '' });
      return { status: res.status, headers: { 'content-type': res.type, ...res.headers }, text: res.body };
    },
    getState: async (key) => state.get(key),
    setState: async (key, value) => void state.set(key, value),
  };
  const runtime = PaperbackInstance.load(paperbackSourceCode(), PAPERBACK_SOURCE_ID, bridge);
  return { site, requests, state, bridge, runtime };
}

async function install(runtime = setup().runtime): Promise<SiteConfig> {
  const repo = parsePaperbackRepo(`${REPO}/versioning.json`, paperbackVersioning(BASE));
  return paperbackSiteConfig({ repo: repo.url, listing: repo.sources[0]!, sections: await paperbackSections(runtime), installedAt: '2026-10-11T00:00:00Z' });
}

function ioFor(runtime: PaperbackInstance): HtmlIO {
  return { fetchHtml: () => Promise.reject(new Error('no HTML here')), parseHtml: parse, paperback: () => runtime };
}

describe('paperback repos', () => {
  it('accepts what people paste for a repo address', () => {
    for (const input of [`${REPO}`, `${REPO}/`, `${REPO}/versioning.json`, `${REPO}/index.html?x=1#top`]) {
      expect(paperbackRepoUrl(input)).toBe(REPO);
    }
    expect(() => paperbackRepoUrl('ftp://example.org/repo')).toThrow(/https/);
  });

  it('reads 0.8 repos and refuses other extension API versions', () => {
    const versioning = paperbackVersioning(BASE) as { builtWith: { types: string } };
    const repo = parsePaperbackRepo(`${REPO}/`, versioning);
    expect(repo).toMatchObject({
      url: REPO,
      types: '0.8.7',
      sources: [{ id: 'TestComics', contentRating: 'EVERYONE', version: '1.0.0' }, { id: 'TestComicsLite' }],
    });
    expect(() => parsePaperbackRepo(REPO, { ...versioning, builtWith: { types: '1.0.0-alpha.53' } })).toThrow(/1\.0\.0-alpha\.53 of Paperback.*0\.8/);
    expect(() => parsePaperbackRepo(REPO, { sources: [] })).toThrow(/before 0\.8/);
    expect(() => parsePaperbackRepo(REPO, { sources: 'nope' })).toThrow(/doesn’t look like a Paperback repo/);
  });

  it('appears as a source with reserved URLs that round-trip any id', async () => {
    const config = await install();
    expect(config).toMatchObject({
      id: 'pb.testcomics',
      name: 'Test Comics (Paperback)',
      icon: `${REPO}/TestComics/includes/icon.svg`,
      nsfw: false,
      paperback: { repo: REPO, sourceId: 'TestComics', version: '1.0.0', site: BASE },
      explore: [{ name: 'Popular' }, { name: 'Featured' }],
    });
    const urls = paperbackUrls(config.id);
    const odd = 'manga/with slashes?&#%';
    expect(urls.mangaId(urls.manga(odd))).toBe(odd);
    expect(urls.chapterIds(urls.chapter(odd, 'ch/1'))).toEqual({ mangaId: odd, chapterId: 'ch/1' });
    expect(() => urls.mangaId(`${PAPERBACK_ORIGIN}/pb.other/manga/x`)).toThrow(/not a title/);

    const registry = new SiteRegistry([config]);
    expect(registry.match(urls.manga(odd))).toMatchObject({ kind: 'series', config: { id: config.id } });
    expect(registry.match(urls.chapter(odd, 'ch/1'))).toMatchObject({ kind: 'chapter' });
    expect(paperbackConfigId('Some Source!')).toBe('pb.some-source-');
  });

  it('marks adult sources 18+ and falls back to a letter icon', () => {
    const listing = { ...(paperbackVersioning(BASE) as { sources: object[] }).sources[0], contentRating: 'ADULT', icon: undefined };
    const repo = parsePaperbackRepo(REPO, { builtWith: { types: '0.8.7' }, sources: [listing] });
    const config = paperbackSiteConfig({ repo: repo.url, listing: repo.sources[0]!, sections: [], installedAt: '' });
    expect(config.nsfw).toBe(true);
    expect(config.icon).toMatch(/^data:image\/svg\+xml,/);
    expect(config.explore).toBeUndefined();
  });
});

describe('paperback sources', () => {
  it('loads a title and its chapters, oldest first', async () => {
    const { runtime, requests } = setup();
    const config = await install(runtime);
    const url = paperbackUrls(config.id).manga('moon-garden');
    const { series, chapters } = await loadSeries(url, config, ioFor(runtime));
    expect(series).toEqual({
      id: `${config.id}:${url}`,
      siteId: config.id,
      url,
      title: 'Moon Garden',
      cover: `${BASE}/covers/moon-garden.svg`,
      description: 'Moon Garden is a generated comic for testing onidoku.',
      authors: ['Ana Ruiz', 'Ken Ito'],
      genres: ['Fantasy', 'Slice of life'],
      status: 'Ongoing',
    });
    expect(chapters.map((c) => c.title)).toEqual(['Chapter 1: The Beginning', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5']);
    expect(chapters[0]!.url).toBe(paperbackUrls(config.id).chapter('moon-garden', 'c1'));
    // The interceptor's headers and cookie reach the request, with the host's user agent.
    expect(requests.at(-1)!.headers).toMatchObject({ referer: `${BASE}/`, cookie: 'pb-mature=1', 'user-agent': 'test-agent', 'x-test-source': 'paperback' });
  });

  it('loads a chapter’s pages and tells what headers its images need', async () => {
    const { runtime } = setup();
    const config = await install(runtime);
    const urls = paperbackUrls(config.id);
    const chapter = await loadChapter(urls.chapter('iron-tide', 'c2'), config, ioFor(runtime));
    expect(chapter).toMatchObject({ url: urls.chapter('iron-tide', 'c2'), seriesUrl: urls.manga('iron-tide'), body: { kind: 'images' } });
    expect(chapter.body.kind === 'images' && chapter.body.pages).toEqual(Array.from({ length: 6 }, (_, i) => `${BASE}/pb-pages/iron-tide/2/${i + 1}.svg`));
    expect(await runtime.call('requestHeaders', [`${BASE}/pb-pages/iron-tide/2/1.svg`])).toMatchObject({ referer: `${BASE}/`, cookie: 'pb-mature=1' });
  });

  it('searches with a form POST', async () => {
    const { runtime, requests } = setup();
    const config = await install(runtime);
    const results = await searchSeries('iron', config, ioFor(runtime));
    expect(results).toEqual([{ url: paperbackUrls(config.id).manga('iron-tide'), title: 'Iron Tide', cover: `${BASE}/covers/iron-tide.svg` }]);
    expect(requests.at(-1)).toMatchObject({ method: 'POST', body: 'q=iron', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  });

  it('explores home sections, paging the ones with more', async () => {
    const { runtime } = setup();
    const config = await install(runtime);
    const io = ioFor(runtime);
    const titles = async (list: number, page: number) => {
      const { results, hasMore } = await exploreSeries(config, list, page, io);
      return { titles: results.map((r) => r.title), hasMore };
    };
    // Popular: 3 comics, 2 a page, most chapters first.
    expect(await titles(0, 1)).toEqual({ titles: ['Long Road', 'Moon Garden'], hasMore: true });
    expect(await titles(0, 2)).toEqual({ titles: ['Iron Tide'], hasMore: true });
    expect(await titles(0, 3)).toEqual({ titles: [], hasMore: false });
    // Asking for a later page out of order walks from the start.
    expect(await titles(0, 2)).toEqual({ titles: ['Iron Tide'], hasMore: true });
    expect(await titles(1, 1)).toEqual({ titles: ['Moon Garden', 'Iron Tide'], hasMore: false });
    expect(await titles(1, 2)).toEqual({ titles: [], hasMore: false });
  });

  it('finds new chapters in update checks', async () => {
    const { runtime, site } = setup();
    const config = await install(runtime);
    const library = new Library(new MemoryLibraryStore());
    const url = paperbackUrls(config.id).manga('iron-tide');
    const { series, chapters } = await loadSeries(url, config, ioFor(runtime));
    await library.add(series, chapters);
    site.handle(new URL(`${BASE}/__admin/add-chapter?series=iron-tide`));
    const { updates, failures } = await checkForUpdates({ library, registry: new SiteRegistry([config]), ...ioFor(runtime), delayMs: 0 });
    expect(failures).toEqual([]);
    expect(updates[0]!.added.map((c) => c.title)).toEqual(['Chapter 4']);
  });

  it('explains blocked requests as a Cloudflare check to pass in a tab', async () => {
    const { runtime } = setup();
    const config = await install(runtime);
    await expect(loadSeries(paperbackUrls(config.id).manga('cf-blocked'), config, ioFor(runtime))).rejects.toThrow(
      `Test Comics (Paperback) is behind a Cloudflare check. open ${BASE} in a tab, wait for the site to show, keep the tab open`,
    );
  });

  it('passes source errors on and refuses methods sources don’t have', async () => {
    const { runtime } = setup();
    await expect(runtime.call('getChapters', ['nope-not-a-series'])).rejects.toThrow(/HTTP 404/);
    await expect(runtime.call('constructor' as never)).rejects.toThrow(/can’t do constructor/);
  });

  it('needs a place to run', async () => {
    const config = await install();
    const io: HtmlIO = { fetchHtml: () => Promise.reject(new Error('no')), parseHtml: parse };
    await expect(loadSeries(paperbackUrls(config.id).manga('x'), config, io)).rejects.toThrow(/Paperback source, and those can't run here/);
  });

  it('loads bundles from older toolchains, which set Sources on the global object', async () => {
    const { bridge } = setup();
    const umd = `(function(f){var g;if(typeof window!=="undefined"){g=window}else if(typeof global!=="undefined"){g=global}else{g=this}g.Sources=f()})(function(){
      class Mini { constructor() { this.requestManager = App.createRequestManager({}); } getMangaShareUrl(id) { return 'https://mini.test/' + id; } }
      return { Mini, MiniInfo: { name: 'Mini' } };
    });`;
    const runtime = PaperbackInstance.load(umd, 'Mini', bridge);
    expect(await runtime.call('getMangaShareUrl', ['a'])).toBe('https://mini.test/a');
    expect((globalThis as { Sources?: unknown }).Sources).toBeUndefined();
  });

  it('refuses bundles without the named source', () => {
    const { bridge } = setup();
    expect(() => PaperbackInstance.load(paperbackSourceCode(), 'Missing', bridge)).toThrow(/doesn’t define Missing/);
  });
});

describe('paperback requests', () => {
  const request = (extra: object) => ({ url: 'https://site.test/a', method: 'post', headers: {}, cookies: [], ...extra });

  it('adds the param, merges cookies and encodes bodies', () => {
    expect(toHttpRequest(request({ param: '?page=2', headers: { Cookie: 'a=1' }, cookies: [{ name: 'b', value: '2' }] }), 5)).toEqual({
      url: 'https://site.test/a?page=2',
      method: 'POST',
      headers: { cookie: 'a=1; b=2' },
      body: undefined,
      timeoutMs: 5,
    });
    expect(toHttpRequest(request({ headers: { 'Content-Type': 'application/json' }, data: { q: 'x' } }), 0).body).toBe('{"q":"x"}');
    expect(toHttpRequest(request({ data: 'raw' }), 0).body).toBe('raw');
    expect(toHttpRequest(request({ method: 'GET', data: { q: 'x' } }), 0).body).toBeUndefined();
  });
});

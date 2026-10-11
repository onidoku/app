import { browseUrl, exploreUrl, extractChapter, extractList, extractSearch, extractSeries, searchUrl, sourceUrl, type Page } from './extract';
import type { PaperbackRuntime } from './paperback/app';
import { PaperbackClient } from './paperback/client';
import type { MediaServer } from './servers/server';
import type { SiteConfig } from './siteConfig';
import type { BrowseKind, ChapterContent, ChapterRef, SearchResult, Series } from './types';

/** How a platform fetches and parses pages; the extension, tests and Android each supply their own. */
export interface HtmlIO {
  fetchHtml(url: string): Promise<string>;
  parseHtml(html: string, url: string): Document;
  /** The API client for a media server source (a config with `server`); needed only for those. */
  server?(config: SiteConfig): MediaServer | undefined;
  /**
   * Where a Paperback source's code runs (a config with `paperback`); needed only for those.
   * Return the same runtime for the same source, so paged explore lists can continue.
   */
  paperback?(config: SiteConfig): PaperbackRuntime | undefined;
}

/** Sources read through code or an API rather than scraped: media servers and Paperback sources. */
type ApiSource = Pick<MediaServer, 'loadSeries' | 'loadChapter' | 'search' | 'explore'>;

const paperbackClients = new WeakMap<PaperbackRuntime, PaperbackClient>();

function apiFor(config: SiteConfig, io: HtmlIO): ApiSource | undefined {
  if (config.server) {
    const server = io.server?.(config);
    if (!server) throw new Error(`${config.name} is a media server, but its connection isn't set up here`);
    return server;
  }
  if (config.paperback) {
    const runtime = io.paperback?.(config);
    if (!runtime) throw new Error(`${config.name} is a Paperback source, and those can't run here`);
    let client = paperbackClients.get(runtime);
    if (!client) paperbackClients.set(runtime, (client = new PaperbackClient(config, runtime)));
    return client;
  }
  return undefined;
}

async function fetchPage(url: string, io: HtmlIO): Promise<Page> {
  return { doc: io.parseHtml(await io.fetchHtml(url), url), url };
}

/** Most pages a paginated chapter list may span (100 chapters a page is common, so ~10k chapters). */
export const MAX_CHAPTER_PAGES = 150;

/**
 * Loads a series and its full chapter list, following `chapters.from` and `chapters.next` when the config has them.
 * Pass `doc` when the page is already loaded (e.g. the live page in a content script).
 */
export async function loadSeries(
  url: string,
  config: SiteConfig,
  io: HtmlIO,
  doc?: Document,
): Promise<{ series: Series; chapters: ChapterRef[]; readUpTo?: string }> {
  const api = apiFor(config, io);
  if (api) return api.loadSeries(url);
  const page = doc ? { doc, url } : await fetchPage(url, io);
  const { from, next } = config.series.chapters;
  const listUrl = sourceUrl(from, page.doc, url);
  const lists = [listUrl ? await fetchPage(listUrl, io) : page];
  // Paginated lists: follow "next" links, never revisiting a page, up to a sane limit.
  const visited = new Set(lists.map((p) => p.url));
  for (let nextUrl = sourceUrl(next, lists[0]!.doc, lists[0]!.url); nextUrl && !visited.has(nextUrl); ) {
    if (lists.length >= MAX_CHAPTER_PAGES) throw new Error(`${config.name}: chapter list has more than ${MAX_CHAPTER_PAGES} pages`);
    visited.add(nextUrl);
    const listPage = await fetchPage(nextUrl, io);
    lists.push(listPage);
    nextUrl = sourceUrl(next, listPage.doc, listPage.url);
  }
  return extractSeries(page.doc, url, config, lists);
}

/** Loads a chapter, following `chapter.from` for its pages or text when the config has one. */
export async function loadChapter(url: string, config: SiteConfig, io: HtmlIO, doc?: Document): Promise<ChapterContent> {
  const api = apiFor(config, io);
  if (api) return api.loadChapter(url);
  const page = doc ? { doc, url } : await fetchPage(url, io);
  const contentUrl = sourceUrl(config.chapter.from, page.doc, url);
  const content = contentUrl ? await fetchPage(contentUrl, io) : page;
  return extractChapter(page.doc, url, config, content);
}

/** Searches a site. Throws if the config has no `search` section. */
export async function searchSeries(query: string, config: SiteConfig, io: HtmlIO): Promise<SearchResult[]> {
  const api = apiFor(config, io);
  if (api) return api.search(query);
  const url = searchUrl(config, query);
  if (!url) throw new Error(`${config.name} does not support search`);
  const page = await fetchPage(url, io);
  return extractSearch(page.doc, url, config);
}

/**
 * Lists a site's titles by an author or genre. `link` is where that name linked to on a series
 * page, for configs whose browse URL is `{url}`. Throws if the config can't browse it.
 */
export async function browseSeries(
  config: SiteConfig,
  kind: BrowseKind,
  name: string,
  io: HtmlIO,
  link?: string,
): Promise<{ url: string; results: SearchResult[] }> {
  const spec = config.browse?.[kind];
  const url = browseUrl(config, kind, name, link);
  if (!spec || !url) throw new Error(`${config.name} can't list titles by this ${kind === 'authors' ? 'author' : 'genre'}`);
  const page = await fetchPage(url, io);
  return { url, results: extractList(page.doc, url, config, spec) };
}

/**
 * Loads one page of a source's explore list (e.g. its popular titles). `hasMore` is false when
 * the list has no `{page}` (a single page) or this page added nothing new.
 */
export async function exploreSeries(
  config: SiteConfig,
  list: number,
  page: number,
  io: HtmlIO,
): Promise<{ url: string; results: SearchResult[]; hasMore: boolean }> {
  const api = apiFor(config, io);
  if (api) return { url: config.server?.url ?? config.paperback!.site, ...(await api.explore(list, page)) };
  const spec = config.explore?.[list];
  const url = exploreUrl(config, list, page);
  if (!spec || !url) throw new Error(`${config.name} has no list to explore here`);
  const results = extractList((await fetchPage(url, io)).doc, url, config, spec);
  return { url, results, hasMore: spec.url.includes('{page}') && results.length > 0 };
}

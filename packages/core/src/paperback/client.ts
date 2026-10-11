import { seriesIdFor } from '../extract';
import type { ServerSeries } from '../servers/server';
import type { SiteConfig } from '../siteConfig';
import type { ChapterContent, ChapterRef, SearchResult, Series } from '../types';
import { normalizeUrl } from '../url';
import type { PaperbackMethod, PaperbackRuntime } from './app';
import { paperbackUrls, type PaperbackRef, type PaperbackSection } from './repo';

// What sources return, as far as onidoku reads it. Sources are third-party code, so every field
// is checked rather than trusted.
interface PbTag {
  label?: unknown;
}
interface PbMangaInfo {
  titles?: unknown;
  image?: unknown;
  author?: unknown;
  artist?: unknown;
  desc?: unknown;
  status?: unknown;
  tags?: { tags?: PbTag[] }[];
}
interface PbChapter {
  id?: unknown;
  name?: unknown;
  chapNum?: unknown;
  volume?: unknown;
  sortingIndex?: unknown;
}
interface PbPartial {
  mangaId?: unknown;
  title?: unknown;
  image?: unknown;
}
interface PbPaged {
  results?: PbPartial[];
  metadata?: unknown;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '');
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/** A source's titles, chapters, search and explore lists, in onidoku's terms. */
export class PaperbackClient {
  private readonly urls;
  private readonly ref: PaperbackRef;
  /** Where each paged explore list got to, so the next page continues from there. */
  private readonly cursors = new Map<string, { page: number; metadata: unknown; done: boolean }>();

  constructor(
    private readonly config: SiteConfig,
    private readonly runtime: PaperbackRuntime,
  ) {
    if (!config.paperback) throw new Error(`${config.name} is not a Paperback source`);
    this.ref = config.paperback;
    this.urls = paperbackUrls(config.id);
  }

  async loadSeries(url: string): Promise<ServerSeries> {
    const mangaId = this.urls.mangaId(url);
    const [manga, chapters] = await Promise.all([
      this.call<{ mangaInfo?: PbMangaInfo }>('getMangaDetails', [mangaId]),
      this.call<PbChapter[]>('getChapters', [mangaId]),
    ]);
    return { series: this.series(url, manga?.mangaInfo ?? {}), chapters: this.chapters(mangaId, chapters) };
  }

  async loadChapter(url: string): Promise<ChapterContent> {
    const { mangaId, chapterId } = this.urls.chapterIds(url);
    const details = await this.call<{ pages?: unknown[] }>('getChapterDetails', [mangaId, chapterId]);
    const pages = (Array.isArray(details?.pages) ? details.pages : []).flatMap((p) => {
      const src = this.absolute(p);
      return src ? [src] : [];
    });
    if (!pages.length) throw new Error(`${this.config.name} found no pages in this chapter`);
    return { url: normalizeUrl(url), seriesUrl: this.urls.manga(mangaId), body: { kind: 'images', pages } };
  }

  async search(query: string): Promise<SearchResult[]> {
    const request = { title: query, includedTags: [], excludedTags: [], includeOperator: 'AND', excludeOperator: 'OR', parameters: {} };
    return this.results((await this.call<PbPaged>('getSearchResults', [request, undefined]))?.results);
  }

  /** `list` indexes the sections captured at install; `page` starts at 1. */
  async explore(list: number, page: number): Promise<{ results: SearchResult[]; hasMore: boolean }> {
    const section = this.ref.sections[list];
    if (!section) throw new Error(`${this.config.name} has no list to explore here`);
    if (!section.more) {
      // Home-page-only sections have no further pages.
      if (page > 1) return { results: [], hasMore: false };
      const sections = await this.call<{ id?: unknown; items?: PbPartial[] }[]>('getHomePageSections');
      const found = (Array.isArray(sections) ? sections : []).find((s) => String(s?.id) === section.id);
      return { results: this.results(found?.items), hasMore: false };
    }
    // Paged lists continue from metadata the previous page returned; without it (another list was
    // opened, or the background restarted), walk from the start.
    let cursor = this.cursors.get(section.id);
    if (!cursor || cursor.page !== page - 1) cursor = { page: 0, metadata: undefined, done: false };
    let last: PbPaged | undefined;
    while (cursor.page < page) {
      if (cursor.done) return { results: [], hasMore: false };
      last = await this.call<PbPaged>('getViewMoreItems', [section.id, cursor.metadata]);
      const metadata: unknown = last?.metadata;
      cursor = { page: cursor.page + 1, metadata, done: metadata === undefined || metadata === null || !last?.results?.length };
    }
    this.cursors.set(section.id, cursor);
    return { results: this.results(last?.results), hasMore: !cursor.done };
  }

  private async call<T>(method: PaperbackMethod, args: unknown[] = []): Promise<T> {
    try {
      return (await this.runtime.call(method, args)) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Sources tell Paperback users to "press the cloud icon"; in a browser, visiting the site does
      // it, and onidoku makes requests Cloudflare still challenges through that tab.
      if (/cloudflare/i.test(message)) {
        throw new Error(`${this.config.name} is behind a Cloudflare check. open ${this.ref.site} in a tab, wait for the site to show, keep the tab open, then try again.`);
      }
      throw new Error(`${this.config.name}: ${message}`);
    }
  }

  private series(url: string, info: PbMangaInfo): Series {
    const titles = Array.isArray(info.titles) ? info.titles.map(text).filter(Boolean) : [];
    if (!titles[0]) throw new Error(`${this.config.name} returned a title without a name`);
    const people = [text(info.author), text(info.artist)].flatMap((s) => s.split(/\s*[,;]\s*/)).filter(Boolean);
    const genres = (Array.isArray(info.tags) ? info.tags : []).flatMap((section) => (Array.isArray(section?.tags) ? section.tags : [])).map((t) => text(t?.label)).filter(Boolean);
    const series: Series = {
      id: seriesIdFor(this.config.id, url),
      siteId: this.config.id,
      url: normalizeUrl(url),
      title: titles[0],
      cover: this.absolute(info.image),
      description: plainText(text(info.desc)) || undefined,
      authors: [...new Set(people)],
      genres: [...new Set(genres)],
      status: text(info.status) || undefined,
    };
    // Same shape as scraped series: no empty optional fields.
    for (const key of Object.keys(series) as (keyof Series)[]) {
      const value = series[key];
      if (value === undefined || (Array.isArray(value) && !value.length)) delete series[key];
    }
    return series;
  }

  /**
   * Oldest first. Paperback sorts by `sortingIndex` (higher is newer) when every chapter has one;
   * otherwise by volume and number, and lists are newest first, so ties keep the later one first.
   */
  private chapters(mangaId: string, raw: PbChapter[]): ChapterRef[] {
    const list = (Array.isArray(raw) ? raw : []).map((c, index) => ({ c, index, id: text(c?.id) })).filter((x) => x.id);
    const indexes = list.map((x) => finite(x.c.sortingIndex));
    const bySortingIndex = list.length > 0 && indexes.every((i) => i !== undefined) && new Set(indexes).size === list.length;
    list.sort((a, b) =>
      bySortingIndex
        ? finite(a.c.sortingIndex)! - finite(b.c.sortingIndex)!
        : (finite(a.c.volume) ?? 0) - (finite(b.c.volume) ?? 0) || (finite(a.c.chapNum) ?? 0) - (finite(b.c.chapNum) ?? 0) || b.index - a.index,
    );
    const seen = new Set<string>();
    return list.flatMap(({ c, id }) => {
      if (seen.has(id)) return [];
      seen.add(id);
      return [{ url: this.urls.chapter(mangaId, id), title: chapterTitle(c, id) }];
    });
  }

  private results(items: PbPartial[] | undefined): SearchResult[] {
    const seen = new Set<string>();
    return (Array.isArray(items) ? items : []).flatMap((item) => {
      const id = text(item?.mangaId);
      if (!id || seen.has(id)) return [];
      seen.add(id);
      const result: SearchResult = { url: this.urls.manga(id), title: plainText(text(item.title)) || id };
      const cover = this.absolute(item.image);
      if (cover) result.cover = cover;
      return [result];
    });
  }

  /** Image addresses as http(s) URLs (relative ones resolved against the site), else undefined. */
  private absolute(value: unknown): string | undefined {
    const src = text(value);
    if (!src) return undefined;
    if (src.startsWith('data:image/')) return src;
    try {
      const url = new URL(src, `${this.ref.site}/`);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * The source's home page sections, which become its explore tabs. Read once at install: sources
 * build them by loading the site's home page, too slow to repeat on every visit to explore.
 */
export async function paperbackSections(runtime: PaperbackRuntime): Promise<PaperbackSection[]> {
  const sections = await runtime.call('getHomePageSections');
  const seen = new Set<string>();
  return (Array.isArray(sections) ? sections : []).flatMap((s: { id?: unknown; title?: unknown; containsMoreItems?: unknown }) => {
    const id = text(s?.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, title: plainText(text(s.title)) || id, more: s.containsMoreItems === true }];
  });
}

/** "Chapter 12", the source's own name, or both when the name doesn't number the chapter. */
function chapterTitle(chapter: PbChapter, id: string): string {
  const name = plainText(text(chapter.name));
  const num = finite(chapter.chapNum);
  const numbered = num !== undefined && (num > 0 || !name) ? `Chapter ${num}` : '';
  if (name && numbered && !/\d/.test(name)) return `${numbered}: ${name}`;
  return name || numbered || id;
}

/** Descriptions sometimes arrive as HTML. */
function plainText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' })[e] ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

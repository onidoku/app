import { seriesIdFor } from '../extract';
import { blockParagraphs, htmlBlocks } from '../text';
import type { ChapterContent, ChapterRef, SearchResult, TextBlock } from '../types';
import { partOf, splitParts, topLevel, withPart, type BookPart } from './parts';
import { ServerAuthError, ServerHttp, type MediaServer, type ServerConfig, type ServerIO, type ServerSeries } from './server';

// Shapes from Kavita's OpenAPI spec (openapi.json in the Kavita repo), only the fields used here.
interface KavitaSeries {
  id: number;
  name: string;
  localizedName?: string;
  libraryId: number;
  format?: number;
}
interface KavitaMetadata {
  summary?: string;
  genres?: { title: string }[];
  tags?: { title: string }[];
  writers?: { name: string }[];
  publicationStatus?: number;
}
interface KavitaChapter {
  id: number;
  range?: string;
  minNumber?: number;
  sortOrder?: number;
  title?: string;
  titleName?: string;
  isSpecial?: boolean;
  pages: number;
  pagesRead: number;
}
interface KavitaVolume {
  id: number;
  name?: string;
  minNumber: number;
  chapters: KavitaChapter[];
}
interface KavitaSeriesDetail {
  volumes?: KavitaVolume[];
  chapters?: KavitaChapter[];
  specials?: KavitaChapter[];
}
interface KavitaTocItem {
  title?: string;
  /** Anchor id within the page. */
  part?: string;
  /** Page index, from 0. */
  page: number;
  children?: KavitaTocItem[];
}
interface KavitaChapterInfo {
  seriesId: number;
  volumeId: number;
  libraryId: number;
  seriesFormat: number;
  pages: number;
  chapterNumber?: string;
  volumeNumber?: string;
  title?: string;
  subtitle?: string;
  chapterTitle?: string;
  isSpecial?: boolean;
}

/** Kavita's MangaFormat enum. */
const FORMAT = { epub: 3 } as const;
/** Kavita's PublicationStatus enum. */
const STATUS = ['ongoing', 'hiatus', 'completed', 'cancelled', 'ended'];
/** Volume numbers Kavita uses for chapters outside any volume and for specials. */
const LOOSE_LEAF = -100000;
const SPECIALS = 100000;
const PAGE_SIZE = 30;
/** SeriesSortField per explore tab (SERVER_EXPLORE): created date, last chapter added, sort name. */
const EXPLORE_SORT = [
  { sortField: 2, isAscending: false },
  { sortField: 4, isAscending: false },
  { sortField: 1, isAscending: true },
];

export class KavitaServer implements MediaServer {
  private readonly http: ServerHttp;
  private token: Promise<{ token: string; username: string }> | undefined;

  constructor(
    private readonly server: ServerConfig,
    io: ServerIO,
  ) {
    this.http = new ServerHttp(server, io);
  }

  /** Kavita trades the user's API key for a JWT; plugins authenticate this way on every version since 0.7. */
  private login(): Promise<{ token: string; username: string }> {
    this.token ??= this.http
      .json<{ token: string; username: string }>(this.http.url('/api/Plugin/authenticate', { apiKey: this.server.apiKey, pluginName: 'onidoku' }), { method: 'POST' })
      .catch((err) => {
        this.token = undefined;
        // Kavita answers a bad key with 401 or 400 depending on version.
        throw err instanceof ServerAuthError || /HTTP 400/.test(String(err)) ? new ServerAuthError(`${this.http.label} rejected the API key.`) : err;
      });
    return this.token;
  }

  /** Authenticated request, logging in again once if the token has expired. */
  private async call(url: string, init: RequestInit = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const { token } = await this.login();
      try {
        return await this.http.request(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
      } catch (err) {
        if (!(err instanceof ServerAuthError) || attempt > 0) throw err;
        this.token = undefined;
      }
    }
  }

  private async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return (await (await this.call(this.http.url(path, query), { headers: { accept: 'application/json' } })).json()) as T;
  }

  private async post<T>(path: string, query: Record<string, string | number | boolean | undefined>, body: unknown): Promise<T> {
    const res = await this.call(this.http.url(path, query), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private seriesUrl(libraryId: number, seriesId: number): string {
    return `${this.server.url}/library/${libraryId}/series/${seriesId}`;
  }

  private chapterUrl(libraryId: number, seriesId: number, chapterId: number): string {
    return `${this.seriesUrl(libraryId, seriesId)}/chapter/${chapterId}`;
  }

  async verify(): Promise<string> {
    return (await this.login()).username;
  }

  async loadSeries(url: string): Promise<ServerSeries> {
    const seriesId = Number(this.http.idAfter(url, 'series'));
    const [series, metadata, detail] = await Promise.all([
      this.get<KavitaSeries>(`/api/Series/${seriesId}`),
      this.get<KavitaMetadata>('/api/Series/metadata', { seriesId }).catch((): KavitaMetadata => ({})),
      this.get<KavitaSeriesDetail>('/api/Series/series-detail', { seriesId }),
    ]);
    const ordered = readingOrder(detail);
    // EPUB files list their own chapters; every other file is one chapter.
    const epub = series.format === FORMAT.epub;
    const parts = await Promise.all(ordered.map(({ chapter }) => (epub ? this.parts(chapter.id, chapter.pages).catch(() => undefined) : undefined)));
    const chapters: ChapterRef[] = [];
    let readUpTo: string | undefined;
    for (const [i, { chapter, volume }] of ordered.entries()) {
      const url = this.chapterUrl(series.libraryId, series.id, chapter.id);
      const title = chapterTitle(chapter, volume);
      const bookParts = parts[i];
      if (!bookParts) {
        chapters.push({ url, title });
        if (chapter.pages > 0 && chapter.pagesRead >= chapter.pages) readUpTo = url;
        continue;
      }
      const prefix = ordered.length > 1 ? `${title} · ` : '';
      bookParts.forEach((part, p) => chapters.push({ url: withPart(url, p), title: `${prefix}${part.title}` }));
      if (chapter.pagesRead > 0) {
        // The chapter holding the page Kavita's reader left off on (all of them once finished).
        const page = Math.min(chapter.pagesRead, chapter.pages - 1);
        let reached = 0;
        bookParts.forEach((part, p) => {
          if (part.files[0]!.index <= page) reached = p;
        });
        readUpTo = withPart(url, chapter.pagesRead >= chapter.pages ? bookParts.length - 1 : reached);
      }
    }
    const seriesUrl = this.seriesUrl(series.libraryId, series.id);
    return {
      series: {
        id: seriesIdFor(this.server.id, seriesUrl),
        siteId: this.server.id,
        url: seriesUrl,
        title: series.localizedName || series.name,
        cover: this.http.url('/api/Image/series-cover', { seriesId: series.id }),
        description: metadata.summary?.trim() || undefined,
        authors: (metadata.writers ?? []).map((w) => w.name),
        genres: [...(metadata.genres ?? []), ...(metadata.tags ?? [])].map((g) => g.title),
        status: metadata.publicationStatus === undefined ? undefined : STATUS[metadata.publicationStatus],
      },
      chapters,
      readUpTo,
    };
  }

  async loadChapter(url: string): Promise<ChapterContent> {
    const chapterId = Number(this.http.idAfter(url, 'chapter'));
    const info = await this.get<KavitaChapterInfo>('/api/Reader/chapter-info', { chapterId, extractPdf: true });
    const chapterUrl = this.chapterUrl(info.libraryId, info.seriesId, chapterId);
    const neighbor = async (which: 'next' | 'prev') => {
      const id = await this.get<number>(`/api/Reader/${which}-chapter`, { seriesId: info.seriesId, volumeId: info.volumeId, currentChapterId: chapterId }).catch(() => -1);
      if (id <= 0) return undefined;
      const neighborUrl = this.chapterUrl(info.libraryId, info.seriesId, id);
      if (info.seriesFormat !== FORMAT.epub) return neighborUrl;
      // Into the neighbouring book: its first chapter going forward, its last going back.
      if (which === 'next') return withPart(neighborUrl, 0);
      const parts = await this.parts(id).catch(() => [] as BookPart[]);
      return withPart(neighborUrl, Math.max(parts.length - 1, 0));
    };
    const seriesUrl = this.seriesUrl(info.libraryId, info.seriesId);

    if (info.seriesFormat === FORMAT.epub) {
      const parts = await this.parts(chapterId, info.pages);
      const index = Math.min(Math.max(partOf(url), 0), parts.length - 1);
      const blocks = await this.partBlocks(chapterId, parts[index]!);
      const [prev, next] = await Promise.all([
        index > 0 ? withPart(chapterUrl, index - 1) : neighbor('prev'),
        index < parts.length - 1 ? withPart(chapterUrl, index + 1) : neighbor('next'),
      ]);
      return { url: withPart(chapterUrl, index), title: parts[index]!.title, seriesUrl, prev, next, body: { kind: 'text', paragraphs: blockParagraphs(blocks), blocks } };
    }

    const [next, prev] = await Promise.all([neighbor('next'), neighbor('prev')]);
    if (!info.pages) throw new Error(`${this.http.label} has no pages for this chapter`);
    // Pages are numbered from 0; extractPdf has Kavita render PDF pages as images.
    const pages = Array.from({ length: info.pages }, (_, page) => this.http.url('/api/Reader/image', { chapterId, page, extractPdf: true }));
    return { url: chapterUrl, title: infoTitle(info), seriesUrl, next, prev, body: { kind: 'images', pages } };
  }

  /** An EPUB's chapters, from Kavita's table of contents over its pages. */
  private async parts(chapterId: number, pages?: number): Promise<BookPart[]> {
    const [toc, count] = await Promise.all([
      this.get<KavitaTocItem[]>(`/api/Book/${chapterId}/chapters`),
      pages ?? this.get<{ pages: number }>(`/api/Book/${chapterId}/book-info`).then((b) => b.pages),
    ]);
    return splitParts(count, topLevel(toc ?? []).map((t) => ({ title: t.title ?? '', index: t.page, id: t.part || undefined })));
  }

  /** A chapter's text with its structure, page by page as Kavita splits the book. */
  private async partBlocks(chapterId: number, part: BookPart): Promise<TextBlock[]> {
    const api = `${this.server.url}/api/`;
    const blocks: TextBlock[] = [];
    for (const file of part.files) {
      const url = this.http.url(`/api/Book/${chapterId}/book-page`, { page: file.index });
      // Kavita sends each page as an HTML fragment, not a whole document.
      const html = await (await this.call(url)).text();
      const doc = this.http.parse(/<body[\s>]/i.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`, url);
      blocks.push(...htmlBlocks(doc, url, { allowImage: (src) => src.startsWith(api), startId: file.startId, endId: file.endId }));
    }
    if (!blocks.length) throw new Error(`${this.http.label}: this chapter has no readable text`);
    return blocks;
  }

  async search(query: string): Promise<SearchResult[]> {
    const found = await this.get<{ series?: { seriesId: number; libraryId: number; name: string; localizedName?: string }[] }>('/api/Search/search', {
      queryString: query,
      includeChapterAndFiles: false,
    });
    return (found.series ?? []).map((s) => ({
      url: this.seriesUrl(s.libraryId, s.seriesId),
      title: s.localizedName || s.name,
      cover: this.http.url('/api/Image/series-cover', { seriesId: s.seriesId }),
    }));
  }

  async explore(list: number, page: number): Promise<{ results: SearchResult[]; hasMore: boolean }> {
    const sortOptions = EXPLORE_SORT[list];
    if (!sortOptions) throw new Error(`${this.http.label} has no list ${list}`);
    const series = await this.post<KavitaSeries[]>(
      '/api/Series/all-v2',
      { PageNumber: page, PageSize: PAGE_SIZE },
      { statements: [], combination: 1, sortOptions, limitTo: 0 },
    );
    return {
      results: (series ?? []).map((s) => ({ url: this.seriesUrl(s.libraryId, s.id), title: s.localizedName || s.name, cover: this.http.url('/api/Image/series-cover', { seriesId: s.id }) })),
      hasMore: (series?.length ?? 0) >= PAGE_SIZE,
    };
  }

  async markRead(chapterUrl: string): Promise<void> {
    const chapterId = Number(this.http.idAfter(chapterUrl, 'chapter'));
    const info = await this.get<KavitaChapterInfo>('/api/Reader/chapter-info', { chapterId, extractPdf: true });
    // Progress on the last page is what Kavita's own reader saves when a chapter is finished. Inside
    // an EPUB, a chapter before the last saves the page it starts on instead.
    let pageNum = info.pages;
    const part = partOf(chapterUrl);
    if (part >= 0 && info.seriesFormat === FORMAT.epub) {
      const parts = await this.parts(chapterId, info.pages);
      if (part < parts.length - 1) pageNum = parts[part]!.files[0]!.index;
    }
    await this.post('/api/Reader/progress', {}, { volumeId: info.volumeId, chapterId, pageNum, seriesId: info.seriesId, libraryId: info.libraryId });
  }

  async fetchImage(url: string): Promise<Blob> {
    return (await this.call(url)).blob();
  }
}

/** Volumes in order with their chapters, then chapters outside volumes, then specials. */
function readingOrder(detail: KavitaSeriesDetail): { chapter: KavitaChapter; volume?: KavitaVolume }[] {
  const out: { chapter: KavitaChapter; volume?: KavitaVolume }[] = [];
  const seen = new Set<number>();
  const add = (chapter: KavitaChapter, volume?: KavitaVolume) => {
    if (seen.has(chapter.id)) return;
    seen.add(chapter.id);
    out.push({ chapter, volume });
  };
  const bySort = (a: KavitaChapter, b: KavitaChapter) => (a.sortOrder ?? a.minNumber ?? 0) - (b.sortOrder ?? b.minNumber ?? 0);
  const volumes = [...(detail.volumes ?? [])]
    .filter((v) => v.minNumber !== LOOSE_LEAF && v.minNumber !== SPECIALS)
    .sort((a, b) => a.minNumber - b.minNumber);
  for (const volume of volumes) for (const chapter of [...volume.chapters].sort(bySort)) add(chapter, volume);
  for (const chapter of [...(detail.chapters ?? [])].sort(bySort)) add(chapter);
  for (const chapter of [...(detail.specials ?? [])].sort(bySort)) add(chapter);
  return out;
}

/** Same naming as the series' chapter list (chapterTitle), from what chapter-info reports. */
function infoTitle(info: KavitaChapterInfo): string {
  if (info.isSpecial) return info.chapterTitle || info.title || 'special';
  const number = info.chapterNumber;
  const wholeVolume = !number || number === String(LOOSE_LEAF) || number === '0';
  const volume = info.volumeNumber && info.volumeNumber !== String(LOOSE_LEAF) ? info.volumeNumber : undefined;
  const base = wholeVolume ? (volume ? `vol. ${volume}` : info.chapterTitle || 'chapter') : `ch. ${number}`;
  return info.chapterTitle && !(wholeVolume && !volume) ? `${base}: ${info.chapterTitle}` : base;
}

function chapterTitle(chapter: KavitaChapter, volume?: KavitaVolume): string {
  if (chapter.isSpecial) return chapter.titleName || chapter.title || chapter.range || 'special';
  // A volume file with no chapter number of its own is the whole volume.
  const wholeVolume = volume && (chapter.minNumber === LOOSE_LEAF || chapter.range === String(LOOSE_LEAF) || chapter.range === '0' || !chapter.range);
  const base = wholeVolume ? `vol. ${volume.name || volume.minNumber}` : `ch. ${chapter.range ?? chapter.minNumber ?? chapter.id}`;
  const prefix = volume && !wholeVolume ? `vol. ${volume.name || volume.minNumber} ` : '';
  return chapter.titleName ? `${prefix}${base}: ${chapter.titleName}` : `${prefix}${base}`;
}

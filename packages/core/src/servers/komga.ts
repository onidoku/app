import { seriesIdFor } from '../extract';
import { blockParagraphs, htmlBlocks } from '../text';
import type { ChapterContent, ChapterRef, SearchResult, TextBlock } from '../types';
import { resolveUrl } from '../url';
import { partOf, splitParts, topLevel, withPart, type BookPart } from './parts';
import { BROWSER_IMAGE_TYPES, ServerHttp, type MediaServer, type ServerConfig, type ServerIO, type ServerSeries } from './server';

// Shapes from Komga's OpenAPI spec (komga/docs/openapi.json), only the fields used here.
interface KomgaSeries {
  id: string;
  name: string;
  deleted?: boolean;
  metadata: { title?: string; status?: string; summary?: string; genres?: string[]; tags?: string[] };
  booksMetadata?: { summary?: string; authors?: { name: string; role: string }[] };
}
interface KomgaBook {
  id: string;
  seriesId: string;
  name: string;
  deleted?: boolean;
  metadata: { title?: string; number?: string };
  media: { mediaProfile?: string; mediaType?: string; pagesCount: number; epubDivinaCompatible?: boolean };
  readProgress?: { completed: boolean } | null;
}
interface KomgaPage<T> {
  content: T[];
  last: boolean;
}
interface KomgaPageInfo {
  number: number;
  mediaType: string;
}
interface KomgaTocEntry {
  title?: string;
  href: string;
  children?: KomgaTocEntry[];
}
interface KomgaManifest {
  readingOrder?: { href: string; type?: string }[];
  toc?: KomgaTocEntry[];
}
/** Where the reader is in an EPUB, as Komga's own reader saves it (Readium's locator). */
interface KomgaProgression {
  locator?: { href?: string };
}

const STATUS: Record<string, string> = { ENDED: 'completed', ONGOING: 'ongoing', ABANDONED: 'abandoned', HIATUS: 'hiatus' };
const PAGE_SIZE = 30;
const EXPLORE_PATHS = ['/api/v1/series/new', '/api/v1/series/updated', '/api/v1/series'];
// Writers first; Komga lists everyone credited (pencillers, colorists, …) with a role.
const AUTHOR_ROLES = ['writer', 'author', 'story'];

export class KomgaServer implements MediaServer {
  private readonly http: ServerHttp;

  constructor(
    private readonly server: ServerConfig,
    io: ServerIO,
  ) {
    this.http = new ServerHttp(server, io);
  }

  private headers(): Record<string, string> {
    if (this.server.apiKey) return { 'X-API-Key': this.server.apiKey };
    const bytes = new TextEncoder().encode(`${this.server.username}:${this.server.password}`);
    return { Authorization: `Basic ${btoa(String.fromCharCode(...bytes))}` };
  }

  private get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.http.json<T>(this.http.url(path, query), { headers: this.headers() });
  }

  private seriesUrl(id: string): string {
    return `${this.server.url}/series/${encodeURIComponent(id)}`;
  }

  private bookUrl(id: string, part?: number): string {
    const url = `${this.server.url}/book/${encodeURIComponent(id)}`;
    return part === undefined ? url : withPart(url, part);
  }

  async verify(): Promise<string> {
    const me = await this.get<{ email?: string; id: string }>('/api/v2/users/me');
    return me.email ?? me.id;
  }

  async loadSeries(url: string): Promise<ServerSeries> {
    const id = this.http.idAfter(url, 'series');
    const [series, books] = await Promise.all([
      this.get<KomgaSeries>(`/api/v1/series/${encodeURIComponent(id)}`),
      this.get<KomgaPage<KomgaBook>>(`/api/v1/series/${encodeURIComponent(id)}/books`, { unpaged: true, sort: 'metadata.numberSort,asc' }),
    ]);
    const live = books.content.filter((b) => !b.deleted);
    const parts = await Promise.all(live.map((b) => (isTextBook(b) ? this.parts(b.id) : Promise.resolve(undefined))));

    // Text EPUBs list their own chapters; every other book is one chapter.
    const chapters: ChapterRef[] = [];
    let readUpTo: string | undefined;
    for (const [i, book] of live.entries()) {
      const bookParts = parts[i];
      if (!bookParts) {
        chapters.push({ url: this.bookUrl(book.id), title: bookTitle(book) });
        if (book.readProgress?.completed) readUpTo = chapters.at(-1)!.url;
        continue;
      }
      const prefix = live.length > 1 ? `${bookTitle(book)} · ` : '';
      const urls = bookParts.map((part, p) => {
        chapters.push({ url: this.bookUrl(book.id, p), title: `${prefix}${part.title}` });
        return this.bookUrl(book.id, p);
      });
      if (book.readProgress?.completed) readUpTo = urls.at(-1);
      else if (book.readProgress) readUpTo = (await this.progressPart(book.id, bookParts).catch(() => undefined)) ?? readUpTo;
    }

    const credits = series.booksMetadata?.authors ?? [];
    const writers = credits.filter((a) => AUTHOR_ROLES.includes(a.role.toLowerCase()));
    const seriesUrl = this.seriesUrl(series.id);
    return {
      series: {
        id: seriesIdFor(this.server.id, seriesUrl),
        siteId: this.server.id,
        url: seriesUrl,
        title: series.metadata.title || series.name,
        cover: this.http.url(`/api/v1/series/${encodeURIComponent(series.id)}/thumbnail`),
        description: series.metadata.summary || series.booksMetadata?.summary || undefined,
        authors: unique((writers.length ? writers : credits).map((a) => a.name)),
        genres: unique([...(series.metadata.genres ?? []), ...(series.metadata.tags ?? [])]),
        status: series.metadata.status ? STATUS[series.metadata.status] : undefined,
      },
      chapters,
      readUpTo,
    };
  }

  async loadChapter(url: string): Promise<ChapterContent> {
    const id = this.http.idAfter(url, 'book');
    const book = await this.get<KomgaBook>(`/api/v1/books/${encodeURIComponent(id)}`);
    const seriesUrl = this.seriesUrl(book.seriesId);

    if (isTextBook(book)) {
      const manifest = await this.manifest(id);
      const parts = bookParts(manifest);
      const index = Math.min(Math.max(partOf(url), 0), parts.length - 1);
      const blocks = await this.partBlocks(id, manifest, parts[index]!);
      const [prev, next] = await Promise.all([
        index > 0 ? this.bookUrl(id, index - 1) : this.neighbor(id, 'previous', 'last'),
        index < parts.length - 1 ? this.bookUrl(id, index + 1) : this.neighbor(id, 'next', 'first'),
      ]);
      return {
        url: this.bookUrl(id, index),
        title: parts[index]!.title,
        seriesUrl,
        prev,
        next,
        body: { kind: 'text', paragraphs: blockParagraphs(blocks), blocks },
      };
    }

    // Image books (CBZ, CBR, PDF, image-only EPUB) are read page by page; Komga renders PDF pages to images.
    const [next, prev, pages] = await Promise.all([
      this.neighbor(id, 'next', 'first'),
      this.neighbor(id, 'previous', 'last'),
      this.get<KomgaPageInfo[]>(`/api/v1/books/${encodeURIComponent(id)}/pages`),
    ]);
    if (!pages.length) throw new Error(`${this.http.label} has no pages for this book (is it still being analyzed?)`);
    return {
      url: this.bookUrl(book.id),
      title: bookTitle(book),
      seriesUrl,
      next,
      prev,
      body: {
        kind: 'images',
        pages: pages.map((p) =>
          this.http.url(`/api/v1/books/${encodeURIComponent(id)}/pages/${p.number}`, BROWSER_IMAGE_TYPES.has(p.mediaType) ? {} : { convert: 'png' }),
        ),
      },
    };
  }

  private manifest(id: string): Promise<KomgaManifest> {
    return this.http.json<KomgaManifest>(this.http.url(`/api/v1/books/${encodeURIComponent(id)}/manifest`), {
      headers: { ...this.headers(), accept: 'application/webpub+json, application/json' },
    });
  }

  private async parts(id: string): Promise<BookPart[]> {
    return bookParts(await this.manifest(id));
  }

  /** A chapter's text with its structure, from the book's own files on this server only. */
  private async partBlocks(id: string, manifest: KomgaManifest, part: BookPart): Promise<TextBlock[]> {
    const resources = `${this.server.url}/api/v1/books/${encodeURIComponent(id)}/resource/`;
    const blocks: TextBlock[] = [];
    for (const file of part.files) {
      const href = resolveUrl(manifest.readingOrder?.[file.index]?.href, resources);
      if (!href?.startsWith(resources)) continue;
      const doc = this.http.parse(await this.http.text(href, { headers: this.headers() }), href);
      blocks.push(...htmlBlocks(doc, href, { allowImage: (src) => src.startsWith(resources), startId: file.startId, endId: file.endId }));
    }
    if (!blocks.length) throw new Error(`${this.http.label}: this chapter has no readable text`);
    return blocks;
  }

  /** The chapter Komga's reader left off in, from its saved position in the book. */
  private async progressPart(id: string, parts: BookPart[]): Promise<string | undefined> {
    const [progression, manifest] = await Promise.all([
      this.get<KomgaProgression>(`/api/v1/books/${encodeURIComponent(id)}/progression`),
      this.manifest(id),
    ]);
    const href = progression.locator?.href?.split('#')[0];
    if (!href) return undefined;
    const file = (manifest.readingOrder ?? []).findIndex((r) => r.href.split('#')[0]!.endsWith(`/resource/${href}`));
    if (file < 0) return undefined;
    // The chapter starting in that file (the first, when chapters share it), else the one running through it.
    let part = parts.findIndex((p) => p.files[0]!.index === file);
    if (part < 0) parts.forEach((p, i) => p.files[0]!.index < file && (part = i));
    return part >= 0 ? this.bookUrl(id, part) : undefined;
  }

  /** The first or last chapter of the next or previous book in the series. */
  private async neighbor(id: string, which: 'next' | 'previous', end: 'first' | 'last'): Promise<string | undefined> {
    let book: KomgaBook;
    try {
      book = await this.get<KomgaBook>(`/api/v1/books/${encodeURIComponent(id)}/${which}`);
    } catch {
      return undefined; // 404 at either end of the series
    }
    if (!isTextBook(book)) return this.bookUrl(book.id);
    const parts = await this.parts(book.id).catch(() => [] as BookPart[]);
    return this.bookUrl(book.id, end === 'first' || !parts.length ? 0 : parts.length - 1);
  }

  async search(query: string): Promise<SearchResult[]> {
    // Komga keeps series whose files are gone, marked deleted; they can't be read.
    const page = await this.get<KomgaPage<KomgaSeries>>('/api/v1/series', { search: query, size: 50, deleted: false });
    return page.content.filter((s) => !s.deleted).map((s) => this.result(s));
  }

  async explore(list: number, page: number): Promise<{ results: SearchResult[]; hasMore: boolean }> {
    const path = EXPLORE_PATHS[list];
    if (!path) throw new Error(`${this.http.label} has no list ${list}`);
    const sort = list === 2 ? 'metadata.titleSort,asc' : undefined;
    const result = await this.get<KomgaPage<KomgaSeries>>(path, { page: page - 1, size: PAGE_SIZE, sort, deleted: false });
    return { results: result.content.filter((s) => !s.deleted).map((s) => this.result(s)), hasMore: !result.last };
  }

  async markRead(chapterUrl: string): Promise<void> {
    const id = this.http.idAfter(chapterUrl, 'book');
    const part = partOf(chapterUrl);
    if (part >= 0) {
      const manifest = await this.manifest(id);
      const parts = bookParts(manifest);
      // Inside a book: save the position at this chapter's start, as Komga's own reader would.
      // Opening the last chapter finishes the book.
      if (part < parts.length - 1) return this.saveProgression(id, manifest, parts[part]!);
    }
    await this.http.request(this.http.url(`/api/v1/books/${encodeURIComponent(id)}/read-progress`), {
      method: 'PATCH',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ completed: true }),
    });
  }

  private async saveProgression(id: string, manifest: KomgaManifest, part: BookPart): Promise<void> {
    const order = manifest.readingOrder ?? [];
    const file = order[part.files[0]!.index];
    const href = file?.href.split('#')[0]!.split('/resource/')[1];
    if (!file || !href) return;
    await this.http.request(this.http.url(`/api/v1/books/${encodeURIComponent(id)}/progression`), {
      method: 'PUT',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({
        modified: new Date().toISOString(),
        device: { id: 'onidoku', name: 'onidoku' },
        locator: {
          href: decodeURIComponent(href),
          type: file.type ?? 'application/xhtml+xml',
          locations: { progression: 0, totalProgression: part.files[0]!.index / Math.max(order.length, 1) },
        },
      }),
    });
  }

  async fetchImage(url: string): Promise<Blob> {
    return (await this.http.request(url, { headers: this.headers() })).blob();
  }

  private result(s: KomgaSeries): SearchResult {
    return { url: this.seriesUrl(s.id), title: s.metadata.title || s.name, cover: this.http.url(`/api/v1/series/${encodeURIComponent(s.id)}/thumbnail`) };
  }
}

/** EPUBs made of text, read chapter by chapter (image-only EPUBs are read page by page). */
function isTextBook(book: KomgaBook): boolean {
  return book.media.mediaProfile === 'EPUB' && !book.media.epubDivinaCompatible;
}

/** Splits an EPUB into chapters by its table of contents (see splitParts). */
function bookParts(manifest: KomgaManifest): BookPart[] {
  const files = (manifest.readingOrder ?? []).map((r) => r.href.split('#')[0]!);
  const toc = topLevel(manifest.toc ?? []).map((e) => {
    const [path, id] = e.href.split('#');
    return { title: e.title ?? '', index: files.findIndex((f) => sameFile(f, path!)), id: id || undefined };
  });
  return splitParts(files.length, toc);
}

function sameFile(a: string, b: string): boolean {
  try {
    return decodeURIComponent(a) === decodeURIComponent(b) || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
  } catch {
    return a === b;
  }
}

function bookTitle(book: KomgaBook): string {
  return book.metadata.title || book.name || `book ${book.metadata.number ?? ''}`.trim();
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

import { describe, expect, it } from 'vitest';
import { createKavita, createKomga, KAVITA_API_KEY, KOMGA_API_KEY, KOMGA_USER, type FakeServer } from '../../../apps/test-site/media-servers.mjs';
import {
  checkForUpdates,
  connectServer,
  Library,
  loadChapter,
  loadSeries,
  MemoryLibraryStore,
  parseServer,
  serverId,
  serverSiteConfig,
  SiteRegistry,
  htmlBlocks,
  splitParts,
  type HtmlIO,
  type ServerConfig,
} from '../src';
import { parse } from './helpers';

const KOMGA = 'http://media.test/komga';
const KAVITA = 'http://media.test:5000';

/** A fetch that answers from a fake server, recording each request. */
function fakeFetch(server: FakeServer, log: string[] = []): typeof fetch {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => (headers[key] = value));
    log.push(`${init.method ?? 'GET'} ${url.pathname}${url.search}`);
    const res = server.handle({ method: init.method ?? 'GET', url, headers, body: String(init.body ?? '') });
    return new Response(res.status === 204 ? null : res.body, { status: res.status, headers: { 'content-type': res.type } });
  };
}

function setup(kind: 'komga' | 'kavita', credentials: Partial<ServerConfig> = {}) {
  const fake = kind === 'komga' ? createKomga(KOMGA) : createKavita(KAVITA);
  const log: string[] = [];
  const server = parseServer({
    kind,
    url: kind === 'komga' ? `${KOMGA}/` : KAVITA,
    ...(Object.keys(credentials).length ? credentials : { apiKey: kind === 'komga' ? KOMGA_API_KEY : KAVITA_API_KEY }),
  });
  const client = connectServer(server, { fetch: fakeFetch(fake, log), parseHtml: (html) => parse(html) });
  const config = serverSiteConfig(server);
  const io: HtmlIO = { fetchHtml: () => Promise.reject(new Error('no HTML here')), parseHtml: parse, server: () => client };
  return { fake, log, server, client, config, io };
}

describe('servers', () => {
  it('validates servers and gives them stable ids and names', () => {
    expect(serverId('komga', 'https://Example.org:8443/komga')).toBe('komga.example-org-8443-komga');
    const server = parseServer({ kind: 'kavita', url: 'http://192.168.1.5:5000/', apiKey: 'k', name: '' });
    expect(server).toMatchObject({ id: 'kavita.192-168-1-5-5000', name: 'Kavita (192.168.1.5:5000)', url: 'http://192.168.1.5:5000' });
    expect(() => parseServer({ kind: 'kavita', url: 'http://x.test', username: 'a', password: 'b' })).toThrow(/API key/);
    expect(() => parseServer({ kind: 'komga', url: 'ftp://x.test', apiKey: 'k' })).toThrow(/url/);
    expect(parseServer({ kind: 'komga', url: 'http://x.test', username: 'a', password: 'b', apiKey: '' }).apiKey).toBeUndefined();
  });

  it('appears as a source whose pages are the server web UI', () => {
    const { config } = setup('komga');
    const registry = new SiteRegistry([config]);
    expect(registry.match(`${KOMGA}/series/S1`)).toMatchObject({ kind: 'series' });
    expect(registry.match(`${KOMGA}/book/B1`)).toMatchObject({ kind: 'chapter' });
    expect(config.explore?.map((l) => l.name)).toEqual(['recently added', 'recently updated', 'all series']);
    const kavita = new SiteRegistry([setup('kavita').config]);
    expect(kavita.match(`${KAVITA}/library/1/series/1`)).toMatchObject({ kind: 'series' });
    expect(kavita.match(`${KAVITA}/library/1/series/1/chapter/12`)).toMatchObject({ kind: 'chapter' });
  });
});

describe('Komga', () => {
  it('loads a series with its books, credits and server read progress', async () => {
    const { config, io, server } = setup('komga');
    const { series, chapters, readUpTo } = await loadSeries(`${KOMGA}/series/S1`, config, io);
    expect(series).toMatchObject({
      id: `${server.id}:${KOMGA}/series/S1`,
      title: 'Star Harbor',
      authors: ['Rin Aoki'],
      genres: ['Adventure', 'space'],
      status: 'ongoing',
      cover: `${KOMGA}/api/v1/series/S1/thumbnail`,
    });
    expect(chapters).toEqual([
      { url: `${KOMGA}/book/B1`, title: 'Arrival' },
      { url: `${KOMGA}/book/B2`, title: 'Departure' },
    ]);
    expect(readUpTo).toBe(`${KOMGA}/book/B1`);
  });

  it('reads image books page by page, converting what browsers can’t show', async () => {
    const { config, io } = setup('komga');
    const chapter = await loadChapter(`${KOMGA}/book/B2`, config, io);
    expect(chapter).toMatchObject({ title: 'Departure', prev: `${KOMGA}/book/B1`, next: undefined, seriesUrl: `${KOMGA}/series/S1` });
    expect(chapter.body).toEqual({ kind: 'images', pages: [`${KOMGA}/api/v1/books/B2/pages/1`, `${KOMGA}/api/v1/books/B2/pages/2?convert=png`] });
  });

  it('lists an EPUB’s chapters from its contents, under the book-title entry', async () => {
    const { config, io } = setup('komga');
    const { chapters } = await loadSeries(`${KOMGA}/series/S2`, config, io);
    expect(chapters).toEqual([
      { url: `${KOMGA}/book/B3?part=1`, title: 'Chapter One: Night' },
      { url: `${KOMGA}/book/B3?part=2`, title: 'Chapter Two: Morning' },
      { url: `${KOMGA}/book/B3?part=3`, title: 'Chapter Three: Noon' },
    ]);
  });

  it('reads an EPUB chapter with its structure, stopping where the next chapter starts', async () => {
    const { config, io } = setup('komga');
    const one = await loadChapter(`${KOMGA}/book/B3?part=1`, config, io);
    expect(one).toMatchObject({ title: 'Chapter One: Night', prev: undefined, next: `${KOMGA}/book/B3?part=2` });
    expect(one.body).toEqual({
      kind: 'text',
      paragraphs: ['Chapter One: Night', 'The lamps were the last to fall asleep.', 'Hush, said the shelves.', 'Lamps', 'Books', 'Old ones'],
      blocks: [
        { type: 'heading', level: 1, text: 'Chapter One: Night' },
        { type: 'paragraph', text: 'The lamps were the last to fall asleep.' },
        { type: 'quote', text: 'Hush, said the shelves.' },
        { type: 'item', text: 'Lamps', depth: 0, ordered: false },
        { type: 'item', text: 'Books', depth: 0, ordered: false },
        { type: 'item', text: 'Old ones', depth: 1, ordered: false },
        { type: 'image', src: `${KOMGA}/api/v1/books/B3/resource/OEBPS/images/map.svg`, alt: 'Map of the library' },
      ],
    });
    const two = await loadChapter(`${KOMGA}/book/B3?part=2`, config, io);
    expect(two.body.kind === 'text' && two.body.blocks).toEqual([
      { type: 'heading', level: 1, text: 'Chapter Two: Morning' },
      { type: 'paragraph', text: 'By morning the books were back on their shelves.' },
      { type: 'pre', text: 'catalog --sort\n  by-title' },
    ]);
    const three = await loadChapter(`${KOMGA}/book/B3?part=3`, config, io);
    expect(three.body.kind === 'text' && three.body.paragraphs).toEqual(['Chapter Three: Noon', 'Nobody noticed a thing.']);
    expect(three.next).toBeUndefined();
  });

  it('saves EPUB progress per chapter and reads it back', async () => {
    const { client, fake, config, io } = setup('komga');
    await client.markRead(`${KOMGA}/book/B3?part=2`);
    expect(fake.progress).toEqual([{ bookId: 'B3', progression: { href: 'OEBPS/ch2.xhtml', type: 'application/xhtml+xml', locations: { progression: 0, totalProgression: 2 / 3 } } }]);
    expect((await loadSeries(`${KOMGA}/series/S2`, config, io)).readUpTo).toBe(`${KOMGA}/book/B3?part=2`);
    // Opening the last chapter finishes the book.
    await client.markRead(`${KOMGA}/book/B3?part=3`);
    expect(fake.progress.at(-1)).toEqual({ bookId: 'B3', completed: true });
  });

  it('accepts a username and password, and explains a rejected login', async () => {
    expect(await setup('komga', KOMGA_USER).client.verify()).toBe(KOMGA_USER.username);
    await expect(setup('komga', { apiKey: 'wrong' }).client.verify()).rejects.toThrow(/rejected the login/);
  });

  it('searches, explores, marks read and fetches images with credentials', async () => {
    const { client, fake } = setup('komga');
    expect(await client.search('harbor')).toEqual([{ url: `${KOMGA}/series/S1`, title: 'Star Harbor', cover: `${KOMGA}/api/v1/series/S1/thumbnail` }]);
    // The first tab is Recently added (the fake lists newest first).
    expect((await client.explore(0, 1)).results.map((r) => r.title)).toEqual(['Quiet Library', 'Star Harbor']);
    const explored = await client.explore(2, 1);
    expect(explored.results.map((r) => r.title)).toEqual(['Star Harbor', 'Quiet Library']);
    expect(explored.hasMore).toBe(false);
    await client.markRead(`${KOMGA}/book/B2`);
    expect(fake.progress).toEqual([{ bookId: 'B2', completed: true }]);
    expect((await client.fetchImage(`${KOMGA}/api/v1/series/S1/thumbnail`)).type).toBe('image/svg+xml');
  });
});

describe('Kavita', () => {
  it('logs in with the API key once and loads volumes before loose chapters', async () => {
    const { config, io, log } = setup('kavita');
    const { series, chapters, readUpTo } = await loadSeries(`${KAVITA}/library/1/series/1`, config, io);
    expect(series).toMatchObject({ title: 'Moon Lantern', authors: ['Sora Ito'], genres: ['Fantasy'], status: 'ongoing', url: `${KAVITA}/library/1/series/1` });
    expect(chapters).toEqual([
      { url: `${KAVITA}/library/1/series/1/chapter/11`, title: 'vol. 1' },
      { url: `${KAVITA}/library/1/series/1/chapter/12`, title: 'ch. 2: Ember' },
      { url: `${KAVITA}/library/1/series/1/chapter/13`, title: 'ch. 3' },
    ]);
    expect(readUpTo).toBe(`${KAVITA}/library/1/series/1/chapter/11`);
    expect(log.filter((l) => l.includes('authenticate'))).toHaveLength(1);
  });

  it('reads image chapters with neighbours, and EPUBs as text', async () => {
    const { config, io } = setup('kavita');
    const chapter = await loadChapter(`${KAVITA}/library/1/series/1/chapter/12`, config, io);
    expect(chapter).toMatchObject({
      title: 'ch. 2: Ember',
      prev: `${KAVITA}/library/1/series/1/chapter/11`,
      next: `${KAVITA}/library/1/series/1/chapter/13`,
    });
    expect(chapter.body).toEqual({
      kind: 'images',
      pages: [0, 1].map((p) => `${KAVITA}/api/Reader/image?chapterId=12&page=${p}&extractPdf=true`),
    });
    const { chapters } = await loadSeries(`${KAVITA}/library/2/series/2`, config, io);
    expect(chapters.map((c) => c.title)).toEqual(['One', 'Two', 'Three']);
    const two = await loadChapter(`${KAVITA}/library/2/series/2/chapter/21?part=2`, config, io);
    expect(two).toMatchObject({ title: 'Two', prev: `${KAVITA}/library/2/series/2/chapter/21?part=1`, next: `${KAVITA}/library/2/series/2/chapter/21?part=3` });
    expect(two.body.kind === 'text' && two.body.paragraphs).toEqual(['Two', 'She folded one more before sleeping.']);
    const one = await loadChapter(`${KAVITA}/library/2/series/2/chapter/21?part=1`, config, io);
    expect(one.body.kind === 'text' && one.body.blocks?.filter((b) => b.type === 'item')).toEqual([
      { type: 'item', text: 'Fold', depth: 0, ordered: true },
      { type: 'item', text: 'Wait', depth: 0, ordered: true },
    ]);
  });

  it('searches, explores, saves progress and rejects a bad key', async () => {
    const { client, fake } = setup('kavita');
    expect((await client.search('paper')).map((r) => r.url)).toEqual([`${KAVITA}/library/2/series/2`]);
    expect((await client.explore(2, 1)).results.map((r) => r.title)).toEqual(['Moon Lantern', 'Paper Stars']);
    await client.markRead(`${KAVITA}/library/1/series/1/chapter/12`);
    expect(fake.progress).toEqual([{ volumeId: 199, chapterId: 12, pageNum: 2, seriesId: 1, libraryId: 1 }]);
    await expect(setup('kavita', { apiKey: 'wrong' }).client.verify()).rejects.toThrow(/rejected the API key/);
  });
});

describe('update checks with servers', () => {
  it('finds new books and takes read progress from the server', async () => {
    const { config, io, fake } = setup('komga');
    const library = new Library(new MemoryLibraryStore());
    const { series, chapters } = await loadSeries(`${KOMGA}/series/S1`, config, io);
    await library.add(series, chapters);
    (fake as ReturnType<typeof createKomga>).addBook('S1');
    const result = await checkForUpdates({ library, registry: new SiteRegistry([config]), ...io, delayMs: 0 });
    expect(result.failures).toEqual([]);
    expect(result.updates[0]?.added.map((c) => c.title)).toEqual(['Chapter 3']);
    expect((await library.get(series.id))?.readUpTo).toBe(`${KOMGA}/book/B1`);
  });
});

describe('splitting books into chapters', () => {
  it('makes one chapter per file when the contents has a single entry', () => {
    expect(splitParts(3, [{ title: 'Start', index: 0 }]).map((p) => p.title)).toEqual(['part 1', 'part 2', 'part 3']);
    expect(splitParts(1, [])).toEqual([{ title: 'part 1', files: [{ index: 0 }] }]);
  });

  it('skips front matter, splits shared files at anchors and drops out-of-order entries', () => {
    const parts = splitParts(5, [
      { title: 'A', index: 1 },
      { title: 'B', index: 2, id: 'b' },
      { title: 'stray', index: 1 },
      { title: 'C', index: 3, id: 'c' },
    ]);
    expect(parts).toEqual([
      { title: 'A', files: [{ index: 1 }, { index: 2, endId: 'b' }] },
      { title: 'B', files: [{ index: 2, startId: 'b' }, { index: 3, endId: 'c' }] },
      { title: 'C', files: [{ index: 3, startId: 'c' }, { index: 4 }] },
    ]);
  });

  it('keeps code lines as they are, whatever the line endings', () => {
    const doc = parse('<html><body><pre>a\r\n  b\r\n</pre></body></html>');
    expect(htmlBlocks(doc, 'http://x.test/a.xhtml')).toEqual([{ type: 'pre', text: 'a\n  b' }]);
  });

  it('keeps the whole file when an anchor is missing', () => {
    const doc = parse('<html><body><p>One</p><p>Two</p></body></html>');
    expect(htmlBlocks(doc, 'http://x.test/a.xhtml', { startId: 'nowhere' })).toHaveLength(2);
  });
});

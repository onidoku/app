import { describe, expect, it } from 'vitest';
import {
  chapterNeighbors,
  checkForUpdates,
  Library,
  LibraryEntrySchema,
  MemoryLibraryStore,
  newCount,
  nextToRead,
  SiteRegistry,
  unreadCount,
  type ChapterRef,
  type Series,
} from '../src';
import { BASE, mangaConfig, parse } from './helpers';

const series: Series = {
  id: 'testsite.manga:http://localhost:4173/series/moon-garden',
  siteId: 'testsite.manga',
  url: `${BASE}/series/moon-garden`,
  title: 'Moon Garden',
};

const chapters = (n: number): ChapterRef[] =>
  Array.from({ length: n }, (_, i) => ({ url: `${BASE}/series/moon-garden/chapter/${i + 1}`, title: `Chapter ${i + 1}` }));

function newLibrary() {
  let t = 1000;
  return new Library(new MemoryLibraryStore(), () => t++);
}

describe('Library', () => {
  it('tracks progress and unread counts', async () => {
    const library = newLibrary();
    await library.add(series, chapters(5));
    let entry = (await library.get(series.id))!;
    expect(unreadCount(entry)).toBe(5);
    expect(nextToRead(entry)?.title).toBe('Chapter 1');

    await library.markRead(`${BASE}/series/moon-garden/chapter/3#page-4`);
    entry = (await library.get(series.id))!;
    expect(unreadCount(entry)).toBe(2);
    expect(nextToRead(entry)?.title).toBe('Chapter 4');

    // Re-reading an earlier chapter doesn't move progress backwards.
    await library.markRead(`${BASE}/series/moon-garden/chapter/1`);
    expect(unreadCount((await library.get(series.id))!)).toBe(2);
  });

  it('finds neighbouring chapters', async () => {
    const library = newLibrary();
    const entry = await library.add(series, chapters(3));
    expect(chapterNeighbors(entry, `${BASE}/series/moon-garden/chapter/2#p1`)).toEqual({
      prev: `${BASE}/series/moon-garden/chapter/1`,
      next: `${BASE}/series/moon-garden/chapter/3`,
    });
    expect(chapterNeighbors(entry, `${BASE}/series/moon-garden/chapter/1`).prev).toBeUndefined();
    expect(chapterNeighbors(entry, `${BASE}/elsewhere`)).toEqual({});
  });

  it('ignores chapters that are not in the library', async () => {
    const library = newLibrary();
    expect(await library.markRead(`${BASE}/series/other/chapter/1`)).toBeUndefined();
  });

  it('does not lose writes made concurrently', async () => {
    const library = newLibrary();
    await library.add(series, chapters(3));
    await Promise.all([
      library.markRead(`${BASE}/series/moon-garden/chapter/2`),
      library.mergeChapters(series.id, chapters(4)),
      library.add({ ...series, id: 'other', url: `${BASE}/series/other` }, []),
    ]);
    const entry = (await library.get(series.id))!;
    expect(entry.chapters).toHaveLength(4);
    expect(entry.readUpTo).toBe(`${BASE}/series/moon-garden/chapter/2`);
    expect(await library.list()).toHaveLength(2);
  });

  it('keeps progress when the read chapter disappears from the site', async () => {
    const library = newLibrary();
    await library.add(series, chapters(4));
    await library.markRead(`${BASE}/series/moon-garden/chapter/3`);
    const fresh = chapters(5).filter((c) => !c.url.endsWith('/3'));
    await library.mergeChapters(series.id, fresh);
    const entry = (await library.get(series.id))!;
    expect(entry.readUpTo).toBe(`${BASE}/series/moon-garden/chapter/2`);
  });

  it('sets progress explicitly, including backwards and to nothing', async () => {
    const library = newLibrary();
    await library.add(series, chapters(5));
    await library.markRead(`${BASE}/series/moon-garden/chapter/4`);
    await library.setProgress(series.id, `${BASE}/series/moon-garden/chapter/2`);
    expect(unreadCount((await library.get(series.id))!)).toBe(3);
    await library.setProgress(series.id, null);
    expect(unreadCount((await library.get(series.id))!)).toBe(5);
    expect(await library.setProgress(series.id, `${BASE}/elsewhere`)).toBeUndefined();
  });

  it('refreshes series details on merge but keeps its identity', async () => {
    const library = newLibrary();
    await library.add(series, chapters(2));
    await library.mergeChapters(series.id, chapters(2), { ...series, id: 'changed', title: 'Moon Garden (Remastered)', status: 'Completed' });
    const entry = (await library.get(series.id))!;
    expect(entry.series).toMatchObject({ id: series.id, title: 'Moon Garden (Remastered)', status: 'Completed' });
  });

  it('keeps the old chapter list when a scrape comes back empty', async () => {
    const library = newLibrary();
    await library.add(series, chapters(3));
    expect((await library.mergeChapters(series.id, []))?.added).toEqual([]);
    expect((await library.get(series.id))?.chapters).toHaveLength(3);
  });
});

describe('Library.import', () => {
  it('adds new series and keeps whichever copy was read most recently', async () => {
    const library = newLibrary();
    const local = await library.add(series, chapters(3));
    await library.markRead(chapters(3)[1]!.url);

    const other: Series = { ...series, id: 'testsite.manga:other', title: 'Other' };
    const stale = { ...local, readUpTo: undefined, lastReadAt: 1 };
    const fresh = { series: other, chapters: chapters(2), addedAt: 5 };
    expect(await library.import([stale, fresh])).toBe(1);
    expect((await library.get(series.id))?.readUpTo).toBe(chapters(3)[1]!.url);
    expect((await library.get(other.id))?.series.title).toBe('Other');

    const newer = { ...local, readUpTo: chapters(3)[2]!.url, lastReadAt: 1e12 };
    expect(await library.import([newer])).toBe(1);
    expect(unreadCount((await library.get(series.id))!)).toBe(0);
  });

  it('validates entries from backups', () => {
    expect(LibraryEntrySchema.safeParse({ series, chapters: chapters(1), addedAt: 1 }).success).toBe(true);
    expect(LibraryEntrySchema.safeParse({ series: { title: 'x' }, chapters: [], addedAt: 1 }).success).toBe(false);
  });
});

describe('checkForUpdates', () => {
  const page = (n: number) =>
    `<h1 class="series-title">Moon Garden</h1><ul class="chapter-list">${chapters(n)
      .reverse()
      .map((c) => `<li><a href="${c.url}"><span class="chapter-name">${c.title}</span></a></li>`)
      .join('')}</ul>`;

  it('reports new chapters and failures without stopping', async () => {
    const library = newLibrary();
    await library.add(series, chapters(3));
    await library.add({ ...series, id: 'gone', siteId: 'uninstalled.site', title: 'Gone' }, []);
    await library.add({ ...series, id: 'broken', url: `${BASE}/series/broken`, title: 'Broken' }, []);

    const sleeps: number[] = [];
    const { updates, failures } = await checkForUpdates({
      library,
      registry: new SiteRegistry([mangaConfig]),
      fetchHtml: async (url) => (url.endsWith('broken') ? '<p>maintenance</p>' : page(5)),
      parseHtml: parse,
      sleep: async (ms) => void sleeps.push(ms),
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]!.added.map((c) => c.title)).toEqual(['Chapter 4', 'Chapter 5']);
    expect(failures.map((f) => f.title).sort()).toEqual(['Broken', 'Gone']);
    expect(failures.find((f) => f.title === 'Gone')?.error).toMatch(/not installed/);
    expect(sleeps).toEqual([1500]);
  });
});

describe('new chapters', () => {
  it('counts chapters found by update checks until they are read or seen', async () => {
    const library = new Library(new MemoryLibraryStore());
    const series = { id: 's:http://x.test/s', siteId: 's', url: 'http://x.test/s', title: 'S' };
    const ch = (n: number) => ({ url: `http://x.test/s/${n}`, title: `Chapter ${n}` });
    await library.add(series, [ch(1), ch(2)]);
    expect(newCount((await library.get(series.id))!)).toBe(0);

    await library.mergeChapters(series.id, [ch(1), ch(2), ch(3), ch(4)]);
    expect((await library.get(series.id))!.newChapters).toEqual([ch(3).url, ch(4).url]);

    // Reading past a new chapter clears it; the later one stays new.
    await library.markRead(ch(3).url);
    expect(newCount((await library.get(series.id))!)).toBe(1);

    // A chapter dropped from the site stops counting too.
    await library.mergeChapters(series.id, [ch(1), ch(2), ch(3)]);
    expect(newCount((await library.get(series.id))!)).toBe(0);

    await library.mergeChapters(series.id, [ch(1), ch(2), ch(3), ch(5)]);
    await library.clearNew(series.id);
    expect((await library.get(series.id))!.newChapters).toBeUndefined();
  });
});

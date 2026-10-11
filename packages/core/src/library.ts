import { v, type Infer } from './validate';
import type { ChapterRef, Series } from './types';
import { normalizeUrl } from './url';

/** Minimal async key-value storage, backed by chrome.storage in the extension. */
export interface KeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/** Where library entries live, one record per series (IndexedDB in the extension). */
export interface LibraryStore {
  all(): Promise<LibraryEntry[]>;
  get(id: string): Promise<LibraryEntry | undefined>;
  /** Stores `put` and deletes `remove` (series ids) together. */
  write(put: LibraryEntry[], remove: string[]): Promise<void>;
}

export class MemoryLibraryStore implements LibraryStore {
  private readonly data = new Map<string, LibraryEntry>();

  async all(): Promise<LibraryEntry[]> {
    return [...this.data.values()].map((e) => structuredClone(e));
  }

  async get(id: string): Promise<LibraryEntry | undefined> {
    const entry = this.data.get(id);
    return entry && structuredClone(entry);
  }

  async write(put: LibraryEntry[], remove: string[]): Promise<void> {
    for (const entry of put) this.data.set(entry.series.id, structuredClone(entry));
    for (const id of remove) this.data.delete(id);
  }
}

export interface LibraryEntry {
  series: Series;
  /** Oldest first. */
  chapters: ChapterRef[];
  /** URL of the furthest chapter read; everything before it counts as read. */
  readUpTo?: string;
  /**
   * Chapters found by update checks that the user hasn't read or looked at yet: what the toolbar
   * badge counts. Reading past one, or opening the series, clears it.
   */
  newChapters?: string[];
  addedAt: number;
  lastReadAt?: number;
  checkedAt?: number;
}

type Entries = Record<string, LibraryEntry>;

export class Library {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: LibraryStore,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<LibraryEntry[]> {
    await this.lock;
    return (await this.store.all()).sort(
      (a, b) => (b.lastReadAt ?? b.addedAt) - (a.lastReadAt ?? a.addedAt),
    );
  }

  async get(id: string): Promise<LibraryEntry | undefined> {
    await this.lock;
    return this.store.get(id);
  }

  async findByChapter(chapterUrl: string): Promise<LibraryEntry | undefined> {
    const target = normalizeUrl(chapterUrl);
    return (await this.list()).find((e) => e.chapters.some((c) => c.url === target));
  }

  add(series: Series, chapters: ChapterRef[]): Promise<LibraryEntry> {
    return this.mutate(series.id, (all, changed) => {
      const existing = all[series.id];
      const entry: LibraryEntry = existing
        ? { ...existing, series, chapters: chapters.length ? chapters : existing.chapters, checkedAt: this.now() }
        : { series, chapters, addedAt: this.now() };
      all[series.id] = entry;
      changed.add(series.id);
      return entry;
    });
  }

  /**
   * Merges entries from a backup. New series are added; for series already in the library the
   * copy read most recently wins, so restoring an old backup never loses newer progress.
   * Returns how many entries were added or replaced.
   */
  import(entries: LibraryEntry[]): Promise<number> {
    return this.mutate(undefined, (all, changedIds) => {
      let changed = 0;
      for (const entry of entries) {
        const existing = all[entry.series.id];
        const recency = (e: LibraryEntry) => e.lastReadAt ?? e.addedAt;
        if (existing && recency(existing) >= recency(entry)) continue;
        all[entry.series.id] = entry;
        changedIds.add(entry.series.id);
        changed++;
      }
      return changed;
    });
  }

  remove(id: string): Promise<boolean> {
    return this.mutate(id, (all, changed) => {
      const had = id in all;
      delete all[id];
      changed.add(id);
      return had;
    });
  }

  /** Records progress. Reading an older chapter again never moves progress backwards. */
  markRead(chapterUrl: string): Promise<LibraryEntry | undefined> {
    const target = normalizeUrl(chapterUrl);
    return this.mutate(undefined, (all, changed) => {
      for (const entry of Object.values(all)) {
        const index = entry.chapters.findIndex((c) => c.url === target);
        if (index < 0) continue;
        if (index > readIndex(entry)) entry.readUpTo = target;
        entry.lastReadAt = this.now();
        pruneNew(entry);
        changed.add(entry.series.id);
        return entry;
      }
      return undefined;
    });
  }

  /**
   * Moves progress forward to a chapter read elsewhere (e.g. in a media server's own app). Unlike
   * markRead it doesn't count as reading now, so the library's "recently read" order is unchanged.
   */
  advanceTo(id: string, chapterUrl: string): Promise<LibraryEntry | undefined> {
    const target = normalizeUrl(chapterUrl);
    return this.mutate(id, (all, changed) => {
      const entry = all[id];
      if (!entry) return undefined;
      const index = entry.chapters.findIndex((c) => c.url === target);
      if (index > readIndex(entry)) entry.readUpTo = target;
      pruneNew(entry);
      changed.add(id);
      return entry;
    });
  }

  /** The user has seen a series' new chapters (e.g. opened its page): they stop counting as new. */
  clearNew(id: string): Promise<LibraryEntry | undefined> {
    return this.mutate(id, (all, changed) => {
      const entry = all[id];
      if (entry?.newChapters) {
        delete entry.newChapters;
        changed.add(id);
      }
      return entry;
    });
  }

  /**
   * Sets progress explicitly, backwards too ("mark read up to here"). `null` marks everything unread.
   * Returns undefined if the series or chapter isn't in the library.
   */
  setProgress(id: string, chapterUrl: string | null): Promise<LibraryEntry | undefined> {
    const target = chapterUrl === null ? null : normalizeUrl(chapterUrl);
    return this.mutate(id, (all, changed) => {
      const entry = all[id];
      if (!entry || (target !== null && !entry.chapters.some((c) => c.url === target))) return undefined;
      if (target === null) delete entry.readUpTo;
      else entry.readUpTo = target;
      pruneNew(entry);
      changed.add(id);
      return entry;
    });
  }

  /**
   * Replaces the chapter list with a fresh scrape and returns the chapters not seen before.
   * Pass the freshly scraped series to refresh its details (title, cover, description…) too.
   */
  mergeChapters(
    id: string,
    fresh: ChapterRef[],
    series?: Series,
  ): Promise<{ entry: LibraryEntry; added: ChapterRef[] } | undefined> {
    return this.mutate(id, (all, changed) => {
      const entry = all[id];
      if (!entry) return undefined;
      changed.add(id);
      entry.checkedAt = this.now();
      if (series) entry.series = { ...series, id: entry.series.id, siteId: entry.series.siteId };
      // An empty scrape almost always means the page failed to parse, not that chapters vanished.
      if (!fresh.length) return { entry, added: [] };

      const known = new Set(entry.chapters.map((c) => c.url));
      const freshUrls = new Set(fresh.map((c) => c.url));
      const added = fresh.filter((c) => !known.has(c.url));

      if (entry.readUpTo && !freshUrls.has(entry.readUpTo)) {
        const stillListed = entry.chapters
          .slice(0, readIndex(entry) + 1)
          .reverse()
          .find((c) => freshUrls.has(c.url));
        entry.readUpTo = stillListed?.url;
      }
      entry.chapters = fresh;
      if (added.length) entry.newChapters = [...(entry.newChapters ?? []), ...added.map((c) => c.url)];
      pruneNew(entry);
      return { entry, added };
    });
  }

  /**
   * Serialises read-modify-write cycles so concurrent callers can't drop each other's changes.
   * `fn` gets just `id`'s entry when one is given, else all of them, and adds the ids it changed
   * to `changed`: only those are written back (or deleted, if no longer in `all`).
   */
  private mutate<T>(id: string | undefined, fn: (all: Entries, changed: Set<string>) => T): Promise<T> {
    const run = this.lock.then(async () => {
      const all: Entries = {};
      const loaded = id === undefined ? await this.store.all() : [await this.store.get(id)];
      for (const entry of loaded) if (entry) all[entry.series.id] = entry;
      const changed = new Set<string>();
      const result = fn(all, changed);
      if (changed.size) {
        const ids = [...changed];
        await this.store.write(ids.flatMap((k) => all[k] ?? []), ids.filter((k) => !all[k]));
      }
      return result;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }
}

const ChapterRefSchema = v.object({ url: v.string().url(), title: v.string() });

/** Validates library entries from outside (e.g. a backup file) before they're stored. */
export const LibraryEntrySchema = v.object({
  series: v.object({
    id: v.string().min(1),
    siteId: v.string().min(1),
    url: v.string().url(),
    title: v.string(),
    cover: v.string().optional(),
    description: v.string().optional(),
    authors: v.array(v.string()).optional(),
    genres: v.array(v.string()).optional(),
    status: v.string().optional(),
    links: v
      .object({ authors: v.record(v.string()).optional(), genres: v.record(v.string()).optional() })
      .optional(),
  }),
  chapters: v.array(ChapterRefSchema),
  readUpTo: v.string().optional(),
  newChapters: v.array(v.string()).optional(),
  addedAt: v.number(),
  lastReadAt: v.number().optional(),
  checkedAt: v.number().optional(),
});

/** Drops new-chapter marks for chapters now read or no longer listed. */
function pruneNew(entry: LibraryEntry): void {
  if (!entry.newChapters) return;
  const read = readIndex(entry);
  const unread = new Set(entry.chapters.slice(read + 1).map((c) => c.url));
  const kept = [...new Set(entry.newChapters)].filter((url) => unread.has(url));
  if (kept.length) entry.newChapters = kept;
  else delete entry.newChapters;
}

/** How many chapters update checks found that are still unread and unseen. */
export function newCount(entry: LibraryEntry): number {
  return entry.newChapters?.length ?? 0;
}

function readIndex(entry: LibraryEntry): number {
  return entry.readUpTo ? entry.chapters.findIndex((c) => c.url === entry.readUpTo) : -1;
}

/** Previous and next chapters in the library's list, for sites whose pages have no such links. */
export function chapterNeighbors(entry: LibraryEntry, chapterUrl: string): { prev?: string; next?: string } {
  const target = normalizeUrl(chapterUrl);
  const index = entry.chapters.findIndex((c) => c.url === target);
  if (index < 0) return {};
  return { prev: entry.chapters[index - 1]?.url, next: entry.chapters[index + 1]?.url };
}

export function unreadCount(entry: LibraryEntry): number {
  return entry.chapters.length - 1 - readIndex(entry);
}

/** The chapter to open on "continue": the one after the last read, or the latest if caught up. */
export function nextToRead(entry: LibraryEntry): ChapterRef | undefined {
  const index = readIndex(entry);
  return entry.chapters[index + 1] ?? entry.chapters[index];
}

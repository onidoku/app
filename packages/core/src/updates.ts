import { loadSeries, type HtmlIO } from './load';
import type { Library, LibraryEntry } from './library';
import type { SiteRegistry } from './registry';
import type { ChapterRef } from './types';

export interface UpdateCheckOptions {
  library: Library;
  registry: SiteRegistry;
  fetchHtml: (url: string) => Promise<string>;
  parseHtml: (html: string, url: string) => Document;
  /** API clients for media server sources. */
  server?: HtmlIO['server'];
  /** Runtimes for Paperback sources. */
  paperback?: HtmlIO['paperback'];
  /** Pause between requests so a big library doesn't hammer one site. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SeriesUpdate {
  entry: LibraryEntry;
  added: ChapterRef[];
}

export interface UpdateFailure {
  seriesId: string;
  title: string;
  error: string;
}

export async function checkForUpdates(
  opts: UpdateCheckOptions,
): Promise<{ updates: SeriesUpdate[]; failures: UpdateFailure[] }> {
  const { delayMs = 1500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = opts;
  const updates: SeriesUpdate[] = [];
  const failures: UpdateFailure[] = [];
  let fetched = false;

  for (const entry of await opts.library.list()) {
    const { series } = entry;
    try {
      const config = opts.registry.get(series.siteId);
      if (!config) throw new Error(`site config "${series.siteId}" is not installed`);
      if (fetched && delayMs > 0) await sleep(delayMs);
      fetched = true;
      const scraped = await loadSeries(series.url, config, opts);
      const merged = await opts.library.mergeChapters(series.id, scraped.chapters, scraped.series);
      // Media servers know what was read in their own apps; never moves progress backwards.
      if (scraped.readUpTo) await opts.library.advanceTo(series.id, scraped.readUpTo);
      if (merged?.added.length) updates.push(merged);
    } catch (err) {
      failures.push({ seriesId: series.id, title: series.title, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { updates, failures };
}

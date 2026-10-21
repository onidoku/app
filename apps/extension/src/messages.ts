import type { AnilistChanges, AnilistMedia, BrowseKind, ChapterRef, LibraryEntry, PageKind, SearchResult, Series, ServerKind, SiteConfig, UpdateFailure } from '@onidoku/core';

/** Requests handled by the background service worker, which owns all storage. */
export type Request =
  | { type: 'pageInfo'; url: string }
  | { type: 'configFor'; url: string }
  | { type: 'addSeries'; url: string }
  /** Loads a series from its site without adding it, for the details page. */
  | { type: 'previewSeries'; url: string }
  | { type: 'removeSeries'; id: string }
  | { type: 'library' }
  | { type: 'markRead'; url: string }
  | { type: 'openReader' }
  | { type: 'series'; id: string }
  | { type: 'refreshSeries'; id: string }
  /** The user opened a series: its new chapters stop counting as new. */
  | { type: 'seenSeries'; id: string }
  | { type: 'setProgress'; id: string; url: string | null }
  /**
   * Opens in `tabId`, else the sending tab, else a new tab. `inOnidoku` reads it on the extension's
   * reader page rather than on the site, whatever the setting says.
   */
  | { type: 'openChapter'; url: string; reader: boolean; tabId?: number; inOnidoku?: boolean }
  | { type: 'openDetails'; id: string }
  | { type: 'neighbors'; url: string }
  | { type: 'chapterContext'; url: string }
  | { type: 'checkNow' }
  | { type: 'listConfigs' }
  | { type: 'installConfig'; raw: unknown }
  | { type: 'removeConfig'; id: string }
  | { type: 'search'; siteId: string; query: string }
  | { type: 'browse'; siteId: string; kind: BrowseKind; name: string; link?: string }
  | { type: 'explore'; siteId: string; list: number; page: number }
  | { type: 'settings' }
  | { type: 'saveSettings'; settings: Partial<Settings> }
  | { type: 'storageUsage' }
  | { type: 'listServers' }
  /** Checks the server and login, then stores it. */
  | { type: 'addServer'; server: unknown }
  | { type: 'removeServer'; id: string }
  | { type: 'exportBackup' }
  | { type: 'importBackup'; backup: unknown }
  /** Lists a Paperback repo's sources (its versioning.json). */
  | { type: 'paperbackRepo'; url: string }
  /** Opens the options page listing a repo, from a paperback:// link found on a page. */
  | { type: 'openPaperbackRepo'; url: string }
  /** Downloads a Paperback source's code and installs it. */
  | { type: 'installPaperback'; repo: string; sourceId: string }
  /** Loads a Paperback chapter for the extension's reader page. */
  | { type: 'loadChapter'; url: string }
  /** An image from a Paperback source's site that extension pages can't load directly (see CF_HOSTS_KEY). */
  | { type: 'paperbackImage'; url: string }
  /** Reads explore lists for Paperback sources that got none at install. */
  | { type: 'refreshExplore' }
  /** A Paperback title's page on its source's site, if the source can tell (null otherwise). */
  | { type: 'shareUrl'; url: string }
  /** The installed Paperback source whose site a page is on, for the on-page prompt. */
  | { type: 'siteSource'; url: string }
  /**
   * Replaces the sending tab's site page with the same title or chapter in onidoku. `titles` are
   * what the page calls itself, for finding it on a Paperback source.
   */
  | { type: 'openInOnidoku'; url: string; titles?: string[] }
  /** Who's logged in to AniList, if anyone (AnilistState). */
  | { type: 'anilistState' }
  /** Opens AniList's login in a tab; the page asks for ANILIST_ORIGINS first. */
  | { type: 'anilistLogin' }
  | { type: 'anilistLogout' }
  | { type: 'anilistSearch'; query: string }
  /** Links a library series to an AniList entry (or unlinks it, `null`) and copies its progress there. */
  | { type: 'anilistLink'; id: string; media: Pick<AnilistMedia, 'id' | 'title'> | null }
  /** A linked series and the user's list entry for it, live from AniList (AnilistTracking). */
  | { type: 'anilistTracking'; mediaId: number }
  /** Changes the user's list entry (status, score, notes, progress); creates it if needed. */
  | { type: 'anilistSave'; mediaId: number; changes: AnilistChanges };

export interface Settings {
  /** Show sources marked 18+ in search. Off by default; installed 18+ sources still work everywhere else. */
  showNsfw: boolean;
  /** Offer the reader on chapter-like pages of sites without a source. Needs access to all sites. */
  detectEverywhere: boolean;
  /**
   * Open chapters from the library and details pages on onidoku's reader page, loaded in the
   * background, instead of on the site (no site scripts or ads).
   */
  readInOnidoku: boolean;
}

export const DEFAULT_SETTINGS: Settings = { showNsfw: false, detectEverywhere: false, readInOnidoku: false };

/** A source as the on-page prompt names it. */
export interface SiteSource {
  id: string;
  name: string;
  icon: string;
}

/** Host access the "offer the reader on any site" setting needs. */
export const ALL_SITES = ['https://*/*', 'http://*/*'];

export interface SearchHit extends SearchResult {
  /** Library id the series gets when added. */
  seriesId: string;
  inLibrary: boolean;
}

export interface BrowseResult {
  /** The site page the titles were listed from. */
  url: string;
  hits: SearchHit[];
}

export interface ExploreResult extends BrowseResult {
  /** Whether asking for the next page may return more titles. */
  hasMore: boolean;
}

/** A series as its site shows it right now, not (necessarily) in the library. */
export interface SeriesPreview {
  seriesId: string;
  series: Series;
  /** Oldest first. */
  chapters: ChapterRef[];
  /** Media servers: the furthest chapter read there. */
  readUpTo?: string;
}

/** A downloadable copy of everything onidoku stores, for moving browsers or recovering after an uninstall. */
export interface Backup {
  format: 'onidoku-backup';
  version: 1;
  exportedAt: string;
  library: LibraryEntry[];
  sources: SiteConfig[];
  settings: Settings;
}

/** A media server as the Sources page shows it: no credentials. */
export interface ServerSummary {
  id: string;
  kind: ServerKind;
  name: string;
  url: string;
  login: 'api-key' | 'password';
}

export interface ImportResult {
  series: number;
  sources: number;
  skipped: number;
}

export interface StorageUsage {
  /** Undefined where the browser can't report it. */
  bytes?: number;
  series: number;
}

export interface PageInfo {
  kind: PageKind | 'unknown';
  siteName?: string;
  siteIcon?: string;
  seriesId?: string;
  inLibrary: boolean;
  /** Set when the series is in the library. */
  seriesTitle?: string;
  unread?: number;
  next?: ChapterRef;
}

/** The library's view of the series a chapter belongs to, for the reader's chapter list. */
export interface ChapterContext {
  seriesId: string;
  seriesTitle: string;
  /** Oldest first. */
  chapters: ChapterRef[];
  /** Index of the furthest chapter read, or -1. */
  readIndex: number;
}

export interface ConfigMatch {
  config: SiteConfig;
  kind: PageKind;
}

export interface LibraryItem {
  entry: LibraryEntry;
  unread: number;
  /** Chapters update checks found that haven't been read or looked at (the badge count). */
  fresh: number;
  next?: ChapterRef;
}

export interface CheckResult {
  updated: number;
  failures: UpdateFailure[];
}

export type Response = { ok: true; data: unknown } | { ok: false; error: string };

export async function send<T = unknown>(request: Request): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as Response | undefined;
  if (!response) throw new Error('no response from the extension background');
  if (!response.ok) throw new Error(response.error);
  return response.data as T;
}

/** The extension's own reader page: media server and Paperback chapters, and others read in onidoku. */
export function readerUrl(chapterUrl: string): string {
  return chrome.runtime.getURL(`reader.html?${new URLSearchParams({ url: chapterUrl })}`);
}

export function pageUrl(page: 'library' | 'search' | 'explore' | 'options'): string {
  return chrome.runtime.getURL(`${page}.html`);
}

/** The search page listing every source's titles by an author or in a genre. */
export function searchByUrl(kind: BrowseKind, name: string): string {
  return chrome.runtime.getURL(`search.html?${new URLSearchParams({ [kind === 'authors' ? 'author' : 'genre']: name })}`);
}

export function detailsUrl(seriesId: string): string {
  return chrome.runtime.getURL(`details.html?id=${encodeURIComponent(seriesId)}`);
}

/** Details for any series page on an installed source, in the library or not. */
export function previewUrl(seriesUrl: string): string {
  return chrome.runtime.getURL(`details.html?${new URLSearchParams({ url: seriesUrl })}`);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

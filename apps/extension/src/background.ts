import {
  chapterNeighbors,
  checkForUpdates,
  configOrigins,
  browseSeries,
  exploreSeries,
  fetchRetrying,
  httpError,
  Library,
  LibraryEntrySchema,
  loadChapter,
  loadSeries,
  normalizeUrl,
  newCount,
  nextToRead,
  parseServer,
  parseSiteConfig,
  searchSeries,
  seriesIdFor,
  unreadCount,
  type ChapterContent,
  type HtmlIO,
  type LibraryEntry,
  type SearchResult,
  type ServerConfig,
} from '@onidoku/core';
import {
  ALL_SITES,
  detailsUrl,
  errorMessage,
  previewUrl,
  readerUrl,
  type Backup,
  type BrowseResult,
  type ChapterContext,
  type CheckResult,
  type ExploreResult,
  type ImportResult,
  type LibraryItem,
  type PageInfo,
  type Request,
  type Response,
  type SearchHit,
  type SeriesPreview,
  type ServerSummary,
  type StorageUsage,
} from './messages';
import { parseHtml } from '#parse-html';
import { allowSourceImages, fetchPaperbackImage, findPaperbackPage, forgetSourceImages, paperbackSiteSource, fetchPaperbackRepo, installPaperback, paperbackRuntime, removePaperback, retryPaperbackSections } from '#paperback';
import { clientFor } from './servers';
import { installConfig, loadRegistry, loadServers, loadSettings, removeConfig, removeServer, saveServer, saveSettings } from './storage';
import { libraryDb } from './library-db';

const ALARM = 'check-updates';
const CHECK_EVERY_MINUTES = 12 * 60;
const NOTIFICATION_PREFIX = 'series:';
const PROMPT_SCRIPT_ID = 'page-prompt';
const DETECT_SCRIPT_ID = 'chapter-detect';

const library = new Library(libraryDb);

async function fetchHtml(url: string): Promise<string> {
  const res = await fetchRetrying(() => fetch(url, { credentials: 'include' }));
  if (!res.ok) throw httpError(res, url);
  return res.text();
}

/** How pages are loaded: fetched HTML for site configs, the API for media servers, a sandbox for Paperback sources. */
async function sourceIO(): Promise<HtmlIO> {
  const servers = await loadServers();
  return {
    fetchHtml,
    parseHtml,
    server(config) {
      const server = servers.find((s) => s.id === config.id);
      return server && clientFor(server, parseHtml);
    },
    paperback: paperbackRuntime,
  };
}

async function ensureAlarm(): Promise<void> {
  // Alarms usually survive restarts, but Chrome doesn't guarantee it.
  if (!(await chrome.alarms.get(ALARM))) {
    await chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: CHECK_EVERY_MINUTES });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  if (__DEV__) {
    for (const raw of __DEV_CONFIGS__) await installConfig(raw);
  }
  await ensureAlarm();
  await refreshBadge();
  await syncPagePrompt();
  await syncDetectScript();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await refreshBadge();
  await syncPagePrompt();
  await syncDetectScript();
});

chrome.permissions.onAdded.addListener(() => void syncPagePrompt().then(syncDetectScript));
chrome.permissions.onRemoved.addListener(() => void syncPagePrompt().then(syncDetectScript));

let promptSync: Promise<void> = Promise.resolve();

/**
 * Runs the on-page prompt on installed sites the user has granted access to, and nowhere else.
 * Calls are chained so overlapping syncs can't race on the script id.
 */
function syncPagePrompt(): Promise<void> {
  promptSync = promptSync.then(async () => {
    // Not on media servers' own web UIs: they're single-page apps with their own reader.
    const configs = (await loadRegistry()).list();
    const origins = [
      ...new Set([
        ...configs.filter((c) => !c.server && !c.paperback).flatMap(configOrigins),
        // Paperback sources' sites, where the prompt offers to open the page in onidoku.
        ...configs.flatMap((c) => (c.paperback ? [`${new URL(c.paperback.site).origin}/*`] : [])),
      ]),
    ];
    const granted: string[] = [];
    for (const origin of origins) {
      if (await chrome.permissions.contains({ origins: [origin] })) granted.push(origin);
    }
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [PROMPT_SCRIPT_ID] });
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [PROMPT_SCRIPT_ID] });
    if (granted.length) {
      await chrome.scripting.registerContentScripts([
        { id: PROMPT_SCRIPT_ID, js: ['prompt.js'], matches: granted, runAt: 'document_idle' },
      ]);
    }
  }).catch((err) => console.error('failed to sync page prompt', err));
  return promptSync;
}

let detectSync: Promise<void> = Promise.resolve();

/**
 * Runs chapter detection on every site only while the user has the setting on and has granted
 * access to all sites. Turning the setting off unregisters the script but leaves the access
 * granted (revoking it could also revoke the per-site access sources need).
 */
function syncDetectScript(): Promise<void> {
  detectSync = detectSync.then(async () => {
    const wanted = (await loadSettings()).detectEverywhere && (await chrome.permissions.contains({ origins: ALL_SITES }));
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [DETECT_SCRIPT_ID] });
    if (registered.length && !wanted) await chrome.scripting.unregisterContentScripts({ ids: [DETECT_SCRIPT_ID] });
    if (!registered.length && wanted) {
      await chrome.scripting.registerContentScripts([
        { id: DETECT_SCRIPT_ID, js: ['detect.js'], matches: ALL_SITES, runAt: 'document_idle' },
      ]);
    }
  }).catch((err) => console.error('failed to sync chapter detection', err));
  return detectSync;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) void runUpdateCheck();
});

// Firefox for Android has no notifications API, so every use is guarded.
chrome.notifications?.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX)) return;
  const entry = await library.get(notificationId.slice(NOTIFICATION_PREFIX.length));
  const next = entry && nextToRead(entry);
  if (next) await openChapter(next.url, true);
  // Paperback titles have no page of their own to open; their details page stands in.
  else if (entry) await chrome.tabs.create({ url: entry.series.siteId.startsWith('pb.') ? detailsUrl(entry.series.id) : entry.series.url });
  await chrome.notifications.clear(notificationId);
});

chrome.runtime.onMessage.addListener((request: Request, sender, sendResponse: (r: Response) => void) => {
  handle(request, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: errorMessage(err) }),
  );
  return true; // keep the channel open for the async response
});

async function handle(request: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (request.type) {
    case 'pageInfo':
      return pageInfo(request.url);
    case 'configFor':
      return (await loadRegistry()).match(request.url) ?? null;
    case 'addSeries':
      return addSeries(request.url);
    case 'previewSeries':
      return previewSeries(request.url);
    case 'removeSeries': {
      const removed = await library.remove(request.id);
      await refreshBadge();
      return removed;
    }
    case 'library':
      return (await library.list()).map(toItem);
    case 'markRead': {
      const entry = await library.markRead(request.url);
      await refreshBadge();
      void syncReadToServer(request.url);
      return entry ?? null;
    }
    case 'openReader': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) throw new Error('openReader must come from a tab');
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      return true;
    }
    case 'series': {
      const entry = await library.get(request.id);
      return entry ? toItem(entry) : null;
    }
    case 'refreshSeries':
      return refreshSeries(request.id);
    case 'seenSeries': {
      const entry = await library.clearNew(request.id);
      await refreshBadge();
      return entry ? toItem(entry) : null;
    }
    case 'setProgress': {
      const entry = await library.setProgress(request.id, request.url);
      if (!entry) throw new Error('that chapter is no longer in the library');
      await refreshBadge();
      return toItem(entry);
    }
    case 'openChapter':
      return openChapter(request.url, request.reader, request.tabId ?? sender.tab?.id, request.inOnidoku);
    case 'siteSource':
      return paperbackSiteSource(request.url);
    case 'openInOnidoku': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) throw new Error('openInOnidoku must come from a tab');
      return openInOnidoku(request.url, request.titles ?? [], tabId);
    }
    case 'neighbors': {
      const entry = await library.findByChapter(request.url);
      return entry ? chapterNeighbors(entry, request.url) : {};
    }
    case 'chapterContext': {
      const entry = await library.findByChapter(request.url);
      if (!entry) return null;
      const context: ChapterContext = {
        seriesId: entry.series.id,
        seriesTitle: entry.series.title,
        chapters: entry.chapters,
        readIndex: entry.readUpTo ? entry.chapters.findIndex((c) => c.url === entry.readUpTo) : -1,
      };
      return context;
    }
    case 'openDetails':
      await chrome.tabs.create({ url: detailsUrl(request.id) });
      return true;
    case 'checkNow':
      return runUpdateCheck();
    case 'listConfigs':
      return (await loadRegistry()).list();
    case 'installConfig': {
      const config = await installConfig(request.raw);
      await syncPagePrompt();
      return config;
    }
    case 'removeConfig':
      if ((await loadRegistry()).get(request.id)?.paperback) await removePaperback(request.id);
      else {
        await removeConfig(request.id);
        await forgetSourceImages(request.id);
      }
      await syncPagePrompt();
      return null;
    case 'paperbackRepo':
      return fetchPaperbackRepo(request.url);
    case 'installPaperback': {
      const config = await installPaperback(request.repo, request.sourceId);
      await syncPagePrompt();
      return config;
    }
    case 'loadChapter':
      return readChapter(request.url);
    case 'paperbackImage':
      return fetchPaperbackImage(request.url);
    case 'refreshExplore':
      await Promise.all((await loadRegistry()).list().filter((c) => c.paperback && !c.explore).map(retryPaperbackSections));
      return null;
    case 'search':
      return search(request.siteId, request.query);
    case 'browse':
      return browse(request);
    case 'explore':
      return explore(request);
    case 'settings':
      return loadSettings();
    case 'saveSettings': {
      const settings = await saveSettings(request.settings);
      await syncDetectScript();
      return settings;
    }
    case 'storageUsage':
      return storageUsage();
    case 'listServers':
      return (await loadServers()).map(summary);
    case 'addServer':
      return addServer(request.server);
    case 'removeServer':
      await removeServer(request.id);
      return null;
    case 'exportBackup':
      return exportBackup();
    case 'importBackup':
      return importBackup(request.backup);
  }
}

async function search(siteId: string, query: string): Promise<SearchHit[]> {
  const config = (await loadRegistry()).get(siteId);
  if (!config) throw new Error(`site config "${siteId}" is not installed`);
  // Requires the host permission the search page requested, like addSeries.
  const results = await searchSeries(query, config, await sourceIO());
  await allowSourceImages(config, results.map((r) => r.cover));
  return toHits(config.id, results);
}

async function browse(request: Extract<Request, { type: 'browse' }>): Promise<BrowseResult> {
  const config = (await loadRegistry()).get(request.siteId);
  if (!config) throw new Error(`site config "${request.siteId}" is not installed`);
  const { url, results } = await browseSeries(config, request.kind, request.name, await sourceIO(), request.link);
  return { url, hits: await toHits(config.id, results) };
}

async function explore(request: Extract<Request, { type: 'explore' }>): Promise<ExploreResult> {
  const config = (await loadRegistry()).get(request.siteId);
  if (!config) throw new Error(`site config "${request.siteId}" is not installed`);
  const { url, results, hasMore } = await exploreSeries(config, request.list, request.page, await sourceIO());
  await allowSourceImages(config, results.map((r) => r.cover));
  return { url, hits: await toHits(config.id, results), hasMore };
}

/** Marks which results are already in the library. */
async function toHits(siteId: string, results: SearchResult[]): Promise<SearchHit[]> {
  const library = await libraryIds();
  return results.map((r) => {
    const seriesId = seriesIdFor(siteId, r.url);
    return { ...r, seriesId, inLibrary: library.has(seriesId) };
  });
}

async function libraryIds(): Promise<Set<string>> {
  return new Set((await library.list()).map((e) => e.series.id));
}

async function storageUsage(): Promise<StorageUsage> {
  const series = (await library.list()).length;
  // Firefox only gained getBytesInUse for storage.local in version 131, and Android may lag.
  const local = chrome.storage.local.getBytesInUse ? await chrome.storage.local.getBytesInUse(null) : undefined;
  // The library is in IndexedDB, which the origin's usage estimate covers.
  const db = (await navigator.storage?.estimate?.())?.usage ?? 0;
  const bytes = local === undefined ? undefined : local + db;
  return { bytes, series };
}

async function exportBackup(): Promise<Backup> {
  return {
    format: 'onidoku-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    library: await library.list(),
    // Media servers stay out: their credentials shouldn't end up in a file. Re-adding a server with
    // the same address brings its series back to life. Paperback sources stay out too (they're
    // code, installed from their repo); reinstalling one does the same for its series.
    sources: (await loadRegistry()).list().filter((c) => !c.server && !c.paperback),
    settings: await loadSettings(),
  };
}

/**
 * Restores a backup on top of what's stored. Sources install only if missing or newer; series
 * merge by most recent reading (see Library.import). Invalid items are skipped, not fatal.
 */
async function importBackup(raw: unknown): Promise<ImportResult> {
  const backup = raw as Partial<Backup> | null;
  if (backup?.format !== 'onidoku-backup' || !Array.isArray(backup.library)) {
    throw new Error('this is not a onidoku backup file');
  }
  let skipped = 0;
  let sources = 0;
  const registry = await loadRegistry();
  for (const rawConfig of Array.isArray(backup.sources) ? backup.sources : []) {
    try {
      const config = parseSiteConfig(rawConfig);
      const installed = registry.get(config.id);
      if (installed && installed.version >= config.version) continue;
      await installConfig(config);
      sources++;
    } catch {
      skipped++;
    }
  }
  const entries = backup.library.flatMap((e) => {
    const parsed = LibraryEntrySchema.safeParse(e);
    if (!parsed.success) skipped++;
    return parsed.success ? [parsed.data as LibraryEntry] : [];
  });
  const series = await library.import(entries);
  if (typeof backup.settings?.showNsfw === 'boolean') await saveSettings({ showNsfw: backup.settings.showNsfw });
  await syncPagePrompt();
  await refreshBadge();
  return { series, sources, skipped };
}

async function pageInfo(url: string): Promise<PageInfo> {
  const match = (await loadRegistry()).match(url);
  if (!match) return { kind: 'unknown', inLibrary: false };
  const entry =
    match.kind === 'series' ? await library.get(seriesIdFor(match.config.id, url)) : await library.findByChapter(url);
  const info: PageInfo = { kind: match.kind, siteName: match.config.name, siteIcon: match.config.icon, inLibrary: Boolean(entry) };
  if (match.kind === 'series') info.seriesId = seriesIdFor(match.config.id, url);
  if (entry) {
    Object.assign(info, { seriesId: entry.series.id, seriesTitle: entry.series.title, unread: unreadCount(entry), next: nextToRead(entry) });
  }
  return info;
}

async function addSeries(url: string): Promise<LibraryEntry> {
  // Reuse what the details page just loaded: long paginated chapter lists are slow to fetch twice.
  const { series, chapters, readUpTo } = (await cachedPreview(url)) ?? (await previewSeries(url));
  let entry = await library.add(series, chapters);
  // Series from a media server start where the user is on the server.
  if (readUpTo) entry = (await library.advanceTo(entry.series.id, readUpTo)) ?? entry;
  await refreshBadge();
  return entry;
}

const PREVIEWS_KEY = 'previews';
/** How long a loaded preview is reused, e.g. when it's added to the library right after. */
const PREVIEW_TTL_MS = 10 * 60_000;
const PREVIEW_MAX = 6;
type PreviewCache = Record<string, { at: number; preview: SeriesPreview }>;
// Session storage outlives the service worker going idle but not the browser; memory is the fallback.
const memoryPreviews: PreviewCache = {};

async function readPreviews(): Promise<PreviewCache> {
  if (!chrome.storage.session) return memoryPreviews;
  return ((await chrome.storage.session.get(PREVIEWS_KEY))[PREVIEWS_KEY] as PreviewCache | undefined) ?? {};
}

async function cachedPreview(url: string): Promise<SeriesPreview | undefined> {
  const hit = (await readPreviews())[normalizeUrl(url)];
  return hit && Date.now() - hit.at < PREVIEW_TTL_MS ? hit.preview : undefined;
}

async function previewSeries(url: string): Promise<SeriesPreview> {
  const match = (await loadRegistry()).match(url);
  if (match?.kind !== 'series') throw new Error('this is not a series page of any installed site');
  // Requires host permission for the site; without it this fetch fails with a CORS error.
  const { series, chapters, readUpTo } = await loadSeries(url, match.config, await sourceIO());
  await allowSourceImages(match.config, [series.cover]);
  const preview: SeriesPreview = { seriesId: series.id, series, chapters, readUpTo };
  const now = Date.now();
  const kept = Object.entries(await readPreviews())
    .filter(([, v]) => now - v.at < PREVIEW_TTL_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, PREVIEW_MAX - 1);
  const cache: PreviewCache = Object.fromEntries([[normalizeUrl(url), { at: now, preview }], ...kept]);
  if (chrome.storage.session) await chrome.storage.session.set({ [PREVIEWS_KEY]: cache }).catch(() => {});
  else {
    for (const key of Object.keys(memoryPreviews)) delete memoryPreviews[key];
    Object.assign(memoryPreviews, cache);
  }
  return preview;
}

async function refreshSeries(id: string): Promise<LibraryItem> {
  const entry = await library.get(id);
  if (!entry) throw new Error('series is not in the library');
  const config = (await loadRegistry()).get(entry.series.siteId);
  if (!config) throw new Error(`site config "${entry.series.siteId}" is not installed`);
  const { series, chapters, readUpTo } = await loadSeries(entry.series.url, config, await sourceIO());
  let merged = (await library.mergeChapters(id, chapters, series))!.entry;
  if (readUpTo) merged = (await library.advanceTo(id, readUpTo)) ?? merged;
  await refreshBadge();
  return toItem(merged);
}

/**
 * Opens a chapter in the sender's tab (so Back returns to the details page) or a new tab, and
 * optionally opens the reader once the page has loaded.
 */
async function openChapter(url: string, reader: boolean, tabId?: number, inOnidoku?: boolean): Promise<boolean> {
  // Media server and Paperback chapters are read on the extension's reader page: they have no
  // page on a site to open (or need the server's login to load). Site chapters are too when the
  // user asks for it (no site scripts or ads), as long as the site is allowed.
  const config = (await loadRegistry()).match(url)?.config;
  const here = Boolean(config && !config.server && !config.paperback && (inOnidoku ?? (reader && (await loadSettings()).readInOnidoku)));
  if (config?.server || config?.paperback || here) {
    const target = reader ? readerUrl(url) : url;
    if (tabId === undefined) await chrome.tabs.create({ url: target });
    else await chrome.tabs.update(tabId, { url: target });
    return true;
  }
  const tab = tabId === undefined ? await chrome.tabs.create({ url }) : await chrome.tabs.update(tabId, { url });
  if (!reader || tab?.id === undefined) return true;
  await waitForLoad(tab.id);
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  return true;
}

function waitForLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') done(resolve);
    };
    const timer = setTimeout(() => done(() => reject(new Error('the chapter took too long to load'))), 30_000);
    const done = (settle: () => void) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      settle();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runUpdateCheck(): Promise<CheckResult> {
  const { updates, failures } = await checkForUpdates({ library, registry: await loadRegistry(), ...(await sourceIO()) });
  for (const { entry, added } of chrome.notifications ? updates : []) {
    await chrome.notifications.create(NOTIFICATION_PREFIX + entry.series.id, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: entry.series.title,
      message: added.length === 1 ? `new: ${added[0]!.title}` : `${added.length} new chapters`,
    });
  }
  if (failures.length) console.warn('update check failures', failures);
  await refreshBadge();
  return { updated: updates.length, failures };
}

/**
 * Opens what a site page shows on onidoku's own pages, in the same tab (so Back returns to the
 * site): a chapter in the reader, a series in details. Paperback sites' pages don't match their
 * source's addresses, so those are looked up through the source (see findPaperbackPage).
 */
async function openInOnidoku(url: string, titles: string[], tabId: number): Promise<boolean> {
  const match = (await loadRegistry()).match(url);
  const target = !match
    ? await findPaperbackPage(url, titles)
    : match.kind === 'chapter'
      ? readerUrl(normalizeUrl(url))
      : previewUrl(normalizeUrl(url));
  await chrome.tabs.update(tabId, { url: target });
  return true;
}

/** Loads a chapter for the extension's reader page (Paperback chapters, and site chapters read in onidoku). */
async function readChapter(url: string): Promise<ChapterContent> {
  const match = (await loadRegistry()).match(url);
  if (match?.kind !== 'chapter' || match.config.server) throw new Error('this chapter isn’t from an installed source');
  const chapter = await loadChapter(url, match.config, await sourceIO());
  if (chapter.body.kind === 'images') await allowSourceImages(match.config, chapter.body.pages);
  // The source works now: a good moment to get explore lists it couldn't at install.
  if (match.config.paperback) void retryPaperbackSections(match.config);
  return chapter;
}

function summary(server: ServerConfig): ServerSummary {
  return { id: server.id, kind: server.kind, name: server.name, url: server.url, login: server.apiKey ? 'api-key' : 'password' };
}

/** Checks the address and login before storing, so a typo shows up here rather than as broken covers later. */
async function addServer(raw: unknown): Promise<{ server: ServerSummary; account: string }> {
  const server = parseServer(raw);
  const account = await clientFor(server, parseHtml).verify();
  await saveServer(server);
  return { server: summary(server), account };
}

let serverSync: Promise<void> = Promise.resolve();

/**
 * Tells the server a chapter was read there too. Best effort: reading works offline from it.
 * Queued, so paging quickly through chapters can't leave an earlier one as the server's position.
 */
function syncReadToServer(chapterUrl: string): Promise<void> {
  serverSync = serverSync.then(async () => {
    const config = (await loadRegistry()).match(chapterUrl)?.config;
    if (!config?.server) return;
    try {
      await (await sourceIO()).server?.(config)?.markRead(chapterUrl);
    } catch (err) {
      console.warn(`couldn't save progress to ${config.name}`, err);
    }
  });
  return serverSync;
}

function toItem(entry: LibraryEntry): LibraryItem {
  return { entry, unread: unreadCount(entry), fresh: newCount(entry), next: nextToRead(entry) };
}

/** The toolbar badge counts chapters update checks found and nobody has looked at yet, not every unread one. */
async function refreshBadge(): Promise<void> {
  const total = (await library.list()).reduce((sum, e) => sum + newCount(e), 0);
  await chrome.action.setBadgeBackgroundColor({ color: '#6a3cf0' });
  await chrome.action.setBadgeText({ text: total === 0 ? '' : total > 99 ? '99+' : String(total) });
}

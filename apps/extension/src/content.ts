// Injected on demand (popup → "Open reader") via activeTab, so the extension needs no
// blanket access to every site. The reader renders inside the page, which means images load
// with the site's own referrer and cookies, just as they would when the user browses normally.
import { guessChapter, loadChapter, normalizeUrl, type ChapterContent, type HtmlIO, type SiteConfig } from '@onidoku/core';
import { errorMessage, send, type ConfigMatch } from './messages';
import { loadPrefs, Reader, toast, withNeighbors, type ReaderHost } from './reader';

// Firefox runs a content script's fetch() as the extension; its `content.fetch` makes the request
// as the page, so the site sees its own cookies and referrer like it does in Chrome. (A page
// element with id="content" can also appear as `content`, hence the function check.)
const pageContent = (globalThis as { content?: { fetch?: unknown } }).content;
const pageFetch: typeof fetch =
  typeof pageContent?.fetch === 'function' ? (pageContent.fetch as typeof fetch).bind(pageContent) : fetch;

const io: HtmlIO = {
  async fetchHtml(url) {
    const res = await pageFetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  },
  parseHtml: (html) => new DOMParser().parseFromString(html, 'text/html'),
};

/** Reader-only mode for sites without a config. Returns undefined when the page doesn't look like a chapter. */
async function guessChapterAt(url: string, doc?: Document): Promise<ChapterContent | undefined> {
  return guessChapter(doc ?? io.parseHtml(await io.fetchHtml(url), url), url);
}

/** How long a site's own script gets to show the next chapter after its link is followed. */
const IN_PAGE_TIMEOUT_MS = 10_000;

/**
 * For sites that build chapters with script (their HTML is an empty shell): follows the site's
 * own link to the chapter, so its script loads it as it would for a click, then reads the page
 * once the new chapter's content has rendered. Undefined if there's no such link or nothing new shows up.
 */
async function guessAfterInPageNavigation(url: string, current: ChapterContent): Promise<ChapterContent | undefined> {
  const target = normalizeUrl(url);
  const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find((a) => a.href && normalizeUrl(a.href) === target);
  if (!link) return undefined;
  const before = JSON.stringify(current.body);
  link.click();
  const deadline = Date.now() + IN_PAGE_TIMEOUT_MS;
  let previous = before;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (normalizeUrl(location.href) !== target) continue;
    const chapter = guessChapter(document, location.href);
    const body = chapter ? JSON.stringify(chapter.body) : before;
    // Sites often add pages one by one: wait until two looks in a row agree.
    if (chapter && body !== before && body === previous) return chapter;
    previous = body;
  }
  return undefined;
}

/** Chapters on this site load in place; links elsewhere are followed. */
function pageHost(config: SiteConfig | undefined): ReaderHost {
  return {
    async load(url, current) {
      if (new URL(url).origin !== location.origin) return undefined;
      // Pages that only fill in their images with script can't be read from fetched HTML; load them for real.
      return config ? loadChapter(url, config, io) : ((await guessChapterAt(url)) ?? (await guessAfterInPageNavigation(url, current)));
    },
    leave: (url) => location.assign(url),
    // Keep the address bar in sync so reloading or sharing lands on the chapter being read.
    navigated(url) {
      if (normalizeUrl(location.href) !== normalizeUrl(url)) history.pushState(null, '', url);
    },
  };
}

async function boot(): Promise<void> {
  // Re-injection after closing: reopen where the reader left off.
  if (window.__onidoku) {
    window.__onidoku.mount();
    return;
  }
  const match = await send<ConfigMatch | null>({ type: 'configFor', url: location.href }).catch(() => null);
  // A media server's own web UI: read it on the extension's reader page, which has the server login.
  if (match?.config.server) {
    if (match.kind === 'chapter') await send({ type: 'openChapter', url: location.href, reader: true });
    else toast('open a chapter from this series to read it in onidoku.');
    return;
  }
  const config = match?.kind === 'chapter' ? match.config : undefined;
  let chapter: ChapterContent;
  try {
    const loaded = config ? await loadChapter(location.href, config, io, document) : await guessChapterAt(location.href, document);
    if (!loaded) throw new Error('onidoku couldn’t find chapter pages on this page.');
    chapter = await withNeighbors(loaded);
  } catch (err) {
    toast(errorMessage(err));
    return;
  }
  const reader = new Reader(pageHost(config), await loadPrefs());
  window.__onidoku = reader;
  reader.show(chapter);
}

void boot();

// The reader for media server and Paperback chapters. Unlike site chapters, which are read on the
// site's own page (content.ts), these have no page to read on: media server chapters load from the
// server's API with the user's login, Paperback ones through their source (in the background).
import { configOrigins, loadChapter, PAPERBACK_ORIGIN, type ChapterContent, type HtmlIO, type SiteConfig } from '@onidoku/core';
import { button, h } from './dom';
import { errorMessage, pageUrl, send, type ConfigMatch } from './messages';
import { loadPrefs, Reader, withNeighbors, type ReaderHost } from './reader';
import { clientFor, imageSrc, releaseImages } from './servers';
import { loadServers } from './storage';

const app = document.getElementById('app')!;

function showError(message: string, action?: HTMLElement, other: HTMLElement = h('a', { href: pageUrl('library'), text: 'go to library' })): void {
  app.removeAttribute('aria-busy');
  app.replaceChildren(h('div', { class: 'empty' }, h('p', { class: 'error', text: message }), action, other));
}

function setTitle(chapter: ChapterContent): void {
  document.title = chapter.title ? `${chapter.title} · onidoku` : 'reader · onidoku';
}

async function boot(): Promise<void> {
  const url = new URLSearchParams(location.search).get('url') ?? '';
  const match = url ? await send<ConfigMatch | null>({ type: 'configFor', url }) : null;
  if (match?.config.paperback) return bootPaperback(url, match.config);
  if (match && !match.config.server) return bootSite(url, match.config);
  const config: SiteConfig | undefined = match?.config.server ? match.config : undefined;
  const server = config && (await loadServers()).find((s) => s.id === config.id);
  if (!config || !server) {
    return url.startsWith(`${PAPERBACK_ORIGIN}/`)
      ? showError('this chapter is from a Paperback source that isn’t installed anymore.', h('a', { href: pageUrl('options'), text: 'install it on the sources page' }))
      : showError('this chapter is from a media server that isn’t added to onidoku anymore.', h('a', { href: pageUrl('options'), text: 'add it on the sources page' }));
  }

  if (!(await chrome.permissions.contains({ origins: configOrigins(config) }))) {
    return showError(
      `onidoku needs access to ${config.name} to read this chapter.`,
      button(`allow access to ${config.name}`, 'primary', async () => {
        if (await chrome.permissions.request({ origins: configOrigins(config) })) location.reload();
      }),
    );
  }

  const parseHtml = (html: string) => new DOMParser().parseFromString(html, 'text/html');
  const io: HtmlIO = { fetchHtml: () => Promise.reject(new Error('not a site source')), parseHtml, server: () => clientFor(server, parseHtml) };
  // Other chapters of the same server load in place; anything else is a normal link.
  await show(url, (next) => (next.startsWith(`${server.url}/`) ? loadChapter(next, config, io) : undefined));
}

/**
 * Site chapters read in onidoku instead of on the site: the background fetches the chapter's page
 * and reads it with the site's config, so none of the site's scripts or ads load.
 */
async function bootSite(url: string, config: SiteConfig): Promise<void> {
  if (!(await chrome.permissions.contains({ origins: configOrigins(config) }))) {
    return showError(
      `onidoku needs access to ${config.name} to read this chapter here.`,
      button(`allow access to ${config.name}`, 'primary', async () => {
        if (await chrome.permissions.request({ origins: configOrigins(config) })) location.reload();
      }),
      h('a', { href: url, text: 'read it on the site instead' }),
    );
  }
  // Chapters of the same source load in place; any other link opens normally.
  const load: Load = async (next) => {
    const match = await send<ConfigMatch | null>({ type: 'configFor', url: next });
    return match?.kind === 'chapter' && match.config.id === config.id ? send<ChapterContent>({ type: 'loadChapter', url: next }) : undefined;
  };
  await show(url, load, h('a', { href: url, text: 'read it on the site' }));
}

/** Paperback chapters load through their source, which runs in the background's sandbox. */
async function bootPaperback(url: string, config: SiteConfig): Promise<void> {
  const own = `${PAPERBACK_ORIGIN}/${config.id}/`;
  await show(url, (next) => (next.startsWith(own) ? send<ChapterContent>({ type: 'loadChapter', url: next }) : undefined));
}

type Load = (url: string) => Promise<ChapterContent | undefined> | undefined;

/** `fallback` is offered when the chapter can't load, next to Retry. */
async function show(url: string, load: Load, fallback?: HTMLElement): Promise<void> {
  let chapter: ChapterContent;
  try {
    const loaded = await load(url);
    if (!loaded) throw new Error('it can’t be read here');
    chapter = await withNeighbors(loaded);
  } catch (err) {
    return showError(`couldn’t load the chapter: ${errorMessage(err)}`, button('retry', 'secondary', () => location.reload()), fallback);
  }

  const host: ReaderHost = {
    load: async (next) => load(next),
    leave: (next) => location.assign(next),
    navigated(next, shown) {
      releaseImages();
      setTitle(shown);
      history.replaceState(null, '', `?${new URLSearchParams({ url: next })}`);
    },
    // Nothing underneath the reader here: go back to where the chapter was opened from.
    closed() {
      if (history.length > 1) history.back();
      else location.assign(pageUrl('library'));
    },
    pageSrc: imageSrc,
  };
  app.removeAttribute('aria-busy');
  app.replaceChildren();
  setTitle(chapter);
  new Reader(host, await loadPrefs()).show(chapter);
}

boot().catch((err) => showError(errorMessage(err)));

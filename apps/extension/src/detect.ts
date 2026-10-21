// Runs on every site only when the user turns on "Offer the reader on any site" (see
// syncDetectScript in background.ts). Pages that look like a chapter get a small card offering
// the reader; nothing is sent anywhere, and installed sources are left to prompt.ts. Pages with a
// Paperback repo's "add to Paperback" link (paperback://addRepo, which only the iOS app can open)
// get a card offering to add the repo to onidoku instead, and clicking such a link does the same.
import { detectChapter, paperbackRepoLink } from '@onidoku/core';
import { CARD_CSS } from './card.css';
import { button, h } from './dom';
import { send, type ConfigMatch } from './messages';

/** Per tab and site, shared with prompt.ts: sessionStorage is scoped to both. */
const DISMISSED_KEY = 'onidoku:prompt-dismissed';
/** After each page or in-app navigation, how long to keep looking as content arrives. */
const WATCH_MS = 15_000;
/** Look once the page has stopped changing for this long. */
const SETTLE_MS = 600;
/** Apps change the URL with pushState, which fires no event a content script can hear. */
const URL_POLL_MS = 1000;

function isDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function dismiss(host: HTMLElement): void {
  host.remove();
  try {
    sessionStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // Storage can be blocked; dismissing for this page view is still fine.
  }
}

/** The page's first "add to Paperback" link. */
function findRepoLink(): { url: string; name?: string } | null {
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="paperback:" i]'))) {
    const link = paperbackRepoLink(a.href);
    if (link) return link;
  }
  return null;
}

function addRepo(url: string): void {
  send({ type: 'openPaperbackRepo', url }).catch((err) => console.error('onidoku: failed to open the Paperback repo', err));
}

function showCard(status: string, action: string, onAction: () => void): HTMLElement {
  const host = h('div');
  const root = host.attachShadow({ mode: 'open' });
  const card = h(
    'div',
    { class: 'od-prompt', role: 'dialog', 'aria-label': 'onidoku' },
    h(
      'div',
      { class: 'head' },
      h('span', { class: 'dot' }),
      h('span', { class: 'site', text: `onidoku · ${location.hostname}` }),
      button('×', 'close', () => dismiss(host), 'hide on this site for this tab'),
    ),
    h('div', { class: 'status', text: status }),
    h(
      'div',
      { class: 'actions' },
      button(action, 'primary', () => {
        host.remove();
        onAction();
      }),
    ),
  );
  root.append(h('style', { text: CARD_CSS }), card);
  document.documentElement.append(host);
  return host;
}

let watchedUrl = '';
let watchUntil = 0;
let hasSource = false;
let card: HTMLElement | undefined;
let settle: ReturnType<typeof setTimeout> | undefined;
const observer = new MutationObserver(() => {
  clearTimeout(settle);
  settle = setTimeout(() => void check(), SETTLE_MS);
});

async function check(): Promise<void> {
  if (location.href !== watchedUrl) {
    // A new page, or a new chapter in an app: start over.
    watchedUrl = location.href;
    watchUntil = Date.now() + WATCH_MS;
    card?.remove();
    card = undefined;
    // Sites with an installed source get the richer prompt instead.
    hasSource = Boolean(await send<ConfigMatch | null>({ type: 'configFor', url: watchedUrl }).catch(() => null));
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (card || hasSource || isDismissed() || window.__onidoku || Date.now() > watchUntil) {
    observer.disconnect();
    return;
  }
  if (__PAPERBACK__) {
    const repo = findRepoLink();
    if (repo) {
      card = showCard(`this page has a Paperback repo${repo.name ? `: ${repo.name}` : ''}.`, 'add to onidoku', () => addRepo(repo.url));
      observer.disconnect();
      return;
    }
  }
  const detection = detectChapter(document, location.href);
  if (detection) {
    const status = detection.kind === 'images' ? 'this looks like a comic chapter.' : 'this looks like a novel chapter.';
    card = showCard(status, 'open reader', () => {
      send({ type: 'openReader' }).catch((err) => console.error('onidoku: failed to open reader', err));
    });
    observer.disconnect();
  }
}

// A click on an "add to Paperback" link would go nowhere off iOS, so it opens the repo in onidoku.
if (__PAPERBACK__) {
  document.addEventListener(
    'click',
    (event) => {
      const a = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="paperback:" i]') : null;
      const link = a && paperbackRepoLink(a.href);
      if (!link) return;
      event.preventDefault();
      addRepo(link.url);
    },
    true,
  );
}

if (window.top === window) {
  void check();
  setInterval(() => {
    if (location.href !== watchedUrl) void check();
  }, URL_POLL_MS);
}

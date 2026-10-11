// Runs automatically, but only on installed sites the user has granted access to (see
// syncPagePrompt in background.ts). Offers the action that fits the page, and saves reading
// progress on chapter pages of series in the library, even when the reader isn't used. On sites of
// Paperback sources it offers to open the page in onidoku instead.
import { chapterLinks } from '@onidoku/core';
import { CARD_CSS } from './card.css';
import { button, h } from './dom';
import { errorMessage, send, type ConfigMatch, type PageInfo, type SiteSource } from './messages';

/** Per tab and site: sessionStorage is scoped to both. */
const DISMISSED_KEY = 'onidoku:prompt-dismissed';

class PagePrompt {
  private readonly host = h('div');
  private readonly root = this.host.attachShadow({ mode: 'open' });

  constructor(private readonly match: ConfigMatch) {}

  show(info: PageInfo, status?: { text: string; error?: boolean }): void {
    const card = h(
      'div',
      { class: 'od-prompt', role: 'dialog', 'aria-label': 'onidoku' },
      h(
        'div',
        { class: 'head' },
        h('span', { class: 'dot' }),
        h('span', { class: 'site', text: `onidoku · ${this.match.config.name}` }),
        button('×', 'close', () => this.dismiss(), 'hide on this site for this tab'),
      ),
    );
    if (info.seriesTitle) card.append(h('div', { class: 'title', text: info.seriesTitle }));
    const line = status?.text ?? this.statusText(info);
    if (line) card.append(h('div', { class: status?.error ? 'status error' : 'status', text: line }));
    card.append(h('div', { class: 'actions' }, ...this.actions(info)));

    this.root.replaceChildren(h('style', { text: CARD_CSS }), card);
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  private statusText(info: PageInfo): string {
    if (!info.inLibrary) {
      return this.match.kind === 'series' ? 'track new chapters and your progress.' : 'read this chapter in the reader.';
    }
    const unread = info.unread === 0 ? 'up to date' : `${info.unread} unread`;
    return this.match.kind === 'chapter' ? `progress saved · ${unread}` : unread;
  }

  private actions(info: PageInfo): HTMLButtonElement[] {
    // Leaves the site for the same page in onidoku, where none of the site's scripts or ads load.
    const inOnidoku = button(this.match.kind === 'series' ? 'open in onidoku' : 'read in onidoku', 'secondary', () =>
      openInOnidoku(this.root, (text, error) => error && this.show(info, { text, error })),
    );
    inOnidoku.title = 'without the site’s ads and scripts';
    if (this.match.kind === 'series') {
      if (!info.inLibrary) return [button('add to library', 'primary', () => this.addSeries(location.href)), inOnidoku];
      const details = button('details', 'secondary', () => send({ type: 'openDetails', id: info.seriesId! }));
      return info.next
        ? [button(`continue: ${info.next.title}`, 'primary', () => location.assign(info.next!.url)), details]
        : [details];
    }
    const actions = [button('open reader', 'primary', () => this.openReader()), inOnidoku];
    const seriesUrl = !info.inLibrary && this.seriesUrlFromPage();
    if (seriesUrl) actions.push(button('add series', 'secondary', () => this.addSeries(seriesUrl)));
    return actions;
  }

  private seriesUrlFromPage(): string | undefined {
    return chapterLinks(document, location.href, this.match.config).seriesUrl;
  }

  private async addSeries(seriesUrl: string): Promise<void> {
    for (const b of Array.from(this.root.querySelectorAll('button'))) b.disabled = true;
    try {
      await send({ type: 'addSeries', url: seriesUrl });
      if (this.match.kind === 'chapter') await send({ type: 'markRead', url: location.href });
      this.show(await pageInfo());
    } catch (err) {
      this.show(await pageInfo(), { text: `couldn't add: ${errorMessage(err)}`, error: true });
    }
  }

  private async openReader(): Promise<void> {
    this.host.remove();
    await send({ type: 'openReader' }).catch((err) => console.error('onidoku: failed to open reader', err));
  }

  private dismiss(): void {
    this.host.remove();
    dismiss();
  }
}

/** Replaces this page with the same title or chapter in onidoku (the background navigates the tab). */
async function openInOnidoku(root: ShadowRoot, status?: (text: string, error?: boolean) => void): Promise<void> {
  for (const b of Array.from(root.querySelectorAll('button'))) b.disabled = true;
  status?.('finding this page in onidoku…');
  try {
    await send({ type: 'openInOnidoku', url: location.href, titles: pageTitles() });
  } catch (err) {
    for (const b of Array.from(root.querySelectorAll('button'))) b.disabled = false;
    status?.(`couldn’t open it: ${errorMessage(err)}`, true);
  }
}

/**
 * What this page calls the title it's about, best guesses first: a link back up to a page this
 * one is under (a chapter's series, in breadcrumbs), the page's own heading and share title,
 * and its <title> without the site's name.
 */
function pageTitles(): string[] {
  const here = location.href.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const up = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .filter((a) => {
      const href = a.href.replace(/[?#].*$/, '').replace(/\/+$/, '');
      return href.length > new URL(here).origin.length + 1 && here.startsWith(`${href}/`);
    })
    .sort((a, b) => b.href.length - a.href.length)
    .map((a) => a.textContent ?? '');
  const candidates = [
    ...up,
    document.querySelector('h1')?.textContent ?? '',
    document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content ?? '',
    document.title.split(/\s+[-–—|·•]\s+/)[0] ?? '',
  ];
  const seen = new Set<string>();
  return candidates
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 2 && t.length <= 120 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, 4);
}

/**
 * On sites of Paperback sources, whose pages onidoku can't read directly: one card offering to
 * open the page in onidoku. The source is only asked to find it after a click.
 */
function showSitePrompt(source: SiteSource): void {
  const host = h('div');
  const root = host.attachShadow({ mode: 'open' });
  const status = h('div', { class: 'status', text: 'browse this site in onidoku, without its ads.' });
  const card = h(
    'div',
    { class: 'od-prompt', role: 'dialog', 'aria-label': 'onidoku' },
    h(
      'div',
      { class: 'head' },
      h('span', { class: 'dot' }),
      h('span', { class: 'site', text: `onidoku · ${source.name}` }),
      button('×', 'close', () => {
        host.remove();
        dismiss();
      }, 'hide on this site for this tab'),
    ),
    status,
    h(
      'div',
      { class: 'actions' },
      button('open in onidoku', 'primary', () =>
        openInOnidoku(root, (text, error) => {
          status.textContent = text;
          status.className = error ? 'status error' : 'status';
        }),
      ),
    ),
  );
  root.replaceChildren(h('style', { text: CARD_CSS }), card);
  document.documentElement.append(host);
}

function dismiss(): void {
  try {
    sessionStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // Storage can be blocked; dismissing for this page view is still fine.
  }
}

function pageInfo(): Promise<PageInfo> {
  return send<PageInfo>({ type: 'pageInfo', url: location.href });
}

function isDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  if (window.top !== window || isDismissed()) return;
  const match = await send<ConfigMatch | null>({ type: 'configFor', url: location.href });
  if (!match) {
    const source = await send<SiteSource | null>({ type: 'siteSource', url: location.href });
    if (source) showSitePrompt(source);
    return;
  }
  let info = await pageInfo();
  if (match.kind === 'chapter' && info.inLibrary) {
    await send({ type: 'markRead', url: location.href });
    info = await pageInfo();
  }
  new PagePrompt(match).show(info);
}

boot().catch((err) => console.error('onidoku prompt failed', err));

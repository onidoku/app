// Pieces shared by the full-page views (library, explore, search, sources, details).
import type { SiteConfig } from '@onidoku/core';
import { h } from './dom';

const TABS = [
  { page: 'library', label: 'library' },
  { page: 'explore', label: 'explore' },
  { page: 'search', label: 'search' },
  { page: 'options', label: 'sources' },
] as const;

export type Tab = (typeof TABS)[number]['page'];

/** Top navigation between the full-page views. */
export function appNav(current?: Tab): HTMLElement {
  return h(
    'nav',
    { class: 'app-nav', 'aria-label': 'onidoku' },
    h('a', { class: 'brand', href: 'library.html' }, h('img', { src: 'icons/logo.svg', alt: '', width: '22', height: '22' }), 'onidoku'),
    ...TABS.map(({ page, label }) =>
      h('a', { href: `${page}.html`, text: label, 'aria-current': page === current ? 'page' : undefined }),
    ),
  );
}

/**
 * A source's icon, or its first letter on a stable colour when it has none or the icon fails
 * to load (sites move their favicons). Decorative: the source name is always shown next to it.
 */
export function sourceIcon(source: Pick<SiteConfig, 'name' | 'icon'> | undefined, size = 20): HTMLElement {
  const name = source?.name ?? '?';
  const letter = () => {
    const el = h('span', { class: 'source-icon letter', text: name.charAt(0).toLowerCase(), 'aria-hidden': 'true' });
    el.style.setProperty('--size', `${size}px`);
    el.style.setProperty('--hue', String(hue(name)));
    return el;
  };
  if (!source?.icon) return letter();
  const img = h('img', { class: 'source-icon', src: source.icon, alt: '', width: String(size), height: String(size) });
  img.style.setProperty('--size', `${size}px`);
  img.addEventListener('error', () => img.replaceWith(letter()), { once: true });
  return img;
}

/** "18+" tag for sources marked nsfw. */
export function nsfwTag(): HTMLElement {
  return h('span', { class: 'tag nsfw', text: '18+', title: 'this source hosts adult content' });
}

function hue(text: string): number {
  let n = 0;
  for (const ch of text) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Who a source is from, for headers: the server's address, or the config's (or Paperback source's) author and version. */
export function sourceByline(config: SiteConfig): string {
  if (config.server) return `${config.developer.replace(/ server$/, '')} · ${new URL(config.server.url).host}`;
  if (config.paperback) return `Paperback source by ${config.developer} · v${config.paperback.version}`;
  return `by ${config.developer} · v${config.version}`;
}

export function timeAgo(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(time).toLocaleDateString();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A status message floating at the bottom of the window, optionally with an action such as
 * Undo. It doesn't touch the page, so focus and scroll stay put. Errors stay until the next message.
 */
export function toast(message: string, options: { error?: boolean; action?: HTMLElement } = {}): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast', class: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.replaceChildren(h('span', { text: message }), options.action ?? '');
  el.className = options.error ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!options.error) toastTimer = setTimeout(() => (el.hidden = true), options.action ? 12_000 : 6000);
}

/** Where a source's "open site" links go: the server, the Paperback source's site, or the site of its pages. */
export function siteHome(config: SiteConfig): string {
  return config.server?.url ?? config.paperback?.site ?? config.series.url.match(/^https?:\/\/[^/]+/)![0];
}

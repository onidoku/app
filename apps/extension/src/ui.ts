// Pieces shared by the full-page views (library, explore, search, sources, details).
import type { SiteConfig } from '@onidoku/core';
import { button, h } from './dom';

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

// ---- Icons (stroke paths on a 24px grid) ---------------------------------------------------

export const ICONS = {
  library: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  explore: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20zM16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36z',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM21 21l-4.35-4.35',
  sources: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5',
  reader: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z',
  play: 'M7 4l13 8-13 8z',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5L20 7',
  newest: 'M7 4v16M3 16l4 4 4-4M13 6h8M13 11h6M13 16h4',
  oldest: 'M7 20V4M3 8l4-4 4 4M13 6h4M13 11h6M13 16h8',
  // A crosshair: "find it in the list", not an arrow (that reads as download).
  jump: 'M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10zM12 2v4M12 18v4M2 12h4M18 12h4',
  checkAll: 'M2 12.5l5 5L17.5 7M12 17.5l1 1L23 8',
  undo: 'M3 12a9 9 0 1 0 2.64-6.36L3 8M3 3v5h5',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6',
} as const;

export function icon(name: keyof typeof ICONS): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

/** A button with an icon and a label (visible, or only as its accessible name when `iconOnly`). */
export function iconButton(name: keyof typeof ICONS, label: string, className: string, onClick: () => unknown, iconOnly = false): HTMLButtonElement {
  const el = button('', className, onClick, iconOnly ? label : undefined);
  el.append(icon(name), iconOnly ? '' : h('span', { text: label }));
  if (iconOnly) el.setAttribute('aria-label', label);
  return el;
}

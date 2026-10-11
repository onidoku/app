import { button, h } from './dom';
import { detailsUrl, errorMessage, pageUrl, previewUrl, send, type CheckResult, type LibraryItem, type PageInfo } from './messages';
import type { Detection } from '@onidoku/core';
import { sourceIcon } from './ui';
import { setImageSrc } from './servers';

/** Series shown in the popup; the rest are one click away in the library. */
const LIST_MAX = 6;

const pageEl = document.getElementById('page')!;
const libraryEl = document.getElementById('library')!;
const headingEl = document.getElementById('library-heading')!;
const emptyEl = document.getElementById('empty')!;
const statusEl = document.getElementById('status')!;
const barActions = document.getElementById('bar-actions')!;
const searchForm = document.getElementById('search') as HTMLFormElement;
const searchInput = document.getElementById('search-input') as HTMLInputElement;

function setStatus(message: string): void {
  statusEl.textContent = message;
  statusEl.hidden = !message;
}

// ---- Icons (stroke paths on a 24px grid) ---------------------------------------------------

const ICONS = {
  library: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  explore: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20zM16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36z',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM21 21l-4.35-4.35',
  sources: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5',
  reader: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z',
  play: 'M7 4l13 8-13 8z',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l5 5L20 7',
} as const;

function icon(name: keyof typeof ICONS): SVGSVGElement {
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
function iconButton(name: keyof typeof ICONS, label: string, className: string, onClick: () => unknown, iconOnly = false): HTMLButtonElement {
  const el = button('', className, onClick, iconOnly ? label : undefined);
  el.append(icon(name), iconOnly ? '' : h('span', { text: label }));
  if (iconOnly) el.setAttribute('aria-label', label);
  return el;
}

// ---- Navigation ----------------------------------------------------------------------------

type Page = 'library' | 'explore' | 'search' | 'options';

/** Switches to the page's tab if one is open, else opens it. `search` forces that exact URL. */
async function openPage(page: Page, search?: string): Promise<void> {
  const url = pageUrl(page);
  const target = search ? `${url}?${search}` : undefined;
  const [existing] = await chrome.tabs.query({ url: `${url}*` }).catch(() => [] as chrome.tabs.Tab[]);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, target ? { active: true, url: target } : { active: true });
    if (existing.windowId !== undefined) await chrome.windows?.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: target ?? url });
  }
  window.close();
}

function renderTabs(): void {
  const tabs: [Page, keyof typeof ICONS, string][] = [
    ['library', 'library', 'library'],
    ['explore', 'explore', 'explore'],
    ['search', 'search', 'search'],
    ['options', 'sources', 'sources'],
  ];
  document.getElementById('tabs')!.replaceChildren(...tabs.map(([page, name, label]) => iconButton(name, label, 'pop-tab', () => openPage(page))));
}

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const q = searchInput.value.trim();
  void openPage('search', q ? new URLSearchParams({ q }).toString() : undefined);
});

// ---- Current page --------------------------------------------------------------------------

function originPattern(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}/*`;
}

/** The card for the open tab. Shown only when there's something to do on it. */
async function renderPage(tab: chrome.tabs.Tab | undefined): Promise<void> {
  pageEl.replaceChildren();
  pageEl.hidden = true;
  barActions.replaceChildren(iconButton('refresh', 'check for new chapters', 'pop-icon', checkNow, true));
  const url = tab?.url;
  if (tab?.id === undefined || !url?.startsWith('http')) return;
  const tabId = tab.id;
  const info = await send<PageInfo>({ type: 'pageInfo', url });

  if (info.kind === 'unknown') {
    const detection = await detect(tabId);
    if (!detection) {
      // Doesn't look like a chapter: the guessing reader stays one tap away, without taking up room.
      barActions.prepend(iconButton('reader', 'try reader on this page', 'pop-icon', () => openReader(tabId), true));
      return;
    }
    pageEl.append(
      h(
        'div',
        { class: 'pop-card-head' },
        h('div', { class: 'pop-card-text' }, h('span', { class: 'pop-kicker', text: new URL(url).host }), h('strong', { text: detection.kind === 'images' ? 'comic chapter' : 'novel chapter' }), h('span', { class: 'hint', text: 'no source for this site, so the reader works from what it finds on the page.' })),
      ),
      h('div', { class: 'pop-actions' }, iconButton('reader', 'open reader', 'primary', () => openReader(tabId))),
    );
    pageEl.hidden = false;
    return;
  }

  const actions: HTMLElement[] = [];
  let title = info.seriesTitle;
  let subtitle = '';
  if (info.kind === 'series' && !info.inLibrary) {
    title = 'series page';
    subtitle = 'track new chapters and your progress.';
    actions.push(iconButton('plus', 'add to library', 'primary', () => addSeries(url)), button('details', 'secondary', () => chrome.tabs.create({ url: previewUrl(url) })));
  } else if (info.kind === 'series') {
    subtitle = unreadText(info.unread ?? 0);
    const next = info.next;
    if (next) actions.push(iconButton('play', `read ${next.title}`, 'primary', () => openChapter(next.url, tabId)));
    actions.push(button('details', 'secondary', () => chrome.tabs.create({ url: detailsUrl(info.seriesId!) })));
  } else {
    title ??= 'chapter page';
    subtitle = info.inLibrary ? unreadText(info.unread ?? 0) : 'add the series from its page to track progress.';
    actions.push(iconButton('reader', 'open reader', 'primary', () => openReader(tabId)));
    if (info.inLibrary && info.seriesId) {
      const seriesId = info.seriesId;
      actions.push(button('details', 'secondary', () => chrome.tabs.create({ url: detailsUrl(seriesId) })));
    }
  }

  pageEl.append(
    h(
      'div',
      { class: 'pop-card-head' },
      sourceIcon({ name: info.siteName ?? '?', icon: info.siteIcon ?? '' }, 28),
      h('div', { class: 'pop-card-text' }, h('span', { class: 'pop-kicker', text: info.siteName ?? new URL(url).host }), h('strong', { text: title ?? '' }), subtitle ? h('span', { class: 'hint', text: subtitle }) : undefined),
    ),
    h('div', { class: 'pop-actions' }, ...actions),
  );
  pageEl.hidden = false;
}

const unreadText = (unread: number) => (unread ? `${unread} unread chapter${unread === 1 ? '' : 's'}` : 'all caught up');

async function addSeries(url: string): Promise<void> {
  // Must be the first await: Chrome only shows the permission prompt during the click.
  const granted = await chrome.permissions.request({ origins: [originPattern(url)] });
  if (!granted) {
    setStatus('site access is needed to check for new chapters.');
    return;
  }
  setStatus('adding…');
  try {
    await send({ type: 'addSeries', url });
    setStatus('added to library.');
  } catch (err) {
    setStatus(errorMessage(err));
  }
  await refresh();
}

/** Whether the tab's page looks like a chapter (see probe.ts). Undefined where scripts can't run, e.g. store pages. */
async function detect(tabId: number): Promise<Detection | undefined> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['probe.js'] });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window as { __onidokuDetection?: unknown }).__onidokuDetection ?? null,
    });
    return (result?.result as Detection | null) ?? undefined;
  } catch {
    return undefined;
  }
}

async function openReader(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    window.close();
  } catch (err) {
    setStatus(errorMessage(err));
  }
}

/** Opens a chapter in the reader, in `tabId` or a new tab. */
function openChapter(url: string, tabId?: number): void {
  void send({ type: 'openChapter', url, reader: true, tabId }).catch((err) => setStatus(errorMessage(err)));
  if (tabId !== undefined) window.close();
}

// ---- Library -------------------------------------------------------------------------------

const lastActive = ({ entry }: LibraryItem) => entry.lastReadAt ?? entry.addedAt;

async function renderLibrary(): Promise<void> {
  const items = await send<LibraryItem[]>({ type: 'library' });
  // Unread first, then whatever was read most recently.
  // Series with new chapters first, then anything unread, most recently active first.
  const sorted = [...items].sort((a, b) => Number(b.fresh > 0) - Number(a.fresh > 0) || Number(b.unread > 0) - Number(a.unread > 0) || lastActive(b) - lastActive(a));
  headingEl.textContent = items.some((i) => i.unread > 0) ? 'continue reading' : 'your library';
  document.getElementById('open-library')!.textContent = items.length > LIST_MAX ? `all ${items.length} ›` : 'open library ›';

  emptyEl.hidden = items.length > 0;
  emptyEl.replaceChildren(
    h('strong', { text: 'your library is empty' }),
    h('span', { class: 'hint', text: 'find something to read, or open a series on a supported site and add it.' }),
    iconButton('explore', 'explore titles', 'primary', () => openPage('explore')),
  );
  libraryEl.replaceChildren(
    ...sorted.slice(0, LIST_MAX).map(({ entry, unread, fresh, next }) => {
      const { series } = entry;
      const cover = series.cover ? setImageSrc(h('img', { class: 'pop-cover', alt: '' }), series.cover) : h('span', { class: 'pop-cover' });
      const count = fresh > 0 ? `${fresh} new` : `${unread} unread`;
      const meta = unread > 0 ? `${count}${next ? ` · next: ${next.title}` : ''}` : 'caught up';
      const open = h('button', { type: 'button', class: 'pop-item-main', title: `${series.title} — details` }, cover, h('span', { class: 'pop-item-text' }, h('strong', { text: series.title }), h('span', { class: unread > 0 ? 'pop-meta unread' : 'pop-meta', text: meta })));
      open.addEventListener('click', () => chrome.tabs.create({ url: detailsUrl(series.id) }));
      const play = next ? iconButton('play', `read ${next.title}`, 'pop-play', () => openChapter(next.url), true) : undefined;
      return h('li', {}, open, play);
    }),
  );
}

async function checkNow(): Promise<void> {
  const btn = barActions.querySelector('.icon-refresh')?.closest('button');
  btn?.classList.add('spinning');
  setStatus('checking for new chapters…');
  try {
    const { updated, failures } = await send<CheckResult>({ type: 'checkNow' });
    const parts = [updated ? `${updated} series updated` : 'no new chapters'];
    if (failures.length) parts.push(`${failures.length} failed: ${failures.map((f) => f.title).join(', ')}`);
    setStatus(parts.join(' · '));
  } catch (err) {
    setStatus(errorMessage(err));
  }
  btn?.classList.remove('spinning');
  await renderLibrary();
}

async function refresh(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await Promise.all([renderPage(tab), renderLibrary()]);
  } catch (err) {
    setStatus(errorMessage(err));
  }
}

document.getElementById('open-library')!.addEventListener('click', () => openPage('library'));
renderTabs();
void refresh();

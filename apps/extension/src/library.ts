import type { SiteConfig } from '@onidoku/core';
import { button, h } from './dom';
import { CONFIGS_KEY, LIBRARY_CHANGED_KEY } from './keys';
import {
  detailsUrl,
  errorMessage,
  send,
  type Backup,
  type CheckResult,
  type ImportResult,
  type LibraryItem,
  type StorageUsage,
} from './messages';
import { appNav, formatBytes, sourceIcon, timeAgo } from './ui';
import { setImageSrc } from './servers';

type Sort = 'recent' | 'unread' | 'title' | 'added' | 'progress';
type Layout = 'grid' | 'compact' | 'list';
type Show = 'all' | 'updated' | 'unread' | 'reading' | 'new' | 'done';

const SORTS: Record<Sort, { label: string; compare: (a: LibraryItem, b: LibraryItem) => number }> = {
  recent: { label: 'last read', compare: (a, b) => recency(b) - recency(a) },
  unread: { label: 'most unread', compare: (a, b) => b.unread - a.unread || recency(b) - recency(a) },
  progress: { label: 'progress', compare: (a, b) => progress(b) - progress(a) || recency(b) - recency(a) },
  title: { label: 'title', compare: (a, b) => a.entry.series.title.localeCompare(b.entry.series.title) },
  added: { label: 'recently added', compare: (a, b) => b.entry.addedAt - a.entry.addedAt },
};

const SHOWS: Record<Show, { label: string; test: (item: LibraryItem) => boolean }> = {
  all: { label: 'all', test: () => true },
  updated: { label: 'new chapters', test: (i) => i.fresh > 0 },
  unread: { label: 'unread', test: (i) => i.unread > 0 },
  reading: { label: 'reading', test: (i) => Boolean(i.entry.readUpTo) && i.unread > 0 },
  new: { label: 'not started', test: (i) => !i.entry.readUpTo },
  done: { label: 'caught up', test: (i) => i.entry.chapters.length > 0 && i.unread === 0 },
};

const LAYOUTS: [Layout, string, string][] = [
  ['grid', '▦', 'grid'],
  ['compact', '▩', 'compact grid'],
  ['list', '☰', 'list'],
];

const VIEW_KEY = 'onidoku:libraryView';

const recency = ({ entry }: LibraryItem) => entry.lastReadAt ?? entry.addedAt;
const readCount = ({ entry, unread }: LibraryItem) => entry.chapters.length - unread;
const progress = (item: LibraryItem) => (item.entry.chapters.length ? readCount(item) / item.entry.chapters.length : 0);

const app = document.getElementById('app')!;
let items: LibraryItem[] = [];
let configs = new Map<string, SiteConfig>();
let query = '';
let source = '';
let { sort, layout, show } = loadView();
let selecting = false;
const selected = new Set<string>();

const grid = h('ul', { class: 'tiles' });
const countEl = h('span', { class: 'hint' });
const statusEl = h('p', { class: 'hint', role: 'status' });
const usageEl = h('p', { class: 'hint storage-note' });
const selectionBar = h('div', { class: 'selection-bar' });
const shelfEl = h('section', { class: 'shelf' });
const showEl = h('div', { class: 'filter-chips', role: 'group', 'aria-label': 'show' });
const layoutEl = h('div', { class: 'segmented-buttons', role: 'group', 'aria-label': 'layout' });
const sourceSelect = h('select', { 'aria-label': 'source' });
const emptyEl = h('div', { class: 'empty' });
// The "/" shortcut hint only helps with a keyboard.
const keyboard = matchMedia('(pointer: fine)').matches;
const filterInput = h('input', { type: 'search', placeholder: `filter by title, author or genre${keyboard ? '  ( / )' : ''}`, 'aria-label': 'filter library' });

function loadView(): { sort: Sort; layout: Layout; show: Show } {
  const fallback = { sort: 'recent' as Sort, layout: 'grid' as Layout, show: 'all' as Show };
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}');
    return {
      sort: saved.sort in SORTS ? saved.sort : fallback.sort,
      layout: LAYOUTS.some(([l]) => l === saved.layout) ? saved.layout : fallback.layout,
      show: saved.show in SHOWS ? saved.show : fallback.show,
    };
  } catch {
    return fallback;
  }
}

function saveView(): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ sort, layout, show }));
  } catch {
    // Storage blocked: the view just resets next time.
  }
}

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.className = isError ? 'error' : 'hint';
}

function skeleton(): void {
  filterInput.addEventListener('input', () => {
    query = filterInput.value;
    renderGrid();
  });
  sourceSelect.addEventListener('change', () => {
    source = sourceSelect.value;
    renderGrid();
  });
  const sortSelect = h(
    'select',
    { 'aria-label': 'sort' },
    ...Object.entries(SORTS).map(([value, { label }]) => h('option', { value, text: label })),
  );
  sortSelect.value = sort;
  sortSelect.addEventListener('change', () => {
    sort = sortSelect.value as Sort;
    saveView();
    renderGrid();
  });

  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: '' });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void importBackup(file);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !(document.activeElement instanceof HTMLInputElement)) {
      event.preventDefault();
      filterInput.focus();
    }
    if (event.key === 'Escape' && selecting) endSelection();
  });

  app.removeAttribute('aria-busy');
  app.replaceChildren(
    appNav('library'),
    h(
      'header',
      { class: 'page-head' },
      h('div', {}, h('h1', { text: 'library' }), countEl),
      h(
        'div',
        { class: 'actions' },
        button('check for new chapters', 'primary', checkNow),
        h(
          'details',
          { class: 'menu' },
          h('summary', { class: 'secondary', text: 'backup' }),
          h(
            'div',
            { class: 'menu-items' },
            button('export backup', '', exportBackup, 'download your library and sources as a file'),
            button('import backup', '', () => fileInput.click(), 'restore from a backup file; nothing is deleted'),
          ),
        ),
        fileInput,
      ),
    ),
    statusEl,
    shelfEl,
    h('div', { class: 'toolbar' }, filterInput, sourceSelect, sortSelect, layoutEl, button('select', 'secondary', startSelection)),
    showEl,
    selectionBar,
    grid,
    emptyEl,
    usageEl,
  );
}

async function load(): Promise<void> {
  const [loaded, installed, usage] = await Promise.all([
    send<LibraryItem[]>({ type: 'library' }),
    send<SiteConfig[]>({ type: 'listConfigs' }),
    send<StorageUsage>({ type: 'storageUsage' }),
  ]);
  items = loaded;
  configs = new Map(installed.map((c) => [c.id, c]));
  for (const id of selected) if (!items.some((i) => i.entry.series.id === id)) selected.delete(id);
  renderSources();
  renderGrid();
  const where = 'stored in this browser’s extension storage. export a backup to keep a copy elsewhere.';
  usageEl.textContent = usage.bytes === undefined ? where : `${formatBytes(usage.bytes)} · ${where}`;
}

/** Sources that have series in the library, for the filter. */
function renderSources(): void {
  const ids = [...new Set(items.map((i) => i.entry.series.siteId))];
  if (source && !ids.includes(source)) source = '';
  sourceSelect.replaceChildren(
    h('option', { value: '', text: 'all sources' }),
    ...ids.map((id) => h('option', { value: id, text: configs.get(id)?.name ?? id })),
  );
  sourceSelect.value = source;
  sourceSelect.hidden = ids.length < 2;
}

function matches(item: LibraryItem, ignoreShow = false): boolean {
  const { series } = item.entry;
  if (source && series.siteId !== source) return false;
  if (!ignoreShow && !SHOWS[show].test(item)) return false;
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [series.title, ...(series.authors ?? []), ...(series.genres ?? [])].some((t) => t.toLowerCase().includes(needle));
}

function renderGrid(): void {
  const shown = items.filter((i) => matches(i)).sort(SORTS[sort].compare);
  const unreadTotal = items.reduce((sum, i) => sum + i.unread, 0);
  const freshTotal = items.reduce((sum, i) => sum + i.fresh, 0);
  countEl.textContent = [
    `${items.length} series`,
    freshTotal ? `${freshTotal} new chapter${freshTotal === 1 ? '' : 's'}` : '',
    unreadTotal ? `${unreadTotal} unread` : '',
  ].filter(Boolean).join(' · ');

  renderShelf();
  renderShowChips();
  renderLayoutButtons();

  grid.className = `tiles layout-${layout}${selecting ? ' selecting' : ''}`;
  grid.replaceChildren(...shown.map(layout === 'list' ? listRow : tile));

  emptyEl.replaceChildren();
  if (!items.length) {
    emptyEl.append(
      h('p', { class: 'empty-title', text: 'your library is empty' }),
      h('p', { class: 'hint', text: 'search your sources, or open a series page on a supported site and add it from the extension icon.' }),
      h('a', { class: 'button primary', href: 'search.html', text: 'search sources' }),
    );
  } else if (!shown.length) {
    emptyEl.append(
      h('p', { class: 'hint', text: 'nothing matches these filters.' }),
      button('clear filters', 'link', () => {
        query = filterInput.value = '';
        source = sourceSelect.value = '';
        show = 'all';
        saveView();
        renderGrid();
      }),
    );
  }
  renderSelectionBar(shown);
}

/** Series being read with chapters waiting, most recently read first: one click back in. */
function renderShelf(): void {
  const reading = items
    .filter((i) => i.entry.lastReadAt && i.unread > 0 && i.next)
    .sort((a, b) => b.entry.lastReadAt! - a.entry.lastReadAt!)
    .slice(0, 3);
  // Only on the unfiltered view: with filters on, the grid itself is the answer.
  shelfEl.hidden = !reading.length || Boolean(query.trim()) || show !== 'all' || Boolean(source) || selecting;
  if (shelfEl.hidden) return;
  shelfEl.replaceChildren(
    h('h2', { text: 'continue reading' }),
    h(
      'ul',
      { class: 'shelf-row' },
      ...reading.map((item) => {
        const { series } = item.entry;
        const cover = series.cover ? setImageSrc(h('img', { alt: '', loading: 'lazy' }), series.cover) : h('span', { class: 'cover blank' });
        const el = h(
          'button',
          { type: 'button', class: 'shelf-item', title: `continue ${series.title}: ${item.next!.title}` },
          cover,
          h('span', { class: 'shelf-text' }, h('strong', { text: series.title }), h('span', { class: 'hint', text: item.next!.title }), h('span', { class: 'hint', text: `${item.unread} unread · ${timeAgo(item.entry.lastReadAt!)}` })),
        );
        el.addEventListener('click', () => continueReading(item));
        return h('li', {}, el);
      }),
    ),
  );
}

function renderShowChips(): void {
  showEl.replaceChildren(
    ...(Object.entries(SHOWS) as [Show, (typeof SHOWS)[Show]][]).map(([key, { label, test }]) => {
      const count = items.filter((i) => matches(i, true) && test(i)).length;
      const el = h('button', { type: 'button', class: 'chip-toggle', 'aria-pressed': String(show === key) }, label, h('span', { class: 'count', text: String(count) }));
      el.addEventListener('click', () => {
        show = key;
        saveView();
        renderGrid();
      });
      return el;
    }),
  );
}

function renderLayoutButtons(): void {
  layoutEl.replaceChildren(
    ...LAYOUTS.map(([key, icon, label]) => {
      const el = button(icon, '', () => {
        layout = key;
        saveView();
        renderGrid();
      }, label);
      el.setAttribute('aria-pressed', String(layout === key));
      el.setAttribute('aria-label', label);
      return el;
    }),
  );
}

function renderSelectionBar(shown: LibraryItem[]): void {
  selectionBar.hidden = !selecting;
  if (!selecting) return;
  const ids = shown.map((i) => i.entry.series.id);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const remove = button(selected.size ? `remove ${selected.size} from library` : 'remove from library', 'secondary danger-text', removeSelected);
  remove.disabled = !selected.size;
  const markRead = button('mark as read', 'secondary', () => markSelected('read'), 'mark every chapter of the selected series read');
  const markUnread = button('mark as unread', 'secondary', () => markSelected('unread'));
  markRead.disabled = markUnread.disabled = !selected.size;
  selectionBar.replaceChildren(
    h('strong', { text: `${selected.size} selected` }),
    button(allSelected ? 'select none' : 'select all', 'link', () => {
      for (const id of ids) allSelected ? selected.delete(id) : selected.add(id);
      renderGrid();
    }),
    h('span', { class: 'spacer' }),
    markRead,
    markUnread,
    remove,
    button('done', 'link', endSelection),
  );
}

function startSelection(): void {
  selecting = !selecting;
  selected.clear();
  renderGrid();
}

function endSelection(): void {
  selecting = false;
  selected.clear();
  renderGrid();
}

function toggleSelected(id: string): void {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderGrid();
}

function coverOf(item: LibraryItem): HTMLElement {
  const { series } = item.entry;
  return series.cover
    ? setImageSrc(h('img', { class: 'cover', alt: '', loading: 'lazy' }), series.cover)
    : h('div', { class: 'cover blank', text: series.title });
}

function progressBar(item: LibraryItem): HTMLElement {
  const fill = h('span', { class: 'fill' });
  fill.style.width = `${Math.round(progress(item) * 100)}%`;
  return h('span', { class: 'mini-progress', title: `${readCount(item)} of ${item.entry.chapters.length} read` }, fill);
}

function sourceLabel(siteId: string): HTMLElement {
  const config = configs.get(siteId);
  return h(
    'span',
    { class: 'tile-source hint' },
    sourceIcon(config ?? { name: siteId, icon: '' }, 14),
    h('span', { text: config?.name ?? `${siteId} (not installed)` }),
  );
}

function tile(item: LibraryItem): HTMLElement {
  const { entry, unread, fresh } = item;
  const { series } = entry;
  const isSelected = selected.has(series.id);
  const open = h(
    'button',
    { type: 'button', class: 'tile-button', title: series.title, 'aria-pressed': selecting ? String(isSelected) : undefined },
    h('span', { class: 'tile-cover' }, coverOf(item), readCount(item) > 0 ? progressBar(item) : undefined),
    unread > 0 ? h('span', { class: 'badge', text: String(unread), title: `${unread} unread` }) : undefined,
    fresh > 0 ? h('span', { class: 'cover-flag new', text: `${fresh} new` }) : undefined,
    selecting ? h('span', { class: 'check-mark', 'aria-hidden': 'true', text: isSelected ? '✓' : '' }) : undefined,
    h('span', { class: 'tile-title', text: series.title }),
  );
  open.addEventListener('click', () => (selecting ? toggleSelected(series.id) : (location.href = detailsUrl(series.id))));
  return h('li', { class: isSelected ? 'tile selected' : 'tile', 'data-id': series.id }, open);
}

function listRow(item: LibraryItem): HTMLElement {
  const { entry, unread, fresh, next } = item;
  const { series } = entry;
  const isSelected = selected.has(series.id);
  const total = entry.chapters.length;
  const main = h(
    'button',
    { type: 'button', class: 'row-main', 'aria-pressed': selecting ? String(isSelected) : undefined },
    selecting ? h('span', { class: 'check-mark inline', 'aria-hidden': 'true', text: isSelected ? '✓' : '' }) : undefined,
    coverOf(item),
    h(
      'span',
      { class: 'row-info' },
      h('span', { class: 'tile-title' }, series.title, fresh > 0 ? h('span', { class: 'new-tag', text: `${fresh} new` }) : undefined),
      sourceLabel(series.siteId),
      h('span', { class: 'row-meta' }, progressBar(item), h('span', { class: 'hint', text: `${readCount(item)} / ${total} read${unread ? ` · ${unread} unread` : ''}` })),
      h('span', { class: 'hint', text: entry.lastReadAt ? `last read ${timeAgo(entry.lastReadAt)}` : `added ${timeAgo(entry.addedAt)}` }),
    ),
  );
  main.addEventListener('click', () => (selecting ? toggleSelected(series.id) : (location.href = detailsUrl(series.id))));
  const action =
    !selecting && next
      ? button(entry.readUpTo ? (unread ? `continue: ${next.title}` : 'read again') : `start: ${next.title}`, unread ? 'primary' : 'secondary', () => continueReading(item))
      : undefined;
  return h('li', { class: isSelected ? 'list-row selected' : 'list-row', 'data-id': series.id }, main, action);
}

function continueReading(item: LibraryItem): void {
  if (!item.next) return;
  void send({ type: 'openChapter', url: item.next.url, reader: true }).catch((err) => setStatus(errorMessage(err), true));
}

async function markSelected(state: 'read' | 'unread'): Promise<void> {
  const chosen = items.filter((i) => selected.has(i.entry.series.id));
  for (const { entry } of chosen) {
    const url = state === 'read' ? (entry.chapters.at(-1)?.url ?? null) : null;
    await send({ type: 'setProgress', id: entry.series.id, url });
  }
  setStatus(`marked ${chosen.length} series as ${state}.`);
  endSelection();
  await load();
}

async function removeSelected(): Promise<void> {
  if (!selected.size) return;
  const titles = items.filter((i) => selected.has(i.entry.series.id)).map((i) => i.entry.series.title);
  const listed = titles.length > 5 ? `${titles.slice(0, 5).join(', ')} and ${titles.length - 5} more` : titles.join(', ');
  if (!confirm(`remove ${titles.length} series from your library? reading progress will be lost.\n\n${listed}`)) return;
  for (const id of selected) await send({ type: 'removeSeries', id });
  setStatus(`removed ${titles.length} series.`);
  endSelection();
  await load();
}

async function checkNow(): Promise<void> {
  setStatus('checking for new chapters…');
  try {
    const { updated, failures } = await send<CheckResult>({ type: 'checkNow' });
    const parts = [updated ? `${updated} series updated` : 'no new chapters'];
    if (failures.length) parts.push(`${failures.length} failed: ${failures.map((f) => f.title).join(', ')}`);
    setStatus(parts.join(' · '), failures.length > 0 && !updated);
  } catch (err) {
    setStatus(errorMessage(err), true);
  }
}

async function exportBackup(): Promise<void> {
  try {
    const backup = await send<Backup>({ type: 'exportBackup' });
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const link = h('a', { href: URL.createObjectURL(blob), download: `onidoku-backup-${backup.exportedAt.slice(0, 10)}.json` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    setStatus(`exported ${backup.library.length} series and ${backup.sources.length} sources.`);
  } catch (err) {
    setStatus(errorMessage(err), true);
  }
}

async function importBackup(file: File): Promise<void> {
  try {
    const backup: unknown = JSON.parse(await file.text());
    const { series, sources, skipped } = await send<ImportResult>({ type: 'importBackup', backup });
    const parts = [`restored ${series} series and ${sources} sources`];
    if (skipped) parts.push(`${skipped} invalid items skipped`);
    if (sources) parts.push('allow site access on the sources page to check them for new chapters');
    setStatus(`${parts.join(' · ')}.`);
  } catch (err) {
    setStatus(err instanceof SyntaxError ? 'that file is not valid JSON.' : errorMessage(err), true);
  }
}

// Changes from the reader, the popup or update checks show up here live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (LIBRARY_CHANGED_KEY in changes || CONFIGS_KEY in changes)) void load();
});

skeleton();
load().catch((err) => setStatus(errorMessage(err), true));

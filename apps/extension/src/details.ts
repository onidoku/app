import { configOrigins, seriesIdFor, type ChapterRef, type Series, type SiteConfig } from '@onidoku/core';
import { button, h } from './dom';
import { LIBRARY_CHANGED_KEY } from './keys';
import { searchByUrl, errorMessage, send, type ConfigMatch, type LibraryItem, type SeriesPreview } from './messages';
import { appNav, siteHome, sourceIcon, timeAgo, toast } from './ui';
import { setImageSrc } from './servers';

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
// `?id=` opens a library entry; `?url=` opens any series page of an installed source, in the
// library or not (from Explore, Search, …). Either way the page follows the series into or out
// of the library.
let seriesId = params.get('id') ?? '';
let seriesUrl = params.get('url') ?? '';

let item: LibraryItem | null = null;
/** Chapters that were new when the page opened: still marked after the badge is cleared. */
let newUrls = new Set<string>();
/** The series as loaded live from its site, while it isn't in the library. */
let preview: SeriesPreview | null = null;
let site: SiteConfig | undefined;
let state: 'ready' | 'loading' | 'no-access' | 'not-found' | 'error' = 'loading';
let loadError = '';
let filter = '';
let newestFirst = true;
/** "Remove from library" was clicked and waits for confirmation. */
let confirmingRemove = false;
/** A "Check for new chapters" is running. */
let checking = false;
/** Chapter rows rendered so far: long lists (thousands on novel sites) render in chunks. */
let limit = 0;

/** Rows added per "Show more". */
const CHUNK = 100;

async function load(): Promise<void> {
  const configs = await send<SiteConfig[]>({ type: 'listConfigs' });
  if (!seriesId && seriesUrl) {
    const match = await send<ConfigMatch | null>({ type: 'configFor', url: seriesUrl });
    if (match?.kind === 'series') seriesId = seriesIdFor(match.config.id, seriesUrl);
  }
  item = seriesId ? await send<LibraryItem | null>({ type: 'series', id: seriesId }) : null;
  if (item?.entry.newChapters?.length) {
    // Opening the series counts as seeing its new chapters; keep them marked while the page is open.
    for (const url of item.entry.newChapters) newUrls.add(url);
    item = (await send<LibraryItem | null>({ type: 'seenSeries', id: seriesId })) ?? item;
  }
  if (item) {
    seriesUrl = item.entry.series.url;
    site = configs.find((c) => c.id === item!.entry.series.siteId);
    preview = null;
    state = 'ready';
    syncUrl();
    return render();
  }

  // Not in the library: show the series as its site has it now.
  site = configs.find((c) => seriesId.startsWith(`${c.id}:`));
  // Library ids are `<source id>:<series URL>`, so links to removed entries still find the series.
  if (!seriesUrl && site) seriesUrl = seriesId.slice(site.id.length + 1);
  if (!seriesUrl || !site) {
    state = 'not-found';
    return render();
  }
  if (preview?.seriesId === seriesId) {
    state = 'ready';
    return render();
  }
  if (!(await chrome.permissions.contains({ origins: configOrigins(site) }))) {
    state = 'no-access';
    return render();
  }
  state = 'loading';
  render();
  try {
    preview = await send<SeriesPreview>({ type: 'previewSeries', url: seriesUrl });
    state = 'ready';
  } catch (err) {
    loadError = errorMessage(err);
    state = 'error';
  }
  render();
}

/** Keeps both forms in the address bar, so a reload or a shared link finds the series either way. */
function syncUrl(): void {
  const search = new URLSearchParams();
  if (seriesId) search.set('id', seriesId);
  if (seriesUrl) search.set('url', seriesUrl);
  history.replaceState(null, '', `?${search}`);
}

async function allowAccess(): Promise<void> {
  if (!site || !(await chrome.permissions.request({ origins: configOrigins(site) }))) return;
  await load();
}

/** What the page shows, from the library entry or the live preview. */
function view(): { series: Series; chapters: ChapterRef[]; readIndex: number } | undefined {
  if (item) {
    const { entry } = item;
    return { series: entry.series, chapters: entry.chapters, readIndex: entry.readUpTo ? entry.chapters.findIndex((c) => c.url === entry.readUpTo) : -1 };
  }
  return preview ? { series: preview.series, chapters: preview.chapters, readIndex: -1 } : undefined;
}

function render(): void {
  app.removeAttribute('aria-busy');
  const shown = view();
  if (!shown) {
    document.title = 'onidoku';
    app.replaceChildren(appNav(), placeholder());
    return;
  }
  const { series, chapters, readIndex } = shown;
  document.title = `${series.title} · onidoku`;

  const info = h(
    'div',
    { class: 'info' },
    h('h1', { text: series.title }),
    h(
      'p',
      { class: 'meta' },
      byline(series.authors ?? [], series.status),
      h(
        'a',
        // Paperback titles have no page of their own to link to: their site's home page stands in.
        { class: 'source-link', href: site?.paperback ? siteHome(site) : series.url, target: '_blank', rel: 'noopener' },
        sourceIcon(site, 16),
        site ? `open on ${site.name}` : 'open on site',
      ),
    ),
    Boolean(series.genres?.length) &&
      h(
        'ul',
        { class: 'chips' },
        ...series.genres!.map((g) => h('li', {}, h('a', { href: searchByUrl('genres', g), title: `find ${g} titles on your sources`, text: g }))),
      ),
    series.description && description(series.description),
    progressBlock(chapters.length, readIndex),
    confirmingRemove ? removeConfirmation() : h('div', { class: 'actions' }, ...actions()),
  );

  const cover = series.cover
    ? setImageSrc(h('img', { class: 'cover', alt: '' }), series.cover)
    : h('div', { class: 'cover blank', text: series.title });
  app.replaceChildren(appNav(), h('section', { class: 'hero' }, cover, info), chapterSection());
}

/** Reading progress and when things last happened, or what adding the series would do. */
function progressBlock(total: number, readIndex: number): HTMLElement {
  if (!item) {
    return h('p', { class: 'hint not-in-library', text: `not in your library · ${total} chapter${total === 1 ? '' : 's'}. add it to track progress and get new-chapter alerts.` });
  }
  const { entry, unread } = item;
  const read = readIndex + 1;
  const fill = h('div', { class: 'fill' });
  fill.style.width = `${total ? Math.round((read / total) * 100) : 0}%`;
  const when = [
    entry.lastReadAt ? `last read ${timeAgo(entry.lastReadAt)}` : undefined,
    entry.checkedAt ? `checked ${timeAgo(entry.checkedAt)}` : undefined,
    `added ${timeAgo(entry.addedAt)}`,
  ].filter(Boolean).join(' · ');
  return h(
    'div',
    { class: 'progress' },
    h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(read), 'aria-label': 'chapters read' }, fill),
    h('span', { class: 'progress-text' }, h('strong', { text: `${read} of ${total} read` }), unread ? ` · ${unread} unread` : total ? ' · all caught up' : ''),
    h('span', { class: 'hint', text: when }),
  );
}

/** Shown while there's no series to show: loading, needs access, or gone. */
function placeholder(): HTMLElement {
  const name = site?.name ?? 'the site';
  switch (state) {
    case 'loading':
      return h('div', { class: 'empty' }, h('span', { class: 'spinner' }), h('p', { text: `loading from ${name}…` }), h('p', { class: 'hint', text: 'long chapter lists can take a few seconds.' }));
    case 'no-access':
      return h('div', { class: 'empty' }, h('p', { text: `onidoku needs access to ${name} to show this series.` }), button(`allow access to ${name}`, 'primary', allowAccess));
    case 'error':
      return h(
        'div',
        { class: 'empty' },
        h('p', { class: 'error', text: `couldn’t load this series: ${loadError}` }),
        button('retry', 'secondary', () => load()),
        seriesUrl ? h('a', { href: seriesUrl, target: '_blank', rel: 'noopener', text: `open on ${name} ↗` }) : undefined,
      );
    default:
      return h('div', { class: 'empty' }, h('p', { text: 'this series isn’t in your library, and no installed source can open it.' }), h('a', { href: 'library.html', text: 'go to library' }));
  }
}

/** "A, B · Ongoing", with each author linking to their browse page. */
function byline(authors: string[], status: string | undefined): HTMLElement {
  const el = h('span', { class: 'byline' });
  authors.forEach((name, i) => {
    if (i) el.append(', ');
    el.append(h('a', { href: searchByUrl('authors', name), title: `find titles by ${name} on your sources`, text: name }));
  });
  if (status) el.append(authors.length ? ` · ${status}` : status);
  return el;
}

/** The summary, clamped to a few lines with "Show more" only when it's actually longer. */
function description(text: string): HTMLElement {
  const el = h('div', { class: 'description clamped' });
  for (const para of text.split('\n\n')) el.append(h('p', { text: para }));
  const toggle = button('show more', 'link', () => {
    const clamped = el.classList.toggle('clamped');
    toggle.textContent = clamped ? 'show more' : 'show less';
  });
  toggle.hidden = true;
  requestAnimationFrame(() => (toggle.hidden = el.scrollHeight <= el.clientHeight + 1));
  return h('div', {}, el, toggle);
}

function actions(): HTMLElement[] {
  if (!item) {
    const first = preview!.chapters[0];
    const list: HTMLElement[] = [];
    if (first) list.push(button(`start reading: ${first.title}`, 'primary', () => openChapter(first)));
    list.push(button('add to library', first ? 'secondary' : 'primary', addToLibrary));
    return list;
  }
  const { entry, next, unread } = item;
  const list: HTMLElement[] = [];
  if (next) {
    const label = !entry.readUpTo ? `start reading: ${next.title}` : unread ? `continue: ${next.title}` : `read again: ${next.title}`;
    list.push(button(label, 'primary', () => openChapter(next)));
  }
  const check = button(checking ? 'checking…' : 'check for new chapters', 'secondary', checkNow);
  check.disabled = checking;
  list.push(
    check,
    button('remove from library', 'secondary danger-text', () => {
      confirmingRemove = true;
      render();
      app.querySelector<HTMLElement>('.confirm-remove button')?.focus();
    }),
  );
  return list;
}

async function checkNow(): Promise<void> {
  checking = true;
  render();
  try {
    const before = new Set(item!.entry.chapters.map((c) => c.url));
    item = await send<LibraryItem>({ type: 'refreshSeries', id: seriesId });
    const added = item.entry.chapters.filter((c) => !before.has(c.url));
    for (const c of added) newUrls.add(c.url);
    toast(added.length ? `${added.length} new chapter${added.length === 1 ? '' : 's'}` : 'no new chapters');
  } catch (err) {
    toast(errorMessage(err), { error: true });
  }
  checking = false;
  render();
}

/** Removal is confirmed in place (Cancel focused), then can be undone from the message. */
function removeConfirmation(): HTMLElement {
  const { entry } = item!;
  const read = entry.readUpTo ? entry.chapters.findIndex((c) => c.url === entry.readUpTo) + 1 : 0;
  return h(
    'div',
    { class: 'confirm-remove', role: 'group', 'aria-label': 'remove from library?' },
    h('p', { class: 'hint', text: read ? `remove from your library? your progress (${read} of ${entry.chapters.length} read) goes with it.` : 'remove from your library?' }),
    h(
      'div',
      { class: 'actions' },
      button('cancel', 'secondary', () => {
        confirmingRemove = false;
        render();
      }),
      button('remove', 'destructive', removeFromLibrary),
    ),
  );
}

async function removeFromLibrary(): Promise<void> {
  const removed = item!.entry;
  confirmingRemove = false;
  try {
    await send({ type: 'removeSeries', id: seriesId });
  } catch (err) {
    toast(errorMessage(err), { error: true });
    return render();
  }
  // Stay on the page: it becomes a preview, one click away from adding it back.
  preview = { seriesId, series: removed.series, chapters: removed.chapters };
  item = null;
  render();
  toast('removed from library.', {
    action: button('undo', 'link', async () => {
      try {
        await send({ type: 'addSeries', url: removed.series.url });
        if (removed.readUpTo) await send({ type: 'setProgress', id: seriesId, url: removed.readUpTo });
        toast('back in your library.');
        await load();
      } catch (err) {
        toast(errorMessage(err), { error: true });
      }
    }),
  });
}

// ---- Chapters ---------------------------------------------------------------------------

function chapterSection(): HTMLElement {
  const { chapters } = view()!;
  const search = h('input', { type: 'search', placeholder: 'filter chapters', 'aria-label': 'filter chapters', value: filter });
  let list = chapterList();
  search.addEventListener('input', () => {
    filter = search.value;
    limit = CHUNK;
    // Replace only the list so the search box keeps focus while typing.
    const fresh = chapterList();
    list.replaceWith(fresh);
    list = fresh;
  });
  const sort = button(newestFirst ? 'newest first' : 'oldest first', 'secondary', () => {
    newestFirst = !newestFirst;
    limit = CHUNK;
    render();
  }, 'change order');

  const next = item?.unread ? item.next : undefined;
  const tools: HTMLElement[] = [search, sort];
  if (next) tools.push(button('jump to up next', 'secondary', () => jumpTo(next.url)));
  if (item && chapters.length) {
    const allRead = item.unread === 0;
    tools.push(
      button(allRead ? 'mark all unread' : 'mark all read', 'secondary', () => setProgress(allRead ? null : chapters.at(-1)!.url, true)),
    );
  }

  return h(
    'section',
    { class: 'chapter-section' },
    h('div', { class: 'row' }, h('h2', { text: `chapters (${chapters.length})` }), h('div', { class: 'tools' }, ...tools)),
    list,
  );
}

function chapterList(): HTMLElement {
  const { chapters, readIndex } = view()!;
  const needle = filter.trim().toLowerCase();
  const rows = chapters
    .map((chapter, index) => ({ chapter, index, read: index <= readIndex }))
    .filter(({ chapter }) => !needle || chapter.title.toLowerCase().includes(needle));
  if (newestFirst) rows.reverse();
  if (!rows.length) return h('p', { class: 'hint', text: needle ? 'no chapters match.' : 'no chapters found.' });
  limit = Math.max(limit, CHUNK);
  const shown = rows.slice(0, limit);
  const list = h('ul', { class: 'chapters' }, ...shown.map(chapterRow));
  if (rows.length <= limit) return list;
  const rest = rows.length - limit;
  const more = button(`show ${Math.min(rest, CHUNK)} more (${rest} left)`, 'secondary show-more', () => {
    limit += CHUNK;
    const fresh = chapterList();
    wrap.replaceWith(fresh);
  });
  const wrap = h('div', {}, list, more);
  return wrap;
}

/** Scrolls to a chapter (rendering more rows if needed) and highlights it briefly. */
function jumpTo(url: string): void {
  const { chapters } = view()!;
  filter = '';
  const index = chapters.findIndex((c) => c.url === url);
  const position = newestFirst ? chapters.length - 1 - index : index;
  limit = Math.max(limit, Math.ceil((position + 1) / CHUNK) * CHUNK);
  render();
  const row = app.querySelector<HTMLElement>(`.chapters li[data-url="${CSS.escape(url)}"]`);
  row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row?.classList.add('flash');
  row?.querySelector<HTMLElement>('.chapter-title')?.focus({ preventScroll: true });
}

function chapterRow({ chapter, index, read }: { chapter: ChapterRef; index: number; read: boolean }): HTMLElement {
  const open = button(chapter.title, 'chapter-title', () => openChapter(chapter), 'open in reader');
  if (!item) return h('li', { class: 'preview', 'data-url': chapter.url }, h('span', { class: 'dot', 'aria-hidden': 'true' }), open);
  const { entry, unread, next } = item;
  const upNext = unread > 0 && next?.url === chapter.url;
  const toggle = read
    ? button('mark unread', 'link', () => setProgress(entry.chapters[index - 1]?.url ?? null), 'mark this and later chapters unread')
    : button('mark read', 'link', () => setProgress(chapter.url), 'mark this and earlier chapters read');
  return h(
    'li',
    { class: [read ? 'read' : '', upNext ? 'up-next' : ''].join(' ').trim(), 'data-url': chapter.url },
    h('span', { class: 'dot', 'aria-label': read ? 'read' : 'unread' }),
    open,
    upNext ? h('span', { class: 'next-tag', text: 'up next' }) : undefined,
    !read && newUrls.has(chapter.url) ? h('span', { class: 'new-tag', text: 'new' }) : undefined,
    toggle,
  );
}

/** Sets progress; `undoable` (bulk changes) offers Undo back to where it was. */
async function setProgress(url: string | null, undoable = false): Promise<void> {
  const before = item?.entry.readUpTo ?? null;
  try {
    item = await send<LibraryItem>({ type: 'setProgress', id: seriesId, url });
    render();
    if (undoable) {
      toast(url ? 'marked all chapters read.' : 'marked all chapters unread.', {
        action: button('undo', 'link', () => setProgress(before)),
      });
    }
  } catch (err) {
    toast(errorMessage(err), { error: true });
  }
}

async function addToLibrary(): Promise<void> {
  // Must be the first await: browsers only show the permission prompt during the click.
  if (site && !(await chrome.permissions.request({ origins: configOrigins(site) }))) return;
  toast('adding…');
  try {
    item = await send<LibraryItem>({ type: 'series', id: (await send<{ series: Series }>({ type: 'addSeries', url: seriesUrl })).series.id });
    preview = null;
    syncUrl();
    render();
    toast('added to library.');
  } catch (err) {
    toast(errorMessage(err), { error: true });
  }
}

function openChapter(chapter: ChapterRef): void {
  void send({ type: 'openChapter', url: chapter.url, reader: true }).catch((err) => toast(errorMessage(err), { error: true }));
}

// Progress saved from the reader or the on-page prompt in other tabs shows up here live.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && LIBRARY_CHANGED_KEY in changes && !confirmingRemove) void load();
});

load().catch((err) => {
  app.replaceChildren(h('p', { class: 'error', text: errorMessage(err) }));
});

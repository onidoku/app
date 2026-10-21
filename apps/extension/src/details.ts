import { ANILIST_SCORE_RANGE, configOrigins, seriesIdFor, type AnilistChanges, type AnilistMedia, type AnilistStatus, type AnilistTracking, type ChapterRef, type Series, type SiteConfig } from '@onidoku/core';
import type { AnilistState } from './anilist';
import { button, h } from './dom';
import { ANILIST_KEY, LIBRARY_CHANGED_KEY } from './keys';
import { searchByUrl, errorMessage, send, type ConfigMatch, type LibraryItem, type SeriesPreview } from './messages';
import { appNav, iconButton, siteHome, sourceIcon, timeAgo, toast } from './ui';
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

/** Whether AniList is connected, for the "track on AniList" control. */
let anilist: AnilistState | undefined;

/** A Paperback title's page on its site, asked of the source after the page loads. */
let shareUrl: { url: string; link?: string } | undefined;

/** The linked AniList entry as AniList has it now, fetched after the page loads. */
let tracking: { mediaId: number; data?: AnilistTracking; error?: string } | undefined;

/** Rows added per "Show more". */
const CHUNK = 100;

async function load(): Promise<void> {
  const configs = await send<SiteConfig[]>({ type: 'listConfigs' });
  if (!seriesId && seriesUrl) {
    const match = await send<ConfigMatch | null>({ type: 'configFor', url: seriesUrl });
    if (match?.kind === 'series') seriesId = seriesIdFor(match.config.id, seriesUrl);
  }
  anilist = await send<AnilistState>({ type: 'anilistState' }).catch(() => undefined);
  item = seriesId ? await send<LibraryItem | null>({ type: 'series', id: seriesId }) : null;
  if (item?.entry.newChapters?.length) {
    // Opening the series counts as seeing its new chapters; keep them marked while the page is open.
    for (const url of item.entry.newChapters) newUrls.add(url);
    item = (await send<LibraryItem | null>({ type: 'seenSeries', id: seriesId })) ?? item;
  }
  if (item) {
    refreshTracking();
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

/** A Paperback title's link: its page once the source has named it, its site's home page until then. */
function sourceLink(config: SiteConfig, url: string): string {
  if (shareUrl?.url !== url) {
    const asked: { url: string; link?: string } = { url };
    shareUrl = asked;
    void send<string | null>({ type: 'shareUrl', url })
      .then((link) => {
        if (!link || shareUrl !== asked) return;
        asked.link = link;
        app.querySelector<HTMLAnchorElement>('.source-link')?.setAttribute('href', link);
      })
      .catch(() => {});
  }
  return shareUrl.link ?? siteHome(config);
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
        // Paperback titles are linked to the page their source shares, or to their site's home page.
        { class: 'source-link', href: site?.paperback ? sourceLink(site, series.url) : series.url, target: '_blank', rel: 'noopener' },
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
    trackerBlock(),
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

const STATUS_LABELS: Record<AnilistStatus, string> = {
  CURRENT: 'reading',
  PLANNING: 'planning to read',
  COMPLETED: 'completed',
  PAUSED: 'paused',
  DROPPED: 'dropped',
  REPEATING: 'rereading',
};

/** Loads the linked entry from AniList in the background; the card shows "loading" meanwhile. */
function refreshTracking(): void {
  const mediaId = anilist?.user ? item?.entry.trackers?.anilist?.id : undefined;
  if (!mediaId) {
    tracking = undefined;
    return;
  }
  if (tracking?.mediaId !== mediaId) tracking = { mediaId };
  send<AnilistTracking>({ type: 'anilistTracking', mediaId })
    .then((data) => (tracking = { mediaId, data }))
    .catch((err) => (tracking = { mediaId, data: tracking?.data, error: errorMessage(err) }))
    .finally(() => {
      if (tracking?.mediaId === mediaId) render();
    });
}

/** Where the series is tracked on AniList and its entry there (library series only). */
function trackerBlock(): HTMLElement | undefined {
  if (!item || !anilist?.available) return undefined;
  const link = item.entry.trackers?.anilist;
  if (!link) return undefined;
  if (!anilist.user) {
    return h('p', { class: 'hint tracker' }, `linked to ${link.title} on AniList, but AniList isn’t connected: `, h('a', { href: 'options.html#trackers', text: 'connect it' }));
  }
  const data = tracking?.data;
  const entry = data?.entry;
  const facts: (string | HTMLElement)[] = [];
  if (!data) facts.push(tracking?.error ?? 'loading from AniList…');
  else if (!entry) facts.push('not on your list yet');
  else {
    facts.push(h('strong', { text: STATUS_LABELS[entry.status] }));
    facts.push(`ch ${entry.progress}${data.media.chapters ? ` / ${data.media.chapters}` : ''}`);
    if (entry.score) facts.push(`★ ${entry.score}/${ANILIST_SCORE_RANGE[data.scoreFormat].max}`);
    if (entry.notes) facts.push(h('span', { class: 'tracker-notes', title: entry.notes, text: `“${entry.notes}”` }));
  }
  const updated = entry?.updatedAt ? h('span', { class: 'hint', title: new Date(entry.updatedAt).toLocaleString(), text: `updated ${timeAgo(entry.updatedAt)}` }) : undefined;
  const edit = iconButton('edit', 'edit your AniList entry', 'row-icon', () => openAnilistEditor(link), true);
  edit.disabled = !data;
  return h(
    'div',
    { class: 'tracker-card' },
    anilistMark(),
    h(
      'div',
      { class: 'tracker-body' },
      h('div', { class: 'tracker-head' }, h('a', { href: `https://anilist.co/manga/${link.id}`, target: '_blank', rel: 'noopener', text: `${link.title} ↗` }), updated),
      h('div', { class: `tracker-facts${tracking?.error && !data ? ' error' : ''}` }, ...facts.flatMap((f, i) => (i ? [' · ', f] : [f]))),
    ),
    edit,
  );
}

/** Status, chapters, score and notes on AniList, plus unlinking. Only changed fields are saved. */
function openAnilistEditor(link: { id: number; title: string }): void {
  const data = tracking?.data;
  if (!data) return;
  const entry = data.entry;
  const range = ANILIST_SCORE_RANGE[data.scoreFormat];

  const status = h('select', {}, ...(Object.keys(STATUS_LABELS) as AnilistStatus[]).map((s) => h('option', { value: s, text: STATUS_LABELS[s] })));
  status.value = entry?.status ?? 'PLANNING';
  const progress = h('input', { type: 'number', min: '0', step: '1', ...(data.media.chapters ? { max: String(data.media.chapters) } : {}) });
  progress.value = String(entry?.progress ?? 0);
  const score = h('input', { type: 'number', min: '0', max: String(range.max), step: String(range.step), placeholder: 'no score' });
  score.value = entry?.score ? String(entry.score) : '';
  const notes = h('textarea', { rows: '3', placeholder: 'only you see these, on AniList', maxlength: '2000' });
  notes.value = entry?.notes ?? '';
  const message = h('p', { class: 'error', role: 'alert' });
  message.hidden = true;
  const save = h('button', { class: 'primary', type: 'submit', text: entry ? 'save' : 'add to your list' });
  const close = h('button', { class: 'icon-button', type: 'button', 'aria-label': 'close', text: '✕' });

  const form = h(
    'form',
    { class: 'anilist-editor' },
    h(
      'div',
      { class: 'field-row' },
      h('label', { class: 'field grow' }, 'status', status),
      h('label', { class: 'field' }, data.media.chapters ? `chapters (of ${data.media.chapters})` : 'chapters read', progress),
      h('label', { class: 'field' }, `score (out of ${range.max})`, score),
    ),
    h('label', { class: 'field' }, 'notes', notes),
    message,
    h(
      'div',
      { class: 'editor-actions' },
      button('unlink from AniList', 'link danger-text', async () => {
        dialog.close();
        await linkAnilist(null);
      }, 'stop copying progress to this entry; the entry stays on your AniList list'),
      save,
    ),
  );
  const dialog = h('dialog', { class: 'add-dialog', 'aria-label': 'your AniList entry' }, h('header', { class: 'dialog-head' }, h('h2', { text: link.title }), close), form);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const changes: AnilistChanges = {};
    if (!entry || status.value !== entry.status) changes.status = status.value as AnilistStatus;
    if (!entry || Number(progress.value) !== entry.progress) changes.progress = Math.max(0, Math.floor(Number(progress.value) || 0));
    const scored = score.value === '' ? 0 : Number(score.value);
    if (scored !== (entry?.score ?? 0)) changes.score = Math.min(range.max, Math.max(0, scored));
    if (notes.value !== (entry?.notes ?? '')) changes.notes = notes.value;
    if (!Object.keys(changes).length) return dialog.close();
    save.disabled = true;
    save.textContent = 'saving…';
    try {
      const saved = await send<AnilistTracking['entry']>({ type: 'anilistSave', mediaId: link.id, changes });
      tracking = { mediaId: link.id, data: { ...data, entry: saved } };
      dialog.close();
      toast('saved on AniList.');
      render();
    } catch (err) {
      message.textContent = errorMessage(err);
      message.hidden = false;
      save.disabled = false;
      save.textContent = entry ? 'save' : 'add to your list';
    }
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  status.focus();
}

/** The AniList mark (as on the "tracking on AniList" chip) with a plus: link this series there. */
function trackButton(): HTMLButtonElement {
  const label = 'track on AniList: copy your progress to your AniList list as you read';
  const el = button('', 'secondary icon-only track-button', openAnilistPicker, label);
  el.setAttribute('aria-label', label);
  el.append(anilistMark(), h('span', { class: 'track-plus', 'aria-hidden': 'true', text: '+' }));
  return el;
}

function anilistMark(): HTMLElement {
  return h('span', { class: 'tracker-mark', 'aria-hidden': 'true', text: 'AL' });
}

async function linkAnilist(media: Pick<AnilistMedia, 'id' | 'title'> | null): Promise<void> {
  try {
    item = await send<LibraryItem>({ type: 'anilistLink', id: seriesId, media });
    refreshTracking();
    toast(media ? `linked to ${media.title} on AniList.` : 'unlinked from AniList.');
  } catch (err) {
    toast(errorMessage(err), { error: true });
  }
  render();
}

/** Search AniList for the series (its title to start with) and pick the matching entry. */
function openAnilistPicker(): void {
  const input = h('input', { type: 'search', 'aria-label': 'search AniList' });
  input.value = item!.entry.series.title;
  const results = h('ul', { class: 'configs anilist-results', 'aria-live': 'polite' });
  const message = h('p', { class: 'hint' });
  const close = h('button', { class: 'icon-button', type: 'button', 'aria-label': 'close', text: '✕' });
  const form = h('form', { class: 'search-form' }, input, h('button', { class: 'primary', type: 'submit', text: 'search' }));
  const dialog = h('dialog', { class: 'add-dialog', 'aria-label': 'track on AniList' }, h('header', { class: 'dialog-head' }, h('h2', { text: 'track on AniList' }), close), form, message, results);

  const search = async () => {
    message.textContent = 'searching…';
    results.replaceChildren();
    try {
      const found = await send<AnilistMedia[]>({ type: 'anilistSearch', query: input.value.trim() });
      message.textContent = found.length ? '' : 'nothing on AniList matches. try another title.';
      results.replaceChildren(
        ...found.map((media) => {
          const cover = media.cover ? h('img', { class: 'anilist-cover', src: media.cover, alt: '' }) : h('span', { class: 'anilist-cover blank' });
          const meta = [media.format?.toLowerCase().replace('_', ' '), media.year, media.chapters ? `${media.chapters} chapters` : undefined].filter(Boolean).join(' · ');
          return h(
            'li',
            {},
            cover,
            h('div', { class: 'config-info' }, h('strong', { text: media.title }), h('span', { class: 'hint' }, meta, meta ? ' · ' : '', h('a', { href: media.siteUrl, target: '_blank', rel: 'noopener', text: 'view ↗' }))),
            h('div', { class: 'config-actions' }, button('link', 'primary small', async () => {
              dialog.close();
              await linkAnilist({ id: media.id, title: media.title });
            })),
          );
        }),
      );
    } catch (err) {
      message.textContent = errorMessage(err);
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void search();
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  void search();
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
    if (first) list.push(readButton('start reading', first, 'primary'));
    list.push(button('add to library', first ? 'secondary' : 'primary', addToLibrary));
    return list;
  }
  const { entry, next, unread } = item;
  const list: HTMLElement[] = [];
  if (next) {
    list.push(readButton(!entry.readUpTo ? 'start reading' : unread ? 'continue reading' : 'read again', next, 'primary'));
  }
  // Everything but reading is an icon, named by its tooltip and accessible label.
  const check = iconButton('refresh', checking ? 'checking for new chapters…' : 'check for new chapters', `secondary icon-only${checking ? ' spinning' : ''}`, checkNow, true);
  check.disabled = checking;
  list.push(check);
  if (anilist?.user && !entry.trackers?.anilist) list.push(trackButton());
  list.push(
    iconButton('trash', 'remove from library', 'secondary icon-only danger-text', () => {
      confirmingRemove = true;
      render();
      app.querySelector<HTMLElement>('.confirm-remove button')?.focus();
    }, true),
  );
  return list;
}

/** "continue reading" and the like: the chapter it opens is in the tooltip, not the label. */
function readButton(label: string, chapter: ChapterRef, className: string): HTMLButtonElement {
  const el = iconButton('play', label, `${className} read-next`, () => openChapter(chapter));
  el.title = `${label}: ${chapter.title}`;
  return el;
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
      iconButton('trash', 'remove', 'destructive', removeFromLibrary),
    ),
  );
}

async function removeFromLibrary(): Promise<void> {
  const removed = item!.entry;
  for (const b of Array.from(app.querySelectorAll<HTMLButtonElement>('.confirm-remove button'))) b.disabled = true;
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
  const sort = iconButton(newestFirst ? 'newest' : 'oldest', newestFirst ? 'newest first: show oldest first' : 'oldest first: show newest first', 'secondary icon-only', () => {
    newestFirst = !newestFirst;
    limit = CHUNK;
    render();
  }, true);

  const next = item?.unread ? item.next : undefined;
  const tools: HTMLElement[] = [search, sort];
  if (next) tools.push(iconButton('jump', 'jump to up next', 'secondary icon-only', () => jumpTo(next.url), true));
  if (item && chapters.length) {
    const allRead = item.unread === 0;
    tools.push(
      iconButton(allRead ? 'undo' : 'checkAll', allRead ? 'mark all unread' : 'mark all read', 'secondary icon-only', () => setProgress(allRead ? null : chapters.at(-1)!.url, true), true),
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
    ? iconButton('undo', 'mark this and later chapters unread', 'row-icon', () => setProgress(entry.chapters[index - 1]?.url ?? null), true)
    : iconButton('check', 'mark this and earlier chapters read', 'row-icon', () => setProgress(chapter.url), true);
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
  if (area === 'local' && (LIBRARY_CHANGED_KEY in changes || ANILIST_KEY in changes) && !confirmingRemove) void load();
});

load().catch((err) => {
  app.replaceChildren(h('p', { class: 'error', text: errorMessage(err) }));
});

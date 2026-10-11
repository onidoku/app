import { browseUrl, configOrigins, type BrowseKind, type SiteConfig } from '@onidoku/core';
import { button, h } from './dom';
import { CONFIGS_KEY, PAPERBACK_KEY, SETTINGS_KEY } from './keys';
import { DEFAULT_SETTINGS, errorMessage, send, type BrowseResult, type LibraryItem, type SearchHit, type Settings } from './messages';
import { resultTile, skeletonGrid } from './results';
import { SourcePicker } from './source-picker';
import { appNav, siteHome, sourceByline, sourceIcon } from './ui';

const RECENT_KEY = 'onidoku:recentSearches';
const RECENT_MAX = 8;

/** A text search, or every title by an author / in a genre (opened from a series' details). */
type Mode = { kind: 'query' } | { kind: BrowseKind; name: string };

type SourceState =
  | { status: 'loading' }
  | { status: 'done'; hits: SearchHit[] }
  | { status: 'error'; error: string }
  | { status: 'no-access' };

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

let configs: SiteConfig[] = [];
let settings: Settings = { ...DEFAULT_SETTINGS };
/** Whether the user has granted access to each source's site. Kept current so submit can request access synchronously. */
let access = new Map<string, boolean>();
let query = '';
let mode: Mode = params.get('author')
  ? { kind: 'authors', name: params.get('author')! }
  : params.get('genre')
    ? { kind: 'genres', name: params.get('genre')! }
    : { kind: 'query' };
/** Library series, for the author/genre links some sources need (see linkFor). */
let library: LibraryItem[] = [];
/** The source tab shown. Until the user picks one, it follows the first source with results. */
let tab = params.get('source') ?? '';
let picked = Boolean(tab);
let states = new Map<string, SourceState>();
/** Bumped per search so late answers from an older search are dropped. */
let generation = 0;

const input = h('input', { type: 'search', name: 'q', placeholder: 'search titles on your sources', 'aria-label': 'search', value: params.get('q') ?? '', autocomplete: 'off' });
const notesEl = h('p', { class: 'hint' });
const recentEl = h('div', { class: 'recent' });
const picker = new SourcePicker('sources', (id) => selectTab(id));
const resultsEl = h('div', { class: 'results', role: 'tabpanel' });
const layoutEl = h('div', { class: 'browse' }, picker.el, h('section', { class: 'browse-main' }, resultsEl));
const emptyEl = h('div', { class: 'results' });
const modeEl = h('div', { class: 'mode-pill' });

/** Sources the user can search: those with a search section, minus 18+ ones unless enabled. */
const searchable = () => configs.filter((c) => c.search && (settings.showNsfw || !c.nsfw));

/** Sources that can list this author's / genre's titles. */
function listable(kind: BrowseKind, name: string): SiteConfig[] {
  return configs.filter((c) => (settings.showNsfw || !c.nsfw) && browseUrl(c, kind, name, linkFor(c.id, kind, name)));
}

/** The sources the current mode runs on. */
const targets = () => (mode.kind === 'query' ? searchable() : listable(mode.kind, mode.name));

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Where a name linked to on this source's series pages, for configs whose list URL is `{url}`. */
function linkFor(siteId: string, kind: BrowseKind, name: string): string | undefined {
  for (const { entry } of library) {
    if (entry.series.siteId !== siteId) continue;
    const links = entry.series.links?.[kind] ?? {};
    const key = Object.keys(links).find((n) => sameName(n, name));
    if (key) return links[key];
  }
  return undefined;
}

/** "titles by SIU" / "Fantasy titles", for headings and empty states. */
function describe(): string {
  if (mode.kind === 'authors') return `titles by ${mode.name}`;
  if (mode.kind === 'genres') return `${mode.name} titles`;
  return `“${query}”`;
}

function skeleton(): void {
  const form = h('form', { class: 'search-form', role: 'search' }, input, h('button', { class: 'primary', type: 'submit', text: 'search' }));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    mode = { kind: 'query' };
    picked = false;
    // Must happen before any await: browsers only show the permission prompt during the submit.
    void run(text, requestMissing(searchable()));
  });

  // "/" focuses the search box from anywhere on the page, like most sites.
  document.addEventListener('keydown', (event) => {
    if (event.key === '/' && document.activeElement !== input) {
      event.preventDefault();
      input.focus();
      input.select();
    }
  });

  app.removeAttribute('aria-busy');
  app.replaceChildren(appNav('search'), h('header', { class: 'page-head' }, h('h1', { text: 'search' })), form, modeEl, recentEl, notesEl, layoutEl, emptyEl);
}

/** Asks for access to every listed source not yet allowed. Call before any await in a click/submit. */
function requestMissing(sources: SiteConfig[]): Promise<boolean> {
  const missing = sources.filter((c) => !access.get(c.id));
  return missing.length
    ? chrome.permissions.request({ origins: [...new Set(missing.flatMap(configOrigins))] }).catch(() => false)
    : Promise.resolve(true);
}

/** The "Titles by author: SIU ×" banner shown while listing an author or genre. */
function renderMode(): void {
  modeEl.hidden = mode.kind === 'query';
  if (mode.kind === 'query') return modeEl.replaceChildren();
  const { kind, name } = mode;
  const sources = listable(kind, name);
  const allowAll = sources.some((c) => !access.get(c.id))
    ? button('allow all and load', 'link', () => void startBrowse(kind, name, requestMissing(sources)))
    : undefined;
  modeEl.replaceChildren(
    h('span', { class: 'kicker', text: kind === 'authors' ? 'author' : 'genre' }),
    h('strong', { text: name }),
    h('span', { class: 'hint', text: `all ${describe()} on your sources` }),
    allowAll ?? '',
    button('×', 'chip-remove', () => {
      mode = { kind: 'query' };
      query = '';
      states = new Map();
      tab = '';
      picked = false;
      syncUrl();
      void load();
      input.focus();
    }, 'back to text search'),
  );
}

async function load(): Promise<void> {
  [configs, settings, library] = await Promise.all([
    send<SiteConfig[]>({ type: 'listConfigs' }),
    send<Settings>({ type: 'settings' }),
    send<LibraryItem[]>({ type: 'library' }),
  ]);
  await refreshAccess();
  renderMode();
  renderRecent();

  const notes: (string | Node)[] = [];
  if (mode.kind !== 'query') {
    const { kind, name } = mode;
    const count = listable(kind, name).length;
    const noun = kind === 'authors' ? 'author' : 'genre';
    const missing = configs.filter((c) => (settings.showNsfw || !c.nsfw) && !listable(kind, name).includes(c)).length;
    if (count) notes.push(`listing from ${count} source${count === 1 ? '' : 's'}. `);
    if (missing) notes.push(`${missing} source${missing === 1 ? ' can’t' : 's can’t'} list titles by ${noun}.`);
    notesEl.replaceChildren(...notes);
    render();
    return;
  }
  const usable = searchable();
  const hiddenNsfw = configs.filter((c) => c.search && c.nsfw && !settings.showNsfw).length;
  const noSearch = configs.filter((c) => !c.search).length;
  if (!configs.length) notes.push('no sources installed. ', h('a', { href: 'options.html#add', text: 'add a source' }), ' to search it.');
  else if (usable.length) notes.push(`searching ${usable.length} source${usable.length === 1 ? '' : 's'}. `);
  if (hiddenNsfw) notes.push(`${hiddenNsfw} 18+ source${hiddenNsfw === 1 ? ' is' : 's are'} hidden (`, h('a', { href: 'options.html', text: 'change' }), '). ');
  if (noSearch) notes.push(`${noSearch} source${noSearch === 1 ? ' has' : 's have'} no search in ${noSearch === 1 ? 'its' : 'their'} config.`);
  notesEl.replaceChildren(...notes);
  render();
}

async function refreshAccess(): Promise<void> {
  const entries = await Promise.all(
    configs.map(async (c) => [c.id, await chrome.permissions.contains({ origins: configOrigins(c) })] as const),
  );
  access = new Map(entries);
}

// ---- Searching ---------------------------------------------------------------------------

async function run(text: string, granted: Promise<boolean>): Promise<void> {
  query = text;
  rememberSearch(text);
  renderMode();
  await start(granted);
}

async function startBrowse(kind: BrowseKind, name: string, granted: Promise<boolean>): Promise<void> {
  mode = { kind, name };
  query = '';
  input.value = '';
  renderMode();
  await start(granted);
}

/** Runs the current mode on every target source at once; each fills in as it answers. */
async function start(granted: Promise<boolean>): Promise<void> {
  const current = ++generation;
  syncUrl();
  await granted;
  await refreshAccess();
  renderMode();
  const sources = targets();
  states = new Map(sources.map((c) => [c.id, access.get(c.id) ? { status: 'loading' } : { status: 'no-access' }]));
  if (!states.has(tab)) picked = false;
  render();
  await Promise.all(sources.filter((c) => access.get(c.id)).map((c) => searchSource(c, current)));
}

async function searchSource(config: SiteConfig, current: number): Promise<void> {
  states.set(config.id, { status: 'loading' });
  render();
  let state: SourceState;
  try {
    const hits =
      mode.kind === 'query'
        ? await send<SearchHit[]>({ type: 'search', siteId: config.id, query })
        : (await send<BrowseResult>({ type: 'browse', siteId: config.id, kind: mode.kind, name: mode.name, link: linkFor(config.id, mode.kind, mode.name) })).hits;
    state = { status: 'done', hits };
  } catch (err) {
    state = { status: 'error', error: errorMessage(err) };
  }
  if (current !== generation) return; // a newer search replaced this one
  states.set(config.id, state);
  render();
}

async function allowAndSearch(config: SiteConfig): Promise<void> {
  if (!(await chrome.permissions.request({ origins: configOrigins(config) }))) return;
  access.set(config.id, true);
  await searchSource(config, generation);
}

// ---- Rendering ---------------------------------------------------------------------------

function render(): void {
  if (mode.kind === 'query' && !query) {
    layoutEl.hidden = true;
    emptyEl.replaceChildren(...emptyState());
    return;
  }
  const sources = targets().filter((c) => states.has(c.id));
  layoutEl.hidden = !sources.length;
  if (!sources.length) {
    emptyEl.replaceChildren(h('p', { class: 'hint', text: mode.kind === 'query' ? 'no sources to search.' : `none of your sources can list ${describe()}.` }));
    return;
  }
  emptyEl.replaceChildren();
  if (!picked) tab = autoTab(sources);
  layoutEl.classList.toggle('single', sources.length < 2);
  renderTabs();
  resultsEl.replaceChildren(...sourceTab(sources.find((c) => c.id === tab) ?? sources[0]!));
}

/** The first source with results; else the first still searching; else the first. */
function autoTab(sources: SiteConfig[]): string {
  const withHits = sources.find((c) => {
    const s = states.get(c.id)!;
    return s.status === 'done' && s.hits.length > 0;
  });
  return (withHits ?? sources.find((c) => states.get(c.id)!.status === 'loading') ?? sources[0]!).id;
}

/** The sidebar, with each source's result count (or that it's still searching, or failed). */
function renderTabs(): void {
  const sources = targets().filter((c) => states.has(c.id));
  picker.update(
    sources.map((config) => {
      const state = states.get(config.id)!;
      const extra =
        state.status === 'done'
          ? countBadge(state.hits.length, false)
          : state.status === 'loading'
            ? countBadge(undefined, true)
            : h('span', { class: 'tab-alert', text: '!', title: state.status === 'error' ? state.error : 'needs access' });
      return { config, extra, failing: state.status === 'error' || state.status === 'no-access' };
    }),
    tab,
  );
}

function countBadge(count: number | undefined, loading: boolean): HTMLElement {
  return loading ? h('span', { class: 'spinner', 'aria-label': 'searching' }) : h('span', { class: 'count', text: String(count ?? 0) });
}

function selectTab(id: string): void {
  tab = id;
  picked = true;
  syncUrl();
  render();
  window.scrollTo({ top: 0 });
}

function sourceTab(config: SiteConfig): HTMLElement[] {
  const state = states.get(config.id) ?? { status: 'loading' };
  const head = h(
    'header',
    { class: 'source-head' },
    sourceIcon(config, 28),
    h('div', {}, h('h2', { text: config.name }), h('span', { class: 'hint', text: sourceByline(config) })),
    h('a', { class: 'see-all', href: siteHome(config), target: '_blank', rel: 'noopener', text: config.server ? 'open server ↗' : 'open site ↗' }),
  );
  const body: (HTMLElement | undefined)[] = [];
  if (state.status === 'loading') body.push(skeletonGrid(8));
  else if (state.status === 'no-access' || state.status === 'error') body.push(h('div', { class: 'empty' }, statusText(config, state)));
  else if (!state.hits.length) body.push(h('div', { class: 'empty' }, h('p', { text: `no ${describe()} on ${config.name}.` })));
  else body.push(h('p', { class: 'hint', text: `${state.hits.length} result${state.hits.length === 1 ? '' : 's'}` }), h('ul', { class: 'tiles' }, ...state.hits.map((hit) => resultTile(config, hit))));
  return [h('section', { class: 'result-group single' }, head, ...body.filter((el): el is HTMLElement => Boolean(el)))];
}

function statusText(config: SiteConfig, state: SourceState): HTMLElement {
  switch (state.status) {
    case 'loading':
      return h('span', { class: 'hint', text: 'searching…' });
    case 'done':
      return h('span', { class: 'hint', text: state.hits.length ? `${state.hits.length} result${state.hits.length === 1 ? '' : 's'}` : 'no results' });
    case 'error':
      return h('span', { class: 'error-inline' }, h('span', { text: state.error }), button('retry', 'link', () => searchSource(config, generation)));
    case 'no-access':
      return h('span', { class: 'hint' }, 'needs access to the site. ', button('allow and search', 'link', () => allowAndSearch(config)));
  }
}

function emptyState(): HTMLElement[] {
  const usable = searchable();
  if (!usable.length) return [];
  return [
    h(
      'div',
      { class: 'source-chips' },
      h('span', { class: 'hint', text: 'sources: ' }),
      ...usable.map((c) => h('span', { class: 'chip' }, sourceIcon(c, 14), c.name)),
    ),
  ];
}


function syncUrl(): void {
  const search = new URLSearchParams();
  if (mode.kind === 'authors') search.set('author', mode.name);
  else if (mode.kind === 'genres') search.set('genre', mode.name);
  else if (query) search.set('q', query);
  if (picked && tab) search.set('source', tab);
  history.replaceState(null, '', search.size ? `?${search}` : location.pathname);
}

// ---- Recent searches (this browser only) ------------------------------------------------

function recentSearches(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Storage blocked: recent searches are a convenience only.
  }
}

function rememberSearch(text: string): void {
  saveRecent([text, ...recentSearches().filter((s) => s.toLowerCase() !== text.toLowerCase())].slice(0, RECENT_MAX));
  renderRecent();
}

function renderRecent(): void {
  const list = recentSearches();
  recentEl.hidden = !list.length;
  recentEl.replaceChildren(
    h('span', { class: 'hint', text: 'recent:' }),
    ...list.map((text) => {
      const chip = h('span', { class: 'chip recent-chip' });
      const use = button(text, 'chip-text', () => {
        input.value = text;
        input.form?.requestSubmit();
      });
      const remove = button('×', 'chip-remove', () => {
        saveRecent(recentSearches().filter((s) => s !== text));
        renderRecent();
      }, `forget “${text}”`);
      chip.append(use, remove);
      return chip;
    }),
    button('clear', 'link', () => {
      saveRecent([]);
      renderRecent();
    }),
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (CONFIGS_KEY in changes || PAPERBACK_KEY in changes || SETTINGS_KEY in changes)) void load();
});
chrome.permissions.onAdded.addListener(() => void refreshAccess());
chrome.permissions.onRemoved.addListener(() => void refreshAccess());

skeleton();
load()
  .then(() => {
    // Deep links (?q=…, ?author=…, ?genre=…) run right away, but only on sources already allowed:
    // there's no click to show a permission prompt from. The others offer "Allow and search".
    if (mode.kind !== 'query') void startBrowse(mode.kind, mode.name, Promise.resolve(false));
    else if (input.value.trim()) void run(input.value.trim(), Promise.resolve(false));
    else input.focus();
  })
  .catch((err) => emptyEl.replaceChildren(h('p', { class: 'error', text: errorMessage(err) })));

// Explore: browse each source's own lists (popular, latest, …) without searching first.
import { configOrigins, type SiteConfig } from '@onidoku/core';
import { button, h } from './dom';
import { CONFIGS_KEY, PAPERBACK_KEY, SERVERS_KEY } from './keys';
import { errorMessage, send, type ExploreResult, type SearchHit } from './messages';
import { resultTile, skeletonGrid } from './results';
import { SourcePicker } from './source-picker';
import { appNav, nsfwTag, siteHome, sourceByline, sourceIcon } from './ui';

/** Everything loaded so far for one source's list; kept so switching back is instant. */
interface ListState {
  hits: SearchHit[];
  /** Last page loaded; 0 before the first. */
  page: number;
  hasMore: boolean;
  loading: boolean;
  error?: string;
}

const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);

let configs: SiteConfig[] = [];
let access = new Map<string, boolean>();
let source = params.get('source') ?? '';
let list = Number(params.get('list')) || 0;
const lists = new Map<string, ListState>();

const notesEl = h('p', { class: 'hint' });
const picker = new SourcePicker('sources', (id) => id !== source && select(id, 0));
const layoutEl = h('div', { class: 'browse' });
const headEl = h('header', { class: 'source-head explore-head' });
const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'lists' });
const resultsEl = h('div', { class: 'results', role: 'tabpanel' });
const moreEl = h('div', { class: 'load-more' });

/** Sources with explore lists, 18+ ones included: the "show 18+" setting only applies to search. */
const explorable = () => configs.filter((c) => c.explore);
const current = () => explorable().find((c) => c.id === source);
const keyOf = (siteId: string, index: number) => `${siteId}#${index}`;

function skeleton(): void {
  app.removeAttribute('aria-busy');
  app.replaceChildren(
    appNav('explore'),
    h('header', { class: 'page-head' }, h('div', {}, h('h1', { text: 'explore' }), h('span', { class: 'hint', text: 'browse titles straight from your sources.' }))),
    notesEl,
    layoutEl,
  );
  layoutEl.append(picker.el, h('section', { class: 'browse-main' }, headEl, tabsEl, resultsEl, moreEl));
  // Load the next page when the "Load more" row scrolls into view.
  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) void loadMore(false);
  }, { rootMargin: '400px' }).observe(moreEl);
}

async function load(): Promise<void> {
  configs = await send<SiteConfig[]>({ type: 'listConfigs' });
  const entries = await Promise.all(configs.map(async (c) => [c.id, await chrome.permissions.contains({ origins: configOrigins(c) })] as const));
  access = new Map(entries);

  const sources = explorable();
  if (!current()) source = sources[0]?.id ?? '';
  if (list >= (current()?.explore?.length ?? 0)) list = 0;

  const notes: (string | Node)[] = [];
  const without = configs.filter((c) => !c.explore).length;
  if (!configs.length) notes.push('no sources installed. ', h('a', { href: 'options.html#add', text: 'add a source' }), ' to explore it.');
  else if (!sources.length) notes.push('none of your sources has lists to explore yet. try ', h('a', { href: 'search.html', text: 'search' }), ' instead.');
  if (sources.length && without) notes.push(`${without} source${without === 1 ? ' has' : 's have'} no explore lists in ${without === 1 ? 'its' : 'their'} config.`);
  notesEl.replaceChildren(...notes);
  notesEl.hidden = !notes.length;

  render();
  if (access.get(source)) void loadMore(false);
}

// ---- Loading -----------------------------------------------------------------------------

/** Loads the next page of the selected list. `user` is true when a click asked for it. */
async function loadMore(user: boolean): Promise<void> {
  const config = current();
  if (!config) return;
  const key = keyOf(config.id, list);
  const state = lists.get(key) ?? { hits: [], page: 0, hasMore: true, loading: false };
  lists.set(key, state);
  if (state.loading || !state.hasMore || (state.error && !user) || !access.get(config.id)) return;
  state.loading = true;
  state.error = undefined;
  render();
  try {
    const result = await send<ExploreResult>({ type: 'explore', siteId: config.id, list, page: state.page + 1 });
    const seen = new Set(state.hits.map((hit) => hit.url));
    const fresh = result.hits.filter((hit) => !seen.has(hit.url));
    state.hits.push(...fresh);
    state.page += 1;
    // Sites that ignore the page number repeat page 1; stop instead of looping.
    state.hasMore = result.hasMore && fresh.length > 0;
  } catch (err) {
    state.error = errorMessage(err);
  }
  state.loading = false;
  if (lists.get(keyOf(source, list)) !== state) return;
  render();
  // The observer only fires on changes: keep going while the end of the list is still on screen.
  if (state.hasMore && !state.error && moreEl.getBoundingClientRect().top < innerHeight + 400) void loadMore(false);
}

async function allow(config: SiteConfig): Promise<void> {
  if (!(await chrome.permissions.request({ origins: configOrigins(config) }))) return;
  access.set(config.id, true);
  await loadMore(true);
}

function select(siteId: string, index: number): void {
  source = siteId;
  list = index;
  const search = new URLSearchParams({ source });
  if (list) search.set('list', String(list));
  history.replaceState(null, '', `?${search}`);
  render();
  window.scrollTo({ top: 0 });
  void loadMore(false);
}

// ---- Rendering ---------------------------------------------------------------------------

function render(): void {
  const sources = explorable();
  layoutEl.hidden = !sources.length;
  layoutEl.classList.toggle('single', sources.length < 2);
  picker.update(sources.map((config) => ({ config })), source);

  const config = current();
  headEl.hidden = tabsEl.hidden = moreEl.hidden = !config;
  if (!config) {
    resultsEl.replaceChildren();
    return;
  }
  headEl.replaceChildren(
    sourceIcon(config, 32),
    h('div', {}, h('h2', {}, config.name, config.nsfw ? nsfwTag() : undefined), h('span', { class: 'hint', text: sourceByline(config) })),
    h('a', { class: 'see-all', href: siteHome(config), target: '_blank', rel: 'noopener', text: config.server ? 'open server ↗' : 'open site ↗' }),
  );

  const explore = config.explore ?? [];
  tabsEl.hidden = explore.length < 2;
  tabsEl.replaceChildren(
    ...explore.map((spec, i) => {
      const el = h('button', { type: 'button', role: 'tab', class: 'tab', 'aria-selected': String(i === list), text: spec.name });
      el.addEventListener('click', () => i !== list && select(config.id, i));
      return el;
    }),
  );

  const state = lists.get(keyOf(config.id, list));
  if (!access.get(config.id)) {
    resultsEl.replaceChildren(
      h('div', { class: 'empty' }, h('p', { text: `onidoku needs access to ${config.name} to list its titles.` }), button(`allow access to ${config.name}`, 'primary', () => allow(config))),
    );
    moreEl.replaceChildren();
    return;
  }
  if (!state || (!state.hits.length && state.loading)) {
    resultsEl.replaceChildren(skeletonGrid(12));
    moreEl.replaceChildren();
    return;
  }
  resultsEl.replaceChildren(
    state.hits.length
      ? h('ul', { class: 'tiles' }, ...state.hits.map((hit) => resultTile(config, hit)))
      : h('div', { class: 'empty' }, h('p', { text: state.error ? 'couldn’t load this list.' : `nothing listed on ${config.name} here.` })),
  );
  moreEl.replaceChildren(
    state.error
      ? h('span', { class: 'error-inline' }, h('span', { text: state.error }), button('retry', 'link', () => loadMore(true)))
      : state.loading
        ? h('span', { class: 'hint' }, h('span', { class: 'spinner' }), ' loading more…')
        : state.hasMore
          ? button('load more', 'secondary', () => loadMore(true))
          : state.hits.length
            ? h('span', { class: 'hint', text: `${state.hits.length} title${state.hits.length === 1 ? '' : 's'} · end of list` })
            : '',
  );
}


chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (CONFIGS_KEY in changes || SERVERS_KEY in changes || PAPERBACK_KEY in changes)) {
    lists.clear();
    void load();
  }
});

skeleton();
load().catch((err) => resultsEl.replaceChildren(h('p', { class: 'error', text: errorMessage(err) })));
// Paperback sources whose explore lists couldn't be read at install (e.g. blocked by Cloudflare
// then) get another try; the list re-renders when they arrive (storage change above).
void send({ type: 'refreshExplore' }).catch(() => undefined);

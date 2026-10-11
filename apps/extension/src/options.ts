import { configOrigins, paperbackConfigId, paperbackFiles, parseServer, parseSiteConfig, SERVER_NAMES, type PaperbackListing, type PaperbackRepo, type ServerKind, type SiteConfig } from '@onidoku/core';
import { button, h } from './dom';
import { ALL_SITES, errorMessage, send, type LibraryItem, type ServerSummary, type Settings } from './messages';
import { CONFIGS_KEY, LIBRARY_CHANGED_KEY, PAPERBACK_KEY, SERVERS_KEY, SETTINGS_KEY } from './keys';
import { appNav, nsfwTag, sourceIcon } from './ui';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const listEl = $('configs');
const serversEl = $('servers');
const paperbackEl = $('paperback');
const nsfwToggle = $<HTMLInputElement>('show-nsfw');
const detectToggle = $<HTMLInputElement>('detect-everywhere');
const readToggle = $<HTMLInputElement>('read-in-onidoku');
const sitesFilter = $<HTMLInputElement>('sites-filter');
const dialog = $<HTMLDialogElement>('add-dialog');
const dialogMessage = $('dialog-message');

/** Above this many sites the list gets a filter box. */
const FILTER_FROM = 7;
/** How long a status message stays up; errors stay until the next message. */
const TOAST_MS = 6000;

$('nav').replaceWith(appNav('options'));

/** The row whose Remove was clicked, waiting for confirmation. */
let confirming = '';
let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A status message at the bottom of the window, optionally with an action such as Undo. */
function show(message: string, isError = false, action?: HTMLElement): void {
  const toast = $('message');
  toast.replaceChildren(h('span', { text: message }), action ?? '');
  toast.className = isError ? 'toast error' : 'toast';
  toast.hidden = false;
  clearTimeout(toastTimer);
  if (!isError) toastTimer = setTimeout(() => (toast.hidden = true), action ? TOAST_MS * 2 : TOAST_MS);
}

/** Must be called before any other await in a click/submit handler: Chrome requires a user gesture. */
function requestAccess(config: SiteConfig): Promise<boolean> {
  return chrome.permissions.request({ origins: configOrigins(config) });
}

/** "Allow access" only where it's missing; nothing to say when it's granted. */
async function accessControl(config: SiteConfig): Promise<HTMLElement | undefined> {
  if (await chrome.permissions.contains({ origins: configOrigins(config) })) return undefined;
  return button('allow access', 'secondary small', async () => {
    if (await requestAccess(config)) await render();
  }, `lets onidoku read ${configOrigins(config).join(', ')} and check it for new chapters`);
}

// ---- Lists ------------------------------------------------------------------------------

async function render(): Promise<void> {
  const [all, servers, library] = await Promise.all([
    send<SiteConfig[]>({ type: 'listConfigs' }),
    send<ServerSummary[]>({ type: 'listServers' }),
    send<LibraryItem[]>({ type: 'library' }),
  ]);
  const usage = new Map<string, number>();
  for (const { entry } of library) usage.set(entry.series.siteId, (usage.get(entry.series.siteId) ?? 0) + 1);

  const sites = all.filter((c) => !c.server && !c.paperback);
  await renderServers(servers, all, usage);
  await renderSites(sites, usage);
  await renderPaperback(all.filter((c) => c.paperback), usage);
  renderFeatured(sites);
}

async function renderPaperback(configs: SiteConfig[], usage: Map<string, number>): Promise<void> {
  $('paperback-section').hidden = !__PAPERBACK__ && !configs.length;
  $('paperback-count').textContent = configs.length ? String(configs.length) : '';
  $('paperback-empty').hidden = configs.length > 0;
  const rows = await Promise.all(
    configs.map(async (config) => {
      const pb = config.paperback!;
      return row({
        id: config.id,
        icon: sourceIcon(config, 32),
        name: config.name,
        tags: [
          config.nsfw ? nsfwTag() : undefined,
          h('span', { class: 'tag', text: 'Paperback' }),
          config.explore ? h('span', { class: 'tag', text: 'explore' }) : undefined,
        ],
        meta: `${new URL(pb.site).host} · v${pb.version} · by ${config.developer} · from ${repoLabel(pb.repo)}`,
        detail: `${pb.repo} (${pb.sourceId})`,
        series: usage.get(config.id) ?? 0,
        access: await accessControl(config),
        removeNote: 'to undo, install it again from its repo.',
        remove: async () => {
          await send({ type: 'removeConfig', id: config.id });
          show(`removed ${config.name}.`);
        },
      });
    }),
  );
  paperbackEl.replaceChildren(...rows);
  paperbackEl.hidden = !rows.length;
}

/** A repo address without the noise: "someone.github.io/extensions/0.8". */
function repoLabel(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

async function renderServers(servers: ServerSummary[], configs: SiteConfig[], usage: Map<string, number>): Promise<void> {
  $('servers-count').textContent = servers.length ? String(servers.length) : '';
  $('servers-empty').hidden = servers.length > 0;
  const rows = await Promise.all(
    servers.map(async (server) => {
      const config = configs.find((c) => c.id === server.id);
      const host = new URL(server.url).host;
      return row({
        id: server.id,
        icon: sourceIcon(config, 32),
        name: server.name,
        tags: [h('span', { class: 'tag', text: SERVER_NAMES[server.kind] })],
        meta: `${host} · ${server.login === 'api-key' ? 'API key' : 'username and password'}`,
        series: usage.get(server.id) ?? 0,
        access: config ? await accessControl(config) : undefined,
        removeNote: 'its login isn’t kept: to undo, connect it again with the same address.',
        remove: async () => {
          await send({ type: 'removeServer', id: server.id });
          show(`removed ${server.name}.`);
        },
      });
    }),
  );
  serversEl.replaceChildren(...rows);
  serversEl.hidden = !rows.length;
}

async function renderSites(sites: SiteConfig[], usage: Map<string, number>): Promise<void> {
  $('sites-count').textContent = sites.length ? String(sites.length) : '';
  $('none').hidden = sites.length > 0;
  sitesFilter.hidden = sites.length < FILTER_FROM;
  const rows = await Promise.all(
    sites.map(async (config) =>
      row({
        id: config.id,
        icon: sourceIcon(config, 32),
        name: config.name,
        tags: [
          config.nsfw ? nsfwTag() : undefined,
          config.search ? h('span', { class: 'tag', text: 'search' }) : undefined,
          config.explore ? h('span', { class: 'tag', text: 'explore' }) : undefined,
        ],
        meta: `${new URL(config.series.url.replace(/\*/g, 'x')).host} · v${config.version} · by ${config.developer}`,
        detail: config.id,
        series: usage.get(config.id) ?? 0,
        access: await accessControl(config),
        remove: async () => {
          await send({ type: 'removeConfig', id: config.id });
          // The config itself is all a site source is, so it can come straight back.
          show(`removed ${config.name}.`, false, button('undo', 'link', () => install(config)));
        },
      }),
    ),
  );
  listEl.replaceChildren(...rows);
  applyFilter();
}

interface RowSpec {
  id: string;
  icon: HTMLElement;
  name: string;
  tags: (HTMLElement | undefined)[];
  meta: string;
  /** Shown on hover: the config id, for people writing sources. */
  detail?: string;
  /** Library series from this source. */
  series: number;
  access?: HTMLElement;
  /** Extra line in the removal confirmation. */
  removeNote?: string;
  remove: () => Promise<void>;
}

/** One source: what it is, how much of the library uses it, and Remove (confirmed in place). */
function row(spec: RowSpec): HTMLElement {
  const seriesText = spec.series ? `${spec.series} series in your library` : 'nothing in your library yet';
  const info = h(
    'div',
    { class: 'config-info' },
    h('div', { class: 'config-name' }, h('strong', { text: spec.name }), ...spec.tags.filter(Boolean)),
    h('span', { class: 'hint', text: `${spec.meta} · ${seriesText}`, title: spec.detail }),
  );
  const li = h('li', { 'data-id': spec.id, 'data-name': spec.name.toLowerCase() }, spec.icon, info);

  if (confirming === spec.id) {
    const keep = spec.series
      ? `its ${spec.series} series stay in your library, but can’t be read or updated until it’s back.`
      : 'nothing in your library uses it.';
    li.classList.add('confirming');
    li.append(
      h(
        'div',
        { class: 'confirm-remove', role: 'group', 'aria-label': `remove ${spec.name}?` },
        h('p', { class: 'hint', text: [keep, spec.removeNote].filter(Boolean).join(' ') }),
        h(
          'div',
          { class: 'config-actions' },
          button('cancel', 'secondary small', () => {
            confirming = '';
            void render();
          }),
          button(`remove ${spec.name}`, 'destructive small', async () => {
            confirming = '';
            try {
              await spec.remove();
            } catch (err) {
              show(errorMessage(err), true);
            }
            await render();
          }),
        ),
      ),
    );
  } else {
    li.append(
      h(
        'div',
        { class: 'config-actions' },
        spec.access,
        removeButton(spec),
      ),
    );
  }
  return li;
}

function removeButton(spec: RowSpec): HTMLElement {
  const el = button('remove', 'link danger-text', () => {
    confirming = spec.id;
    // Focus Cancel, so a stray Enter doesn't remove anything.
    void render().then(() => document.querySelector<HTMLElement>(`li[data-id="${CSS.escape(spec.id)}"] .confirm-remove button`)?.focus());
  });
  // Every row has a Remove: say which source it's for.
  el.setAttribute('aria-label', `remove ${spec.name}`);
  return el;
}

function applyFilter(): void {
  const needle = sitesFilter.value.trim().toLowerCase();
  let shown = 0;
  for (const li of Array.from(listEl.children) as HTMLElement[]) {
    const match = !needle || li.dataset.name!.includes(needle) || li.dataset.id!.includes(needle);
    li.hidden = !match;
    if (match) shown++;
  }
  $('sites-no-match').hidden = !needle || shown > 0;
}

sitesFilter.addEventListener('input', applyFilter);

const FEATURED = __FEATURED_CONFIGS__.map((raw) => parseSiteConfig(raw));

/** Suggested sources not installed yet; installing one asks for its site access in the same click. */
function renderFeatured(installed: SiteConfig[]): void {
  const available = FEATURED.filter((f) => !installed.some((c) => c.id === f.id));
  $('featured-section').hidden = !available.length;
  $('featured').replaceChildren(
    ...available.map((config) =>
      h(
        'li',
        {},
        sourceIcon(config, 32),
        h('div', { class: 'config-info' }, h('div', { class: 'config-name' }, h('strong', { text: config.name })), h('span', { class: 'hint', text: new URL(config.series.url.replace(/\*/g, 'x')).host })),
        h('div', { class: 'config-actions' }, button('install', 'primary small', () => install(config, requestAccess(config)))),
      ),
    ),
  );
}

/** Installs a site config; resolves to whether it worked (errors are shown). */
async function install(raw: unknown, accessRequest?: Promise<boolean>, report = show): Promise<boolean> {
  try {
    const config = await send<SiteConfig>({ type: 'installConfig', raw });
    // Don't wait on the access prompt: the row offers "Allow access" until it's granted
    // (permissions.onAdded re-renders the list then).
    void accessRequest?.catch(() => false);
    show(`installed ${config.name}.`);
    await render();
    return true;
  } catch (err) {
    report(errorMessage(err), true);
    return false;
  }
}

// ---- Add dialog -------------------------------------------------------------------------

type Panel = 'server' | 'url' | 'json' | 'paperback';

function openDialog(panel: Panel): void {
  selectPanel(panel);
  dialogError('');
  if (!dialog.open) dialog.showModal();
  dialog.querySelector<HTMLElement>(`.dialog-panel[data-panel="${panel}"] input:not([type=hidden]), .dialog-panel[data-panel="${panel}"] textarea`)?.focus();
}

function selectPanel(panel: Panel): void {
  for (const tab of Array.from(dialog.querySelectorAll<HTMLElement>('[role=tab]'))) tab.setAttribute('aria-selected', String(tab.dataset.panel === panel));
  for (const form of Array.from(dialog.querySelectorAll<HTMLElement>('.dialog-panel'))) form.hidden = form.dataset.panel !== panel;
  dialogError('');
}

/** Errors stay in the dialog, next to what caused them. */
function dialogError(message: string): void {
  dialogMessage.textContent = message;
  dialogMessage.hidden = !message;
}

function closeDialog(): void {
  dialog.close();
  if (location.hash) history.replaceState(null, '', location.pathname);
}

$('add-source').addEventListener('click', () => openDialog('server'));
$('add-server-open').addEventListener('click', () => openDialog('server'));
$('add-paperback-open').addEventListener('click', () => openDialog('paperback'));
$('paperback-tab').hidden = !__PAPERBACK__;
$('add-close').addEventListener('click', closeDialog);
for (const tab of Array.from(dialog.querySelectorAll<HTMLElement>('[role=tab]'))) {
  tab.addEventListener('click', () => openDialog(tab.dataset.panel as Panel));
}
// A click on the backdrop (outside the dialog box) closes it.
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) closeDialog();
});

// Links elsewhere can open the dialog directly: options.html#add, #add-server, #add-url, #add-json, #add-paperback.
function openFromHash(): void {
  const match = location.hash.match(/^#add(?:-(server|url|json|paperback))?$/);
  if (match) openDialog((match[1] as Panel | undefined) ?? 'server');
}
window.addEventListener('hashchange', openFromHash);
openFromHash();

$('from-url').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = $<HTMLInputElement>('url').value;
  dialogError('');
  let raw: unknown;
  try {
    // Works for hosts that send CORS headers (e.g. raw.githubusercontent.com); otherwise paste the JSON.
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    dialogError(`couldn't download the config: ${errorMessage(err)}`);
    return;
  }
  if (await install(raw, undefined, dialogError)) {
    ($('from-url') as HTMLFormElement).reset();
    closeDialog();
  }
});

const jsonInput = $<HTMLTextAreaElement>('json');
const jsonCheck = $('json-check');

/** Checks pasted JSON as it's typed, so mistakes show before Install. */
function checkJson(): SiteConfig | undefined {
  const text = jsonInput.value.trim();
  if (!text) {
    jsonCheck.textContent = '';
    return undefined;
  }
  try {
    const config = parseSiteConfig(JSON.parse(text));
    jsonCheck.className = 'hint ok';
    jsonCheck.textContent = `✓ ${config.name} (${config.id}, v${config.version})`;
    return config;
  } catch (err) {
    jsonCheck.className = 'hint error';
    jsonCheck.textContent = errorMessage(err);
    return undefined;
  }
}

jsonInput.addEventListener('input', () => {
  dialogError('');
  checkJson();
});

$('from-json').addEventListener('submit', async (event) => {
  event.preventDefault();
  const config = checkJson();
  if (!config) return void jsonInput.focus();
  // Ask for site access while the submit still counts as a user gesture.
  if (await install(JSON.parse(jsonInput.value), requestAccess(config), dialogError)) {
    ($('from-json') as HTMLFormElement).reset();
    jsonCheck.textContent = '';
    closeDialog();
  }
});

// ---- Media server form --------------------------------------------------------------------

const serverForm = $<HTMLFormElement>('add-server');
const field = (id: string) => $<HTMLInputElement>(id);
const kindSelect = $<HTMLSelectElement>('server-kind');

const KEY_HINTS: Record<ServerKind, string> = {
  komga: 'in Komga: your account menu → account settings → API keys (Komga 1.20 or later).',
  kavita: 'in Kavita: settings → your account → API key / auth keys.',
};

function syncServerForm(): void {
  const kind = kindSelect.value as ServerKind;
  $('server-key-hint').textContent = KEY_HINTS[kind];
  // Kavita apps log in with an API key only; Komga also accepts a username and password.
  $('komga-login').hidden = kind !== 'komga';
  field('server-url').placeholder = kind === 'komga' ? 'http://192.168.1.5:25600' : 'http://192.168.1.5:5000';
}

kindSelect.addEventListener('change', syncServerForm);
syncServerForm();

serverForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const kind = kindSelect.value as ServerKind;
  const raw = {
    kind,
    url: field('server-url').value,
    name: field('server-name').value,
    apiKey: field('server-key').value,
    ...(kind === 'komga' ? { username: field('server-user').value, password: field('server-password').value } : {}),
  };
  let origins: string[];
  try {
    origins = [`${new URL(parseServer(raw).url).origin}/*`];
  } catch (err) {
    dialogError(errorMessage(err).replace(/^Invalid server: (apiKey|url): /, ''));
    return;
  }
  // Must be the first await: browsers only show the permission prompt during the click.
  if (!(await chrome.permissions.request({ origins }).catch(() => false))) {
    dialogError('onidoku needs access to the server’s address to read from it.');
    return;
  }
  const submit = serverForm.querySelector<HTMLButtonElement>('button[type=submit]')!;
  submit.disabled = true;
  submit.textContent = 'connecting…';
  dialogError('');
  try {
    const { server, account } = await send<{ server: ServerSummary; account: string }>({ type: 'addServer', server: raw });
    serverForm.reset();
    syncServerForm();
    closeDialog();
    show(`connected to ${server.name} as ${account}. its series are now in search and explore.`);
    await render();
  } catch (err) {
    dialogError(errorMessage(err));
  } finally {
    submit.disabled = false;
    submit.textContent = 'connect';
  }
});


// ---- Paperback repos ----------------------------------------------------------------------

const paperbackForm = $<HTMLFormElement>('from-paperback');
const paperbackListing = $('paperback-listing');
let shownRepo: PaperbackRepo | undefined;

paperbackForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = paperbackForm.querySelector<HTMLButtonElement>('button[type=submit]')!;
  dialogError('');
  submit.disabled = true;
  submit.textContent = 'loading…';
  try {
    shownRepo = await send<PaperbackRepo>({ type: 'paperbackRepo', url: field('paperback-url').value });
    await renderListing();
  } catch (err) {
    shownRepo = undefined;
    paperbackListing.replaceChildren();
    dialogError(errorMessage(err));
  } finally {
    submit.disabled = false;
    submit.textContent = 'list sources';
  }
});

/** The repo's sources, each with Install (or Update, or a note that it's installed). */
async function renderListing(): Promise<void> {
  const repo = shownRepo;
  if (!repo) return;
  const installed = new Map((await send<SiteConfig[]>({ type: 'listConfigs' })).filter((c) => c.paperback).map((c) => [c.id, c]));
  const sources = [...repo.sources].sort((a, b) => a.name.localeCompare(b.name));
  if (!sources.length) {
    paperbackListing.replaceChildren(h('li', { class: 'hint', text: 'this repo lists no sources.' }));
    return;
  }
  const isCurrent = (listing: PaperbackListing) => {
    const current = installed.get(paperbackConfigId(listing.id));
    return current?.paperback?.repo === repo.url && current.paperback.version === listing.version;
  };
  const missing = sources.filter((listing) => !isCurrent(listing));
  let allRow: HTMLElement | undefined;
  if (missing.length > 1) {
    const el: HTMLButtonElement = button(`install all ${missing.length}`, 'secondary small', () => installAll(repo, missing, el));
    allRow = h(
      'li',
      { class: 'listing-all' },
      h('span', { class: 'hint', text: `${sources.length} sources, ${missing.length} not installed or out of date.` }),
      h('div', { class: 'config-actions' }, el),
    );
  }
  paperbackListing.replaceChildren(
    ...(allRow ? [allRow] : []),
    ...sources.map((listing) => {
      const current = installed.get(paperbackConfigId(listing.id));
      const same = isCurrent(listing);
      const icon = sourceIcon({ name: listing.name, icon: paperbackFiles(repo.url, listing).icon ?? '' }, 32);
      const tags = [
        listing.contentRating === 'ADULT' ? nsfwTag() : undefined,
        listing.contentRating === 'MATURE' ? h('span', { class: 'tag', text: 'mature' }) : undefined,
        ...(listing.tags ?? []).slice(0, 3).map((t) => h('span', { class: 'tag', text: t.text })),
      ];
      let action: HTMLElement;
      if (same) action = h('span', { class: 'hint', text: 'installed' });
      else {
        const el: HTMLButtonElement = button(current ? `update to v${listing.version}` : 'install', current ? 'secondary small' : 'primary small', () =>
          installFromRepo(repo, listing.id, listing.name, el),
        );
        action = el;
      }
      return h(
        'li',
        {},
        icon,
        h(
          'div',
          { class: 'config-info' },
          h('div', { class: 'config-name' }, h('strong', { text: listing.name }), ...tags.filter(Boolean)),
          h('span', { class: 'hint', text: `${hostOf(listing.websiteBaseURL)} · v${listing.version}${listing.author ? ` · by ${listing.author}` : ''}` }),
        ),
        h('div', { class: 'config-actions' }, action),
      );
    }),
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Must be the first await in a click handler: browsers only show the permission prompt during the click. */
async function allowAllSites(who: string): Promise<boolean> {
  if (await chrome.permissions.request({ origins: ALL_SITES }).catch(() => false)) return true;
  dialogError(`${who} need${who.endsWith('sources') ? '' : 's'} access to all sites: Paperback sources load from wherever their site keeps pages and images.`);
  return false;
}

/** Installs at once: a few at a time, since each one downloads its code and reads its site's home page. */
const INSTALL_ALL_PARALLEL = 4;

async function installAll(repo: PaperbackRepo, listings: PaperbackListing[], el: HTMLButtonElement): Promise<void> {
  if (!(await allowAllSites('these sources'))) return;
  dialogError('');
  for (const b of Array.from(paperbackListing.querySelectorAll('button'))) b.disabled = true;
  let done = 0;
  const failed: string[] = [];
  const queue = [...listings];
  el.textContent = `installing… 0 of ${listings.length}`;
  await Promise.all(
    Array.from({ length: Math.min(INSTALL_ALL_PARALLEL, queue.length) }, async () => {
      for (let listing = queue.shift(); listing; listing = queue.shift()) {
        try {
          await send<SiteConfig>({ type: 'installPaperback', repo: repo.url, sourceId: listing.id });
        } catch (err) {
          failed.push(`${listing.name} (${errorMessage(err)})`);
        }
        el.textContent = `installing… ${++done} of ${listings.length}`;
      }
    }),
  );
  const installed = listings.length - failed.length;
  show(`installed ${installed} source${installed === 1 ? '' : 's'} from ${repoLabel(repo.url)}.`);
  if (failed.length) dialogError(`couldn’t install ${failed.length}: ${failed.join('; ')}`);
  await render();
  await renderListing();
}

async function installFromRepo(repo: PaperbackRepo, sourceId: string, name: string, el: HTMLButtonElement): Promise<void> {
  if (!(await allowAllSites(name))) return;
  dialogError('');
  el.disabled = true;
  el.textContent = 'installing…';
  try {
    const config = await send<SiteConfig>({ type: 'installPaperback', repo: repo.url, sourceId });
    show(`installed ${config.name}. it’s now in search${config.explore ? ' and explore' : ''}.`);
    await render();
  } catch (err) {
    dialogError(errorMessage(err));
  }
  await renderListing();
}

// ---- Settings -----------------------------------------------------------------------------

async function renderSettings(): Promise<void> {
  const settings = await send<Settings>({ type: 'settings' });
  nsfwToggle.checked = settings.showNsfw;
  readToggle.checked = settings.readInOnidoku;
  detectToggle.checked = settings.detectEverywhere && (await chrome.permissions.contains({ origins: ALL_SITES }));
}

nsfwToggle.addEventListener('change', async () => {
  await send({ type: 'saveSettings', settings: { showNsfw: nsfwToggle.checked } });
  show(nsfwToggle.checked ? '18+ sources are shown in search.' : '18+ sources are hidden in search.');
});

readToggle.addEventListener('change', async () => {
  await send({ type: 'saveSettings', settings: { readInOnidoku: readToggle.checked } });
  show(readToggle.checked ? 'chapters open in onidoku’s reader.' : 'chapters open on their sites.');
});

detectToggle.addEventListener('change', async () => {
  // Must be the first await: Chrome only shows the permission prompt during the click.
  if (detectToggle.checked && !(await chrome.permissions.request({ origins: ALL_SITES }))) {
    detectToggle.checked = false;
    show('without access to all sites, the reader is still one click away in the toolbar popup.');
    return;
  }
  await send({ type: 'saveSettings', settings: { detectEverywhere: detectToggle.checked } });
  show(detectToggle.checked ? 'onidoku will offer the reader on pages that look like chapters.' : 'stopped offering the reader on other sites.');
});

// Sources and the library can change underneath the page (other tabs, onInstalled, update checks).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (CONFIGS_KEY in changes || SERVERS_KEY in changes || PAPERBACK_KEY in changes || LIBRARY_CHANGED_KEY in changes)) void render();
  if (area === 'local' && SETTINGS_KEY in changes) void renderSettings();
});
chrome.permissions.onAdded.addListener(() => void render());
chrome.permissions.onRemoved.addListener(() => void render());

void render();
void renderSettings();

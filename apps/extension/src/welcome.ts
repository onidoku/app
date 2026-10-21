// The page opened once, on install: what onidoku does, and the few things worth setting up, done in place.
import { configOrigins, paperbackConfigId, paperbackFiles, parseServer, type PaperbackListing, type PaperbackRepo, type ServerKind, type SiteConfig } from '@onidoku/core';
import { button, h } from './dom';
import { ALL_SITES, errorMessage, send, type ServerSummary, type Settings } from './messages';
import { CONFIGS_KEY, PAPERBACK_KEY, SERVERS_KEY, SETTINGS_KEY } from './keys';
import { nsfwTag, sourceIcon, toast } from './ui';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const field = (id: string) => $<HTMLInputElement>(id);

const detectAllow = $<HTMLButtonElement>('detect-allow');
const featuredAllow = $<HTMLButtonElement>('featured-allow');

/** The suggested sources installed with onidoku, while they're still installed. */
let featured: SiteConfig[] = [];

function stepError(id: string, message: string): void {
  $(id).textContent = message;
  $(id).hidden = !message;
}

async function render(): Promise<void> {
  const [settings, servers, configs, everywhere] = await Promise.all([
    send<Settings>({ type: 'settings' }),
    send<ServerSummary[]>({ type: 'listServers' }),
    send<SiteConfig[]>({ type: 'listConfigs' }),
    chrome.permissions.contains({ origins: ALL_SITES }),
  ]);

  const detecting = settings.detectEverywhere && everywhere;
  detectAllow.hidden = detecting;
  $('detect-done').hidden = !detecting;

  const ids = new Set(__FEATURED_CONFIGS__.map((raw) => (raw as { id: string }).id));
  featured = configs.filter((c) => ids.has(c.id));
  const featuredOrigins = featured.flatMap(configOrigins);
  const featuredReady = !featuredOrigins.length || (await chrome.permissions.contains({ origins: featuredOrigins }));
  $('step-featured').hidden = !featured.length;
  featuredAllow.hidden = featuredReady;
  $('featured-done').hidden = !featuredReady;
  $('featured').replaceChildren(
    ...featured.map((config) =>
      h(
        'li',
        {},
        sourceIcon(config, 32),
        h('div', { class: 'config-info' }, h('strong', { text: config.name }), h('span', { class: 'hint', text: new URL(config.series.url.replace(/\*/g, 'x')).host })),
      ),
    ),
  );

  const serverDone = $('server-done');
  serverDone.hidden = !servers.length;
  serverDone.textContent = `✓ ${servers.map((s) => s.name).join(', ')}`;

  const paperback = configs.filter((c) => c.paperback);
  $('step-paperback').hidden = !__PAPERBACK__ && !paperback.length;
  const paperbackDone = $('paperback-done');
  paperbackDone.hidden = !paperback.length;
  paperbackDone.textContent = `✓ ${paperback.length} source${paperback.length === 1 ? '' : 's'}`;
}

// ---- Reader on any site -------------------------------------------------------------------

detectAllow.addEventListener('click', async () => {
  // Must be the first await: Chrome only shows the permission prompt during the click.
  if (!(await chrome.permissions.request({ origins: ALL_SITES }).catch(() => false))) {
    toast('without access to all sites, the reader is still one click away in the toolbar popup.');
    return;
  }
  await send({ type: 'saveSettings', settings: { detectEverywhere: true } });
  await render();
});

// ---- Suggested sources --------------------------------------------------------------------

featuredAllow.addEventListener('click', async () => {
  // Must be the first await: browsers only show the permission prompt during the click.
  if (!(await chrome.permissions.request({ origins: featured.flatMap(configOrigins) }).catch(() => false))) {
    toast('without access, they can’t be read or checked: you can allow it later on the sources page.');
    return;
  }
  await render();
});

// ---- Media server -------------------------------------------------------------------------

const serverForm = $<HTMLFormElement>('add-server');
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
    apiKey: field('server-key').value,
    ...(kind === 'komga' ? { username: field('server-user').value, password: field('server-password').value } : {}),
  };
  let origins: string[];
  try {
    origins = [`${new URL(parseServer(raw).url).origin}/*`];
  } catch (err) {
    stepError('server-error', errorMessage(err).replace(/^Invalid server: (apiKey|url): /, ''));
    return;
  }
  // Must be the first await: browsers only show the permission prompt during the click.
  if (!(await chrome.permissions.request({ origins }).catch(() => false))) {
    stepError('server-error', 'onidoku needs access to the server’s address to read from it.');
    return;
  }
  const submit = serverForm.querySelector<HTMLButtonElement>('button[type=submit]')!;
  submit.disabled = true;
  submit.textContent = 'connecting…';
  stepError('server-error', '');
  try {
    const { server, account } = await send<{ server: ServerSummary; account: string }>({ type: 'addServer', server: raw });
    serverForm.reset();
    syncServerForm();
    toast(`connected to ${server.name} as ${account}. its series are now in search and explore.`);
    await render();
  } catch (err) {
    stepError('server-error', errorMessage(err));
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
  stepError('paperback-error', '');
  submit.disabled = true;
  submit.textContent = 'loading…';
  try {
    shownRepo = await send<PaperbackRepo>({ type: 'paperbackRepo', url: field('paperback-url').value });
    await renderListing();
  } catch (err) {
    shownRepo = undefined;
    paperbackListing.replaceChildren();
    stepError('paperback-error', errorMessage(err));
  } finally {
    submit.disabled = false;
    submit.textContent = 'list sources';
  }
});

/** The repo's sources, each with Install, plus Install all. */
async function renderListing(): Promise<void> {
  const repo = shownRepo;
  if (!repo) return;
  const installed = new Set((await send<SiteConfig[]>({ type: 'listConfigs' })).filter((c) => c.paperback?.repo === repo.url).map((c) => c.id));
  const sources = [...repo.sources].sort((a, b) => a.name.localeCompare(b.name));
  if (!sources.length) {
    paperbackListing.replaceChildren(h('li', { class: 'hint', text: 'this repo lists no sources.' }));
    return;
  }
  const missing = sources.filter((listing) => !installed.has(paperbackConfigId(listing.id)));
  let allRow: HTMLElement | undefined;
  if (missing.length > 1) {
    const el: HTMLButtonElement = button(`install all ${missing.length}`, 'primary small', () => installSources(repo, missing, el));
    allRow = h('li', { class: 'listing-all' }, h('span', { class: 'hint', text: `${sources.length} sources, ${missing.length} not installed.` }), h('div', { class: 'config-actions' }, el));
  }
  paperbackListing.replaceChildren(
    ...(allRow ? [allRow] : []),
    ...sources.map((listing) => {
      const action = installed.has(paperbackConfigId(listing.id))
        ? h('span', { class: 'hint', text: 'installed' })
        : (() => {
            const el: HTMLButtonElement = button('install', 'secondary small', () => installSources(repo, [listing], el));
            return el;
          })();
      return h(
        'li',
        {},
        sourceIcon({ name: listing.name, icon: paperbackFiles(repo.url, listing).icon ?? '' }, 32),
        h(
          'div',
          { class: 'config-info' },
          h('div', { class: 'config-name' }, h('strong', { text: listing.name }), listing.contentRating === 'ADULT' ? nsfwTag() : undefined),
          h('span', { class: 'hint', text: `v${listing.version}${listing.author ? ` · by ${listing.author}` : ''}` }),
        ),
        h('div', { class: 'config-actions' }, action),
      );
    }),
  );
}

/** A few at a time, since each one downloads its code and reads its site's home page. */
const INSTALL_PARALLEL = 4;

async function installSources(repo: PaperbackRepo, listings: PaperbackListing[], el: HTMLButtonElement): Promise<void> {
  // Must be the first await: browsers only show the permission prompt during the click.
  if (!(await chrome.permissions.request({ origins: ALL_SITES }).catch(() => false))) {
    stepError('paperback-error', 'Paperback sources need access to all sites: they load from wherever their site keeps pages and images.');
    return;
  }
  stepError('paperback-error', '');
  for (const b of Array.from(paperbackListing.querySelectorAll('button'))) b.disabled = true;
  let done = 0;
  const failed: string[] = [];
  const queue = [...listings];
  el.textContent = listings.length > 1 ? `installing… 0 of ${listings.length}` : 'installing…';
  await Promise.all(
    Array.from({ length: Math.min(INSTALL_PARALLEL, queue.length) }, async () => {
      for (let listing = queue.shift(); listing; listing = queue.shift()) {
        try {
          await send<SiteConfig>({ type: 'installPaperback', repo: repo.url, sourceId: listing.id });
        } catch (err) {
          failed.push(`${listing.name} (${errorMessage(err)})`);
        }
        if (listings.length > 1) el.textContent = `installing… ${++done} of ${listings.length}`;
      }
    }),
  );
  const count = listings.length - failed.length;
  if (count) toast(`installed ${count} source${count === 1 ? '' : 's'}. they’re now in search.`);
  if (failed.length) stepError('paperback-error', `couldn’t install ${failed.length}: ${failed.join('; ')}`);
  await render();
  await renderListing();
}

// The sources page in another tab, or the background, can change things underneath.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (CONFIGS_KEY in changes || SERVERS_KEY in changes || PAPERBACK_KEY in changes || SETTINGS_KEY in changes)) void render();
});
chrome.permissions.onAdded.addListener(() => void render());
chrome.permissions.onRemoved.addListener(() => void render());

void render();

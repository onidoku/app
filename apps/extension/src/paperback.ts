// Paperback sources, the background's side (Chrome only). A source is third-party code, so it
// runs in a sandboxed frame (paperback-sandbox.ts) inside an offscreen document
// (paperback-host.ts), and everything it does outside its frame comes through here:
//
// - requests: made from the background, so they get the extension's site access. Headers a
//   browser won't let a page set (referer, cookie, origin, user agent) are applied by a
//   short-lived declarativeNetRequest rule for that one request. The browser's own cookies go
//   only to the source's own site.
// - settings: kept per source in storage.
// - images: covers and pages load in extension pages, so the headers the source's image server
//   expects are added by a lasting rule per image host, for requests from this extension only.
import {
  fetchRetrying,
  PaperbackClient,
  paperbackUrls,
  paperbackConfigId,
  paperbackFiles,
  paperbackRepoUrl,
  paperbackSections,
  paperbackSiteConfig,
  parsePaperbackRepo,
  type PaperbackInstall,
  type PaperbackRepo,
  type PaperbackRuntime,
  type PaperbackSection,
  type PbHttpRequest,
  type PbHttpResponse,
  type SiteConfig,
} from '@onidoku/core';
import { CF_HOSTS_KEY, paperbackCodeKey, paperbackStateKey } from './keys';
import { HOST_PORT, type FromHost, type SandboxCall, type ToHost, type WithoutId } from './paperback-protocol';
import { previewUrl, readerUrl, type SiteSource } from './messages';
import { chromeStore, loadPaperbackInstalls, removePaperbackInstall, savePaperbackInstall } from './storage';

/** Chrome and Edge only: Firefox has neither offscreen documents nor (on AMO) room for downloaded code. */
export const PAPERBACK_SUPPORTED = __PAPERBACK__ && typeof chrome.offscreen !== 'undefined';

const HOST_PAGE = 'paperback-host.html';
const LOAD_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;
/** The sandbox page closes after this long without calls, to free its memory. */
const HOST_IDLE_MS = 3 * 60_000;
/** Bigger bundles than this are refused; real ones are around 1 MB. */
const MAX_CODE_BYTES = 15_000_000;
const MAX_BODY_BYTES = 30_000_000;
const MAX_STATE_BYTES = 200_000;
/** How long an install waits for the source's home page (its explore tabs) before going without. */
const SECTIONS_TIMEOUT_MS = 20_000;

// ---- The sandbox host ------------------------------------------------------------------------

let port: chrome.runtime.Port | undefined;
let starting: Promise<chrome.runtime.Port> | undefined;
let connectWaiters: ((port: chrome.runtime.Port) => void)[] = [];
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
/** Sources loaded into the current host page. */
const loaded = new Map<string, Promise<void>>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;

if (PAPERBACK_SUPPORTED) {
  chrome.runtime.onConnect.addListener((p) => {
    if (p.name !== HOST_PORT || p.sender?.url !== chrome.runtime.getURL(HOST_PAGE)) return;
    port = p;
    loaded.clear();
    p.onMessage.addListener((message: FromHost) => onHostMessage(p, message));
    p.onDisconnect.addListener(() => {
      if (port !== p) return;
      port = undefined;
      loaded.clear();
      for (const waiter of pending.values()) waiter.reject(new Error('the Paperback sandbox stopped. try again.'));
      pending.clear();
    });
    for (const resolve of connectWaiters) resolve(p);
    connectWaiters = [];
  });
}

/** The connection to the sandbox host page, opening a fresh page if there's none. */
function host(): Promise<chrome.runtime.Port> {
  if (port) return Promise.resolve(port);
  starting ??= (async () => {
    try {
      // A page left over from before the service worker restarted can't reconnect: replace it.
      const stale = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
      if (stale.length) await chrome.offscreen.closeDocument();
      const connected = new Promise<chrome.runtime.Port>((resolve, reject) => {
        connectWaiters.push(resolve);
        setTimeout(() => reject(new Error('the Paperback sandbox didn’t start')), 10_000);
      });
      await chrome.offscreen.createDocument({
        url: HOST_PAGE,
        reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING],
        justification: 'Runs the Paperback sources the user installed, each in a sandboxed frame without extension access.',
      });
      return await connected;
    } finally {
      starting = undefined;
    }
  })();
  return starting;
}

function scheduleIdle(): void {
  clearTimeout(idleTimer);
  if (pending.size) return;
  idleTimer = setTimeout(() => {
    if (pending.size || !port) return;
    port.disconnect();
    port = undefined;
    loaded.clear();
    void chrome.offscreen.closeDocument().catch(() => {});
  }, HOST_IDLE_MS);
}

async function send(configId: string, message: WithoutId<SandboxCall>, timeoutMs: number): Promise<unknown> {
  const p = await host();
  const id = nextId++;
  clearTimeout(idleTimer);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the source took too long to answer'));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (err) => (clearTimeout(timer), reject(err)),
      });
      p.postMessage({ ...message, id, configId } as ToHost);
    });
  } finally {
    scheduleIdle();
  }
}

function onHostMessage(p: chrome.runtime.Port, message: FromHost): void {
  const { configId } = message;
  if (message.kind === 'result') {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.ok) waiter?.resolve(message.value);
    else waiter?.reject(new Error(message.error));
    return;
  }
  const work = message.kind === 'fetch' ? sourceFetch(configId, message.request) : message.kind === 'state' ? sourceState(configId, message) : undefined;
  work?.then(
    (value) => p.postMessage({ kind: 'reply', id: message.id, ok: true, value, configId } satisfies ToHost),
    (err) => p.postMessage({ kind: 'reply', id: message.id, ok: false, error: err instanceof Error ? err.message : String(err), configId } satisfies ToHost),
  );
}

// ---- Runtimes --------------------------------------------------------------------------------

const runtimes = new Map<string, PaperbackRuntime>();

/** Runs a source's methods in its sandboxed frame. One per source, so paged explore lists can continue. */
export function paperbackRuntime(config: SiteConfig): PaperbackRuntime | undefined {
  if (!PAPERBACK_SUPPORTED || !config.paperback) return undefined;
  let runtime = runtimes.get(config.id);
  if (!runtime) {
    runtime = {
      call: async (method, args = []) => {
        await ensureLoaded(config);
        return send(config.id, { kind: 'call', method, args }, CALL_TIMEOUT_MS);
      },
    };
    runtimes.set(config.id, runtime);
  }
  return runtime;
}

async function ensureLoaded(config: SiteConfig): Promise<void> {
  await host();
  let ready = loaded.get(config.id);
  if (!ready) {
    ready = (async () => {
      const code = await chromeStore.get(paperbackCodeKey(config.id));
      if (typeof code !== 'string') throw new Error(`${config.name}’s code is missing. install it again from the sources page.`);
      await send(config.id, { kind: 'load', code, sourceId: config.paperback!.sourceId }, LOAD_TIMEOUT_MS);
    })();
    loaded.set(config.id, ready);
    ready.catch(() => loaded.delete(config.id));
  }
  return ready;
}

/** Stops a source's frame, e.g. before replacing its code. */
function dropRuntime(configId: string): void {
  runtimes.delete(configId);
  loaded.delete(configId);
  port?.postMessage({ kind: 'drop', configId } satisfies ToHost);
}

// ---- What sources may do: requests and settings ---------------------------------------------

async function installOf(configId: string): Promise<PaperbackInstall> {
  const install = (await loadPaperbackInstalls()).find((i) => paperbackConfigId(i.listing.id) === configId);
  if (!install) throw new Error('this source isn’t installed anymore');
  return install;
}

/** Headers browsers don't let pages set; a declarativeNetRequest rule sets them instead. */
const RULE_HEADERS = new Set(['cookie', 'referer', 'origin']);
/**
 * Headers the browser manages itself. That includes the user agent: sites behind Cloudflare only
 * accept the clearance cookie (from passing the check in a tab) with the browser's own user agent,
 * so a source's own (often an iPhone's, written for Paperback) is never sent.
 */
const BROWSER_HEADERS = /^(host|connection|content-length|accept-encoding|keep-alive|transfer-encoding|te|trailer|upgrade|expect|date|via|dnt|user-agent|proxy-.*|sec-.*)$/;
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function splitHeaders(headers: Record<string, string>): { plain: Record<string, string>; rule: Record<string, string> } {
  const plain: Record<string, string> = {};
  const rule: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase().trim();
    const value = String(rawValue).replace(/[\r\n]+/g, ' ').trim();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || BROWSER_HEADERS.test(name)) continue;
    if (!RULE_HEADERS.has(name)) plain[name] = value;
    else if (value) rule[name] = value;
  }
  return { plain, rule };
}

/** Whether a host belongs to the source's site (www. or not, and its subdomains). */
function onSite(hostname: string, site: string): boolean {
  const a = hostname.replace(/^www\./, '');
  const b = new URL(site).hostname.replace(/^www\./, '');
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function isText(contentType: string): boolean {
  return !contentType || /^text\/|json|xml|javascript|html|x-www-form-urlencoded/i.test(contentType);
}

/**
 * The cookie header for a source's request: on its own site, the browser's cookies for the URL
 * (logins, Cloudflare's clearance) with the source's own on top; elsewhere, only the source's.
 * Built here rather than left to the browser, because a header rule that adds the source's
 * cookies would otherwise replace the browser's.
 */
async function cookieHeader(url: string, ownSite: boolean, fromSource: string | undefined): Promise<string | undefined> {
  const cookies = new Map<string, string>();
  if (ownSite && chrome.cookies) {
    for (const c of await chrome.cookies.getAll({ url }).catch(() => [] as chrome.cookies.Cookie[])) cookies.set(c.name, c.value);
  }
  for (const part of (fromSource ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) cookies.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return cookies.size ? [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') : undefined;
}

async function sourceFetch(configId: string, request: PbHttpRequest): Promise<PbHttpResponse> {
  const install = await installOf(configId);
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error(`not a web address: ${String(request.url).slice(0, 200)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`can’t load ${url.protocol} addresses`);
  url.hash = '';
  const method = String(request.method).toUpperCase();
  if (!METHODS.has(method)) throw new Error(`unsupported request method ${method}`);
  const { plain, rule } = splitHeaders(request.headers);
  const ownSite = onSite(url.hostname, install.listing.websiteBaseURL);
  const cookie = await cookieHeader(url.href, ownSite, rule.cookie);
  if (cookie) rule.cookie = cookie;
  else delete rule.cookie;
  // Hosts known to challenge the extension go straight through a tab of the site, when one is open.
  if (ownSite && (await challengedHosts()).has(url.hostname)) {
    const viaTab = await fetchInSiteTab(url, method, plain, request.body);
    if (viaTab) return viaTab;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(request.timeoutMs) || 20_000, 1000), 60_000));
  try {
    const res = await withHeaderRule(url.href, rule, () =>
      fetchRetrying(() =>
        fetch(url.href, {
          method,
          headers: plain,
          body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
          // The browser's cookies (logins, Cloudflare clearance) only go to the source's own site.
          // They're also in the cookie header built above; this lets the site update them.
          credentials: ownSite ? 'include' : 'omit',
          signal: controller.signal,
        }),
      ),
    );
    // Cloudflare can challenge the background's requests even with the clearance cookie: they
    // don't look like the site's own. A tab on the site makes them as the site's own page would.
    if (ownSite && res.headers.get('cf-mitigated') === 'challenge') {
      await markChallenged(url.hostname);
      const viaTab = await fetchInSiteTab(url, method, plain, request.body);
      if (viaTab) return viaTab;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => (headers[name] = value));
    if (method === 'HEAD') return { status: res.status, headers };
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_BODY_BYTES) throw new Error(`${url.host} sent more than ${MAX_BODY_BYTES / 1e6} MB`);
    if (isText(headers['content-type'] ?? '')) return { status: res.status, headers, text: await res.text() };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) throw new Error(`${url.host} sent more than ${MAX_BODY_BYTES / 1e6} MB`);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { status: res.status, headers, base64: btoa(binary) };
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`${url.host} took too long to answer`);
    throw err instanceof Error && err.message.startsWith(url.host) ? err : new Error(`couldn’t reach ${url.host}: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

let cfHosts: Promise<Set<string>> | undefined;

/** Hosts seen challenging the extension this browser session (pages read the list for images). */
function challengedHosts(): Promise<Set<string>> {
  cfHosts ??= (async () => {
    const stored = chrome.storage.session ? (await chrome.storage.session.get(CF_HOSTS_KEY))[CF_HOSTS_KEY] : undefined;
    return new Set(Array.isArray(stored) ? (stored as string[]) : []);
  })();
  return cfHosts;
}

async function markChallenged(hostname: string): Promise<void> {
  const hosts = await challengedHosts();
  if (hosts.has(hostname)) return;
  hosts.add(hostname);
  await chrome.storage.session?.set({ [CF_HOSTS_KEY]: [...hosts] }).catch(() => {});
}

/**
 * An image from a Paperback source's site, for extension pages that can't load it directly
 * (its host challenges the extension): fetched like the source's own requests, through a tab of
 * the site when needed.
 */
export async function fetchPaperbackImage(raw: string): Promise<{ type: string; base64?: string; text?: string }> {
  const url = new URL(raw);
  const install = (await loadPaperbackInstalls()).find((i) => onSite(url.hostname, i.listing.websiteBaseURL));
  if (!install) throw new Error('not an image from an installed Paperback source’s site');
  const site = install.listing.websiteBaseURL.replace(/\/+$/, '');
  const res = await sourceFetch(paperbackConfigId(install.listing.id), { url: url.href, method: 'GET', headers: { referer: `${site}/` }, timeoutMs: 30_000 });
  if (res.status !== 200) throw new Error(`${url.host} answered HTTP ${res.status} for an image`);
  return { type: res.headers['content-type'] ?? 'image/jpeg', base64: res.base64, text: res.text };
}

/**
 * Makes a request from a tab the user has open on the site, as that page's own (same-origin, with
 * the site's cookies and the page as referer). Undefined when no tab of the site is open.
 */
async function fetchInSiteTab(url: URL, method: string, headers: Record<string, string>, body: string | undefined): Promise<PbHttpResponse | undefined> {
  const tabs = await chrome.tabs.query({ url: [`*://${url.hostname}/*`, `*://*.${url.hostname.replace(/^www\./, '')}/*`] });
  // Same host first: requests to another subdomain would be cross-origin from the page.
  const tab = tabs.find((t) => t.url && new URL(t.url).hostname === url.hostname && t.status === 'complete') ?? tabs.find((t) => t.status === 'complete');
  if (tab?.id === undefined) return undefined;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [url.href, method, headers, method === 'GET' || method === 'HEAD' ? null : (body ?? null), MAX_BODY_BYTES],
    // Runs in the page (isolated from its scripts), so it can't use anything from this file.
    func: async (href: string, method: string, headers: Record<string, string>, body: string | null, maxBytes: number) => {
      const res = await fetch(href, { method, headers, body, credentials: 'include' });
      const out: Record<string, string> = {};
      res.headers.forEach((value, name) => (out[name] = value));
      if (method === 'HEAD') return { status: res.status, headers: out };
      const type = res.headers.get('content-type') ?? '';
      if (!type || /^text\/|json|xml|javascript|html|x-www-form-urlencoded/i.test(type)) return { status: res.status, headers: out, text: await res.text() };
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error(`${new URL(href).host} sent more than ${maxBytes / 1e6} MB`);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { status: res.status, headers: out, base64: btoa(binary) };
    },
  });
  return result?.result as PbHttpResponse | undefined;
}

async function sourceState(configId: string, message: Extract<FromHost, { kind: 'state' }>): Promise<unknown> {
  await installOf(configId);
  const key = String(message.key).slice(0, 200);
  const stored = ((await chromeStore.get(paperbackStateKey(configId))) as Record<string, unknown> | undefined) ?? {};
  if (message.op === 'get') return stored[key];
  const next = { ...stored, [key]: message.value ?? null };
  if (JSON.stringify(next).length > MAX_STATE_BYTES) throw new Error('the source tried to store too much');
  await chromeStore.set(paperbackStateKey(configId), next);
  return null;
}

// ---- Header rules ----------------------------------------------------------------------------

let nextRuleId = 1;
let sessionRulesCleared: Promise<void> | undefined;

/** Matches exactly one URL. */
function urlCondition(url: string): { urlFilter: string } | { regexFilter: string } {
  // urlFilter treats * ^ | specially; the rare URL containing them gets an escaped regex instead.
  return /[*^|]/.test(url) ? { regexFilter: `^${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` } : { urlFilter: `|${url}|` };
}

function headerActions(headers: Record<string, string>): chrome.declarativeNetRequest.ModifyHeaderInfo[] {
  return Object.entries(headers).map(([header, value]) => ({ header, operation: 'set', value }));
}

/** Runs a request with headers set by a rule for just that URL from the background. */
async function withHeaderRule<T>(url: string, headers: Record<string, string>, run: () => Promise<T>): Promise<T> {
  if (!Object.keys(headers).length || !chrome.declarativeNetRequest) return run();
  // Session rules are only ever these; any left from before a restart are stale.
  sessionRulesCleared ??= chrome.declarativeNetRequest
    .getSessionRules()
    .then((rules) => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) }));
  await sessionRulesCleared;
  const id = nextRuleId++;
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: headerActions(headers) },
        condition: { ...urlCondition(url), tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: ['xmlhttprequest', 'other'] },
      },
    ],
  });
  try {
    return await run();
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
}

const IMAGE_RULES_KEY = 'paperbackImageRules';
/** Per source, per image host: the rule adding its headers (0 when the host needs none). */
type ImageRules = Record<string, Record<string, number>>;
let imageQueue: Promise<void> = Promise.resolve();

/**
 * Lets covers and pages from these URLs load in extension pages: many image servers refuse
 * requests without the site's referer. Adds one lasting rule per image host, applied only to this
 * extension's requests, with the headers the source's interceptor gives a request there
 * (Paperback sources) or the site as referer (site configs read on the reader page).
 */
export function allowSourceImages(config: SiteConfig, urls: (string | undefined)[]): Promise<void> {
  if (config.server || !PAPERBACK_SUPPORTED || !chrome.declarativeNetRequest) return Promise.resolve();
  const task = imageQueue.then(async () => {
    const rules = ((await chromeStore.get(IMAGE_RULES_KEY)) as ImageRules | undefined) ?? {};
    const mine = (rules[config.id] ??= {});
    const samples = new Map<string, string>();
    for (const raw of urls) {
      try {
        const url = new URL(raw ?? '');
        if ((url.protocol === 'https:' || url.protocol === 'http:') && !(url.hostname in mine)) samples.set(url.hostname, url.href);
      } catch {
        // Not a web address (e.g. a data: image): nothing to allow.
      }
    }
    if (!samples.size) return;
    const runtime = paperbackRuntime(config);
    const site = `${config.series.url.match(/^https?:\/\/[^/]+/)![0]}/`;
    let id = Math.max(0, ...(await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id)) + 1;
    const addRules: chrome.declarativeNetRequest.Rule[] = [];
    for (const [hostname, sample] of samples) {
      const asked = runtime ? ((await runtime.call('requestHeaders', [sample]).catch(() => ({}))) as Record<string, string>) : { referer: site };
      const { rule } = splitHeaders(asked ?? {});
      if (!Object.keys(rule).length) {
        mine[hostname] = 0;
        continue;
      }
      addRules.push({
        id,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: headerActions(rule) },
        condition: { requestDomains: [hostname], resourceTypes: ['image'], initiatorDomains: [chrome.runtime.id] },
      });
      mine[hostname] = id++;
    }
    if (addRules.length) await chrome.declarativeNetRequest.updateDynamicRules({ addRules });
    await chromeStore.set(IMAGE_RULES_KEY, rules);
  });
  imageQueue = task.catch((err) => console.warn('couldn’t allow Paperback images', err));
  return imageQueue;
}

/** Removes a source's image rules (when it's uninstalled). */
export async function forgetSourceImages(configId: string): Promise<void> {
  const task = imageQueue.then(async () => {
    const rules = ((await chromeStore.get(IMAGE_RULES_KEY)) as ImageRules | undefined) ?? {};
    const ids = Object.values(rules[configId] ?? {}).filter(Boolean);
    if (ids.length && chrome.declarativeNetRequest) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
    delete rules[configId];
    await chromeStore.set(IMAGE_RULES_KEY, rules);
  });
  imageQueue = task.catch(() => {});
  return task;
}

// ---- Site pages -----------------------------------------------------------------------------

async function installOnSite(url: string): Promise<PaperbackInstall | undefined> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return (await loadPaperbackInstalls()).find((i) => onSite(hostname, i.listing.websiteBaseURL));
}

/** The installed Paperback source whose site this page is on, if any. */
export async function paperbackSiteSource(url: string): Promise<SiteSource | null> {
  const install = PAPERBACK_SUPPORTED ? await installOnSite(url) : undefined;
  if (!install) return null;
  const config = paperbackSiteConfig(install);
  return { id: config.id, name: config.name, icon: config.icon };
}

/**
 * A Paperback title's page on its source's site (the source's share URL), or undefined when the
 * source has none. Only http(s) addresses: the source is downloaded code.
 */
export async function paperbackShareUrl(config: SiteConfig, url: string): Promise<string | undefined> {
  const runtime = paperbackRuntime(config);
  if (!runtime) return undefined;
  const share = await runtime.call('getMangaShareUrl', [paperbackUrls(config.id).mangaId(url)]).catch(() => undefined);
  if (typeof share !== 'string') return undefined;
  try {
    const { protocol } = new URL(share);
    return protocol === 'https:' || protocol === 'http:' ? share : undefined;
  } catch {
    return undefined;
  }
}

/** An address reduced for comparing pages: no scheme, www., query, case or trailing slash. */
function comparable(url: string): string {
  const u = new URL(url);
  return `${u.hostname.replace(/^www\./, '')}${decodeURI(u.pathname)}`.toLowerCase().replace(/\/+$/, '');
}

const within = (page: string, prefix: string) => page === prefix || page.startsWith(`${prefix}/`);

/** Search results checked against the page per title tried: each costs no request (share URLs are local). */
const MATCH_RESULTS = 10;
/** Ids guessed from the address whose details are fetched when the source has no share URLs. */
const ID_DETAILS_TRIES = 2;

/**
 * Ids a source might give the title at this address, likeliest first: runs of the path's last
 * segments, shortest first (Dynasty's /series/<id>, a site's /manga/<id>/<slug>), then the whole
 * path and the address.
 */
function idGuesses(url: string): string[] {
  const u = new URL(url);
  const path = decodeURI(u.pathname).replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean).slice(-6);
  const runs: string[] = [];
  for (let len = 1; len <= segments.length; len++) {
    for (let start = segments.length - len; start >= 0; start--) runs.push(segments.slice(start, start + len).join('/'));
  }
  return [...new Set([...runs, path, url])].filter(Boolean);
}

/** A title reduced for comparing: case, punctuation and spacing don't count. */
const sameTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Where a page of a Paperback source's site is in onidoku. Paperback titles have ids, not URLs,
 * so a title whose link (its share URL) is this page, or contains it, is the one: first among the
 * titles in the library (`saved`, their onidoku addresses), then ids guessed from the address,
 * then the source's search results for what the page calls itself. A page under the title's link is a chapter if one of its chapter
 * ids is in the rest of the address. Without a match, it's a search for the page's title on that
 * source; the site's home page is that source's explore lists.
 */
export async function findPaperbackPage(url: string, titles: string[], saved: string[] = []): Promise<string> {
  const install = PAPERBACK_SUPPORTED ? await installOnSite(url) : undefined;
  if (!install) throw new Error('no installed Paperback source has this site');
  const config = paperbackSiteConfig(install);
  const page = comparable(url);
  const home = comparable(install.listing.websiteBaseURL);
  const explore = chrome.runtime.getURL(`explore.html?${new URLSearchParams({ source: config.id })}`);
  if (page === home) return explore;

  const runtime = paperbackRuntime(config)!;
  const client = new PaperbackClient(config, runtime);
  const urls = paperbackUrls(config.id);
  /** Where the page is if it's this title's page or, unless `exact`, one of its chapters. */
  const place = async (mangaUrl: string, exact = false): Promise<string | undefined> => {
    let link: string;
    try {
      const share = await runtime.call('getMangaShareUrl', [urls.mangaId(mangaUrl)]);
      if (typeof share !== 'string') return undefined;
      link = comparable(share);
    } catch {
      return undefined;
    }
    if (page === link) return previewUrl(mangaUrl);
    if (exact || !within(page, link)) return undefined;
    // Below the title's own page: look for the chapter in the rest of the address.
    const rest = page.slice(link.length + 1);
    const { chapters } = await client.loadSeries(mangaUrl).catch(() => ({ chapters: [] }));
    const chapter = chapters.find((c) => {
      const id = urls.chapterIds(c.url).chapterId.toLowerCase().replace(/\/+$/, '');
      const tail = id.includes('/') ? id.split('/').filter(Boolean).at(-1)! : id;
      return rest === tail || rest.split('/').includes(tail);
    });
    return chapter ? readerUrl(chapter.url) : previewUrl(mangaUrl);
  };

  for (const mangaUrl of saved.filter((u) => u.startsWith(`${urls.base}/manga/`))) {
    const found = await place(mangaUrl);
    if (found) return found;
  }
  // The address usually holds the title's id: a guess the source turns back into exactly this page
  // is it. Not one whose page is merely above this one: Dynasty's "series" would be the directory.
  const guesses = idGuesses(url);
  for (const id of guesses) {
    const found = await place(urls.manga(id), true);
    if (found) return found;
  }
  if (!titles.length) return explore;
  // Sources without share URLs: the likeliest ids (the address's last segments) whose details carry this page's title.
  const wanted = new Set(titles.map(sameTitle));
  const pagePath = decodeURI(new URL(url).pathname).replace(/\/+$/, '');
  for (const id of guesses.filter((g) => pagePath.endsWith(`/${g}`)).slice(0, ID_DETAILS_TRIES)) {
    const details = await runtime.call('getMangaDetails', [id]).catch(() => undefined);
    const names = (details as { mangaInfo?: { titles?: unknown } } | undefined)?.mangaInfo?.titles;
    if (Array.isArray(names) && names.some((n) => typeof n === 'string' && wanted.has(sameTitle(n)))) return previewUrl(urls.manga(id));
  }
  for (const title of titles.slice(0, 3)) {
    const results = await client.search(title).catch(() => []);
    for (const result of results.slice(0, MATCH_RESULTS)) {
      const found = await place(result.url);
      if (found) return found;
    }
  }
  return chrome.runtime.getURL(`search.html?${new URLSearchParams({ q: titles[0]!, source: config.id })}`);
}

// ---- Installing ------------------------------------------------------------------------------

/** Reads a repo's list of sources. Repos are public files, usually on GitHub Pages. */
export async function fetchPaperbackRepo(input: string): Promise<PaperbackRepo> {
  const url = paperbackRepoUrl(input);
  let res: Response;
  try {
    res = await fetch(`${url}/versioning.json`, { cache: 'no-store', credentials: 'omit' });
  } catch (err) {
    throw new Error(`couldn’t reach the repo: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) throw new Error('there’s no Paperback repo at that address (no versioning.json). use the repo’s own address, e.g. https://someone.github.io/extensions/0.8');
  if (!res.ok) throw new Error(`the repo answered HTTP ${res.status}`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    throw new Error('the repo’s versioning.json isn’t valid JSON');
  }
  return parsePaperbackRepo(url, raw);
}

/** Downloads a source's code and installs it, replacing an installed source with the same id. */
export async function installPaperback(repoUrl: string, sourceId: string): Promise<SiteConfig> {
  if (!PAPERBACK_SUPPORTED) throw new Error('Paperback sources work in Chrome and Edge only');
  const repo = await fetchPaperbackRepo(repoUrl);
  const listing = repo.sources.find((s) => s.id === sourceId);
  if (!listing) throw new Error(`the repo doesn’t list ${sourceId} anymore`);
  const res = await fetch(paperbackFiles(repo.url, listing).code, { cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`couldn’t download ${listing.name}’s code (HTTP ${res.status})`);
  const code = await res.text();
  if (code.length > MAX_CODE_BYTES) throw new Error(`${listing.name}’s code is too big`);

  const configId = paperbackConfigId(listing.id);
  dropRuntime(configId);
  const install: PaperbackInstall = { repo: repo.url, listing, sections: [], installedAt: new Date().toISOString() };
  await savePaperbackInstall(install, code);
  // Explore tabs come from the source's home page sections. Best effort: a source that can't
  // load its home page right now still installs, just without explore.
  try {
    install.sections = await homeSections(paperbackSiteConfig(install));
    await savePaperbackInstall(install);
  } catch (err) {
    console.warn(`couldn’t read ${listing.name}’s home sections`, err);
  }
  // The config gained its sections: clients built from the old one must not be reused.
  runtimes.delete(configId);
  return paperbackSiteConfig(install);
}

/** The source's home page sections (its explore tabs), giving up after a while. */
function homeSections(config: SiteConfig): Promise<PaperbackSection[]> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the home page took too long')), SECTIONS_TIMEOUT_MS));
  return Promise.race([paperbackSections(paperbackRuntime(config)!), timeout]);
}

const sectionTries = new Map<string, number>();
/** Tries a source without explore lists again at most this often. */
const SECTIONS_RETRY_MS = 10 * 60_000;

/**
 * Reads the explore lists of a source that got none at install, e.g. because its site's
 * Cloudflare check blocked it then. Best effort, and not more than every few minutes.
 */
export async function retryPaperbackSections(config: SiteConfig): Promise<void> {
  if (!PAPERBACK_SUPPORTED || !config.paperback || config.paperback.sections.length) return;
  if (Date.now() - (sectionTries.get(config.id) ?? 0) < SECTIONS_RETRY_MS) return;
  sectionTries.set(config.id, Date.now());
  try {
    const install = await installOf(config.id);
    if (install.sections.length) return;
    install.sections = await homeSections(config);
    if (!install.sections.length) return;
    await savePaperbackInstall(install);
    // The config gained explore lists: the client built from the old one must not be reused.
    runtimes.delete(config.id);
  } catch (err) {
    console.warn(`couldn’t read ${config.name}’s home sections`, err);
  }
}

export async function removePaperback(configId: string): Promise<void> {
  dropRuntime(configId);
  await forgetSourceImages(configId);
  await removePaperbackInstall(configId);
}

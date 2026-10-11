// The host side of Paperback's 0.8 extension API: the global `App` that source bundles call to
// build requests, results and settings, and a loader that runs a bundle against it. Plain
// JavaScript with no browser APIs, so it runs the same in the extension's sandbox and in tests.
//
// Everything a source can do from here goes through a PaperbackBridge the host provides: making
// HTTP requests and keeping a few settings. The host decides what those are allowed to reach.

/** An HTTP request ready to send: the source's interceptor has run and the body is encoded. */
export interface PbHttpRequest {
  url: string;
  method: string;
  /** Lowercase names. May include headers pages can't set themselves (cookie, referer, origin, user-agent). */
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface PbHttpResponse {
  status: number;
  /** Lowercase names. */
  headers: Record<string, string>;
  /** The body as text, for text responses. */
  text?: string;
  /** The body as base64, for binary responses. */
  base64?: string;
}

export interface PaperbackBridge {
  fetch(request: PbHttpRequest): Promise<PbHttpResponse>;
  getState(key: string): Promise<unknown>;
  setState(key: string, value: unknown): Promise<void>;
  /** What the source gets for getDefaultUserAgent(): the browser's own, so sites see one consistent client. */
  userAgent: string;
}

/** Calls the host makes on a loaded source. */
export type PaperbackMethod =
  | 'getMangaDetails'
  | 'getChapters'
  | 'getChapterDetails'
  | 'getSearchResults'
  | 'getViewMoreItems'
  | 'getMangaShareUrl'
  /** Every section getHomePageSections reports, in its final state. */
  | 'getHomePageSections'
  /** The headers the source's interceptor adds to a plain GET of `args[0]` (for loading its images). */
  | 'requestHeaders';

/** Something that runs a source's methods: a PaperbackInstance, or a proxy to one in a sandbox. */
export interface PaperbackRuntime {
  call(method: PaperbackMethod, args?: unknown[]): Promise<unknown>;
}

// ---- Paperback's object shapes (as sources build them) -------------------------------------

export interface PbRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: unknown;
  param?: string;
  cookies: { name: string; value: string; domain?: string }[];
}

export interface PbResponse {
  data?: string;
  rawData?: Uint8Array;
  status: number;
  headers: Record<string, string>;
  request: PbRequest;
}

interface PbInterceptor {
  interceptRequest(request: PbRequest): Promise<PbRequest>;
  interceptResponse(response: PbResponse): Promise<PbResponse>;
}

interface PbSource {
  requestManager?: RequestManager;
  getHomePageSections?(callback: (section: { id: string }) => void): Promise<void>;
  [method: string]: unknown;
}

/** Most requests per second a source may make, whatever it asks for. */
const MAX_RPS = 10;
const DEFAULT_TIMEOUT_MS = 20_000;

class RequestManager {
  readonly requestsPerSecond: number;
  readonly requestTimeout: number;
  readonly interceptor?: PbInterceptor;
  private nextSlot = 0;

  constructor(
    info: { requestsPerSecond?: number; requestTimeout?: number; interceptor?: PbInterceptor },
    private readonly bridge: PaperbackBridge,
  ) {
    this.requestsPerSecond = Math.min(Math.max(Number(info.requestsPerSecond) || 2.5, 0.2), MAX_RPS);
    this.requestTimeout = Number(info.requestTimeout) > 0 ? Number(info.requestTimeout) : DEFAULT_TIMEOUT_MS;
    this.interceptor = info.interceptor;
  }

  async getDefaultUserAgent(): Promise<string> {
    return this.bridge.userAgent;
  }

  async schedule(request: PbRequest, _retries?: number): Promise<PbResponse> {
    const intercepted = this.interceptor ? await this.interceptor.interceptRequest(request) : request;
    await this.throttle();
    const res = await this.bridge.fetch(toHttpRequest(intercepted, this.requestTimeout));
    const response: PbResponse = {
      status: res.status,
      headers: caseInsensitive(res.headers),
      data: res.text,
      rawData: res.base64 === undefined ? undefined : rawData(res.base64),
      request: intercepted,
    };
    return this.interceptor ? this.interceptor.interceptResponse(response) : response;
  }

  /** Spaces requests out to the source's requests-per-second. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + 1000 / this.requestsPerSecond;
    if (slot > now) await new Promise((resolve) => setTimeout(resolve, slot - now));
  }
}

/** Turns a source's request into one the host can send: URL with `param`, cookies as a header, encoded body. */
export function toHttpRequest(request: PbRequest, timeoutMs: number): PbHttpRequest {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (value !== undefined && value !== null) headers[name.toLowerCase()] = String(value);
  }
  const cookies = (request.cookies ?? []).filter((c) => c?.name).map((c) => `${c.name}=${c.value ?? ''}`);
  if (cookies.length) headers.cookie = [headers.cookie, ...cookies].filter(Boolean).join('; ');
  const method = String(request.method || 'GET').toUpperCase();
  let body: string | undefined;
  const data = request.data;
  if (data !== undefined && data !== null && method !== 'GET' && method !== 'HEAD') {
    if (typeof data === 'string') body = data;
    else if (headers['content-type']?.includes('json')) body = JSON.stringify(data);
    else {
      // Paperback sends objects as a form; sources encode values themselves (urlEncodeObject).
      body = Object.entries(data as Record<string, unknown>).map(([k, v]) => `${k}=${v}`).join('&');
      headers['content-type'] ??= 'application/x-www-form-urlencoded';
    }
  }
  return { url: `${request.url}${request.param ?? ''}`, method, headers, body, timeoutMs };
}

/** Sources read headers the way the site sent them (`headers['Link']`); fetch gives lowercase names. */
function caseInsensitive(headers: Record<string, string>): Record<string, string> {
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) lower[name.toLowerCase()] = value;
  return new Proxy(lower, {
    get: (target, key) => (typeof key === 'string' ? target[key.toLowerCase()] : undefined),
    has: (target, key) => typeof key === 'string' && key.toLowerCase() in target,
  });
}

function rawData(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Object.assign(bytes, { toString: () => new TextDecoder().decode(bytes) });
}

function createApp(bridge: PaperbackBridge): Record<string, unknown> {
  const scope = (prefix: string) => ({
    store: (key: string, value: unknown) => bridge.setState(`${prefix}${key}`, value),
    retrieve: (key: string) => bridge.getState(`${prefix}${key}`),
  });
  type Info = Record<string, unknown>;
  const factories: Record<string, (info: Info) => unknown> = {
    createRequest: (info) => ({
      url: String(info.url),
      method: String(info.method ?? 'GET'),
      headers: { ...(info.headers as Info | undefined) },
      data: info.data,
      param: info.param,
      cookies: [...((info.cookies as unknown[] | undefined) ?? [])],
    }),
    createRequestManager: (info) => new RequestManager(info, bridge),
    createSourceStateManager: () => ({ ...scope('state:'), keychain: scope('keychain:') }),
    createSourceManga: (info) => ({ id: info.id, mangaInfo: info.mangaInfo }),
    createMangaInfo: (info) => ({ artist: '', author: '', hentai: false, tags: [], covers: [], ...info }),
    createChapter: (info) => ({ name: '', volume: 0, group: '', langCode: '', ...info }),
    createHomeSection: (info) => ({ ...info, items: info.items ?? [] }),
    createPagedResults: (info) => ({ results: info.results ?? [], metadata: info.metadata }),
    createRawData: (info) => info.byteArray,
  };
  // Everything else (tags, cookies, settings UI…) is a plain object of what the source passed in.
  return new Proxy(factories, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined;
      return target[key] ?? (key.startsWith('create') ? (info: Info) => ({ ...info }) : undefined);
    },
  });
}

/** Methods the host may call on a source, besides the special ones handled in `call`. */
const SOURCE_METHODS = new Set<string>(['getMangaDetails', 'getChapters', 'getChapterDetails', 'getSearchResults', 'getViewMoreItems', 'getMangaShareUrl']);

/** A loaded source bundle. */
export class PaperbackInstance implements PaperbackRuntime {
  private constructor(
    private readonly source: PbSource,
    private readonly app: Record<string, unknown>,
    readonly sourceId: string,
  ) {}

  /**
   * Runs a bundle (it defines `Sources`, an object of source classes and their info) and
   * creates the source named `sourceId`. Only call this where running the bundle is safe: in the
   * extension, that's a sandboxed page with no extension APIs.
   */
  static load(code: string, sourceId: string, bridge: PaperbackBridge): PaperbackInstance {
    const app = createApp(bridge);
    const holder: { Sources?: Record<string, unknown> } = {};
    // Newer toolchains (esbuild) leave a `_Sources` variable and assign `this.Sources`; older ones
    // (browserify, 0.8 alphas) are UMD bundles that set `Sources` on the global object.
    const scope = globalThis as { Sources?: Record<string, unknown> };
    const before = scope.Sources;
    const run = new Function('App', `${code}\n;return typeof _Sources !== 'undefined' ? _Sources : this.Sources;`) as (
      this: typeof holder,
      app: unknown,
    ) => Record<string, unknown> | undefined;
    let exported: Record<string, unknown> | undefined;
    try {
      exported = run.call(holder, app) ?? holder.Sources ?? (scope.Sources !== before ? scope.Sources : undefined);
    } finally {
      if (scope.Sources !== before) scope.Sources = before;
    }
    const Source = exported?.[sourceId];
    if (typeof Source !== 'function') throw new Error(`the source’s code doesn’t define ${sourceId}`);
    return new PaperbackInstance(new (Source as new (cheerio?: unknown) => PbSource)(undefined), app, sourceId);
  }

  async call(method: PaperbackMethod, args: unknown[] = []): Promise<unknown> {
    const source = this.source;
    if (method === 'getHomePageSections') {
      if (typeof source.getHomePageSections !== 'function') return [];
      // Sources report each section more than once (empty, then filled): keep the last of each.
      const sections = new Map<string, unknown>();
      await source.getHomePageSections((section) => section?.id !== undefined && sections.set(String(section.id), section));
      return [...sections.values()];
    }
    if (method === 'requestHeaders') {
      const request = (this.app.createRequest as (info: object) => PbRequest)({ url: String(args[0]), method: 'GET' });
      const interceptor = source.requestManager?.interceptor;
      return toHttpRequest(interceptor ? await interceptor.interceptRequest(request) : request, 0).headers;
    }
    const fn = source[method];
    if (!SOURCE_METHODS.has(method) || typeof fn !== 'function') throw new Error(`this source can’t do ${method}`);
    return (fn as (...a: unknown[]) => unknown).apply(source, args);
  }
}

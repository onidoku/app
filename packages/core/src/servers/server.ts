import { v, type Infer } from '../validate';
import type { SiteConfig } from '../siteConfig';
import type { ChapterContent, ChapterRef, SearchResult, Series } from '../types';

/**
 * Self-hosted media servers (Komga, Kavita) are sources too, but they're read through their
 * JSON APIs with the user's credentials instead of scraped with CSS selectors. Each server gets a
 * generated SiteConfig (see serverSiteConfig) so the library, search, explore and update checks
 * treat it like any other source; the config's `server` field routes loading to the API client.
 */
export const SERVER_KINDS = ['komga', 'kavita'] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];

export const SERVER_NAMES: Record<ServerKind, string> = { komga: 'Komga', kavita: 'Kavita' };

const BaseUrl = v
  .string()
  .trim()
  .url()
  .regex(/^https?:\/\//, 'must be an http(s) address')
  .transform((u) => {
    const url = new URL(u);
    url.hash = '';
    url.search = '';
    return url.href.replace(/\/+$/, '');
  });

/** A server as the user added it. Credentials stay in the extension's storage and never go in backups. */
export const ServerSchema = v
  .object({
    kind: v.enum(SERVER_KINDS),
    id: v.string().min(1),
    name: v.string().trim().min(1).max(80),
    /** Address of the server's web UI, e.g. `http://192.168.1.5:25600` or `https://example.org/komga`. */
    url: BaseUrl,
    apiKey: v.string().trim().min(1).optional(),
    /** Komga only: username (email) and password, for servers without API keys. */
    username: v.string().trim().min(1).optional(),
    password: v.string().min(1).optional(),
  })
  .strict()
  .refine((s) => Boolean(s.apiKey) || (s.kind === 'komga' && Boolean(s.username && s.password)), {
    message: 'needs an API key (Komga also accepts a username and password)',
    path: ['apiKey'],
  });
export type ServerConfig = Infer<typeof ServerSchema>;

/** What a generated SiteConfig says about its server; no credentials. */
export interface ServerRef {
  kind: ServerKind;
  url: string;
}

/** Stable id for a server, so removing and re-adding it keeps library entries working. */
export function serverId(kind: ServerKind, url: string): string {
  const { host, pathname } = new URL(url);
  const slug = `${host}${pathname}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${kind}.${slug}`.slice(0, 64);
}

/** Validates a server the user entered, filling in its id and a default name. */
export function parseServer(raw: unknown): ServerConfig {
  const input = { ...(raw as Record<string, unknown>) };
  const kind = SERVER_KINDS.find((k) => k === input.kind);
  if (kind && typeof input.url === 'string') {
    try {
      const url = BaseUrl.parse(input.url);
      input.id ??= serverId(kind, url);
      if (!input.name || (typeof input.name === 'string' && !input.name.trim())) input.name = `${SERVER_NAMES[kind]} (${new URL(url).host})`;
    } catch {
      // Reported by the schema below.
    }
  }
  for (const key of ['apiKey', 'username', 'password']) if (input[key] === '') delete input[key];
  const result = ServerSchema.safeParse(input);
  if (!result.success) {
    // A missing id or name only follows from a bad kind or address; report those instead.
    const issue = result.error.issues.find((i) => i.path[0] !== 'id' && i.path[0] !== 'name') ?? result.error.issues[0]!;
    throw new Error(`invalid server: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  return result.data;
}

/** Explore tabs every server offers, in this order. */
export const SERVER_EXPLORE = ['recently added', 'recently updated', 'all series'] as const;

const ICON_COLORS: Record<ServerKind, string> = { komga: '#005ed3', kavita: '#4ac694' };

/**
 * The SiteConfig a server appears as. Its selectors are never used (loading goes through the
 * server's API); the URL globs match the server's own web UI pages, which is also what library
 * entries link to.
 */
export function serverSiteConfig(server: ServerConfig): SiteConfig {
  const base = server.url;
  const pages = server.kind === 'komga'
    ? { series: `${base}/series/*`, chapter: `${base}/book/*` }
    : { series: `${base}/library/*/series/*`, chapter: `${base}/library/*/series/*/chapter/*` };
  const letter = SERVER_NAMES[server.kind].charAt(0);
  const icon = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${ICON_COLORS[server.kind]}"/><text x="16" y="22.5" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`,
  )}`;
  return {
    schema: 1,
    id: server.id,
    name: server.name,
    version: 1,
    icon,
    developer: `${SERVER_NAMES[server.kind]} server`,
    nsfw: false,
    series: { url: pages.series, title: 'title', chapters: { item: 'a', order: 'oldest-first' } },
    chapter: { url: pages.chapter, pages: 'img' },
    search: { url: `${base}/?search={query}`, item: 'a' },
    explore: SERVER_EXPLORE.map((name) => ({ name, url: `${base}/`, item: 'a' })),
    server: { kind: server.kind, url: base },
  };
}

/** A series and its chapters as the server lists them, plus how far the user has read there. */
export interface ServerSeries {
  series: Series;
  /** Oldest first. */
  chapters: ChapterRef[];
  /** The furthest chapter the server has marked as read, if any. */
  readUpTo?: string;
}

/** An authenticated connection to one server. */
export interface MediaServer {
  /** Checks the address and credentials; resolves to the account name. */
  verify(): Promise<string>;
  loadSeries(url: string): Promise<ServerSeries>;
  loadChapter(url: string): Promise<ChapterContent>;
  search(query: string): Promise<SearchResult[]>;
  /** `list` indexes SERVER_EXPLORE; `page` starts at 1. */
  explore(list: number, page: number): Promise<{ results: SearchResult[]; hasMore: boolean }>;
  /** Marks a chapter as read on the server. */
  markRead(chapterUrl: string): Promise<void>;
  /** Fetches an image (page or cover) with the server's credentials. */
  fetchImage(url: string): Promise<Blob>;
}

export interface ServerIO {
  fetch: typeof fetch;
  /** For EPUB text, which servers hand out as XHTML. */
  parseHtml(html: string, url: string): Document;
}

/** Shared request plumbing: error messages people can act on, and JSON handling. */
export class ServerHttp {
  readonly label: string;

  constructor(
    readonly server: ServerConfig,
    private readonly io: ServerIO,
  ) {
    this.label = `${SERVER_NAMES[server.kind]} at ${new URL(server.url).host}`;
  }

  url(path: string, query: Record<string, string | number | boolean | undefined> = {}): string {
    const url = new URL(`${this.server.url}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.href;
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.io.fetch(url, { ...init, credentials: 'omit' });
    } catch (err) {
      throw new Error(`couldn’t reach ${this.label}. check that it’s running and the address is right. (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.status === 401 || res.status === 403) throw new ServerAuthError(`${this.label} rejected the login. check the API key${this.server.kind === 'komga' ? ' or username and password' : ''}.`);
    if (!res.ok) throw new Error(`${this.label} answered HTTP ${res.status} for ${new URL(url).pathname}`);
    return res;
  }

  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, { ...init, headers: { accept: 'application/json', ...init.headers } });
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // Usually the address points at some other web page (a proxy's, or the server without its sub-path).
      throw new Error(`${this.label} didn’t answer like a ${SERVER_NAMES[this.server.kind]} server. check the address, including any sub-path like /${this.server.kind}.`);
    }
  }

  async text(url: string, init: RequestInit = {}): Promise<string> {
    return (await this.request(url, init)).text();
  }

  parse(html: string, url: string): Document {
    return this.io.parseHtml(html, url);
  }

  /** The numeric/opaque id after `segment` in one of the server's web UI URLs. */
  idAfter(url: string, segment: string): string {
    const path = new URL(url).pathname.slice(new URL(this.server.url).pathname.replace(/\/$/, '').length);
    const parts = path.split('/').filter(Boolean);
    const index = parts.indexOf(segment);
    const id = index >= 0 ? parts[index + 1] : undefined;
    if (!id) throw new Error(`not a ${SERVER_NAMES[this.server.kind]} ${segment} address: ${url}`);
    return decodeURIComponent(id);
  }
}

export class ServerAuthError extends Error {
  override name = 'ServerAuthError';
}

/** Image types every supported browser shows; servers convert anything else to PNG on request. */
export const BROWSER_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml']);

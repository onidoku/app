import { v, type Infer } from '../validate';
import type { SiteConfig } from '../siteConfig';

/**
 * Paperback (an iOS manga reader) has a large community catalogue of sources. A Paperback source
 * is a compiled JavaScript bundle, not data, so onidoku runs it in an isolated sandbox (see
 * PaperbackInstance) and gives it a generated SiteConfig, the same way media servers get one: the
 * library, search, explore and update checks then treat it like any other source, and the
 * config's `paperback` field routes loading to the sandbox.
 *
 * Only the 0.8 extension API is supported; it's what nearly every published repo targets.
 */
export const PAPERBACK_API = '0.8';

/**
 * Paperback identifies titles and chapters by opaque ids, but onidoku identifies them by URL. They
 * get URLs under this reserved host (`.invalid` never resolves), so they can't collide with a real
 * site or be opened by mistake: these chapters are read on the extension's reader page.
 */
export const PAPERBACK_ORIGIN = 'https://paperback.invalid';

const ContentRating = v.enum(['EVERYONE', 'MATURE', 'ADULT']);

/** One source as a repo's versioning.json lists it. Unknown fields are ignored. */
export const PaperbackListingSchema = v.object({
  id: v.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'must be 1-64 letters, digits, ".", "_" or "-"'),
  name: v.string().trim().min(1).max(80),
  author: v.string().optional(),
  desc: v.string().optional(),
  website: v.string().optional(),
  version: v.string().min(1).max(40),
  icon: v.string().regex(/^[\w.-]+$/, 'must be a file name').optional(),
  contentRating: ContentRating.default('EVERYONE'),
  websiteBaseURL: v.string().url().regex(/^https?:\/\//, 'must be an http(s) URL'),
  tags: v.array(v.object({ text: v.string(), type: v.string().optional() })).optional(),
  intents: v.number().optional(),
});
export type PaperbackListing = Infer<typeof PaperbackListingSchema>;

const RepoSchema = v.object({
  builtWith: v.object({ types: v.string(), toolchain: v.string().optional() }).optional(),
  sources: v.array(PaperbackListingSchema),
});

export interface PaperbackRepo {
  /** Base address, without a trailing slash; sources live at `<url>/<id>/source.js`. */
  url: string;
  /** The extension API version the repo was built with, e.g. "0.8.7". */
  types?: string;
  sources: PaperbackListing[];
}

/**
 * Reads a repo page's "add to Paperback" link (`paperback://addRepo?displayName=…&url=…`), which
 * only the iOS app can open. Null for any other link.
 */
export function paperbackRepoLink(href: string): { url: string; name?: string } | null {
  let link: URL;
  try {
    link = new URL(href.trim());
  } catch {
    return null;
  }
  if (link.protocol !== 'paperback:' || link.hostname.toLowerCase() !== 'addrepo') return null;
  const url = link.searchParams.get('url');
  if (!url) return null;
  const name = link.searchParams.get('displayName')?.trim();
  return name ? { url, name } : { url };
}

/** Normalizes what people paste: the repo's page, its versioning.json, the folder, or its paperback:// link. */
export function paperbackRepoUrl(input: string): string {
  const url = new URL(paperbackRepoLink(input)?.url ?? input.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('a repo address starts with https://');
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/(index\.html|versioning\.json)$/, '').replace(/\/+$/, '');
  return url.href.replace(/\/+$/, '');
}

/**
 * Validates a repo's versioning.json. Repos built for another extension API (0.6, 0.9 and later)
 * are refused: their sources call functions this host doesn't provide.
 */
export function parsePaperbackRepo(url: string, raw: unknown): PaperbackRepo {
  const result = RepoSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`this doesn’t look like a Paperback repo: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  const types = result.data.builtWith?.types;
  if (!types || !types.startsWith(`${PAPERBACK_API}.`)) {
    const built = types ? `version ${types}` : 'an old version (before 0.8)';
    throw new Error(`this repo is built for ${built} of Paperback; onidoku runs ${PAPERBACK_API} repos. many repos keep one folder per version, e.g. …/0.8`);
  }
  return { url: paperbackRepoUrl(url), types, sources: result.data.sources };
}

/** Where a listed source's code and icon are. */
export function paperbackFiles(repoUrl: string, listing: Pick<PaperbackListing, 'id' | 'icon'>) {
  const base = `${repoUrl}/${encodeURIComponent(listing.id)}`;
  return { code: `${base}/source.js`, icon: listing.icon ? `${base}/includes/${encodeURIComponent(listing.icon)}` : undefined };
}

/** A home page section, captured at install so it can be an explore tab. */
export interface PaperbackSection {
  id: string;
  title: string;
  /** Whether the section has a "view more" list (paged), not just the items on the home page. */
  more: boolean;
}

/** An installed Paperback source as stored; its code is stored separately (it's large). */
export interface PaperbackInstall {
  repo: string;
  listing: PaperbackListing;
  sections: PaperbackSection[];
  installedAt: string;
}

/** What a generated SiteConfig says about its Paperback source. */
export interface PaperbackRef {
  repo: string;
  /** The id within the repo, e.g. "MangaFox". */
  sourceId: string;
  version: string;
  /** The site's address, for "open site" links. */
  site: string;
  sections: PaperbackSection[];
}

/** Stable config id for a Paperback source; installing the same id from another repo replaces it. */
export function paperbackConfigId(sourceId: string): string {
  return `pb.${sourceId.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`.slice(0, 64);
}

/** Explore tabs a SiteConfig allows; sections past this aren't offered. */
const MAX_EXPLORE = 8;

/**
 * The SiteConfig a Paperback source appears as. Like a media server's, its selectors are never
 * used: loading goes through the source's code (see PaperbackClient).
 */
export function paperbackSiteConfig(install: PaperbackInstall): SiteConfig {
  const { listing } = install;
  const id = paperbackConfigId(listing.id);
  const urls = paperbackUrls(id);
  const icon = paperbackFiles(install.repo, listing).icon ?? letterIcon(listing.name);
  const sections = install.sections.slice(0, MAX_EXPLORE);
  return {
    schema: 1,
    id,
    name: listing.name,
    // SiteConfig versions are integers; the source's own version string is kept in `paperback`.
    version: 1,
    icon,
    developer: (listing.author?.trim() || 'Paperback source').slice(0, 80),
    nsfw: listing.contentRating === 'ADULT',
    series: { url: `${urls.base}/manga/*`, title: 'title', chapters: { item: 'a', order: 'oldest-first' } },
    chapter: { url: `${urls.base}/chapter/*/*`, pages: 'img' },
    search: { url: `${urls.base}/search?q={query}`, item: 'a' },
    ...(sections.length
      ? { explore: sections.map((s) => ({ name: s.title.trim().slice(0, 40) || s.id.slice(0, 40), url: `${urls.base}/section/${encodeURIComponent(s.id)}`, item: 'a' })) }
      : {}),
    paperback: { repo: install.repo, sourceId: listing.id, version: listing.version, site: listing.websiteBaseURL.replace(/\/+$/, ''), sections },
  };
}

/** Builds and reads the URLs a Paperback source's titles and chapters get. */
export function paperbackUrls(configId: string) {
  const base = `${PAPERBACK_ORIGIN}/${configId}`;
  const part = (url: string, kind: 'manga' | 'chapter'): string[] | undefined => {
    if (!url.startsWith(`${base}/${kind}/`)) return undefined;
    const path = new URL(url).pathname.slice(`/${configId}/${kind}/`.length).replace(/\/+$/, '');
    return path.split('/').map(decodeURIComponent);
  };
  return {
    base,
    manga: (mangaId: string) => `${base}/manga/${encodeURIComponent(mangaId)}`,
    chapter: (mangaId: string, chapterId: string) => `${base}/chapter/${encodeURIComponent(mangaId)}/${encodeURIComponent(chapterId)}`,
    mangaId(url: string): string {
      const [mangaId, extra] = part(url, 'manga') ?? [];
      if (!mangaId || extra !== undefined) throw new Error(`not a title of this Paperback source: ${url}`);
      return mangaId;
    },
    chapterIds(url: string): { mangaId: string; chapterId: string } {
      const [mangaId, chapterId, extra] = part(url, 'chapter') ?? [];
      if (!mangaId || !chapterId || extra !== undefined) throw new Error(`not a chapter of this Paperback source: ${url}`);
      return { mangaId, chapterId };
    },
  };
}

/** A plain icon for sources whose repo has none. */
function letterIcon(name: string): string {
  const letter = name.trim().charAt(0).toUpperCase() || 'P';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#e5484d"/><text x="16" y="22.5" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="#fff" text-anchor="middle">${letter.replace(/[<&>"]/g, '')}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

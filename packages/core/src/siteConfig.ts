import { v, type Infer } from './validate';
import type { PaperbackRef } from './paperback/repo';
import type { ServerRef } from './servers/server';

/**
 * A CSS selector, or a selector plus the attribute(s) to read (first non-empty wins).
 * A bare selector reads the field's natural value: text for titles, `href` for links,
 * lazy-load attributes then `src` for images.
 */
export const FieldSchema = v.union([
  v.string().min(1),
  v
    .object({
      selector: v.string().min(1),
      attr: v.union([v.string().min(1), v.array(v.string().min(1), { min: 1 })]).optional(),
    })
    .strict(),
]);
export type Field = Infer<typeof FieldSchema>;

/**
 * Where to load more of the page from, for sites that fetch content after the page loads:
 * a URL read from the page (e.g. a "show all" button's `hx-get`), or a template in which
 * `{url}` is the page's own URL. Only URLs on the same site as the page are ever loaded.
 */
export const SourceSchema = v.union([
  FieldSchema,
  v.object({ template: v.string().includes('{url}', { message: 'template must contain {url}' }) }).strict(),
]);
export type Source = Infer<typeof SourceSchema>;

/** Source icon shown next to its name: an http(s) URL (usually the site's favicon) or an inline data: image. */
const IconUrl = v
  .string()
  .regex(/^(https?:\/\/[^/]+\/|data:image\/)/, 'must be an http(s) URL or a data:image/ URL');

/** A page listing series (search results, a genre, an author's works). */
const ListSchema = v
  .object({
    url: v
      .string()
      .regex(/^(https?:\/\/[^/*]+\/|\{url\})/, 'must be an http(s) URL with a literal host, or start with {url}')
      .refine((u) => /\{(url|slug|name)\}/.test(u), 'must contain {url}, {slug} or {name}'),
    item: v.string().min(1),
    title: FieldSchema.optional(),
    link: FieldSchema.optional(),
    cover: FieldSchema.optional(),
  })
  .strict();
export type ListSpec = Infer<typeof ListSchema>;

/**
 * A page listing a site's titles to browse without a search term (popular, latest, a ranking).
 * `{page}` in the URL is replaced with the page number (1, 2, …) for "Load more".
 */
const ExploreSchema = v
  .object({
    name: v.string().min(1).max(40),
    url: v.string().regex(/^https?:\/\/[^/*]+\//, 'must be an http(s) URL with a literal host'),
    item: v.string().min(1),
    title: FieldSchema.optional(),
    link: FieldSchema.optional(),
    cover: FieldSchema.optional(),
  })
  .strict();
export type ExploreSpec = Infer<typeof ExploreSchema>;

const UrlPrefix = v.string().regex(/^https?:\/\/[^/*]+\//, 'must start with an http(s) origin and a "/"');

const UrlGlob = v
  .string()
  .regex(/^https?:\/\/[^/*]+\//, 'must be an http(s) URL glob with a literal host, e.g. "https://example.com/series/*"');

/**
 * Site configs are declarative data, never code: browser stores forbid extensions from
 * running remotely loaded scripts, and data is far easier to review and sandbox.
 */
export const SiteConfigSchema = v
  .object({
    schema: v.literal(1),
    id: v
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, 'must be 2-64 chars of lowercase letters, digits, ".", "_" or "-"'),
    name: v.string().min(1).max(80),
    version: v.number().int().min(0),
    icon: IconUrl,
    /** Who wrote and maintains the config (not the site's owner). */
    developer: v.string().min(1).max(80),
    /** True when the site hosts adult (18+) content; such sources can be hidden in search. */
    nsfw: v.boolean(),
    /**
     * Prefix replacements for cover image URLs, first match wins. For sites whose image server
     * refuses requests not coming from the site itself, when the same images are also served from
     * a host that doesn't check (covers are shown on extension pages, outside the site).
     */
    coverRewrite: v
      .array(v.object({ from: UrlPrefix, to: UrlPrefix }).strict())
      .optional(),
    series: v
      .object({
        url: UrlGlob,
        title: FieldSchema,
        cover: FieldSchema.optional(),
        description: FieldSchema.optional(),
        /** Matches every author element (e.g. each link in an author list). */
        authors: FieldSchema.optional(),
        /** Matches every genre/tag element. */
        genres: FieldSchema.optional(),
        status: FieldSchema.optional(),
        chapters: v
          .object({
            /** Selector for each chapter entry; the entry is the link itself or contains one. */
            item: v.string().min(1),
            title: FieldSchema.optional(),
            link: FieldSchema.optional(),
            order: v.enum(['newest-first', 'oldest-first']).default('newest-first'),
            /** Load the chapter list from another URL; `item` then applies to that document. */
            from: SourceSchema.optional(),
            /**
             * For lists split over several pages: the link to the next page (e.g. `a[rel=next]`),
             * followed until there is none. `order` describes the whole list across pages.
             */
            next: FieldSchema.optional(),
          })
          .strict(),
      })
      .strict(),
    chapter: v
      .object({
        url: UrlGlob,
        title: FieldSchema.optional(),
        /** Image pages (manga/comics). Exactly one of `pages` or `text` is required. */
        pages: FieldSchema.optional(),
        /** Container of the chapter text (novels). */
        text: FieldSchema.optional(),
        next: FieldSchema.optional(),
        prev: FieldSchema.optional(),
        series: FieldSchema.optional(),
        /** Load `pages`/`text` from another URL; the other fields still come from the page. */
        from: SourceSchema.optional(),
      })
      .strict()
      .refine((c) => Boolean(c.pages) !== Boolean(c.text), {
        message: 'must define exactly one of "pages" or "text"',
      }),
    /**
     * Optional: list a site's titles by author or genre. `url` is a template: `{url}` is the link
     * the author/genre had on the series page, `{slug}` its name as a URL slug ("Slice of Life" →
     * "slice-of-life") and `{name}` its name URL-encoded. Lists are read like search results.
     */
    browse: v
      .object({ authors: ListSchema.optional(), genres: ListSchema.optional() })
      .strict()
      .optional(),
    /** Optional: lists to browse on the Explore page, shown as tabs in this order (e.g. Popular, Latest). */
    explore: v.array(ExploreSchema, { min: 1, max: 8 }).optional(),
    /** Optional: lets the extension search the site. Results must link to series pages. */
    search: v
      .object({
        /** Search results URL; `{query}` is replaced with the URL-encoded search text. Same host as series pages. */
        url: v
          .string()
          .regex(/^https?:\/\/[^/*]+\//, 'must be an http(s) URL with a literal host')
          .includes('{query}', { message: 'must contain {query}' }),
        /** Selector for each result; the result is the link itself or contains one. */
        item: v.string().min(1),
        title: FieldSchema.optional(),
        link: FieldSchema.optional(),
        cover: FieldSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((c) => !c.search || hostOf(c.search.url) === hostOf(c.series.url), {
    message: 'must be on the same host as series.url',
    path: ['search', 'url'],
  })
  .superRefine((c, ctx) => {
    for (const kind of ['authors', 'genres'] as const) {
      const url = c.browse?.[kind]?.url;
      if (url && !url.startsWith('{url}') && hostOf(url) !== hostOf(c.series.url)) {
        ctx.addIssue({ message: 'must be on the same host as series.url', path: ['browse', kind, 'url'] });
      }
    }
    c.explore?.forEach((list, i) => {
      if (hostOf(list.url) !== hostOf(c.series.url)) {
        ctx.addIssue({ message: 'must be on the same host as series.url', path: ['explore', i, 'url'] });
      }
    });
  });

export type SiteConfig = Infer<typeof SiteConfigSchema> & {
  /** Only on configs generated for a media server (serverSiteConfig); JSON configs can't set it. */
  server?: ServerRef;
  /** Only on configs generated for a Paperback source (paperbackSiteConfig); JSON configs can't set it. */
  paperback?: PaperbackRef;
};

export class SiteConfigError extends Error {
  override name = 'SiteConfigError';
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
  }
}

function hostOf(urlOrGlob: string): string {
  return urlOrGlob.match(/^https?:\/\/([^/]+)/)?.[1] ?? '';
}

/** Match patterns (`scheme://host/*`) for the hosts a config's pages live on. */
export function configOrigins(config: SiteConfig): string[] {
  // A Paperback source is code that may load from any host (its site, image servers, APIs).
  if (config.paperback) return ['https://*/*', 'http://*/*'];
  const origins = [config.series.url, config.chapter.url].map((glob) => `${glob.match(/^https?:\/\/[^/]+/)![0]}/*`);
  return [...new Set(origins)];
}

export function parseSiteConfig(raw: unknown): SiteConfig {
  const result = SiteConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new SiteConfigError(`invalid site config: ${issues[0]}`, issues);
  }
  return result.data;
}

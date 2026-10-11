import type { Field, ListSpec, SiteConfig, Source } from './siteConfig';
import type { BrowseKind, ChapterContent, ChapterRef, SearchResult, Series } from './types';
import { globToRegExp, normalizeUrl, resolveUrl } from './url';

/** Attributes sites use for lazy-loaded images, most specific first. */
export const IMAGE_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'src'];
const LINK_ATTRS = ['href'];
const TEXT: null = null;

export class ExtractError extends Error {
  override name = 'ExtractError';
}

/** A parsed document plus the URL it came from (for resolving relative links). */
export interface Page {
  doc: Document;
  url: string;
}

export function seriesIdFor(configId: string, url: string): string {
  return `${configId}:${normalizeUrl(url).replace(/\/+$/, '')}`;
}

/**
 * Reads a series page. `list` is the separately loaded chapter list for configs with
 * `chapters.from` or `chapters.next` (see loadSeries), in page order; without it the list is
 * read from the page itself.
 */
export function extractSeries(
  doc: Document,
  url: string,
  config: SiteConfig,
  list: Page | Page[] = { doc, url },
): { series: Series; chapters: ChapterRef[] } {
  const { series: spec } = config;
  const title = readOne(doc, spec.title, TEXT);
  if (!title) throw new ExtractError(`${config.id}: series title not found (${describe(spec.title)})`);

  const chapters: ChapterRef[] = [];
  const seen = new Set<string>();
  for (const page of Array.isArray(list) ? list : [list]) {
    for (const item of Array.from(page.doc.querySelectorAll(spec.chapters.item))) {
      const href = spec.chapters.link
        ? readOne(item, spec.chapters.link, LINK_ATTRS)
        : item.matches('a[href]')
          ? item.getAttribute('href')
          : readOne(item, 'a[href]', LINK_ATTRS);
      const chapterUrl = resolveUrl(href, page.url);
      if (!chapterUrl || seen.has(chapterUrl)) continue;
      seen.add(chapterUrl);
      const chapterTitle = spec.chapters.title ? readOne(item, spec.chapters.title, TEXT) : clean(item.textContent);
      chapters.push({ url: chapterUrl, title: chapterTitle || chapterUrl });
    }
  }
  if (spec.chapters.order === 'newest-first') chapters.reverse();

  const series: Series = {
    id: seriesIdFor(config.id, url),
    siteId: config.id,
    url: normalizeUrl(url),
    title,
    cover: coverUrl(readOne(doc, spec.cover, IMAGE_ATTRS), url, config),
    description: spec.description ? readDescription(doc, spec.description) : undefined,
    status: readOne(doc, spec.status, TEXT),
  };
  const links: NonNullable<Series['links']> = {};
  for (const kind of ['authors', 'genres'] as const) {
    const field = spec[kind];
    if (!field) continue;
    const found = readNamedLinks(doc, field, url);
    series[kind] = found.names;
    if (Object.keys(found.links).length) links[kind] = found.links;
  }
  if (links.authors || links.genres) series.links = links;
  // Drop empty optional fields so stored entries stay small and comparisons stay simple.
  for (const key of Object.keys(series) as (keyof Series)[]) {
    const value = series[key];
    if (value === undefined || (Array.isArray(value) && !value.length)) delete series[key];
  }
  return { series, chapters };
}

/** Everything about a chapter page except its content: works even before images load. */
export function chapterLinks(doc: Document, url: string, config: SiteConfig): Omit<ChapterContent, 'body'> {
  const spec = config.chapter;
  return {
    url: normalizeUrl(url),
    title: readOne(doc, spec.title, TEXT),
    next: resolveUrl(readOne(doc, spec.next, LINK_ATTRS), url),
    prev: resolveUrl(readOne(doc, spec.prev, LINK_ATTRS), url),
    seriesUrl: resolveUrl(readOne(doc, spec.series, LINK_ATTRS), url),
  };
}

/**
 * Reads a chapter page. `content` is the separately loaded pages/text for configs with
 * `chapter.from` (see loadChapter); without it they're read from the page itself.
 */
export function extractChapter(doc: Document, url: string, config: SiteConfig, content: Page = { doc, url }): ChapterContent {
  const spec = config.chapter;
  const base = chapterLinks(doc, url, config);

  if (spec.pages) {
    const pages = unique(
      readAll(content.doc, spec.pages, IMAGE_ATTRS)
        .map((src) => resolveUrl(src, content.url))
        .filter((src): src is string => Boolean(src)),
    );
    if (!pages.length) throw new ExtractError(`${config.id}: no pages found (${describe(spec.pages)})`);
    return { ...base, body: { kind: 'images', pages } };
  }

  const selector = typeof spec.text === 'string' ? spec.text : spec.text!.selector;
  const container = content.doc.querySelector(selector);
  const paragraphs = container ? chapterParagraphs(content.doc, container) : [];
  if (!paragraphs.length) throw new ExtractError(`${config.id}: chapter text not found (${selector})`);
  return { ...base, body: { kind: 'text', paragraphs } };
}

/**
 * Names (text) of every element a field matches, plus the link each one is or sits in, when that
 * link stays on the page's site. Authors split on "/" or "," become separate names.
 */
function readNamedLinks(doc: Document, field: Field, pageUrl: string): { names: string[]; links: Record<string, string> } {
  const { selector, attrs } = normalize(field, TEXT);
  const host = new URL(pageUrl).host;
  const names: string[] = [];
  const links: Record<string, string> = {};
  for (const el of Array.from(doc.querySelectorAll(selector))) {
    const value = valueOf(el, attrs);
    if (!value) continue;
    const anchor = el.closest('a[href]') ?? el.querySelector('a[href]');
    const href = resolveUrl(anchor?.getAttribute('href'), pageUrl);
    // A single element listing several people ("A / B") without separate links.
    const parts = href ? [value] : value.split(/\s+\/\s+|\s*,\s+/).map(clean).filter(Boolean);
    for (const name of parts) {
      if (names.includes(name)) continue;
      names.push(name);
      if (href && new URL(href).host === host) links[name] = href;
    }
  }
  return { names, links };
}

/** "Slice of Life" → "slice-of-life", for sites whose list URLs use names. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The page listing a site's titles for an author or genre, or undefined if the config can't
 * browse that kind (or needs the name's link from a series page and none is known).
 */
export function browseUrl(config: SiteConfig, kind: BrowseKind, name: string, link?: string): string | undefined {
  const template = config.browse?.[kind]?.url;
  if (!template || (template.includes('{url}') && !link)) return undefined;
  const url = template
    .replaceAll('{url}', link ?? '')
    .replaceAll('{slug}', slugify(name))
    .replaceAll('{name}', encodeURIComponent(name));
  const resolved = resolveUrl(url, config.series.url.replace(/\*.*$/, ''));
  // Links come from site pages; never follow one off the site the config is for.
  if (!resolved || new URL(resolved).host !== new URL(config.series.url.replace(/\*.*$/, '')).host) return undefined;
  return resolved;
}

/** Page `page` (from 1) of one of the config's explore lists, or undefined if it has no such list. */
export function exploreUrl(config: SiteConfig, list: number, page = 1): string | undefined {
  return config.explore?.[list]?.url.replaceAll('{page}', String(Math.max(1, Math.floor(page))));
}

/** The URL to load for a search, or undefined if the config can't search. */
export function searchUrl(config: SiteConfig, query: string): string | undefined {
  return config.search?.url.replaceAll('{query}', encodeURIComponent(query.trim()));
}

/**
 * Reads a search results page. Only results linking to pages the config understands as series
 * pages are kept, so every result can be added to the library.
 */
export function extractSearch(doc: Document, url: string, config: SiteConfig): SearchResult[] {
  return config.search ? extractList(doc, url, config, config.search) : [];
}

/** Reads any page listing series (search results, an author's works, a genre) with the given selectors. */
export function extractList(
  doc: Document,
  url: string,
  config: SiteConfig,
  spec: Pick<ListSpec, 'item' | 'title' | 'link' | 'cover'>,
): SearchResult[] {
  const isSeries = globToRegExp(config.series.url);
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const item of Array.from(doc.querySelectorAll(spec.item))) {
    const href = spec.link
      ? readOne(item, spec.link, LINK_ATTRS)
      : item.matches('a[href]')
        ? item.getAttribute('href')
        : readOne(item, 'a[href]', LINK_ATTRS);
    const seriesUrl = resolveUrl(href, url);
    if (!seriesUrl || seen.has(seriesUrl) || !isSeries.test(seriesUrl)) continue;
    seen.add(seriesUrl);
    const title = (spec.title ? readOne(item, spec.title, TEXT) : clean(item.textContent)) || seriesUrl;
    const cover = coverUrl(readOne(item, spec.cover ?? 'img', IMAGE_ATTRS), url, config);
    results.push(cover ? { url: seriesUrl, title, cover } : { url: seriesUrl, title });
  }
  return results;
}

/** Resolves a cover's URL and applies the config's `coverRewrite`. */
function coverUrl(raw: string | undefined, base: string, config: SiteConfig): string | undefined {
  const resolved = resolveUrl(raw, base);
  const rule = resolved && config.coverRewrite?.find((r) => resolved.startsWith(r.from));
  return rule ? rule.to + resolved.slice(rule.from.length) : resolved;
}

/**
 * Resolves a config's `from` source against a page. Returns undefined when the page has no such
 * element (e.g. no "show all" button because every chapter is already listed), and refuses URLs
 * on other sites so a config can't make onidoku load content from anywhere else.
 */
export function sourceUrl(source: Source | undefined, doc: Document, pageUrl: string): string | undefined {
  if (!source) return undefined;
  const raw =
    typeof source === 'object' && 'template' in source
      ? source.template.replaceAll('{url}', normalizeUrl(pageUrl))
      : readOne(doc, source, LINK_ATTRS);
  const resolved = resolveUrl(raw, pageUrl);
  if (resolved && new URL(resolved).host !== new URL(pageUrl).host) {
    throw new ExtractError(`refusing to load ${resolved}: it is not on the same site as ${pageUrl}`);
  }
  return resolved;
}

/**
 * Copy of the container minus anything the site hides from readers: scripts, `hidden`/inline
 * `display:none` elements, and classes a <style> block hides (some sites hide anti-copy notices
 * this way, and they'd otherwise show up in the reader).
 */
function withoutHidden(doc: Document, container: Element): Element {
  const hiddenClasses = new Set<string>();
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    for (const rule of (style.textContent ?? '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!/display\s*:\s*none/i.test(rule[2]!)) continue;
      for (const selector of rule[1]!.split(',')) {
        const match = selector.trim().match(/^\.([\w-]+)$/);
        if (match) hiddenClasses.add(match[1]!);
      }
    }
  }
  const copy = container.cloneNode(true) as Element;
  const selectors = ['script', 'style', 'noscript', '[hidden]', '[style*="display:none"]', '[style*="display: none"]'];
  for (const name of hiddenClasses) selectors.push(`.${name}`);
  for (const el of Array.from(copy.querySelectorAll(selectors.join(',')))) el.remove();
  // "Chapter 2<br>Title" should read "Chapter 2 Title", not "Chapter 2Title".
  for (const br of Array.from(copy.querySelectorAll('br'))) br.replaceWith(doc.createTextNode(' '));
  return copy;
}

/** Paragraphs joined by blank lines; attribute fields (e.g. a meta tag's content) are read as-is. */
function readDescription(doc: Document, field: Field): string | undefined {
  if (typeof field !== 'string' && field.attr !== undefined) return readOne(doc, field, TEXT);
  const el = doc.querySelector(typeof field === 'string' ? field : field.selector);
  if (!el) return undefined;
  return paragraphsOf(withoutHidden(doc, el)).join('\n\n') || undefined;
}

/** A chapter text container's paragraphs, minus anything the site hides from readers. */
export function chapterParagraphs(doc: Document, container: Element): string[] {
  return paragraphsOf(withoutHidden(doc, container));
}

/** Plain-text paragraphs only: site HTML is never injected into the reader. */
function paragraphsOf(el: Element): string[] {
  const ps = Array.from(el.querySelectorAll('p'))
    .map((p) => clean(p.textContent))
    .filter(Boolean);
  if (ps.length) return ps;
  return (el.textContent ?? '').split(/\n/).map(clean).filter(Boolean);
}

function normalize(field: Field, defaultAttrs: string[] | null): { selector: string; attrs: string[] | null } {
  if (typeof field === 'string') return { selector: field, attrs: defaultAttrs };
  return { selector: field.selector, attrs: field.attr === undefined ? defaultAttrs : [field.attr].flat() };
}

export function valueOf(el: Element, attrs: string[] | null): string | undefined {
  if (!attrs) return clean(el.textContent) || undefined;
  for (const attr of attrs) {
    const value = el.getAttribute(attr)?.trim();
    // Lazy loaders park a tiny data: placeholder in src until the real image loads.
    if (value && !value.startsWith('data:')) return value;
  }
  return undefined;
}

function readOne(root: ParentNode, field: Field | undefined, defaultAttrs: string[] | null): string | undefined {
  if (!field) return undefined;
  const { selector, attrs } = normalize(field, defaultAttrs);
  const el = root.querySelector(selector);
  return el ? valueOf(el, attrs) : undefined;
}

function readAll(root: ParentNode, field: Field, defaultAttrs: string[] | null): string[] {
  const { selector, attrs } = normalize(field, defaultAttrs);
  return Array.from(root.querySelectorAll(selector))
    .map((el) => valueOf(el, attrs))
    .filter((v): v is string => Boolean(v));
}

function describe(field: Field): string {
  return typeof field === 'string' ? field : field.selector;
}

export function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

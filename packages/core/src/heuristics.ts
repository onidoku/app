import { chapterParagraphs, clean, IMAGE_ATTRS, valueOf } from './extract';
import type { ChapterContent } from './types';
import { normalizeUrl, resolveUrl } from './url';

const JUNK_SRC = /(logo|icon|avatar|banner|sprite|emoji|badge|pixel|\/ads?\/)/i;
const JUNK_CLASS = /\b(ad|ads|advert|logo|icon|avatar|banner)\b/i;
const MIN_SIDE = 200;

/**
 * Fallback for pages no site config covers: picks the largest group of content-sized images
 * that share a container. Works on most single-page chapter layouts.
 */
export function guessImagePages(doc: Document, url: string, minPages = 3): string[] {
  const groups = new Map<Element, string[]>();
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const image = imageSrc(img, url);
    if (!image || JUNK_SRC.test(image.src) || JUNK_CLASS.test(img.getAttribute('class') ?? '')) continue;
    const { src } = image;
    // In the live page the loaded size is known; otherwise only the attributes are.
    const width = (image.loaded && img.naturalWidth) || Number(img.getAttribute('width'));
    const height = (image.loaded && img.naturalHeight) || Number(img.getAttribute('height'));
    if ((width && width < MIN_SIDE) || (height && height < MIN_SIDE)) continue;

    // Climb past per-image wrappers (<figure>, <div class="page">) to the shared container.
    let container: Element = img.parentElement ?? img;
    while (container.parentElement && container.querySelectorAll('img').length < 2) {
      container = container.parentElement;
    }
    const group = groups.get(container) ?? [];
    group.push(src);
    groups.set(container, group);
  }

  let best: string[] = [];
  for (const group of groups.values()) if (group.length > best.length) best = group;
  return best.length >= minPages ? [...new Set(best)] : [];
}

const LAZY_ATTRS = IMAGE_ATTRS.filter((attr) => attr !== 'src');

/**
 * The image an <img> is for, and whether that's the one it has loaded (so its natural size is
 * meaningful). Lazy-load attributes win over what's loaded so far, since until the user scrolls
 * that's usually the site's placeholder. In the live page, a `blob:` URL the site's script made is
 * used as is (it stays usable while the page is open, and the reader runs in the same page).
 */
function imageSrc(img: HTMLImageElement, pageUrl: string): { src: string; loaded: boolean } | undefined {
  const current = typeof img.currentSrc === 'string' ? img.currentSrc : '';
  if (current.startsWith('blob:')) return { src: current, loaded: true };
  const lazy = resolveUrl(valueOf(img, LAZY_ATTRS) ?? largestCandidate(img.getAttribute('data-srcset')), pageUrl);
  if (lazy) return { src: lazy, loaded: lazy === current };
  // currentSrc covers <picture> and srcset; fetched HTML has no currentSrc.
  const src = resolveUrl(current && !current.startsWith('data:') ? current : (valueOf(img, ['src']) ?? largestCandidate(img.getAttribute('srcset'))), pageUrl);
  return src ? { src, loaded: src === current } : undefined;
}

function largestCandidate(srcset: string | null): string | undefined {
  let best: { url: string; size: number } | undefined;
  for (const candidate of (srcset ?? '').split(',')) {
    const [candidateUrl, descriptor = '1x'] = candidate.trim().split(/\s+/);
    const size = parseFloat(descriptor) || 1;
    if (candidateUrl && !candidateUrl.startsWith('data:') && (!best || size > best.size)) best = { url: candidateUrl, size };
  }
  return best?.url;
}

const NEXT_TEXT = /^(next|next chapter|next ch\.?|next episode|newer|›|»|→|>|>>)$/i;
const PREV_TEXT = /^(prev|previous|prev chapter|previous chapter|prev ch\.?|previous episode|older|‹|«|←|<|<<)$/i;
const NEXT_HINT = /\bnext\b/i;
const PREV_HINT = /\bprev(ious)?\b/i;
// The number must end there: in `/chapter/3f2e9a1c` the 3 is part of an id, not a chapter number.
const CHAPTER_NUMBER = /(?:chapter|chap|ch|episode|ep)[-_/ .]*(\d+(?:\.\d+)?)(?![\da-z])/gi;
/** Chapter pages addressed by id rather than number, e.g. `/chapter/3f2e9a1c` or `/viewer/12ab`. */
const CHAPTER_PATH = /\/(?:chapters?|episodes?|ch|ep|viewer)\/[^/]+/i;

/** The last chapter/episode number in a URL path, e.g. 12.5 for `/series/x/chapter-12.5/`. */
export function chapterNumber(url: string): number | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const matches = Array.from(path.matchAll(CHAPTER_NUMBER));
  const last = matches[matches.length - 1];
  return last ? Number(last[1]) : undefined;
}

/**
 * Fallback for pages no site config covers: finds the next/previous chapter links from
 * `rel` attributes, link wording ("Next chapter", "›") and chapter numbers in URLs.
 * Only links on the same site as the page are considered.
 */
export function guessChapterLinks(doc: Document, url: string): { next?: string; prev?: string } {
  const here = new URL(url);
  const self = resolveUrl(url, url);
  const current = chapterNumber(url);
  const best = { next: { url: undefined as string | undefined, score: 0 }, prev: { url: undefined as string | undefined, score: 0 } };

  const consider = (dir: 'next' | 'prev', href: string, score: number) => {
    if (score > best[dir].score) best[dir] = { url: href, score };
  };

  for (const el of Array.from(doc.querySelectorAll('a[href], link[href]'))) {
    const href = resolveUrl(el.getAttribute('href'), url);
    if (!href || new URL(href).origin !== here.origin || href === self) continue;
    if (el.matches('[aria-disabled="true"], .disabled')) continue;

    const rel = (el.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const label = [el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean).join(' ');
    const hints = `${el.getAttribute('class') ?? ''} ${el.getAttribute('id') ?? ''} ${label}`;
    const num = chapterNumber(href);
    const step = current !== undefined && num !== undefined ? num - current : undefined;

    for (const dir of ['next', 'prev'] as const) {
      const exact = dir === 'next' ? NEXT_TEXT : PREV_TEXT;
      const hint = dir === 'next' ? NEXT_HINT : PREV_HINT;
      let score = 0;
      if (rel.includes(dir) || (dir === 'prev' && rel.includes('previous'))) score += 3;
      if (exact.test(text) || exact.test(label.trim())) score += 2;
      else if (hint.test(text) || hint.test(hints)) score += 1;
      if (/chapter|episode/i.test(`${text} ${label}`) && score > 0) score += 1;
      // A chapter number one step away is strong evidence on its own; a number going the
      // wrong way rules the link out (e.g. "Next" pointing at a series' first chapter).
      if (step !== undefined) {
        const forward = dir === 'next' ? step > 0 : step < 0;
        if (!forward) continue;
        if (Math.abs(step) <= 1) score += 2;
      }
      consider(dir, href, score);
    }
  }
  return { next: best.next.url, prev: best.prev.url };
}

const MIN_TEXT_CHARS = 1500;
const MIN_PARAGRAPHS = 5;
/** Share of a container's text that may sit inside links before it reads as navigation, not prose. */
const MAX_LINK_DENSITY = 0.25;
const NOT_CONTENT = 'nav, header, footer, aside, form, [role=navigation], [role=complementary]';

/**
 * Fallback for novel pages no site config covers: finds the element holding the most prose,
 * either as <p> children or as text separated by <br> (common on translation sites), and
 * rejects link-heavy blocks like chapter lists and menus.
 */
export function guessTextParagraphs(doc: Document, minChars = MIN_TEXT_CHARS): string[] {
  const scores = new Map<Element, { chars: number; paragraphs: number; br: boolean }>();
  for (const p of Array.from(doc.querySelectorAll('p'))) {
    const parent = p.parentElement;
    const chars = clean(p.textContent).length;
    if (!parent || !chars) continue;
    const score = scores.get(parent) ?? { chars: 0, paragraphs: 0, br: false };
    scores.set(parent, { ...score, chars: score.chars + chars, paragraphs: score.paragraphs + 1 });
  }
  for (const el of Array.from(doc.querySelectorAll('div, article, section, td'))) {
    const lines = brLines(el);
    const chars = lines.reduce((sum, line) => sum + line.length, 0);
    if (lines.length >= MIN_PARAGRAPHS && chars > (scores.get(el)?.chars ?? 0)) {
      scores.set(el, { chars, paragraphs: lines.length, br: true });
    }
  }

  let best: { el: Element; br: boolean } | undefined;
  let bestChars = minChars - 1;
  for (const [el, { chars, paragraphs, br }] of scores) {
    if (chars <= bestChars || paragraphs < MIN_PARAGRAPHS || el.closest(NOT_CONTENT)) continue;
    if (linkDensity(el) > MAX_LINK_DENSITY) continue;
    best = { el, br };
    bestChars = chars;
  }
  if (!best) return [];
  return best.br ? brLines(best.el) : chapterParagraphs(doc, best.el);
}

/** The element's own text split at its <br> children, or [] when it has none. */
function brLines(el: Element): string[] {
  const lines: string[] = [];
  let current = '';
  let breaks = 0;
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 1 && (node as Element).tagName === 'BR') {
      breaks++;
      if (clean(current)) lines.push(clean(current));
      current = '';
    } else if (node.nodeType === 3 || (node.nodeType === 1 && /^(SPAN|EM|I|B|STRONG|A|FONT)$/.test((node as Element).tagName))) {
      current += node.textContent ?? '';
    }
  }
  if (clean(current)) lines.push(clean(current));
  return breaks ? lines : [];
}

function linkDensity(el: Element): number {
  const total = clean(el.textContent).length;
  if (!total) return 1;
  const linked = Array.from(el.querySelectorAll('a')).reduce((sum, a) => sum + clean(a.textContent).length, 0);
  return linked / total;
}

/** Reader-only mode for pages no site config covers: pages or text, title and chapter links, all guessed. */
export function guessChapter(doc: Document, url: string): ChapterContent | undefined {
  const pages = guessImagePages(doc, url);
  const paragraphs = pages.length ? [] : guessTextParagraphs(doc);
  if (!pages.length && !paragraphs.length) return undefined;
  const title = doc.title.trim() || doc.querySelector('h1')?.textContent?.trim() || undefined;
  const body: ChapterContent['body'] = pages.length ? { kind: 'images', pages } : { kind: 'text', paragraphs };
  return { url: normalizeUrl(url), title, body, ...guessChapterLinks(doc, url) };
}

const CHAPTER_HEADING =
  /\b(chapter|chap|ch|episode|ep|part|vol|volume)\.?\s*\d+|\b(prologue|epilogue|interlude)\b|第\s*[\d〇一二三四五六七八九十百千]+\s*[话話章回集]|제\s*\d+\s*화/i;

export interface Detection {
  kind: ChapterContent['body']['kind'];
  /** Why the page looks like a chapter: a chapter number in the URL, a chapter-like heading, chapter links. */
  signals: ('url' | 'heading' | 'links')[];
}

/**
 * Whether a page without a site config looks like a comic or novel chapter, for offering the
 * reader unprompted. Stricter than guessChapter (which runs only when the user asks): besides
 * content, it needs two independent chapter signals, so articles, galleries and shop pages
 * with a "Next" link don't trigger it.
 */
export function detectChapter(doc: Document, url: string): Detection | undefined {
  const chapter = guessChapter(doc, url);
  if (!chapter) return undefined;
  const signals: Detection['signals'] = [];
  if (chapterNumber(url) !== undefined || CHAPTER_PATH.test(safePath(url))) signals.push('url');
  const headings = [doc.title, ...Array.from(doc.querySelectorAll('h1, h2, h3')).slice(0, 5).map((h) => h.textContent ?? '')];
  if (headings.some((text) => CHAPTER_HEADING.test(text))) signals.push('heading');
  if (chapter.next || chapter.prev || hasChapterControls(doc)) signals.push('links');
  return signals.length >= 2 ? { kind: chapter.body.kind, signals } : undefined;
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

const CHAPTER_CONTROL = /^(next|prev|previous)\s+(chapter|episode|ch\.?)$/i;

/** Next/previous chapter buttons that aren't links (apps that change chapters with script). */
function hasChapterControls(doc: Document): boolean {
  return Array.from(doc.querySelectorAll('button, [role=button], a:not([href])')).some((el) =>
    [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')].some((text) => CHAPTER_CONTROL.test(clean(text))),
  );
}

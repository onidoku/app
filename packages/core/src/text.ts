import type { TextBlock } from './types';
import { resolveUrl } from './url';

const SKIP = new Set(['script', 'style', 'noscript', 'head', 'template', 'button', 'input', 'select', 'textarea', 'audio', 'video', 'iframe', 'object', 'math']);
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const LEAF_BLOCKS = new Set(['p', 'dt', 'dd', 'figcaption', 'caption', 'summary']);
// Elements that start a new block; a div holding only text and inline elements is a paragraph.
const BLOCK_TAGS = new Set([
  ...Object.keys(HEADINGS), ...LEAF_BLOCKS, 'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'figure',
  'blockquote', 'pre', 'ul', 'ol', 'li', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'hr', 'img', 'svg', 'body',
]);

export interface BlockOptions {
  /** Which image URLs may be shown (e.g. only the book's own resources). Images are left out without it. */
  allowImage?(url: string): boolean;
  /** Start at the element with this id (a table-of-contents anchor) instead of the top. */
  startId?: string;
  /** Stop before the element with this id. */
  endId?: string;
}

/**
 * A book page's structure as plain-text blocks: headings, paragraphs, quotes, code, list items,
 * table rows and images, in reading order. Never HTML, so nothing from the book runs or styles
 * the reader.
 */
export function htmlBlocks(doc: Document, url: string, options: BlockOptions = {}): TextBlock[] {
  const blocks: TextBlock[] = [];
  // An anchor that isn't in the page (renamed by the server, say) mustn't empty the chapter.
  const has = (id: string | undefined) => Boolean(id && doc.querySelector(`[id="${cssEscape(id)}"]`));
  options = { ...options, startId: has(options.startId) ? options.startId : undefined, endId: has(options.endId) ? options.endId : undefined };
  let collecting = !options.startId;
  let done = false;

  const push = (block: TextBlock) => {
    if (collecting && !done) blocks.push(block);
  };
  const image = (el: Element) => {
    const raw = el.getAttribute('src') ?? el.getAttribute('href') ?? el.getAttribute('xlink:href');
    const src = resolveUrl(raw, url);
    if (src && options.allowImage?.(src)) push({ type: 'image', src, alt: clean(el.getAttribute('alt') ?? '') || undefined });
  };
  const text = (el: Element) => clean(el.textContent);

  const visit = (el: Element, ctx: { quote: boolean; depth: number; ordered: boolean }) => {
    if (done) return;
    const id = el.getAttribute('id');
    if (id && id === options.endId && collecting) return void (done = true);
    if (id && id === options.startId) collecting = true;
    const tag = el.localName.toLowerCase();
    if (SKIP.has(tag) || el.hasAttribute('hidden')) return;

    if (tag in HEADINGS) {
      const t = text(el);
      if (t) push({ type: 'heading', level: HEADINGS[tag]!, text: t });
      return;
    }
    if (tag === 'pre') {
      // Windows line endings (common in EPUBs) would otherwise show as blank lines.
      const t = (el.textContent ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '');
      if (t) push({ type: 'pre', text: t });
      return;
    }
    if (tag === 'hr') return push({ type: 'rule' });
    if (tag === 'img') return image(el);
    if (tag === 'svg') {
      for (const img of Array.from(el.querySelectorAll('image'))) image(img);
      return;
    }
    if (tag === 'tr') {
      const cells = Array.from(el.children).map(text).filter(Boolean);
      if (cells.length) push({ type: 'paragraph', text: cells.join(' · ') });
      return;
    }
    if (tag === 'li') {
      // The item's own text, then any nested lists one level deeper.
      const own = Array.from(el.childNodes)
        .filter((n) => !(n.nodeType === 1 && ['ul', 'ol'].includes((n as Element).localName.toLowerCase())))
        .map((n) => n.textContent ?? '')
        .join(' ');
      const t = clean(own);
      if (t) push({ type: 'item', text: t, depth: ctx.depth, ordered: ctx.ordered });
      for (const list of Array.from(el.children).filter((c) => ['ul', 'ol'].includes(c.localName.toLowerCase()))) {
        visit(list, { ...ctx, depth: ctx.depth + 1, ordered: list.localName.toLowerCase() === 'ol' });
      }
      for (const img of Array.from(el.querySelectorAll('img'))) image(img);
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      for (const child of Array.from(el.children)) visit(child, { ...ctx, ordered: tag === 'ol' });
      return;
    }
    const hasBlocks = Array.from(el.children).some((c) => BLOCK_TAGS.has(c.localName.toLowerCase()));
    if (LEAF_BLOCKS.has(tag) || (!hasBlocks && tag !== 'body')) {
      // Anchors inside a paragraph still start or end the slice.
      if (!collecting && options.startId && el.querySelector(`[id="${cssEscape(options.startId)}"]`)) collecting = true;
      if (collecting && options.endId && el.querySelector(`[id="${cssEscape(options.endId)}"]`)) return void (done = true);
      const t = text(el);
      if (t) push({ type: ctx.quote ? 'quote' : 'paragraph', text: t });
      for (const img of Array.from(el.querySelectorAll('img'))) image(img);
      return;
    }
    const inner = { ...ctx, quote: ctx.quote || tag === 'blockquote' };
    for (const child of Array.from(el.children)) visit(child, inner);
  };

  const root = doc.body ?? doc.documentElement;
  if (root) visit(root, { quote: false, depth: 0, ordered: false });
  return blocks;
}

/** The plain paragraphs of some blocks, for code that only understands paragraphs. */
export function blockParagraphs(blocks: TextBlock[]): string[] {
  return blocks.flatMap((b) => (b.type === 'image' || b.type === 'rule' ? [] : [b.text]));
}

function clean(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function cssEscape(id: string): string {
  return id.replace(/["\\]/g, '\\$&');
}

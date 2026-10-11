/** A table-of-contents entry: its title, the file (or page) it starts in, and an anchor in it. */
export interface TocEntry {
  title: string;
  index: number;
  id?: string;
}

/**
 * One chapter of a book made of files (or pages): which of them hold its text, and where it
 * starts or ends partway through a file when chapters share one.
 */
export interface BookPart {
  title: string;
  files: { index: number; startId?: string; endId?: string }[];
}

/**
 * Splits a book of `count` files into chapters at its top-level contents entries (in the files'
 * order). Files before the first entry (cover, title page, printed contents) are skipped. A book
 * with no usable contents, or one entry for everything (common in converted EPUBs), becomes one
 * chapter per file.
 */
export function splitParts(count: number, toc: TocEntry[]): BookPart[] {
  const entries = toc.filter((e) => e.index >= 0 && e.index < count);
  // Entries out of order would make overlapping chapters; drop those.
  const ordered = entries.filter((e, i) => entries.slice(0, i).every((prev) => prev.index <= e.index));
  if (ordered.length < 2 && count > 1) return range(0, count).map((index) => ({ title: `part ${index + 1}`, files: [{ index }] }));
  if (!ordered.length) return [{ title: 'part 1', files: [{ index: 0 }] }];

  return ordered.map((entry, i) => {
    const next = ordered[i + 1];
    const title = entry.title.trim() || `part ${i + 1}`;
    const starting = (index: number) => ({ index, startId: index === entry.index ? entry.id : undefined });
    if (!next) return { title, files: range(entry.index, count).map(starting) };
    if (next.index === entry.index) return { title, files: [{ index: entry.index, startId: entry.id, endId: next.id }] };
    const files: BookPart['files'] = range(entry.index, next.index).map(starting);
    // The next chapter starts partway into its file: the text before its anchor is still ours.
    if (next.id) files.push({ index: next.index, endId: next.id });
    return { title, files };
  });
}

/** Top-level contents entries, looking through a lone entry that only wraps the real chapters (the book's title). */
export function topLevel<T extends { children?: T[] }>(toc: T[]): T[] {
  let level = toc;
  while (level.length === 1 && level[0]!.children?.length) level = level[0]!.children!;
  return level;
}

/** Query parameter selecting a chapter inside a book, e.g. `…/book/<id>?part=3` (from 1). */
export const PART = 'part';

/** Which chapter of a book a URL points at (from 0), or -1 for the whole book. */
export function partOf(url: string): number {
  const value = Number(new URL(url).searchParams.get(PART));
  return Number.isInteger(value) && value >= 1 ? value - 1 : -1;
}

export function withPart(url: string, part: number): string {
  return `${url}?${PART}=${part + 1}`;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
}

export interface Series {
  /** Stable id: `<siteConfigId>:<seriesUrl>`. */
  id: string;
  /** Id of the site config that understands this series' pages. */
  siteId: string;
  url: string;
  title: string;
  cover?: string;
  description?: string;
  authors?: string[];
  genres?: string[];
  /** As the site words it, e.g. "Ongoing", "Completed", "Hiatus". */
  status?: string;
  /** Where each author/genre linked to on the series page (same site only), for browsing. */
  links?: { authors?: Record<string, string>; genres?: Record<string, string> };
}

export type BrowseKind = 'authors' | 'genres';

export interface ChapterRef {
  url: string;
  title: string;
}

/** Structured text, for books whose headings, lists and code matter (EPUBs from media servers). */
export type TextBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'pre'; text: string }
  | { type: 'item'; text: string; depth: number; ordered: boolean }
  | { type: 'image'; src: string; alt?: string }
  | { type: 'rule' };

export type ChapterBody =
  | { kind: 'images'; pages: string[] }
  /** `blocks`, when present, is the same text with its structure; `paragraphs` is always filled. */
  | { kind: 'text'; paragraphs: string[]; blocks?: TextBlock[] };

export interface ChapterContent {
  url: string;
  title?: string;
  next?: string;
  prev?: string;
  seriesUrl?: string;
  body: ChapterBody;
}

export interface SearchResult {
  /** Series page URL. */
  url: string;
  title: string;
  cover?: string;
}

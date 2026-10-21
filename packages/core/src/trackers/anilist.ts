// AniList, as a tracker: reading progress on onidoku is copied to the user's AniList list.
// API docs: https://docs.anilist.co (GraphQL at graphql.anilist.co).
import { chapterNumber } from '../heuristics';
import type { LibraryEntry } from '../library';

export const ANILIST_API = 'https://graphql.anilist.co';
/**
 * AniList's own page for apps with nowhere to redirect to. It's the one redirect URL registered for
 * onidoku's client, so a single client id works for every browser and store: the extension watches
 * the login tab land here and reads the token from its address.
 */
export const ANILIST_PIN = 'https://anilist.co/api/v2/oauth/pin';
/** Origins the extension needs: the login pages (to see the token arrive) and the API. */
export const ANILIST_ORIGINS = ['https://anilist.co/*', 'https://graphql.anilist.co/*'];

/** Implicit grant: the token comes back in the redirect's #fragment, no client secret involved. */
export function anilistAuthUrl(clientId: string): string {
  return `https://anilist.co/api/v2/oauth/authorize?${new URLSearchParams({ client_id: clientId, response_type: 'token' })}`;
}

/** The token from the pin page's address once login succeeds, else undefined. */
export function anilistTokenFrom(url: string, now = Date.now()): { token: string; expiresAt: number } | undefined {
  if (!url.startsWith(ANILIST_PIN)) return undefined;
  const params = new URLSearchParams(new URL(url).hash.slice(1));
  const token = params.get('access_token');
  if (!token) return undefined;
  // AniList tokens last a year; trust the number it sends when there is one.
  const seconds = Number(params.get('expires_in')) || 365 * 24 * 3600;
  return { token, expiresAt: now + seconds * 1000 };
}

export type AnilistStatus = 'CURRENT' | 'PLANNING' | 'COMPLETED' | 'DROPPED' | 'PAUSED' | 'REPEATING';

export interface AnilistMedia {
  id: number;
  title: string;
  cover?: string;
  year?: number;
  /** MANGA, NOVEL, ONE_SHOT… */
  format?: string;
  /** Total chapters, once the series has finished. */
  chapters?: number;
  siteUrl: string;
}

export interface AnilistListEntry {
  progress: number;
  status: AnilistStatus;
  /** In the user's own score format (see AnilistScoreFormat); 0 means not scored. */
  score?: number;
  notes?: string;
  /** When the entry last changed on AniList, from any app (ms since epoch). */
  updatedAt?: number;
}

/** What a user can change on their list entry from onidoku. Fields left out stay as they are. */
export type AnilistChanges = Partial<Pick<AnilistListEntry, 'progress' | 'status' | 'score' | 'notes'>>;

/** How the user scores on AniList (their profile setting): the range a score is entered in. */
export type AnilistScoreFormat = 'POINT_100' | 'POINT_10_DECIMAL' | 'POINT_10' | 'POINT_5' | 'POINT_3';

export const ANILIST_SCORE_RANGE: Record<AnilistScoreFormat, { max: number; step: number }> = {
  POINT_100: { max: 100, step: 1 },
  POINT_10_DECIMAL: { max: 10, step: 0.1 },
  POINT_10: { max: 10, step: 1 },
  POINT_5: { max: 5, step: 1 },
  POINT_3: { max: 3, step: 1 },
};

export interface AnilistUser {
  id: number;
  name: string;
}

/** A linked series as the details page shows it: the series, the user's entry, and how they score. */
export interface AnilistTracking {
  media: AnilistMedia;
  /** Undefined while the series isn't on the user's list. */
  entry?: AnilistListEntry;
  scoreFormat: AnilistScoreFormat;
}

export class AnilistAuthError extends Error {}

interface RawMedia {
  id: number;
  title: { userPreferred?: string; romaji?: string; english?: string };
  coverImage?: { medium?: string };
  startDate?: { year?: number };
  format?: string;
  chapters?: number;
  siteUrl: string;
}

const MEDIA_FIELDS = 'id title { userPreferred romaji english } coverImage { medium } startDate { year } format chapters siteUrl';

export class Anilist {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  async viewer(): Promise<AnilistUser> {
    const data = await this.query<{ Viewer: AnilistUser }>('query { Viewer { id name } }');
    return data.Viewer;
  }

  /** Manga and light novels matching a title, best matches first. */
  async search(title: string): Promise<AnilistMedia[]> {
    const data = await this.query<{ Page: { media: RawMedia[] } }>(
      `query ($search: String) { Page(perPage: 10) { media(search: $search, type: MANGA, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} } } }`,
      { search: title },
    );
    return data.Page.media.map(toMedia);
  }

  /** A series, the logged-in user's list entry for it, and their score format, in one request. */
  async entry(mediaId: number): Promise<AnilistTracking> {
    const data = await this.query<{ Media: RawMedia & { mediaListEntry?: RawEntry | null }; Viewer: { mediaListOptions?: { scoreFormat?: AnilistScoreFormat } } }>(
      `query ($id: Int) { Media(id: $id) { ${MEDIA_FIELDS} mediaListEntry { ${ENTRY_FIELDS} } } Viewer { mediaListOptions { scoreFormat } } }`,
      { id: mediaId },
    );
    return {
      media: toMedia(data.Media),
      entry: data.Media.mediaListEntry ? toEntry(data.Media.mediaListEntry) : undefined,
      scoreFormat: data.Viewer.mediaListOptions?.scoreFormat ?? 'POINT_10',
    };
  }

  /** Creates the list entry if needed. Only the fields given are sent, so the rest keep their values. */
  async save(mediaId: number, changes: AnilistChanges): Promise<AnilistListEntry> {
    const types = { progress: 'Int', status: 'MediaListStatus', score: 'Float', notes: 'String' } as const;
    const fields = (Object.keys(types) as (keyof typeof types)[]).filter((k) => changes[k] !== undefined);
    const declared = ['$id: Int', ...fields.map((k) => `$${k}: ${types[k]}`)].join(', ');
    const args = ['mediaId: $id', ...fields.map((k) => `${k}: $${k}`)].join(', ');
    const data = await this.query<{ SaveMediaListEntry: RawEntry }>(
      `mutation (${declared}) { SaveMediaListEntry(${args}) { ${ENTRY_FIELDS} } }`,
      { id: mediaId, ...Object.fromEntries(fields.map((k) => [k, changes[k]])) },
    );
    return toEntry(data.SaveMediaListEntry);
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchFn(ANILIST_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string; status?: number }[] };
    if (res.status === 401 || body.errors?.some((e) => e.status === 401 || /invalid token/i.test(e.message))) {
      throw new AnilistAuthError('AniList logged onidoku out. connect it again on the sources page.');
    }
    if (res.status === 429) throw new Error('AniList is limiting requests (HTTP 429). try again in a minute.');
    if (!res.ok || body.errors?.length || !body.data) throw new Error(`AniList: ${body.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
    return body.data;
  }
}

const ENTRY_FIELDS = 'progress status score notes updatedAt';

interface RawEntry {
  progress?: number | null;
  status: AnilistStatus;
  score?: number | null;
  notes?: string | null;
  /** Seconds since epoch. */
  updatedAt?: number | null;
}

function toEntry(raw: RawEntry): AnilistListEntry {
  return {
    progress: raw.progress ?? 0,
    status: raw.status,
    score: raw.score ?? undefined,
    notes: raw.notes ?? undefined,
    updatedAt: raw.updatedAt ? raw.updatedAt * 1000 : undefined,
  };
}

function toMedia(raw: RawMedia): AnilistMedia {
  return {
    id: raw.id,
    title: raw.title.userPreferred ?? raw.title.english ?? raw.title.romaji ?? `#${raw.id}`,
    cover: raw.coverImage?.medium,
    year: raw.startDate?.year ?? undefined,
    format: raw.format ?? undefined,
    chapters: raw.chapters ?? undefined,
    siteUrl: raw.siteUrl,
  };
}

const TITLE_NUMBER = /(?:chapter|chap|ch|episode|ep)\.?\s*(\d+(?:\.\d+)?)/i;

/**
 * The chapter count AniList should show for an entry: the number of the furthest chapter read, from
 * its title ("Chapter 12") or URL, else its position in the list. Half chapters count as the one
 * before (12.5 → 12), since AniList only takes whole numbers.
 */
export function trackerProgress(entry: LibraryEntry): number {
  if (!entry.readUpTo) return 0;
  const index = entry.chapters.findIndex((c) => c.url === entry.readUpTo);
  if (index < 0) return 0;
  const chapter = entry.chapters[index]!;
  const number = Number(chapter.title.match(TITLE_NUMBER)?.[1] ?? chapterNumber(chapter.url) ?? index + 1);
  return Math.max(0, Math.floor(number));
}

/**
 * What to save, if anything: progress only ever moves forward, and a series being reread or
 * finished keeps its status. Undefined when AniList is already there.
 */
export function nextAnilistEntry(progress: number, current: AnilistListEntry | undefined, total?: number): Pick<AnilistListEntry, 'progress' | 'status'> | undefined {
  if (progress <= 0 || (current && progress <= current.progress)) return undefined;
  if (total && progress >= total) return { progress: total, status: current?.status === 'REPEATING' ? 'REPEATING' : 'COMPLETED' };
  const status = current?.status === 'REPEATING' ? 'REPEATING' : 'CURRENT';
  return { progress, status };
}

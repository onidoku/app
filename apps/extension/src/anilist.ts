// AniList in the background: logging in, and copying reading progress to the user's list.
import {
  Anilist,
  ANILIST_ORIGINS,
  anilistAuthUrl,
  AnilistAuthError,
  anilistTokenFrom,
  nextAnilistEntry,
  trackerProgress,
  type AnilistChanges,
  type AnilistListEntry,
  type AnilistMedia,
  type AnilistTracking,
  type AnilistUser,
  type LibraryEntry,
} from '@onidoku/core';
import { ANILIST_KEY } from './keys';
import { chromeStore } from './storage';

/**
 * onidoku's AniList API client (anilist.co/settings/developer), registered with the redirect URL
 * https://anilist.co/api/v2/oauth/pin. Not a secret: the implicit grant has none.
 */
export const ANILIST_CLIENT_ID = '53992';

export interface AnilistLogin {
  token: string;
  expiresAt: number;
  user: AnilistUser;
}

/** What the pages show: who's logged in, if anyone. */
export interface AnilistState {
  /** False until a client id is filled in above. */
  available: boolean;
  user?: AnilistUser;
}

async function stored(): Promise<AnilistLogin | undefined> {
  const login = (await chromeStore.get(ANILIST_KEY)) as AnilistLogin | undefined;
  return login && login.expiresAt > Date.now() ? login : undefined;
}

export async function anilistState(): Promise<AnilistState> {
  const login = await stored();
  return { available: Boolean(ANILIST_CLIENT_ID), user: login?.user };
}

/**
 * Opens AniList's login in a tab. The page asked for ANILIST_ORIGINS first (that needs the click),
 * which lets watchLoginTabs see the tab arrive on the pin page with the token in its address.
 */
export async function startAnilistLogin(): Promise<void> {
  if (!ANILIST_CLIENT_ID) throw new Error('AniList isn’t set up in this build.');
  if (!(await chrome.permissions.contains({ origins: ANILIST_ORIGINS }))) throw new Error('onidoku needs access to anilist.co to log in.');
  await chrome.tabs.create({ url: anilistAuthUrl(ANILIST_CLIENT_ID) });
}

/**
 * Registered at the top level of the background, so a login finishing after the service worker
 * went idle still wakes it.
 */
export function watchLoginTabs(): void {
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    const found = change.url ? anilistTokenFrom(change.url) : undefined;
    if (!found) return;
    void (async () => {
      try {
        const user = await new Anilist(found.token).viewer();
        await chromeStore.set(ANILIST_KEY, { ...found, user } satisfies AnilistLogin);
        // Back to where the user started (usually the sources page) rather than leaving the token on screen.
        await chrome.tabs.remove(tabId);
      } catch (err) {
        console.warn('AniList login failed', err);
      }
    })();
  });
}

export async function anilistLogout(): Promise<void> {
  await chrome.storage.local.remove(ANILIST_KEY);
}

async function client(): Promise<Anilist> {
  const login = await stored();
  if (!login) throw new AnilistAuthError('connect AniList on the sources page first.');
  return new Anilist(login.token);
}

/** A rejected token means the user revoked onidoku on AniList (or it expired): forget it. */
async function forgetIfRevoked<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AnilistAuthError) await anilistLogout();
    throw err;
  }
}

export async function anilistSearch(title: string): Promise<AnilistMedia[]> {
  return forgetIfRevoked(async () => (await client()).search(title));
}

/** The linked series and the user's entry for it, live from AniList, for the details page. */
export function anilistTracking(mediaId: number): Promise<AnilistTracking> {
  // Behind any progress still being saved, so the page shows where AniList ends up.
  const run = queue.then(() => forgetIfRevoked(async () => (await client()).entry(mediaId)));
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Status, score, notes or progress changed on the details page. Queued with the progress sync, so a
 * chapter read at the same moment can't overwrite it with the older values.
 */
export function anilistSave(mediaId: number, changes: AnilistChanges): Promise<AnilistListEntry> {
  const run = queue.then(() => forgetIfRevoked(async () => (await client()).save(mediaId, changes)));
  queue = run.catch(() => undefined);
  return run;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Copies an entry's progress to AniList when it's linked there and ahead of it. Queued, so paging
 * quickly through chapters saves them in order; best effort, since reading works without AniList.
 */
export function syncToAnilist(entry: LibraryEntry | undefined): Promise<void> {
  const link = entry?.trackers?.anilist;
  if (!entry || !link) return Promise.resolve();
  const run = queue.then(async () => {
    if (!(await stored())) return;
    await forgetIfRevoked(async () => {
      const api = await client();
      const { media, entry: current } = await api.entry(link.id);
      const next = nextAnilistEntry(trackerProgress(entry), current, media.chapters);
      if (next) await api.save(link.id, next);
    });
  });
  queue = run.catch((err) => console.warn(`couldn't update ${entry.series.title} on AniList`, err));
  return queue as Promise<void>;
}

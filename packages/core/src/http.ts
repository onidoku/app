/** Retries after an HTTP 429 before giving up. Sites usually allow a burst, then ask for a pause. */
export const MAX_RATE_LIMIT_RETRIES = 6;
/** Longer pauses than this aren't waited out: the request fails and the user can try later. */
export const MAX_RETRY_WAIT_MS = 30_000;

/**
 * How long to wait before retrying a request the site rate-limited (HTTP 429), from its
 * `Retry-After` header (seconds or an HTTP date), else a growing default. Undefined: give up.
 */
export function rateLimitDelay(retryAfter: string | null, attempt: number, now = Date.now()): number | undefined {
  if (attempt >= MAX_RATE_LIMIT_RETRIES) return undefined;
  let ms = 2000 * 2 ** attempt;
  if (retryAfter?.trim()) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(seconds)) ms = seconds * 1000;
    else if (!Number.isNaN(date)) ms = date - now;
  }
  // A little extra so we land after the window resets, not exactly on it.
  ms = Math.max(ms, 0) + 250;
  return ms <= MAX_RETRY_WAIT_MS ? ms : undefined;
}

/**
 * Runs `request`, waiting and retrying while the site answers HTTP 429. Any other response,
 * and a 429 that can't be waited out, is returned as is.
 */
export async function fetchRetrying(request: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await request();
    const wait = res.status === 429 ? rateLimitDelay(res.headers.get('retry-after'), attempt) : undefined;
    if (wait === undefined) return res;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** A readable error for a failed page request. */
export function httpError(res: Response, url: string): Error {
  const host = new URL(url).host;
  if (res.status === 429) return new Error(`${host} is limiting requests (HTTP 429). try again in a minute.`);
  return new Error(`HTTP ${res.status} from ${host}`);
}

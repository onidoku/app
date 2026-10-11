/** Drops the fragment so `/chapter/2` and `/chapter/2#comments` are the same chapter. */
export function normalizeUrl(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

/** Resolves a (possibly relative) link against the page URL. Only http(s) URLs survive. */
export function resolveUrl(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    u.hash = '';
    return u.href;
  } catch {
    return undefined;
  }
}

/**
 * Compiles a URL glob to a RegExp. `*` matches within one path segment and `**` matches
 * across segments, so `https://site/series/*` does not also match the series' chapters.
 * Globs without a `?` also accept a trailing slash and any query string.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/?#]*';
      }
    } else {
      out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  if (!glob.includes('?')) out += '/?(?:\\?.*)?';
  return new RegExp(`^${out}$`);
}

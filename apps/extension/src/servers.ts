// Connections to the user's media servers, shared by the background, the reader page and the
// library pages (whose covers need the server's login to load).
import { connectServer, type MediaServer, type ServerConfig } from '@onidoku/core';
import { CF_HOSTS_KEY, SERVERS_KEY } from './keys';
import { send } from './messages';
import { loadServers } from './storage';

const clients = new Map<string, { key: string; client: MediaServer }>();

/** One client per server, reused while its settings stay the same (Kavita logins are reused). */
export function clientFor(server: ServerConfig, parseHtml: (html: string, url: string) => Document): MediaServer {
  const key = JSON.stringify(server);
  const cached = clients.get(server.id);
  if (cached?.key === key) return cached.client;
  const client = connectServer(server, { fetch: (input, init) => fetch(input, init), parseHtml });
  clients.set(server.id, { key, client });
  return client;
}

const domParse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

let servers: Promise<ServerConfig[]> | undefined;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && SERVERS_KEY in changes) servers = undefined;
});

/** The server whose API an image URL is on, if any. */
async function serverOf(url: string): Promise<ServerConfig | undefined> {
  servers ??= loadServers();
  return (await servers).find((s) => url.startsWith(`${s.url}/api/`));
}

let challenged: Promise<string[]> | undefined;
chrome.storage.session?.onChanged.addListener((changes) => {
  if (CF_HOSTS_KEY in changes) challenged = undefined;
});

/** Whether the image's host challenges the extension's requests (Cloudflare), as Paperback sources found. */
async function behindChallenge(url: string): Promise<boolean> {
  challenged ??= chrome.storage.session
    ? chrome.storage.session.get(CF_HOSTS_KEY).then((s) => (Array.isArray(s[CF_HOSTS_KEY]) ? (s[CF_HOSTS_KEY] as string[]) : []), () => [])
    : Promise.resolve([]);
  try {
    return (await challenged).includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Loads an image through the background, which goes through an open tab of the site. */
async function viaBackground(url: string): Promise<string> {
  const { type, base64, text } = await send<{ type: string; base64?: string; text?: string }>({ type: 'paperbackImage', url });
  const body = base64 !== undefined ? Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) : (text ?? '');
  return URL.createObjectURL(new Blob([body], { type }));
}

const images = new Map<string, Promise<string>>();

/**
 * An image source that works for media server covers and pages, which need the server's login,
 * and for images on sites whose Cloudflare check blocks the extension: those are fetched and
 * shown from a blob: URL. Anything else is used as is.
 */
export function imageSrc(url: string): Promise<string> {
  let src = images.get(url);
  if (!src) {
    src = serverOf(url).then(async (server) => {
      if (server) return URL.createObjectURL(await clientFor(server, domParse).fetchImage(url));
      return (await behindChallenge(url)) ? viaBackground(url) : url;
    });
    src.catch(() => images.delete(url));
    images.set(url, src);
  }
  return src;
}

/** Sets an <img>'s source through imageSrc, firing its error event if the image can't be fetched. */
export function setImageSrc(img: HTMLImageElement, url: string): HTMLImageElement {
  imageSrc(url).then(
    (src) => (img.src = src),
    () => img.dispatchEvent(new Event('error')),
  );
  return img;
}

/** Frees the blob: URLs made so far, e.g. when the reader moves to another chapter. */
export function releaseImages(): void {
  for (const src of images.values()) void src.then((s) => s.startsWith('blob:') && URL.revokeObjectURL(s), () => undefined);
  images.clear();
}

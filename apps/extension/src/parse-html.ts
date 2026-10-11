// Chrome's MV3 background is a service worker, which has no DOMParser, so it parses with linkedom.
// Firefox builds swap in parse-html.native.ts instead (see "imports" in package.json).
import { DOMParser } from 'linkedom';

export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html') as unknown as Document;
}

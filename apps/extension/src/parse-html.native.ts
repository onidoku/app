// Firefox's MV3 background is an event page with a real DOMParser, so no parser is bundled.
export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

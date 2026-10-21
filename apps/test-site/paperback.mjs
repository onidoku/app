// A Paperback extension repo for the test site, laid out like published ones: versioning.json
// listing the sources, and <id>/source.js plus <id>/includes/<icon> for each.
import { readFileSync } from 'node:fs';

export const PAPERBACK_SOURCE_ID = 'TestComics';

export function paperbackSourceCode() {
  return readFileSync(new URL(`./paperback/${PAPERBACK_SOURCE_ID}/source.js`, import.meta.url), 'utf8');
}

/** @param {string} origin */
export function paperbackVersioning(origin) {
  return {
    buildTime: '2026-10-01T00:00:00.000Z',
    builtWith: { toolchain: '0.8.7', types: '0.8.7' },
    sources: [
      {
        id: PAPERBACK_SOURCE_ID,
        name: 'Test Comics (Paperback)',
        author: 'onidoku tests',
        desc: 'Extension that pulls comics from the onidoku test site',
        website: origin,
        contentRating: 'EVERYONE',
        version: '1.0.0',
        icon: 'icon.svg',
        tags: [{ text: 'English', type: 'info' }],
        websiteBaseURL: origin,
        intents: 5,
      },
      {
        id: 'TestComicsLite',
        name: 'Test Comics Lite (Paperback)',
        author: 'onidoku tests',
        desc: 'The same comics, as a second source',
        contentRating: 'EVERYONE',
        version: '1.0.0',
        websiteBaseURL: origin,
        intents: 5,
      },
    ],
  };
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#e5484d"/></svg>';

/** Serves the repo under /paperback/; undefined for other paths. @param {URL} url */
export function handlePaperbackRepo(url) {
  const path = url.pathname;
  // The repo's page, with the "add to Paperback" link repo pages have.
  if (path === '/paperback/') {
    const add = `paperback://addRepo?displayName=Test%20Repo&url=${encodeURIComponent(`${url.origin}/paperback`)}`;
    return { status: 200, type: 'text/html; charset=utf-8', body: `<!doctype html><title>Test Repo</title><h1>Test Repo</h1><p><a href="${add}">Add to Paperback</a></p>` };
  }
  if (path === '/paperback/versioning.json') {
    return { status: 200, type: 'application/json', body: JSON.stringify(paperbackVersioning(url.origin)), headers: { 'access-control-allow-origin': '*' } };
  }
  // Both listed sources are in one bundle; each path serves it, as each source's own build would.
  if (path === `/paperback/${PAPERBACK_SOURCE_ID}/source.js` || path === '/paperback/TestComicsLite/source.js') {
    return { status: 200, type: 'text/javascript; charset=utf-8', body: paperbackSourceCode(), headers: { 'access-control-allow-origin': '*' } };
  }
  if (path === `/paperback/${PAPERBACK_SOURCE_ID}/includes/icon.svg`) return { status: 200, type: 'image/svg+xml', body: ICON };
  return undefined;
}

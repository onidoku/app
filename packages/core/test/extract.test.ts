import { describe, expect, it } from 'vitest';
import { browseUrl, chapterNumber, detectChapter, guessTextParagraphs, extractChapter, extractSearch, extractSeries, ExtractError, fetchRetrying, guessChapter, guessChapterLinks, guessImagePages, MAX_RATE_LIMIT_RETRIES, rateLimitDelay, loadSeries, MAX_CHAPTER_PAGES, parseSiteConfig, searchUrl, slugify, sourceUrl } from '../src';
import { BASE, fixture, mangaConfig, novelConfig, parse } from './helpers';

describe('extractSeries', () => {
  const { series, chapters } = extractSeries(fixture('series.html'), `${BASE}/series/moon-garden#top`, mangaConfig);

  it('reads title and lazy-loaded cover', () => {
    expect(series).toEqual({
      id: 'testsite.manga:http://localhost:4173/series/moon-garden',
      siteId: 'testsite.manga',
      url: `${BASE}/series/moon-garden`,
      title: 'Moon Garden',
      cover: `${BASE}/covers/moon-garden.svg`,
      description: 'A gardener on the moon.\n\nThings grow strangely.',
      authors: ['Ana Ruiz', 'Ken Ito'],
      genres: ['Fantasy', 'Drama'],
      status: 'Ongoing',
      // Authors are links on the page (genres aren't), so they can be browsed on the site.
      links: { authors: { 'Ana Ruiz': `${BASE}/author/ana`, 'Ken Ito': `${BASE}/author/ken` } },
    });
  });

  it('leaves out details the page does not have', () => {
    const { series } = extractSeries(parse('<h1 class="series-title">Bare</h1>'), `${BASE}/series/bare`, mangaConfig);
    expect(Object.keys(series).sort()).toEqual(['id', 'siteId', 'title', 'url']);
  });

  it('returns chapters oldest first, deduped by URL, with absolute links', () => {
    expect(chapters).toEqual([
      { url: `${BASE}/series/moon-garden/chapter/1`, title: 'Chapter 1' },
      { url: `${BASE}/series/chapter/1-oops`, title: `${BASE}/series/chapter/1-oops` },
      { url: `${BASE}/series/moon-garden/chapter/2`, title: 'Chapter 2' },
      { url: `${BASE}/series/moon-garden/chapter/3`, title: 'Chapter 3' },
    ]);
  });

  it('throws a descriptive error when the title selector misses', () => {
    expect(() => extractSeries(parse('<p>nothing</p>'), `${BASE}/series/x`, mangaConfig)).toThrow(ExtractError);
    expect(() => extractSeries(parse('<p>nothing</p>'), `${BASE}/series/x`, mangaConfig)).toThrow(/h1\.series-title/);
  });
});

describe('extractChapter', () => {
  it('reads image pages, preferring lazy attributes over placeholders', () => {
    const chapter = extractChapter(fixture('chapter.html'), `${BASE}/series/moon-garden/chapter/2`, mangaConfig);
    expect(chapter).toEqual({
      url: `${BASE}/series/moon-garden/chapter/2`,
      title: 'Moon Garden – Chapter 2',
      next: `${BASE}/series/moon-garden/chapter/3`,
      prev: `${BASE}/series/moon-garden/chapter/1`,
      seriesUrl: `${BASE}/series/moon-garden`,
      body: {
        kind: 'images',
        pages: [
          `${BASE}/pages/moon-garden/2/1.svg`,
          `${BASE}/pages/moon-garden/2/2.svg`,
          `${BASE}/pages/moon-garden/2/3.svg`,
          'https://cdn.example.org/moon-garden/2/4.svg',
        ],
      },
    });
  });

  it('reads novel text as plain paragraphs, never HTML', () => {
    const chapter = extractChapter(fixture('novel-chapter.html'), `${BASE}/novel/quiet-orbit/chapter/1`, novelConfig);
    expect(chapter.body).toEqual({
      kind: 'text',
      // Hidden anti-copy notices and the <script> are dropped; <br> becomes a space.
      paragraphs: ['Chapter 1 The Station', 'The station hummed.', 'Mira counted the seconds between pulses.'],
    });
    expect(chapter.prev).toBeUndefined();
    expect(chapter.next).toBe(`${BASE}/novel/quiet-orbit/chapter/2`);
  });

  it('throws when no pages are found', () => {
    expect(() => extractChapter(parse('<div class="reader"></div>'), `${BASE}/series/x/chapter/1`, mangaConfig)).toThrow(
      /no pages found/,
    );
  });
});

describe('guessImagePages', () => {
  it('finds the main image sequence and skips logos, avatars and ads', () => {
    expect(guessImagePages(fixture('unknown-site.html'), 'https://unknown.example/read/42')).toEqual([
      'https://unknown.example/scan/p1.jpg',
      'https://unknown.example/scan/p2.jpg',
      'https://unknown.example/scan/p3.jpg',
      'https://unknown.example/scan/p4.jpg',
    ]);
  });

  it('returns nothing for pages without an image sequence', () => {
    expect(guessImagePages(parse('<img src="/a.jpg"><p>text</p>'), 'https://x.example/')).toEqual([]);
  });
});

describe('guessImagePages in the live page', () => {
  /** Gives parsed <img>s what a browser has: what they've loaded so far and its size. */
  function live(doc: Document, loaded: (img: HTMLImageElement) => { src: string; width: number; height: number }) {
    for (const img of Array.from(doc.querySelectorAll('img'))) {
      const { src, width, height } = loaded(img);
      Object.defineProperties(img, { currentSrc: { value: src }, naturalWidth: { value: width }, naturalHeight: { value: height } });
    }
    return doc;
  }

  it('prefers lazy-load URLs over the placeholder shown until the user scrolls', () => {
    const doc = live(
      parse(`<div>${[1, 2, 3].map((n) => `<img src="https://cdn.example/blank.png" data-url="/s/${n}.jpg">`).join('')}</div>`),
      () => ({ src: 'https://cdn.example/blank.png', width: 1, height: 1 }),
    );
    expect(guessImagePages(doc, 'https://x.example/ep/1')).toEqual([1, 2, 3].map((n) => `https://x.example/s/${n}.jpg`));
  });

  it("uses the blob: images a site's script made, and skips small loaded images", () => {
    const doc = live(
      parse(`<div>${[1, 2, 3].map((n) => `<img data-n="${n}">`).join('')}<img data-n="icon"></div>`),
      (img) => (img.dataset.n === 'icon' ? { src: 'blob:https://x.example/icon', width: 24, height: 24 } : { src: `blob:https://x.example/${img.dataset.n}`, width: 800, height: 1200 }),
    );
    expect(guessImagePages(doc, 'https://x.example/ep/1')).toEqual([1, 2, 3].map((n) => `blob:https://x.example/${n}`));
  });
});

describe('chapterNumber', () => {
  it('reads the last chapter or episode number in the path', () => {
    expect(chapterNumber('https://x.example/manga/vol-2/chapter-12.5/')).toBe(12.5);
    expect(chapterNumber('https://x.example/read/ep_7?page=2')).toBe(7);
    expect(chapterNumber('https://x.example/about')).toBeUndefined();
  });

  it('does not read a number out of an opaque chapter id', () => {
    expect(chapterNumber('https://x.example/chapter/3f2e9a1c')).toBeUndefined();
    expect(chapterNumber('https://x.example/chapter/3f2e9a1c/2')).toBeUndefined();
  });
});

describe('guessChapterLinks', () => {
  const url = 'https://x.example/manga/moon/chapter-5';

  it('prefers rel links', () => {
    const doc = parse('<link rel="next" href="/manga/moon/chapter-6"><a rel="prev" href="/manga/moon/chapter-4">back</a>');
    expect(guessChapterLinks(doc, url)).toEqual({
      next: 'https://x.example/manga/moon/chapter-6',
      prev: 'https://x.example/manga/moon/chapter-4',
    });
  });

  it('reads link wording and arrows', () => {
    const doc = parse('<a href="/r/abc">‹</a><a class="btn" href="/r/def">Next Chapter</a><a href="/r/zzz">Next page</a>');
    expect(guessChapterLinks(doc, 'https://x.example/r/xyz')).toEqual({
      next: 'https://x.example/r/def',
      prev: 'https://x.example/r/abc',
    });
  });

  it('falls back to chapter numbers one step away', () => {
    const doc = parse('<select></select><a href="/manga/moon/chapter-4">4</a><a href="/manga/moon/chapter-6">6</a><a href="/manga/moon/chapter-9">9</a>');
    expect(guessChapterLinks(doc, url)).toEqual({
      next: 'https://x.example/manga/moon/chapter-6',
      prev: 'https://x.example/manga/moon/chapter-4',
    });
  });

  it('skips other sites, disabled links, the page itself and links going the wrong way', () => {
    const doc = parse(
      '<a href="https://evil.example/manga/moon/chapter-6">Next</a><a class="disabled" href="/manga/moon/chapter-4">Prev</a>' +
        '<a href="/manga/moon/chapter-5#top">Next</a><a href="/manga/moon/chapter-1">Next</a>',
    );
    expect(guessChapterLinks(doc, url)).toEqual({ next: undefined, prev: undefined });
  });
});

describe('guessChapter', () => {
  it('combines pages, title and links', () => {
    const doc = parse(
      '<html><head><title>Moon Garden Ch. 5</title></head><body><div>' +
        [1, 2, 3].map((n) => `<img src="/s/${n}.jpg">`).join('') +
        '</div><a href="/manga/moon/chapter-6">Next</a></body></html>',
    );
    expect(guessChapter(doc, 'https://x.example/manga/moon/chapter-5#c')).toEqual({
      url: 'https://x.example/manga/moon/chapter-5',
      title: 'Moon Garden Ch. 5',
      body: { kind: 'images', pages: [1, 2, 3].map((n) => `https://x.example/s/${n}.jpg`) },
      next: 'https://x.example/manga/moon/chapter-6',
      prev: undefined,
    });
  });

  it('falls back to text when there are no images', () => {
    const doc = parse(`<title>Ch. 12</title><div>${PROSE.map((p) => `<p>${p}</p>`).join('')}</div>`);
    expect(guessChapter(doc, 'https://x.example/n/12')?.body).toEqual({ kind: 'text', paragraphs: PROSE.map((p) => p.trim()) });
  });

  it('returns undefined when the page has no image sequence or prose', () => {
    expect(guessChapter(parse('<p>hello</p>'), 'https://x.example/')).toBeUndefined();
  });
});

const PROSE = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1}. ` + 'The moon garden grew strange flowers that night. '.repeat(5));

describe('guessTextParagraphs', () => {
  it('finds the block of prose, not the menu or comments', () => {
    const doc = parse(
      '<nav><p><a href="/">Home</a></p></nav><div class="text">' +
        PROSE.map((p) => `<p>${p}</p>`).join('') +
        '</div><div class="comments"><p>Thanks for the chapter!</p><p>First</p></div>',
    );
    expect(guessTextParagraphs(doc)).toEqual(PROSE.map((p) => p.trim()));
  });

  it('splits <br>-separated text into paragraphs', () => {
    const doc = parse(`<div id="content">${PROSE.join('<br><br>')}</div>`);
    expect(guessTextParagraphs(doc)).toEqual(PROSE.map((p) => p.trim()));
  });

  it('ignores short pages and link lists', () => {
    expect(guessTextParagraphs(parse('<div><p>Short.</p><p>Also short.</p></div>'))).toEqual([]);
    const toc = parse(`<div>${PROSE.map((p, i) => `<p><a href="/c/${i}">${p}</a></p>`).join('')}</div>`);
    expect(guessTextParagraphs(toc)).toEqual([]);
  });
});

describe('detectChapter', () => {
  const novel = (title: string) =>
    parse(`<html><head><title>${title}</title></head><body><article>${PROSE.map((p) => `<p>${p}</p>`).join('')}</article><a href="/n/moon/chapter-13">Next chapter</a></body></html>`);
  const comic = (title: string) =>
    parse(`<html><head><title>${title}</title></head><body><div>${[1, 2, 3].map((n) => `<img src="/s/${n}.jpg">`).join('')}</div></body></html>`);

  it('detects novel and comic chapters from two signals', () => {
    expect(detectChapter(novel('Moon Garden'), 'https://x.example/n/moon/chapter-12')).toEqual({ kind: 'text', signals: ['url', 'links'] });
    expect(detectChapter(comic('Moon Garden Ch. 5'), 'https://x.example/m/moon/chapter-5')).toEqual({ kind: 'images', signals: ['url', 'heading'] });
    expect(detectChapter(comic('月之庭 第5话'), 'https://x.example/read/abc')).toBeUndefined();
  });

  it('detects chapters addressed by id, with next/previous buttons instead of links', () => {
    const doc = parse(
      `<html><head><title>Moon Garden - Ch. 5</title></head><body><div>${[1, 2, 3].map((n) => `<img srcset="/s/${n}-small.jpg 1x, /s/${n}.jpg 2x">`).join('')}</div></body></html>`,
    );
    expect(detectChapter(doc, 'https://x.example/chapter/3f2e9a1c')).toEqual({ kind: 'images', signals: ['url', 'heading'] });
    expect(guessImagePages(doc, 'https://x.example/chapter/3f2e9a1c')).toEqual([1, 2, 3].map((n) => `https://x.example/s/${n}.jpg`));

    const buttons = parse(`<html><head><title>Moon Garden</title></head><body><div>${[1, 2, 3].map((n) => `<img src="/s/${n}.jpg">`).join('')}</div><button>Next chapter</button></body></html>`);
    expect(detectChapter(buttons, 'https://x.example/read/3f2e9a1c')).toBeUndefined();
    expect(detectChapter(buttons, 'https://x.example/viewer/3f2e9a1c')).toEqual({ kind: 'images', signals: ['url', 'links'] });
  });

  it('leaves articles and galleries alone', () => {
    // Prose with a "Next" link but nothing chapter-like about the URL or title: a blog post.
    expect(detectChapter(novel('How I grow tomatoes'), 'https://blog.example/2026/tomatoes')).toBeUndefined();
    expect(detectChapter(comic('Holiday photos'), 'https://photos.example/album/7')).toBeUndefined();
    expect(detectChapter(parse('<p>hello</p>'), 'https://x.example/chapter-1')).toBeUndefined();
  });
});

describe('sourceUrl', () => {
  const doc = parse('<button class="more" hx-get="/series/x/all">More</button><a class="evil" href="https://evil.example/steal">x</a>');
  const page = `${BASE}/series/x`;

  it('reads a URL from an attribute', () => {
    expect(sourceUrl({ selector: 'button.more', attr: 'hx-get' }, doc, page)).toBe(`${BASE}/series/x/all`);
  });

  it('fills a template with the page URL', () => {
    expect(sourceUrl({ template: '{url}/images?style=long' }, doc, `${page}#top`)).toBe(`${BASE}/series/x/images?style=long`);
  });

  it('returns undefined when the element is missing', () => {
    expect(sourceUrl('button.missing', doc, page)).toBeUndefined();
    expect(sourceUrl(undefined, doc, page)).toBeUndefined();
  });

  it('refuses URLs on other sites', () => {
    expect(() => sourceUrl('a.evil', doc, page)).toThrow(/not on the same site/);
  });
});

describe('extractSearch', () => {
  const page = parse(`<ul class="results">
    <li><a href="/series/moon-garden"><img src="data:image/gif;base64,R0lGOD" data-src="/covers/moon.svg"><span class="name">Moon Garden</span></a></li>
    <li><a href="/series/moon-garden#again"><span class="name">Duplicate</span></a></li>
    <li><a href="/series/moon-garden/chapter/1"><span class="name">Not a series page</span></a></li>
    <li><a href="/series/iron-tide"><span class="name">Iron Tide</span></a></li>
  </ul>`);

  it('builds the URL with the query encoded', () => {
    expect(searchUrl(mangaConfig, ' moon & sun ')).toBe(`${BASE}/search?kind=manga&q=moon%20%26%20sun`);
    expect(searchUrl({ ...mangaConfig, search: undefined }, 'moon')).toBeUndefined();
  });

  it('rewrites cover URLs by prefix', () => {
    const config = { ...mangaConfig, coverRewrite: [{ from: `${BASE}/covers/`, to: 'https://cdn.example/c/' }] };
    expect(extractSearch(page, `${BASE}/search?q=moon`, config)[0]?.cover).toBe('https://cdn.example/c/moon.svg');
  });

  it('keeps one result per series page, with absolute links and lazy covers', () => {
    expect(extractSearch(page, `${BASE}/search?q=moon`, mangaConfig)).toEqual([
      { url: `${BASE}/series/moon-garden`, title: 'Moon Garden', cover: `${BASE}/covers/moon.svg` },
      { url: `${BASE}/series/iron-tide`, title: 'Iron Tide' },
    ]);
  });
});

describe('browseUrl', () => {
  it('fills the name, slug or link the config asks for', () => {
    expect(slugify('Slice of Life')).toBe('slice-of-life');
    expect(slugify('Sci-Fi & Fantasy')).toBe('sci-fi-fantasy');
    expect(browseUrl(mangaConfig, 'genres', 'Slice of life')).toBe(`${BASE}/genre/slice-of-life?kind=manga`);
    expect(browseUrl(mangaConfig, 'authors', 'Ana Ruiz', `${BASE}/author/ana-ruiz`)).toBe(`${BASE}/author/ana-ruiz`);
  });

  it('needs a link for {url} templates and never leaves the site', () => {
    const linked = { ...mangaConfig, browse: { authors: { url: '{url}', item: 'li' } } };
    expect(browseUrl(linked, 'authors', 'Ana Ruiz')).toBeUndefined();
    expect(browseUrl(linked, 'authors', 'Ana Ruiz', `${BASE}/author/ana`)).toBe(`${BASE}/author/ana`);
    expect(browseUrl(linked, 'authors', 'Ana Ruiz', 'https://evil.example/author/ana')).toBeUndefined();
    expect(browseUrl({ ...mangaConfig, browse: undefined }, 'genres', 'Fantasy')).toBeUndefined();
  });
});

describe('paginated chapter lists (chapters.next)', () => {
  const config = parseSiteConfig({
    ...novelConfig,
    series: { ...novelConfig.series, chapters: { item: 'ul.list a', order: 'oldest-first', from: { template: '{url}/chapters' }, next: 'a[rel=next]' } },
  });
  const listPage = (n: number, last: number, next = n + 1) =>
    `<ul class="list"><li><a href="/novel/x/chapter/${2 * n - 1}">Ch ${2 * n - 1}</a></li><li><a href="/novel/x/chapter/${2 * n}">Ch ${2 * n}</a></li></ul>` +
    (n < last ? `<a rel="next" href="/novel/x/chapters?page=${next}">›</a>` : '');
  const io = (last: number, next?: (n: number) => number) => {
    const fetched: string[] = [];
    return {
      fetched,
      fetchHtml: async (url: string) => {
        fetched.push(url);
        if (!url.includes('/chapters')) return '<h1 class="series-title">X</h1>';
        const n = Number(new URL(url).searchParams.get('page') ?? 1);
        return listPage(n, last, next?.(n));
      },
      parseHtml: (html: string) => parse(html),
    };
  };

  it('follows next links and joins every page in order', async () => {
    const site = io(3);
    const { chapters } = await loadSeries(`${BASE}/novel/x`, config, site);
    expect(chapters.map((c) => c.title)).toEqual(['Ch 1', 'Ch 2', 'Ch 3', 'Ch 4', 'Ch 5', 'Ch 6']);
    expect(site.fetched).toHaveLength(4);
  });

  it('stops when a next link points back to a page already read', async () => {
    const site = io(5, (n) => (n === 2 ? 2 : n + 1));
    const { chapters } = await loadSeries(`${BASE}/novel/x`, config, site);
    expect(chapters).toHaveLength(4);
  });

  it('gives up on lists longer than the limit', async () => {
    await expect(loadSeries(`${BASE}/novel/x`, config, io(MAX_CHAPTER_PAGES + 5))).rejects.toThrow(/more than 150 pages/);
  });
});

describe('rateLimitDelay', () => {
  it('waits as long as Retry-After asks, in seconds or as a date', () => {
    expect(rateLimitDelay('10', 0)).toBe(10_250);
    expect(rateLimitDelay(new Date(5_000).toUTCString(), 0, 0)).toBe(5_250);
  });

  it('backs off on its own without a header, and gives up eventually', () => {
    expect(rateLimitDelay(null, 0)).toBe(2_250);
    expect(rateLimitDelay(null, 1)).toBe(4_250);
    expect(rateLimitDelay('5', MAX_RATE_LIMIT_RETRIES)).toBeUndefined();
  });

  it('does not wait out long pauses', () => {
    expect(rateLimitDelay('3600', 0)).toBeUndefined();
  });
});

describe('fetchRetrying', () => {
  it('retries after a 429 and returns the next answer', async () => {
    const answers = [new Response('', { status: 429, headers: { 'retry-after': '0' } }), new Response('ok')];
    const res = await fetchRetrying(async () => answers.shift()!);
    expect(await res.text()).toBe('ok');
  });
});

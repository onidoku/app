// Fake Komga and Kavita servers for tests: just the API endpoints onidoku uses, with the response
// shapes from each project's OpenAPI spec. Served by server.mjs under /komga and /kavita, and
// called directly (as a fetch stand-in) by the core unit tests. Generated content only.

export const KOMGA_API_KEY = 'komga-test-key';
export const KOMGA_USER = { username: 'reader@example.org', password: 'secret' };
export const KAVITA_API_KEY = 'kavita-test-key';

const json = (body, status = 200, headers = {}) => ({ status, type: 'application/json', body: JSON.stringify(body), headers });
const notFound = () => ({ status: 404, type: 'application/json', body: '{"error":"Not Found"}' });
const unauthorized = () => ({ status: 401, type: 'application/json', body: '{"error":"Unauthorized"}' });

function pageSvg(label, hue) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1100" viewBox="0 0 800 1100"><rect width="800" height="1100" fill="hsl(${hue} 50% 85%)"/><text x="400" y="560" font-family="sans-serif" font-size="64" text-anchor="middle" fill="#222">${label}</text></svg>`;
  return { status: 200, type: 'image/svg+xml', body: svg };
}

function paged(items, query) {
  if (query.get('unpaged') === 'true') return { content: items, last: true, number: 0, totalPages: 1, totalElements: items.length };
  const size = Number(query.get('size') ?? 20);
  const page = Number(query.get('page') ?? 0);
  const content = items.slice(page * size, page * size + size);
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  return { content, last: page >= totalPages - 1, number: page, totalPages, totalElements: items.length };
}

/** Komga: series → books; image books have pages, the EPUB has a webpub manifest. */
export function createKomga(base) {
  const series = [
    { id: 'S1', name: 'Star Harbor', metadata: { title: 'Star Harbor', status: 'ONGOING', summary: 'Ships come home to a harbor in the sky.', genres: ['Adventure'], tags: ['space'] }, booksMetadata: { authors: [{ name: 'Rin Aoki', role: 'writer' }, { name: 'Kai Mori', role: 'penciller' }] } },
    { id: 'S2', name: 'Quiet Library', metadata: { title: 'Quiet Library', status: 'ENDED', summary: 'A novel about a library at night.', genres: ['Drama'], tags: [] }, booksMetadata: { authors: [{ name: 'June Park', role: 'writer' }] } },
  ];
  let books = [
    { id: 'B1', seriesId: 'S1', name: 'Star Harbor v01', number: 1, metadata: { title: 'Arrival', number: '1', numberSort: 1 }, media: { mediaProfile: 'DIVINA', mediaType: 'application/zip', pagesCount: 3 }, readProgress: { completed: true, page: 3 } },
    { id: 'B2', seriesId: 'S1', name: 'Star Harbor v02', number: 2, metadata: { title: 'Departure', number: '2', numberSort: 2 }, media: { mediaProfile: 'DIVINA', mediaType: 'application/zip', pagesCount: 2 }, readProgress: null },
    { id: 'B3', seriesId: 'S2', name: 'Quiet Library', number: 1, metadata: { title: 'Quiet Library', number: '1', numberSort: 1 }, media: { mediaProfile: 'EPUB', mediaType: 'application/epub+zip', pagesCount: 2, epubDivinaCompatible: false }, readProgress: null },
  ];
  const progress = [];
  // Like real EPUBs: a cover before the contents, a book-title entry wrapping the chapters, and
  // two chapters sharing a file (split at an anchor).
  const epub = {
    'OEBPS/cover.xhtml': '<html><body><img src="images/cover.svg" alt="Cover"/></body></html>',
    'OEBPS/ch1.xhtml': '<html><body><section><h1>Chapter One: Night</h1><p>The lamps were the last to fall asleep.</p><blockquote><p>Hush, said the shelves.</p></blockquote><ul><li>Lamps</li><li>Books<ul><li>Old ones</li></ul></li></ul><p><img src="images/map.svg" alt="Map of the library"/></p></section></body></html>',
    'OEBPS/ch2.xhtml': '<html><body><h1>Chapter Two: Morning</h1><p>By morning the books were back on their shelves.</p><pre>catalog --sort\n  by-title</pre><h1 id="three">Chapter Three: Noon</h1><p>Nobody noticed a thing.</p></body></html>',
  };
  const toc = [{ title: 'Quiet Library', href: 'OEBPS/ch1.xhtml', children: [
    { title: 'Chapter One: Night', href: 'OEBPS/ch1.xhtml' },
    { title: 'Chapter Two: Morning', href: 'OEBPS/ch2.xhtml' },
    { title: 'Chapter Three: Noon', href: 'OEBPS/ch2.xhtml#three' },
  ] }];
  let progression = {};
  const pageTypes = (book) => Array.from({ length: book.media.pagesCount }, (_, i) => ({ number: i + 1, fileName: `${i + 1}.jpg`, mediaType: book.id === 'B2' && i === 1 ? 'image/jxl' : 'image/jpeg', width: 800, height: 1100 }));

  function authorized(headers) {
    if (headers['x-api-key'] === KOMGA_API_KEY) return true;
    const basic = headers.authorization?.match(/^Basic (.+)$/)?.[1];
    return basic !== undefined && Buffer.from(basic, 'base64').toString() === `${KOMGA_USER.username}:${KOMGA_USER.password}`;
  }

  return {
    progress,
    /** Simulates a new book being scanned into a series. */
    addBook(seriesId = 'S1') {
      const n = books.filter((b) => b.seriesId === seriesId).length + 1;
      books = [...books, { id: `B${books.length + 1}x`, seriesId, name: `New ${n}`, number: n, metadata: { title: `Chapter ${n}`, number: String(n), numberSort: n }, media: { mediaProfile: 'DIVINA', mediaType: 'application/zip', pagesCount: 1 }, readProgress: null }];
    },
    handle({ method, url, headers, body }) {
      const path = url.pathname.slice(new URL(base).pathname.replace(/\/$/, "").length);
      if (!path.startsWith('/api/')) return { status: 200, type: 'text/html', body: '<!doctype html><title>Komga</title><div id="app"></div>' };
      if (!authorized(headers)) return unauthorized();
      const q = url.searchParams;
      let m;
      if (path === '/api/v2/users/me') return json({ id: 'U1', email: KOMGA_USER.username, roles: ['USER'] });
      if (path === '/api/v1/series' || path === '/api/v1/series/new' || path === '/api/v1/series/updated') {
        const needle = q.get('search')?.toLowerCase();
        const list = needle ? series.filter((s) => s.metadata.title.toLowerCase().includes(needle)) : path.endsWith('/new') ? [...series].reverse() : series;
        return json(paged(list, q));
      }
      if ((m = path.match(/^\/api\/v1\/series\/([^/]+)$/))) {
        const s = series.find((x) => x.id === m[1]);
        return s ? json({ ...s, booksCount: books.filter((b) => b.seriesId === s.id).length }) : notFound();
      }
      if ((m = path.match(/^\/api\/v1\/series\/([^/]+)\/books$/))) {
        const list = books.filter((b) => b.seriesId === m[1]).sort((a, b) => a.metadata.numberSort - b.metadata.numberSort);
        return json(paged(list, q));
      }
      if ((m = path.match(/^\/api\/v1\/series\/([^/]+)\/thumbnail$/))) return pageSvg(`Cover ${m[1]}`, 200);
      if ((m = path.match(/^\/api\/v1\/books\/([^/]+)(\/.*)?$/))) {
        const book = books.find((b) => b.id === m[1]);
        if (!book) return notFound();
        const rest = m[2] ?? '';
        const siblings = books.filter((b) => b.seriesId === book.seriesId).sort((a, b) => a.metadata.numberSort - b.metadata.numberSort);
        const index = siblings.indexOf(book);
        if (!rest) return json(book);
        if (rest === '/next') return siblings[index + 1] ? json(siblings[index + 1]) : notFound();
        if (rest === '/previous') return siblings[index - 1] ? json(siblings[index - 1]) : notFound();
        if (rest === '/pages') return json(pageTypes(book));
        const page = rest.match(/^\/pages\/(\d+)$/);
        if (page) {
          if (book.id === 'B2' && page[1] === '2' && q.get('convert') !== 'png') return { status: 200, type: 'image/jxl', body: 'not a browser image' };
          return pageSvg(`${book.metadata.title} · page ${page[1]}`, 30 * Number(page[1]));
        }
        if (rest === '/manifest') {
          const href = (path) => `${base}/api/v1/books/${book.id}/resource/${path}`;
          const absolute = (entries) => entries.map((e) => ({ ...e, href: href(e.href), children: e.children && absolute(e.children) }));
          return {
            status: 200,
            type: 'application/webpub+json',
            body: JSON.stringify({ readingOrder: Object.keys(epub).map((path) => ({ href: href(path), type: 'application/xhtml+xml' })), toc: absolute(toc) }),
          };
        }
        if (rest === '/progression') {
          if (method === 'PUT') {
            progression = JSON.parse(body || '{}');
            progress.push({ bookId: book.id, progression: progression.locator });
            book.readProgress = { completed: false, page: 1 };
            return { status: 204, type: 'text/plain', body: '' };
          }
          return json(progression);
        }
        const resource = rest.match(/^\/resource\/(.+)$/);
        if (resource?.[1].endsWith('.svg')) return pageSvg(resource[1], 90);
        if (resource) return epub[resource[1]] ? { status: 200, type: 'application/xhtml+xml', body: epub[resource[1]] } : notFound();
        if (rest === '/read-progress' && method === 'PATCH') {
          const update = JSON.parse(body || '{}');
          progress.push({ bookId: book.id, ...update });
          if (update.completed) book.readProgress = { completed: true, page: book.media.pagesCount };
          return { status: 204, type: 'text/plain', body: '' };
        }
      }
      return notFound();
    },
  };
}

/** Kavita: API key → JWT; series → volumes → chapters; EPUB chapters are read page by page as HTML. */
export function createKavita(base) {
  const TOKEN = 'test-jwt';
  const series = [
    { id: 1, name: 'Moon Lantern', localizedName: '', libraryId: 1, format: 1, metadata: { summary: 'A lantern that only lights at new moon.', genres: [{ id: 1, title: 'Fantasy' }], tags: [], writers: [{ id: 1, name: 'Sora Ito' }], publicationStatus: 0 } },
    { id: 2, name: 'Paper Stars', localizedName: '', libraryId: 2, format: 3, metadata: { summary: 'A light novel.', genres: [{ id: 2, title: 'Romance' }], tags: [], writers: [{ id: 2, name: 'Mei Lin' }], publicationStatus: 2 } },
  ];
  const chapters = [
    { id: 11, seriesId: 1, volumeId: 101, range: '-100000', minNumber: -100000, sortOrder: 0, title: '', titleName: '', pages: 3, pagesRead: 3, isSpecial: false },
    { id: 12, seriesId: 1, volumeId: 199, range: '2', minNumber: 2, sortOrder: 2, title: '2', titleName: 'Ember', pages: 2, pagesRead: 0, isSpecial: false },
    { id: 13, seriesId: 1, volumeId: 199, range: '3', minNumber: 3, sortOrder: 3, title: '3', titleName: '', pages: 2, pagesRead: 0, isSpecial: false },
    { id: 21, seriesId: 2, volumeId: 201, range: '-100000', minNumber: -100000, sortOrder: 0, title: '', titleName: '', pages: 3, pagesRead: 0, isSpecial: false },
  ];
  const volumes = [
    { id: 101, seriesId: 1, name: '1', minNumber: 1, maxNumber: 1 },
    { id: 199, seriesId: 1, name: '-100000', minNumber: -100000, maxNumber: -100000 },
    { id: 201, seriesId: 2, name: '1', minNumber: 1, maxNumber: 1 },
  ];
  // Kavita hands out EPUB pages as HTML fragments, with a table of contents pointing into them.
  const bookPages = [
    '<div><p>Paper Stars</p><p>A light novel</p></div>',
    '<div><h2>One</h2><p>Paper stars only shine indoors.</p><ol><li>Fold</li><li>Wait</li></ol></div>',
    '<div><h2>Two</h2><p>She folded one more before sleeping.</p><h2 id="three">Three</h2><p>It glowed.</p></div>',
  ];
  const bookToc = [{ title: 'Paper Stars', page: 1, part: '', children: [
    { title: 'One', page: 1, part: '', children: [] },
    { title: 'Two', page: 2, part: '', children: [] },
    { title: 'Three', page: 2, part: 'three', children: [] },
  ] }];
  const progress = [];

  const ordered = (seriesId) => chapters.filter((c) => c.seriesId === seriesId);
  const info = (c) => {
    const s = series.find((x) => x.id === c.seriesId);
    return { chapterNumber: c.range, volumeNumber: volumes.find((v) => v.id === c.volumeId).name, volumeId: c.volumeId, seriesName: s.name, seriesFormat: s.format, seriesId: s.id, libraryId: s.libraryId, libraryType: s.format === 3 ? 4 : 0, chapterTitle: c.titleName, pages: c.pages, fileName: `c${c.id}.cbz`, isSpecial: false, subtitle: c.titleName ? `Ch. ${c.range} - ${c.titleName}` : `Ch. ${c.range}`, title: s.name };
  };

  return {
    progress,
    TOKEN,
    addChapter(seriesId = 1) {
      const n = ordered(seriesId).length + 1;
      chapters.push({ id: 100 + chapters.length, seriesId, volumeId: 199, range: String(n), minNumber: n, sortOrder: n, title: String(n), titleName: '', pages: 1, pagesRead: 0, isSpecial: false });
    },
    handle({ method, url, headers, body }) {
      const path = url.pathname.slice(new URL(base).pathname.replace(/\/$/, "").length);
      if (!path.startsWith('/api/')) return { status: 200, type: 'text/html', body: '<!doctype html><title>Kavita</title><app-root></app-root>' };
      const q = url.searchParams;
      if (path === '/api/Plugin/authenticate' && method === 'POST') {
        return q.get('apiKey') === KAVITA_API_KEY ? json({ username: 'reader', token: TOKEN, apiKey: KAVITA_API_KEY }) : unauthorized();
      }
      if (headers.authorization !== `Bearer ${TOKEN}`) return unauthorized();
      let m;
      if ((m = path.match(/^\/api\/Series\/(\d+)$/))) {
        const s = series.find((x) => x.id === Number(m[1]));
        return s ? json({ id: s.id, name: s.name, localizedName: s.localizedName, libraryId: s.libraryId, format: s.format }) : notFound();
      }
      if (path === '/api/Series/metadata') return json(series.find((x) => x.id === Number(q.get('seriesId')))?.metadata ?? {});
      if (path === '/api/Series/series-detail') {
        const id = Number(q.get('seriesId'));
        const vols = volumes.filter((v) => v.seriesId === id).map((v) => ({ ...v, chapters: chapters.filter((c) => c.volumeId === v.id) }));
        return json({ volumes: vols, chapters: chapters.filter((c) => c.seriesId === id && volumes.find((v) => v.id === c.volumeId)?.minNumber === -100000), specials: [], storylineChapters: [], unreadCount: 0, totalCount: 0 });
      }
      if (path === '/api/Series/all-v2' && method === 'POST') {
        const filter = JSON.parse(body || '{}');
        const list = filter.sortOptions?.sortField === 1 ? [...series].sort((a, b) => a.name.localeCompare(b.name)) : series;
        const size = Number(q.get('PageSize') ?? 20);
        const page = Number(q.get('PageNumber') ?? 1);
        return json(list.slice((page - 1) * size, page * size).map(({ metadata, ...s }) => s));
      }
      if (path === '/api/Search/search') {
        const needle = (q.get('queryString') ?? '').toLowerCase();
        return json({ libraries: [], series: series.filter((s) => s.name.toLowerCase().includes(needle)).map((s) => ({ seriesId: s.id, name: s.name, libraryId: s.libraryId, format: s.format })) });
      }
      if (path === '/api/Image/series-cover') return pageSvg(`Cover ${q.get('seriesId')}`, 120);
      const chapter = chapters.find((c) => c.id === Number(q.get('chapterId') ?? q.get('currentChapterId')));
      if (path === '/api/Reader/chapter-info') return chapter ? json(info(chapter)) : notFound();
      if (path === '/api/Reader/image') return chapter ? pageSvg(`Chapter ${chapter.range} · page ${Number(q.get('page')) + 1}`, 60 * Number(q.get('page'))) : notFound();
      if ((m = path.match(/^\/api\/Reader\/(next|prev)-chapter$/))) {
        if (!chapter) return json(-1);
        const order = ordered(chapter.seriesId).sort((a, b) => {
          const va = volumes.find((v) => v.id === a.volumeId).minNumber;
          const vb = volumes.find((v) => v.id === b.volumeId).minNumber;
          return (va === -100000 ? 1e9 : va) - (vb === -100000 ? 1e9 : vb) || a.sortOrder - b.sortOrder;
        });
        const sibling = order[order.indexOf(chapter) + (m[1] === 'next' ? 1 : -1)];
        return json(sibling ? sibling.id : -1);
      }
      if (path === '/api/Reader/progress' && method === 'POST') {
        const update = JSON.parse(body || '{}');
        progress.push(update);
        const target = chapters.find((c) => c.id === update.chapterId);
        if (target) target.pagesRead = Math.min(update.pageNum, target.pages);
        return { status: 200, type: 'text/plain', body: '' };
      }
      if ((m = path.match(/^\/api\/Book\/(\d+)\/book-info$/))) {
        const c = chapters.find((x) => x.id === Number(m[1]));
        return c ? json({ bookTitle: 'Paper Stars', seriesId: c.seriesId, volumeId: c.volumeId, seriesFormat: 3, pages: bookPages.length }) : notFound();
      }
      if ((m = path.match(/^\/api\/Book\/(\d+)\/chapters$/))) return json(bookToc);
      if ((m = path.match(/^\/api\/Book\/(\d+)\/book-page$/))) {
        const page = bookPages[Number(q.get('page'))];
        return page ? { status: 200, type: 'text/html', body: page } : notFound();
      }
      return notFound();
    },
  };
}

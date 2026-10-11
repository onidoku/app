// A fake comic + novel site for testing. Content is generated, so nothing copyrighted is involved.
// Markup deliberately mimics real-world quirks: lazy-loaded images, ads, logos, newest-first lists.

const PAGES_PER_CHAPTER = 6;
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

const INITIAL = [
  { id: 'moon-garden', title: 'Moon Garden', kind: 'manga', chapters: 5, hue: 205, authors: ['Ana Ruiz', 'Ken Ito'], genres: ['Fantasy', 'Slice of life'], status: 'Ongoing' },
  { id: 'iron-tide', title: 'Iron Tide', kind: 'manga', chapters: 3, hue: 20, authors: ['Sol Park'], genres: ['Action'], status: 'Completed' },
  { id: 'quiet-orbit', title: 'Quiet Orbit', kind: 'novel', chapters: 4, hue: 140, authors: ['Mira Chen'], genres: ['Sci-fi', 'Mystery'], status: 'Ongoing' },
  // Loads like many modern sites (htmx/fetch): partial chapter list with a "show all" button,
  // chapter images fetched after the page loads, and no next/prev links in the HTML.
  { id: 'long-road', title: 'Long Road', kind: 'lazy', chapters: 8, hue: 280, authors: ['Rin Sato'], genres: ['Adventure'], status: 'Ongoing' },
];
const LAZY_PREVIEW = 2;

// A single-page-app reader, like many modern comic sites: the server sends an empty shell, the
// script fetches each page and shows it as a blob: URL, chapter ids are opaque (the first starts
// with a digit, which isn't a chapter number), and chapters change with pushState. No config covers it.
const APP = { id: 'star-ferry', title: 'Star Ferry', hue: 320, chapters: ['3f2e9a1c', 'b81d04e7', '9c03aa52'] };

const SENTENCES = [
  'The station hummed in the dark between two moons.',
  'Mira counted the seconds between each pulse of the beacon.',
  'Nobody had answered the call in eleven days.',
  'She wrote the numbers down anyway, because writing them felt like company.',
  'Somewhere below, the garden lamps flickered on, one row at a time.',
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const prefix = (s) => ({ manga: 'series', novel: 'novel', lazy: 'lazy' })[s.kind];

export function createSite() {
  let series;
  const reset = () => {
    series = new Map(INITIAL.map((s) => [s.id, { ...s }]));
  };
  reset();

  const html = (body) => ({ status: 200, type: 'text/html; charset=utf-8', body });
  const svg = (body) => ({ status: 200, type: 'image/svg+xml', body });
  const text = (status, body) => ({ status, type: 'text/plain; charset=utf-8', body });
  const notFound = () => text(404, 'Not found');

  function layout(title, body) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Test Site</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f4f4f5;color:#18181b}
  header{display:flex;gap:10px;align-items:center;padding:10px 16px;background:#fff;border-bottom:1px solid #e4e4e7}
  main{max-width:820px;margin:0 auto;padding:16px}
  .reader img{display:block;width:100%;margin:0 auto 8px}
  aside{display:flex;gap:12px;justify-content:center;padding:16px}
  nav{display:flex;gap:12px;margin:12px 0}
  .chapter-list a{display:flex;justify-content:space-between;padding:6px 0}
</style></head>
<body>
<header><a href="/"><img src="/static/logo.svg" width="32" height="32" alt=""></a><strong>Test Site</strong></header>
<main>${body}</main>
<aside><img class="ad" src="/static/ad.svg" width="300" height="250" alt=""><img class="ad" src="/static/ad.svg?slot=2" width="300" height="250" alt=""></aside>
</body></html>`;
  }

  function indexPage() {
    const items = [...series.values()]
      .map((s) => `<li><a href="/${prefix(s)}/${s.id}">${esc(s.title)}</a> (${s.kind}, ${s.chapters} chapters)</li>`)
      .join('');
    const app = `<li><a href="/app/${APP.id}/chapter/${APP.chapters[0]}">${APP.title}</a> (single-page app, ${APP.chapters.length} chapters)</li>`;
    return layout('Home', `<h1>Test Site</h1><ul>${items}${app}</ul>`);
  }

  function seriesPage(s) {
    const chapters = [];
    for (let n = s.chapters; n >= 1; n--) {
      chapters.push(
        `<li><a href="/${prefix(s)}/${s.id}/chapter/${n}"><span class="chapter-name">Chapter ${n}</span><time>2026-09-${String(n).padStart(2, '0')}</time></a></li>`,
      );
    }
    return layout(
      s.title,
      `<h1 class="series-title">${esc(s.title)}</h1>
<img class="cover" src="${PLACEHOLDER}" data-src="/covers/${s.id}.svg" width="240" height="340" alt="">
<div class="meta">
  <p>By ${s.authors.map((a) => `<a class="author" href="/author/${slug(a)}">${esc(a)}</a>`).join(', ')} · <span class="status">${esc(s.status)}</span></p>
  <ul class="genres">${s.genres.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
</div>
<div class="synopsis"><p>${esc(s.title)} is a generated ${s.kind} series for testing onidoku.</p><p>${SENTENCES[s.hue % SENTENCES.length]}</p></div>
<ul class="chapter-list">${chapters.join('')}</ul>`,
    );
  }

  function chapterPage(s, n) {
    const base = `/${prefix(s)}/${s.id}`;
    const nav = `<nav><a class="back" href="${base}">${esc(s.title)}</a>${
      n > 1 ? `<a class="prev" href="${base}/chapter/${n - 1}">Prev</a>` : ''
    }${n < s.chapters ? `<a class="next" href="${base}/chapter/${n + 1}">Next</a>` : ''}</nav>`;
    const heading = `<h1 class="chapter-title">${esc(s.title)} – Chapter ${n}</h1>`;

    if (s.kind === 'novel') {
      // Three sentences a paragraph: long enough to read as a real chapter to the reader's text detection.
      const sentence = (k) => SENTENCES[k % SENTENCES.length];
      const paragraphs = Array.from({ length: 12 }, (_, i) => `<p>${[0, 1, 2].map((j) => sentence(i + n + j)).join(' ')}</p>`).join('');
      return layout(`${s.title} ${n}`, `${nav}${heading}<article class="chapter-text">${paragraphs}</article>${nav}`);
    }
    const pages = Array.from(
      { length: PAGES_PER_CHAPTER },
      (_, i) => `<div class="page"><img src="${PLACEHOLDER}" data-src="/pages/${s.id}/${n}/${i + 1}.svg" alt=""></div>`,
    ).join('');
    return layout(`${s.title} ${n}`, `${nav}${heading}<div class="reader">${pages}</div>${nav}`);
  }

  // Search like most sites do it: a results page with a cover, title and link per series.
  function searchPage(query, kind) {
    const needle = query.trim().toLowerCase();
    return listPage(`Search: ${query}`, `Results for “${query}”`, (s) => (!kind || s.kind === kind) && needle && s.title.toLowerCase().includes(needle));
  }

  /** Popular (most chapters) and latest (newest first) listings, paged like most sites. */
  function explorePage(which, kind, page, per) {
    const all = [...series.values()].filter((s) => !kind || s.kind === kind);
    const sorted = which === 'popular' ? all.sort((a, b) => b.chapters - a.chapters) : all.reverse();
    const slice = new Set(sorted.slice((page - 1) * per, page * per));
    const heading = `${which === 'popular' ? 'Popular' : 'Latest updates'} · page ${page}`;
    return listPage(heading, heading, (s) => slice.has(s), [...slice]);
  }

  /** Author and genre pages list series with the same markup as search results. */
  function listPage(title, heading, keep, order = [...series.values()]) {
    const items = order
      .filter(keep)
      .map(
        (s) =>
          `<li class="result"><a href="/${prefix(s)}/${s.id}"><img src="${PLACEHOLDER}" data-src="/covers/${s.id}.svg" alt=""><span class="name">${esc(s.title)}</span></a></li>`,
      )
      .join('');
    return layout(title, `<h1>${esc(heading)}</h1>${items ? `<ul class="results">${items}</ul>` : '<p>No results.</p>'}`);
  }

  function lazyChapterLinks(s, count) {
    const rows = [];
    for (let n = s.chapters; n > s.chapters - count && n >= 1; n--) {
      rows.push(`<div class="row"><a class="ch" href="/lazy/${s.id}/chapter/${n}"><span class="name">Chapter ${n}</span> <span class="badge">new</span></a></div>`);
    }
    return rows.join('');
  }

  function lazySeriesPage(s) {
    const more =
      s.chapters > LAZY_PREVIEW
        ? `<button class="show-all" hx-get="/lazy/${s.id}/full-chapter-list" hx-swap="outerHTML">Show all chapters</button>`
        : '';
    return layout(
      s.title,
      `<h1 class="series-title">${esc(s.title)}</h1>
<img class="cover" src="/covers/${s.id}.svg" width="240" height="340" alt="">
<div id="chapter-list">${lazyChapterLinks(s, LAZY_PREVIEW)}${more}</div>
<script>
  document.querySelector('.show-all')?.addEventListener('click', async (e) => {
    e.target.outerHTML = await (await fetch(e.target.getAttribute('hx-get'))).text();
  });
</script>`,
    );
  }

  function lazyChapterPage(s, n) {
    return layout(
      `${s.title} ${n}`,
      `<a class="back" href="/lazy/${s.id}">${esc(s.title)}</a>
<h1 class="chapter-title">${esc(s.title)} – Chapter ${n}</h1>
<div id="chapter-images"></div>
<script>
  fetch(location.pathname + '/images')
    .then((r) => r.text())
    .then((html) => (document.getElementById('chapter-images').innerHTML = html));
</script>`,
    );
  }

  function pageSvg(s, n, p) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200">
<rect width="800" height="1200" fill="hsl(${s.hue} 45% ${90 - p * 5}%)"/>
<rect x="40" y="40" width="720" height="1120" fill="none" stroke="#222" stroke-width="6"/>
<text x="400" y="560" font-family="sans-serif" font-size="60" text-anchor="middle" fill="#222">${esc(s.title)}</text>
<text x="400" y="650" font-family="sans-serif" font-size="44" text-anchor="middle" fill="#222">Chapter ${n} · Page ${p}/${PAGES_PER_CHAPTER}</text>
</svg>`;
  }

  function coverSvg(s) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="340" viewBox="0 0 240 340">
<rect width="240" height="340" fill="hsl(${s.hue} 55% 45%)"/>
<text x="120" y="180" font-family="sans-serif" font-size="26" text-anchor="middle" fill="#fff">${esc(s.title)}</text></svg>`;
  }

  function appShell() {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Star Ferry · Test Site</title>
<style>body{margin:0;background:#111;color:#eee;font:16px system-ui,sans-serif}#app img{display:block;width:100%;max-width:800px;margin:0 auto}.bar{display:flex;gap:12px;justify-content:center;padding:12px}.bar a{color:#9cf}</style>
</head><body><div id="app">Loading…</div><script src="/static/app.js"></script></body></html>`;
  }

  /** The app's chapter data, as its JSON API would return it. */
  function appChapter(index) {
    const id = APP.chapters[index];
    if (!id) return undefined;
    const link = (i) => (APP.chapters[i] ? `/app/${APP.id}/chapter/${APP.chapters[i]}` : null);
    return {
      title: `${APP.title} - Ch. ${index + 1}`,
      pages: Array.from({ length: PAGES_PER_CHAPTER }, (_, p) => `/app-pages/${index + 1}/${p + 1}.svg`),
      prev: link(index - 1),
      next: link(index + 1),
    };
  }

  const APP_JS = `
async function render() {
  const app = document.getElementById('app');
  const id = location.pathname.split('/').pop();
  const res = await fetch('/api/app/chapter/' + id);
  if (!res.ok) { app.textContent = 'Not found'; return; }
  const ch = await res.json();
  document.title = ch.title + ' · Test Site';
  // Pages arrive a moment after the shell, as object URLs, the way many readers load them.
  await new Promise((r) => setTimeout(r, 300));
  const imgs = await Promise.all(ch.pages.map(async (src) => {
    const img = document.createElement('img');
    img.src = URL.createObjectURL(await (await fetch(src)).blob());
    await img.decode().catch(() => {});
    return img;
  }));
  const bar = () => {
    const el = document.createElement('div');
    el.className = 'bar';
    for (const [label, href] of [['Previous chapter', ch.prev], ['Next chapter', ch.next]]) {
      if (!href) continue;
      const a = document.createElement('a');
      a.href = href;
      a.textContent = label;
      el.append(a);
    }
    return el;
  };
  const strip = document.createElement('div');
  strip.className = 'strip';
  strip.append(...imgs);
  app.replaceChildren(bar(), strip, bar());
}
document.addEventListener('click', (event) => {
  const a = event.target.closest && event.target.closest('a[href^="/app/"]');
  if (!a) return;
  event.preventDefault();
  history.pushState(null, '', a.href);
  render();
});
addEventListener('popstate', render);
render();
`;

  // ---- JSON API for the Paperback test source (paperback/TestComics/source.js) ----
  // Like sites that check where requests come from, it answers only requests carrying the
  // source's own header, a referer on this site and its cookie: headers the source sets in its
  // interceptor, and browser pages can't set themselves.
  const json = (data) => ({ status: 200, type: 'application/json', body: JSON.stringify(data) });
  const comics = () => [...series.values()].filter((s) => s.kind !== 'novel');
  const pbTile = (s, origin) => ({ id: s.id, title: s.title, cover: `${origin}/covers/${s.id}.svg` });

  function fromPaperback(url, headers) {
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join('; ') : String(v ?? '')]));
    return h['x-test-source'] === 'paperback' && (h.referer ?? '').startsWith(`${url.origin}/`) && /(?:^|;\s*)pb-mature=1(?:;|$)/.test(h.cookie ?? '');
  }

  function paperbackApi(url, { method = 'GET', headers = {}, body = '' }) {
    const path = url.pathname;
    let m;
    // The same refusal Cloudflare gives, for the source's "open the site first" error.
    if (!fromPaperback(url, headers) || path.startsWith('/api/pb/manga/cf-blocked')) {
      return { status: 403, type: 'text/plain', body: 'Forbidden', headers: { 'cf-mitigated': 'challenge' } };
    }
    if (path === '/api/pb/search' && method === 'POST') {
      const needle = decodeURIComponent(new URLSearchParams(body).get('q') ?? '').trim().toLowerCase();
      return json(comics().filter((s) => needle && s.title.toLowerCase().includes(needle)).map((s) => pbTile(s, url.origin)));
    }
    if (path === '/api/pb/popular') {
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const per = Math.max(1, Number(url.searchParams.get('per')) || 20);
      const sorted = comics().sort((a, b) => b.chapters - a.chapters);
      return json(sorted.slice((page - 1) * per, page * per).map((s) => pbTile(s, url.origin)));
    }
    if (path === '/api/pb/featured') return json(comics().slice(0, 2).map((s) => pbTile(s, url.origin)));
    if ((m = path.match(/^\/api\/pb\/manga\/([\w-]+)$/))) {
      const s = series.get(m[1]);
      if (!s || s.kind === 'novel') return notFound();
      return json({
        title: s.title,
        cover: `${url.origin}/covers/${s.id}.svg`,
        authors: s.authors,
        genres: s.genres,
        status: s.status,
        description: `<p>${esc(s.title)} is a generated comic for testing onidoku.</p>`,
      });
    }
    if ((m = path.match(/^\/api\/pb\/manga\/([\w-]+)\/chapters$/))) {
      const s = series.get(m[1]);
      if (!s || s.kind === 'novel') return notFound();
      const list = [];
      for (let n = s.chapters; n >= 1; n--) list.push({ id: `c${n}`, name: n === 1 ? 'The Beginning' : `Chapter ${n}`, number: n });
      return json(list);
    }
    if ((m = path.match(/^\/api\/pb\/chapter\/([\w-]+)\/c(\d+)$/))) {
      const s = series.get(m[1]);
      const n = Number(m[2]);
      if (!s || s.kind === 'novel' || n < 1 || n > s.chapters) return notFound();
      return json({ pages: Array.from({ length: PAGES_PER_CHAPTER }, (_, i) => `${url.origin}/pb-pages/${s.id}/${n}/${i + 1}.svg`) });
    }
    return notFound();
  }

  /**
   * @param {URL} url
   * @param {{ method?: string, headers?: Record<string, string | string[] | undefined>, body?: string }} [request]
   */
  function handle(url, request = {}) {
    const path = url.pathname;
    let m;
    if (path === '/') return html(indexPage());
    if (path.startsWith('/api/pb/')) return paperbackApi(url, request);
    // Paperback chapter pages: only shown with a referer on this site, like hotlink-protected image hosts.
    if ((m = path.match(/^\/pb-pages\/([\w-]+)\/(\d+)\/(\d+)\.svg$/))) {
      const referer = String(Object.entries(request.headers ?? {}).find(([k]) => k.toLowerCase() === 'referer')?.[1] ?? '');
      if (!referer.startsWith(`${url.origin}/`)) return text(403, 'Hotlinking not allowed');
      const s = series.get(m[1]);
      const n = Number(m[2]);
      const p = Number(m[3]);
      if (!s || n < 1 || n > s.chapters || p < 1 || p > PAGES_PER_CHAPTER) return notFound();
      return svg(pageSvg(s, n, p));
    }

    // Test controls: simulate a site publishing a new chapter.
    if (path === '/__admin/add-chapter') {
      const s = series.get(url.searchParams.get('series') ?? '');
      if (!s) return text(404, `Unknown series. Try one of: ${[...series.keys()].join(', ')}`);
      s.chapters += 1;
      return text(200, `${s.title} now has ${s.chapters} chapters`);
    }
    if (path === '/__admin/reset') {
      reset();
      return text(200, 'Reset');
    }

    if (path === '/popular' || path === '/latest') {
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const per = Math.max(1, Number(url.searchParams.get('per')) || 20);
      return html(explorePage(path.slice(1), url.searchParams.get('kind'), page, per));
    }
    if (path === '/search') return html(searchPage(url.searchParams.get('q') ?? '', url.searchParams.get('kind')));
    if ((m = path.match(/^\/author\/([\w-]+)$/))) {
      const name = [...series.values()].flatMap((s) => s.authors).find((a) => slug(a) === m[1]);
      return name ? html(listPage(name, `Series by ${name}`, (s) => s.authors.includes(name))) : notFound();
    }
    if ((m = path.match(/^\/genre\/([\w-]+)$/))) {
      const kind = url.searchParams.get('kind');
      return html(listPage(m[1], `Genre: ${m[1]}`, (s) => (!kind || s.kind === kind) && s.genres.some((g) => slug(g) === m[1])));
    }

    if (path === '/static/logo.svg')
      return svg('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#6366f1"/></svg>');
    if (path === '/static/ad.svg')
      return svg(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="250"><rect width="300" height="250" fill="#fde68a"/><text x="150" y="130" font-family="sans-serif" font-size="28" text-anchor="middle">AD</text></svg>',
      );
    if (path === '/static/app.js') return { status: 200, type: 'text/javascript; charset=utf-8', body: APP_JS };
    if ((m = path.match(/^\/app\/([\w-]+)\/chapter\/([\w-]+)\/?$/))) {
      return m[1] === APP.id && APP.chapters.includes(m[2]) ? html(appShell()) : notFound();
    }
    if ((m = path.match(/^\/api\/app\/chapter\/([\w-]+)$/))) {
      const chapter = appChapter(APP.chapters.indexOf(m[1]));
      return chapter ? { status: 200, type: 'application/json', body: JSON.stringify(chapter) } : notFound();
    }
    if ((m = path.match(/^\/app-pages\/(\d+)\/(\d+)\.svg$/))) {
      const [n, p] = [Number(m[1]), Number(m[2])];
      return n >= 1 && n <= APP.chapters.length && p >= 1 && p <= PAGES_PER_CHAPTER ? svg(pageSvg(APP, n, p)) : notFound();
    }
    if ((m = path.match(/^\/covers\/([\w-]+)\.svg$/))) {
      const s = series.get(m[1]);
      return s ? svg(coverSvg(s)) : notFound();
    }
    if ((m = path.match(/^\/pages\/([\w-]+)\/(\d+)\/(\d+)\.svg$/))) {
      const s = series.get(m[1]);
      const n = Number(m[2]);
      const p = Number(m[3]);
      if (!s || n < 1 || n > s.chapters || p < 1 || p > PAGES_PER_CHAPTER) return notFound();
      return svg(pageSvg(s, n, p));
    }
    if ((m = path.match(/^\/lazy\/([\w-]+)\/full-chapter-list$/))) {
      const s = series.get(m[1]);
      return s?.kind === 'lazy' ? html(lazyChapterLinks(s, s.chapters)) : notFound();
    }
    if ((m = path.match(/^\/lazy\/([\w-]+)\/chapter\/(\d+)\/images$/))) {
      const s = series.get(m[1]);
      const n = Number(m[2]);
      if (s?.kind !== 'lazy' || n < 1 || n > s.chapters) return notFound();
      return html(
        Array.from({ length: PAGES_PER_CHAPTER }, (_, i) => `<img src="/pages/${s.id}/${n}/${i + 1}.svg" alt="Page ${i + 1}">`).join(''),
      );
    }
    if ((m = path.match(/^\/lazy\/([\w-]+)\/?$/))) {
      const s = series.get(m[1]);
      return s?.kind === 'lazy' ? html(lazySeriesPage(s)) : notFound();
    }
    if ((m = path.match(/^\/lazy\/([\w-]+)\/chapter\/(\d+)\/?$/))) {
      const s = series.get(m[1]);
      const n = Number(m[2]);
      return s?.kind === 'lazy' && n >= 1 && n <= s.chapters ? html(lazyChapterPage(s, n)) : notFound();
    }
    if ((m = path.match(/^\/(series|novel)\/([\w-]+)\/?$/))) {
      const s = series.get(m[2]);
      return s && prefix(s) === m[1] ? html(seriesPage(s)) : notFound();
    }
    if ((m = path.match(/^\/(series|novel)\/([\w-]+)\/chapter\/(\d+)\/?$/))) {
      const s = series.get(m[2]);
      const n = Number(m[3]);
      return s && prefix(s) === m[1] && n >= 1 && n <= s.chapters ? html(chapterPage(s, n)) : notFound();
    }
    return notFound();
  }

  return { handle, reset };
}

// Builds one store slide from real screenshots (shots/*.png) and the positions of UI elements in them
// (shots/data.json), both written by scripts/store-shots.mjs.
const params = new URLSearchParams(location.search);
const slideId = params.get('slide') ?? 'hero';
const data = await (await fetch('shots/data.json')).json();
const root = document.getElementById('slide');
const wide = matchMedia('(min-aspect-ratio: 3/2)').matches;
const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
const BAR_REM = 3; // .chrome-bar height

/** Tiny DOM helper: el('div.a.b', { style, html }, ...children). */
function el(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

const logo = () => el('img', { src: 'logo.svg', alt: '' });
const px = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, `${v}px`]));

function copy({ eyebrow, title, sub, points = [], brand = false }) {
  return el(
    'div.copy',
    {},
    brand ? el('div.brandline', {}, logo(), 'onidoku') : null,
    eyebrow ? el('p.eyebrow', { html: eyebrow }) : null,
    el('h1', { html: title }),
    sub ? el('p.sub', { html: sub }) : null,
    points.length ? el('div.points', {}, points.map((p) => el('span.pill', { html: p }))) : null,
  );
}

/**
 * Width that fits a screenshot inside W% of the visual's width and H% of its height.
 * Browser windows add the address bar's height.
 */
function fit(name, W, H, popup = false) {
  const { w, h } = data[name];
  const bar = popup ? '0px' : `${BAR_REM}rem`;
  return `min(${W}cqw, calc((${H}cqh - ${bar}) * ${w / h}))`;
}

/**
 * A screenshot in a browser window (or as a popup card), with callouts on real elements.
 * callouts: [{ rect: key in data.json (or 'all'), label, side, gap, pad, box }]
 */
function shot(name, { url, popup = false, badge, callouts = [], style = {} } = {}) {
  const info = data[name];
  const img = el('img', { src: `shots/${name}.png`, alt: '' });
  const bar = popup
    ? null
    : el('div.chrome-bar', {}, el('span.dots', {}, el('i'), el('i'), el('i')), el('span.url', {}, url ?? ''),
        el('span.ext', {}, el('img', { src: 'logo.svg', alt: '' }), badge ? el('b', {}, String(badge)) : null));
  const marks = el('div.marks');
  const wrap = el(popup ? 'div.shot.popup' : 'div.shot', { style }, el('div.frame', {}, bar, img), marks);
  wrap.layout = () => {
    const box = wrap.getBoundingClientRect();
    const pic = img.getBoundingClientRect();
    const scale = pic.width / info.w;
    for (const c of callouts) {
      let [x, y, w, h] = c.rect === 'all' ? [0, 0, info.w, info.h] : info.rects[c.rect];
      // Keep boxes inside the screenshot.
      [w, h] = [Math.min(w, info.w - x), Math.min(h, info.h - y)];
      const pad = (c.pad ?? 6) * scale;
      const r = {
        left: pic.left - box.left + x * scale - pad,
        top: pic.top - box.top + y * scale - pad,
        width: w * scale + 2 * pad,
        height: h * scale + 2 * pad,
      };
      if (c.box !== false) marks.append(el('div.hl', { style: px(r) }));
      if (c.label) marks.append(...tag(r, c));
    }
  };
  return wrap;
}

/** A numbered label beside a box, joined by a short gold line. Numbers are set later, in reading order. */
function tag(r, { label, side = 'right', gap = 3 }) {
  const t = el('div.tag', {}, el('span.n'), el('span', { html: label }));
  const line = el('div.line');
  const g = gap * remPx;
  const thick = 0.28 * remPx;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  t.place = () => {
    const { width: tw, height: th } = t.getBoundingClientRect();
    const pos = {
      right: [r.left + r.width + g, cy - th / 2],
      left: [r.left - g - tw, cy - th / 2],
      top: [cx - tw / 2, r.top - g - th],
      bottom: [cx - tw / 2, r.top + r.height + g],
    }[side];
    Object.assign(t.style, px({ left: pos[0], top: pos[1] }));
    const lines = {
      right: { left: r.left + r.width, top: cy - thick / 2, width: g, height: thick },
      left: { left: r.left - g, top: cy - thick / 2, width: g, height: thick },
      top: { left: cx - thick / 2, top: r.top - g, width: thick, height: g },
      bottom: { left: cx - thick / 2, top: r.top + r.height, width: thick, height: g },
    };
    Object.assign(line.style, px(lines[side]));
    // Nudge labels that would leave the slide back inside it (the line still points at the box).
    const slide = root.getBoundingClientRect();
    const tr = t.getBoundingClientRect();
    const margin = 1.6 * remPx;
    const dx = Math.min(0, slide.right - margin - tr.right) || Math.max(0, slide.left + margin - tr.left);
    const dy = Math.min(0, slide.bottom - margin - tr.bottom) || Math.max(0, slide.top + margin - tr.top);
    if (dx || dy) Object.assign(t.style, px({ left: pos[0] + dx, top: pos[1] + dy }));
  };
  return [line, t];
}

/** A label that isn't attached to a screenshot element. */
const floatTag = (label, style) => el('div.tag', { style }, el('span.n'), el('span', { html: label }));

/** Looks like onidoku's real notifications: the series as the title, then "new: <chapter>". */
function toast(series, message, when, style) {
  return el('div.toast', { style }, logo(), el('div', {}, el('small', {}, `onidoku · ${when}`), el('strong', {}, series), el('span', {}, message)));
}

const ICONS = {
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/>',
  noUser: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/><path d="M3 3l18 18"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18"/><path d="M8 14l3 3 5-5"/>',
  code: '<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/><path d="M14 4l-4 16"/>',
  download: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>',
};
const card = (icon, title, text) =>
  el('div.card', {}, el('span', { html: `<svg viewBox="0 0 24 24">${ICONS[icon]}</svg>` }), el('h3', {}, title), el('p', {}, text));

const visual = (...children) => el('div.visual', {}, ...children);

const SLIDES = {
  hero: () => [
    copy({
      brand: true,
      eyebrow: 'for comics and novels',
      title: 'read like <br><span class="grad">a demon.</span>',
      sub: 'one clean reader, one library and new-chapter alerts for every comic and novel you follow.',
      points: ['no ads', 'no account', 'no tracking'],
    }),
    visual(
      shot('reader-comic', {
        url: 'peppercarrot.com/en/webcomic/ep01_Potion-of-Flight.html',
        badge: 3,
        style: wide
          ? { width: fit('reader-comic', 90, 88), left: '0', top: '50%', transform: 'translateY(-50%)' }
          : { width: fit('reader-comic', 84, 100), left: '3cqw', top: '0' },
      }),
      shot('popup-light', {
        popup: true,
        style: wide
          ? { width: fit('popup-light', 32, 82, true), right: '0', bottom: '2cqh', transform: 'rotate(2.5deg)' }
          : { width: fit('popup-light', 30, 92, true), right: '5cqw', bottom: '0', transform: 'rotate(2.5deg)' },
      }),
    ),
  ],

  reader: () => [
    copy({
      eyebrow: '✦ the reader',
      title: 'a reader that gets <span class="grad">out of the way</span>',
      sub: 'no sidebars, pop-ups or autoplaying ads. just the pages, or just the words.',
      points: ['<kbd>N</kbd><kbd>P</kbd> chapters', '<kbd>S</kbd> settings', '<kbd>C</kbd> chapter list'],
    }),
    visual(
      shot('reader-settings', {
        url: 'standardebooks.org/ebooks/jane-austen/pride-and-prejudice/text/chapter-1',
        style: wide
          ? { width: fit('reader-settings', 100, 84), right: '0', top: '2cqh' }
          : { width: fit('reader-settings', 86, 100), right: '0', top: '0' },
        callouts: [
          { rect: 'theme', label: 'dark, sepia or light', side: 'left', gap: 4 },
          { rect: 'type', label: 'your font, size and spacing', side: 'left', gap: 4 },
        ],
      }),
      shot('reader-comic', {
        url: 'peppercarrot.com',
        style: wide
          ? { width: fit('reader-comic', 46, 46), left: '0', bottom: '0' }
          : { width: fit('reader-comic', 40, 50), left: '0', bottom: '0' },
        callouts: [{ rect: 'all', box: false, label: 'comics as one long strip', side: 'top', gap: -1.5, pad: 0 }],
      }),
    ),
  ],

  library: () => [
    copy({
      eyebrow: '✦ the library',
      title: 'one library for <span class="grad">everything</span>',
      sub: 'every series you follow, from every site and server, on one shelf. pick up exactly where you left off.',
      points: ['one-click add', 'backup & restore'],
    }),
    visual(
      shot('library', {
        url: 'onidoku · library',
        style: wide
          ? { width: fit('library', 100, 92), right: '0', top: '50%', transform: 'translateY(-50%)' }
          : { width: fit('library', 100, 100), left: '50%', top: '0', transform: 'translateX(-50%)' },
        callouts: [
          { rect: 'shelf', label: 'continue where you left off', side: 'top', gap: 2.4, pad: 4 },
          { rect: 'chips', label: 'new, reading, caught up', side: 'right', gap: 2.5, pad: 4 },
          { rect: 'tile', label: 'unread count and progress', side: 'right', gap: 3, pad: 4 },
        ],
      }),
    ),
  ],

  alerts: () => [
    copy({
      eyebrow: '✦ alerts',
      title: 'never miss <span class="grad">a chapter</span>',
      sub: 'onidoku checks your whole library in the background, and tells you the moment something new drops.',
      points: ['notifications', 'badge count', 'check any time'],
    }),
    visual(
      shot('popup-light', {
        popup: true,
        style: { width: fit('popup-light', 42, 84, true), right: '2cqw', top: '13cqh' },
        callouts: [
          { rect: 'refresh', label: 'check for new chapters now', side: 'top', gap: 2.2, pad: 4 },
          { rect: 'first', label: 'the next chapter, one click away', side: 'left', gap: 2.4, pad: 2 },
        ],
      }),
      toast('Pepper&Carrot', 'new: Episode 39: The Tavern', 'now', { left: '0', bottom: wide ? '22cqh' : '34cqh', transform: 'rotate(-1.5deg)' }),
      toast('Dracula', '2 new chapters', '2 min ago', { left: wide ? '6cqw' : '8cqw', bottom: wide ? '3cqh' : '12cqh', transform: 'rotate(1deg)' }),
    ),
  ],

  sources: () => [
    copy({
      eyebrow: '✦ sources',
      title: 'any site, <span class="grad">your choice</span>',
      sub: 'onidoku ships with no sources. add openly licensed sites in one click, write your own in minutes, or connect your own Komga or Kavita server.',
    }),
    visual(
      shot('explore', {
        url: 'onidoku · explore',
        style: wide
          ? { width: fit('explore', 88, 62), right: '0', top: '0' }
          : { width: fit('explore', 80, 72), left: '50%', top: '0', transform: 'translateX(-50%)' },
        callouts: [
          { rect: 'tabs', label: 'popular and newest, per source', side: 'right', gap: 2.5, pad: 4 },
          { rect: 'done', label: 'already in your library', side: 'right', gap: 2.5, pad: 3 },
        ],
      }),
      el('div.code', { style: { left: '0', bottom: '0', width: wide ? '50cqw' : '44cqw' } },
        el('div.code-bar', {}, 'my-source.json'),
        el('pre', { html: '{\n  <span class="k">"series"</span>: {\n    <span class="k">"title"</span>: <span class="s">".teaser h2"</span>,\n    <span class="k">"chapters"</span>: { <span class="k">"item"</span>: <span class="s">"figcaption a"</span> }\n  },\n  <span class="k">"chapter"</span>: { <span class="k">"pages"</span>: <span class="s">".webcomic-page img"</span> }\n}' }),
      ),
      floatTag('write your own: no code', { left: wide ? '6cqw' : '4cqw', bottom: wide ? '37cqh' : '35cqh' }),
      shot('server-dialog', {
        popup: true,
        style: { width: fit('server-dialog', wide ? 42 : 40, 52, true), right: '0', bottom: '0', transform: 'rotate(1.5deg)' },
      }),
      floatTag('your own Komga or Kavita', { right: wide ? '6cqw' : '5cqw', bottom: wide ? '50cqh' : '50cqh' }),
    ),
  ],

  privacy: () => [
    copy({
      eyebrow: '✦ yours, and only yours',
      title: 'no ads. no account. <span class="grad">no tracking.</span>',
      sub: 'everything onidoku keeps stays in your browser. nothing is ever sent to us.',
    }),
    visual(
      el('div.cards', { style: { inset: '0', alignContent: 'center' } },
        card('shield', 'stays in your browser', 'library, progress and settings live in the extension’s own storage.'),
        card('noUser', 'no account, ever', 'install it and start reading. nothing to sign up for.'),
        card('window', 'nothing unlocked', 'it shows what the site already shows you, the way it should have looked.'),
        card('download', 'backup in one click', 'export your library to a file and import it anywhere.'),
        card('lock', 'sources are data', 'a source is a list of CSS selectors, not code.'),
        card('code', 'source available', 'read every line on GitHub.'),
      ),
    ),
  ],

  tile: () => [el('div.tile-small', {}, el('div', {}, logo(), el('h1', {}, 'onidoku'), el('p', { html: 'read like <span class="grad">a demon.</span>' })))],
};

const layout = el('div.layout', {}, ...SLIDES[slideId]());
if (slideId === 'tile') layout.className = 'tile-wrap';
root.append(layout);

// Wait for fonts and images, then place callouts (they need real sizes).
await document.fonts.ready;
await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r)))));
for (const s of document.querySelectorAll('.shot')) s.layout?.();
for (const t of document.querySelectorAll('.tag')) t.place?.();
// Number the labels in reading order: top to bottom, then left to right.
const tags = [...document.querySelectorAll('.tag')].map((t) => [t, t.getBoundingClientRect()]);
tags.sort(([, a], [, b]) => (Math.abs(a.top - b.top) < 30 ? a.left - b.left : a.top - b.top));
tags.forEach(([t], i) => (t.querySelector('.n').textContent = String(i + 1)));
document.body.dataset.ready = '1';

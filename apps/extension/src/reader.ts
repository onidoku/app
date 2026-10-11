// The reader UI: an overlay with the chapter's pages or text, chapter navigation and settings.
// It runs inside a site's page (content.ts) and on the extension's own reader page
// (reader-page.ts, for media servers); a ReaderHost supplies what differs between the two.
import type { ChapterContent, TextBlock } from '@onidoku/core';
import { button, h } from './dom';
import { errorMessage, send, type ChapterContext } from './messages';
import { READER_CSS } from './reader.css';

type Mode = 'webtoon' | 'ltr' | 'rtl';
type Fit = 'width' | 'height' | 'original';
type Theme = 'dark' | 'sepia' | 'light';
type Font = 'serif' | 'sans' | 'mono';
type Backdrop = 'black' | 'gray' | 'white';

export interface Prefs {
  // Comics
  mode: Mode;
  /** Paged modes: how a page fits the screen. */
  fit: Fit;
  /** Vertical mode: max page width in px; 0 fills the window. */
  stripWidth: number;
  /** Vertical mode: space between pages. */
  gap: boolean;
  backdrop: Backdrop;
  // Novels
  fontSize: number;
  lineHeight: number;
  font: Font;
  /** Text column width in characters. */
  textWidth: number;
  justify: boolean;
  theme: Theme;
  // Both
  /** Hide the toolbar while scrolling down. */
  autoHide: boolean;
}

const DEFAULT_PREFS: Prefs = {
  mode: 'webtoon',
  fit: 'height',
  stripWidth: 800,
  gap: false,
  backdrop: 'black',
  fontSize: 19,
  lineHeight: 1.75,
  font: 'serif',
  textWidth: 68,
  justify: false,
  theme: 'dark',
  autoHide: true,
};
const PREFS_KEY = 'readerPrefs';

const FONTS: Record<Font, string> = {
  serif: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
  sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, monospace",
};

const SHORTCUTS: [string, string][] = [
  ['N / P', 'next / previous chapter'],
  ['← →', 'turn page (paged modes)'],
  ['Space', 'scroll down or next page (Shift: back)'],
  ['C', 'chapter list'],
  ['S', 'settings'],
  ['F', 'fullscreen'],
  ['H', 'show / hide toolbar'],
  ['?', 'this help'],
  ['Esc', 'close panel, then the reader'],
];

/** What the reader needs from the page it runs on. */
export interface ReaderHost {
  /** Loads a chapter to show in place; undefined when only opening its page will do. */
  load(url: string, current: ChapterContent): Promise<ChapterContent | undefined>;
  /** Goes to a chapter the reader couldn't load itself. */
  leave(url: string): void;
  /** After moving to another chapter inside the reader, e.g. to update the address bar. */
  navigated(url: string, chapter: ChapterContent): void;
  /** After the reader closes. */
  closed?(): void;
  /** The image source for a page, for pages that can't be loaded by URL (e.g. needing a server login). */
  pageSrc?(url: string): Promise<string>;
}

/** Fills in next/prev from the library for sites whose pages don't link chapters together. */
export async function withNeighbors(chapter: ChapterContent): Promise<ChapterContent> {
  if (chapter.next && chapter.prev) return chapter;
  type Neighbors = { prev?: string; next?: string };
  const found = await send<Neighbors>({ type: 'neighbors', url: chapter.url }).catch((): Neighbors => ({}));
  return { ...chapter, next: chapter.next ?? found.next, prev: chapter.prev ?? found.prev };
}

declare global {
  interface Window {
    __onidoku?: Reader;
  }
}

type Panel = 'settings' | 'chapters' | 'help' | null;

export class Reader {
  private readonly frame = h('div');
  private readonly root = this.frame.attachShadow({ mode: 'open' });
  private readonly overlay = h('div', { class: 'overlay' });
  private readonly bar = h('header', { class: 'bar' });
  private readonly progressFill = h('div', { class: 'fill' });
  private view = h('div', { class: 'view', tabindex: '-1' });
  private pager: HTMLElement | null = null;
  private panelEl: HTMLElement | null = null;
  private chapter!: ChapterContent;
  private context: ChapterContext | null = null;
  /** Paged modes; pages.length is the end-of-chapter page. */
  private page = 0;
  private panel: Panel = null;
  private loading = false;
  private uiHidden = false;
  private lastScroll = 0;
  private savedOverflow = '';
  private readonly onKey = (event: KeyboardEvent) => this.handleKey(event);
  private readonly onFullscreen = () => this.renderBar();

  constructor(
    private readonly host: ReaderHost,
    private prefs: Prefs,
  ) {
    this.root.append(
      h('style', { text: READER_CSS }),
      this.overlay,
    );
  }

  show(chapter: ChapterContent): void {
    this.chapter = chapter;
    this.page = 0;
    this.context = null;
    this.uiHidden = false;
    if (this.frame.isConnected) this.render();
    else this.mount();
    send({ type: 'markRead', url: chapter.url }).catch(() => undefined);
    void this.loadContext(chapter.url);
  }

  mount(): void {
    if (this.frame.isConnected) return;
    document.documentElement.append(this.frame);
    this.savedOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    window.addEventListener('keydown', this.onKey, true);
    document.addEventListener('fullscreenchange', this.onFullscreen);
    if (this.chapter) this.render();
  }

  close(): void {
    if (document.fullscreenElement === this.frame) void document.exitFullscreen();
    this.frame.remove();
    document.documentElement.style.overflow = this.savedOverflow;
    window.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    this.host.closed?.();
  }

  private async loadContext(url: string): Promise<void> {
    const context = await send<ChapterContext | null>({ type: 'chapterContext', url }).catch(() => null);
    if (this.chapter.url !== url) return; // moved on meanwhile
    this.context = context;
    this.renderBar();
    if (this.panel === 'chapters') this.renderPanel();
    if (this.isEndVisible()) this.renderView();
  }

  // ---- Rendering ------------------------------------------------------------------------

  private render(): void {
    this.applyAppearance();
    this.overlay.replaceChildren(this.bar, h('div', { class: 'progress' }, this.progressFill), this.view);
    this.renderBar();
    this.renderView();
    this.renderPanel();
  }

  /** Appearance settings are CSS variables, so changing them never loses the scroll position. */
  private applyAppearance(): void {
    const { prefs, overlay } = this;
    overlay.dataset.theme = prefs.theme;
    overlay.dataset.backdrop = prefs.backdrop;
    overlay.dataset.fit = prefs.fit;
    overlay.classList.toggle('gap', prefs.gap);
    overlay.classList.toggle('justify', prefs.justify);
    overlay.classList.toggle('ui-hidden', this.uiHidden);
    overlay.classList.toggle('is-text', this.chapter?.body.kind === 'text');
    overlay.style.setProperty('--font-size', `${prefs.fontSize}px`);
    overlay.style.setProperty('--line-height', String(prefs.lineHeight));
    overlay.style.setProperty('--font', FONTS[prefs.font]);
    overlay.style.setProperty('--text-width', `${prefs.textWidth}ch`);
    overlay.style.setProperty('--strip-width', prefs.stripWidth ? `${prefs.stripWidth}px` : '100%');
  }

  private renderBar(): void {
    const c = this.chapter;
    const fullscreen = document.fullscreenElement === this.frame;
    const position = this.context ? this.context.chapters.findIndex((ch) => ch.url === c.url) : -1;
    this.bar.replaceChildren(
      button('✕', 'icon', () => this.close(), 'close (Esc)'),
      h(
        'div',
        { class: 'heading' },
        h('span', { class: 'title', text: c.title ?? document.title }),
        this.context
          ? h('span', {
              class: 'subtitle',
              text: position >= 0 ? `${this.context.seriesTitle} · ${position + 1} of ${this.context.chapters.length}` : this.context.seriesTitle,
            })
          : undefined,
      ),
      this.chapterButton('‹ prev', c.prev, 'previous chapter (P)'),
      this.chapterButton('next ›', c.next, 'next chapter (N)'),
      ...(c.body.kind === 'text'
        ? [
            button('A−', 'quick', () => this.update({ fontSize: clamp(this.prefs.fontSize - 1, 12, 36) }), 'smaller text'),
            button('A+', 'quick', () => this.update({ fontSize: clamp(this.prefs.fontSize + 1, 12, 36) }), 'larger text'),
          ]
        : []),
      ...(this.context ? [button('ⓘ', 'icon', () => this.openDetails(), 'series details in library')] : []),
      this.toggle('☰', 'chapters', 'chapters (C)'),
      this.toggle('⚙', 'settings', 'settings (S)'),
      button(fullscreen ? '⤡' : '⤢', 'icon', () => this.toggleFullscreen(), fullscreen ? 'exit fullscreen (F)' : 'fullscreen (F)'),
      keysOnly(this.toggle('?', 'help', 'keyboard shortcuts (?)')),
    );
  }

  private openDetails(): void {
    if (this.context) void send({ type: 'openDetails', id: this.context.seriesId }).catch(() => undefined);
  }

  private toggle(label: string, panel: Exclude<Panel, null>, title: string): HTMLButtonElement {
    const el = button(label, 'icon', () => this.setPanel(this.panel === panel ? null : panel), title);
    el.setAttribute('aria-pressed', String(this.panel === panel));
    return el;
  }

  private renderView(): void {
    const c = this.chapter;
    const view = h('div', { class: 'view', tabindex: '-1' });
    this.pager?.remove();
    this.pager = null;
    if (c.body.kind === 'text') this.renderText(view, c.body.paragraphs, c.body.blocks);
    else if (this.prefs.mode === 'webtoon') this.renderWebtoon(view, c.body.pages);
    else this.renderPaged(view, c.body.pages);

    view.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.view.replaceWith(view);
    this.view = view;
    this.lastScroll = 0;
    this.updateProgress();
    view.focus({ preventScroll: true });
  }

  private renderWebtoon(view: HTMLElement, pages: string[]): void {
    view.classList.add('webtoon');
    pages.forEach((src, i) => view.append(this.pageImage(src, i, i < 3 ? 'eager' : 'lazy')));
    view.append(this.endOfChapter());
    view.addEventListener('click', (event) => {
      if (!(event.target as Element).closest('button')) this.setUiHidden(!this.uiHidden);
    });
  }

  private renderPaged(view: HTMLElement, pages: string[]): void {
    view.classList.add('paged');
    const atEnd = this.page >= pages.length;
    view.append(atEnd ? this.endOfChapter() : this.pageImage(pages[this.page]!, this.page, 'eager'));
    // Preload the next pages so turning feels instant.
    for (const src of pages.slice(this.page + 1, this.page + 3)) {
      if (this.host.pageSrc) void this.host.pageSrc(src).catch(() => undefined);
      else new Image().src = src;
    }

    // Swipes turn pages on touch screens, the way a finger turns paper: left goes forward
    // (mirrored for right-to-left). Mostly-vertical drags are left alone for scrolling.
    let start: { x: number; y: number } | undefined;
    view.addEventListener('touchstart', (event) => {
      const t = event.touches[0];
      start = event.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : undefined;
    }, { passive: true });
    view.addEventListener('touchend', (event) => {
      const t = event.changedTouches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      start = undefined;
      // Zoomed-in pages pan with a drag instead.
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 1.5 || (visualViewport?.scale ?? 1) > 1.05) return;
      const forward = (dx < 0) !== (this.prefs.mode === 'rtl');
      this.turn(forward ? 1 : -1);
    }, { passive: true });

    // Thirds: outer ones turn pages (mirrored for right-to-left), the middle toggles the toolbar.
    view.addEventListener('click', (event) => {
      if ((event.target as Element).closest('button')) return;
      const third = Math.floor((event.clientX / view.clientWidth) * 3);
      if (third === 1) return this.setUiHidden(!this.uiHidden);
      const forward = (third === 2) !== (this.prefs.mode === 'rtl');
      this.turn(forward ? 1 : -1);
    });

    const slider = h('input', {
      type: 'range',
      min: '0',
      max: String(pages.length - 1),
      value: String(Math.min(this.page, pages.length - 1)),
      'aria-label': 'page',
    });
    if (this.prefs.mode === 'rtl') slider.classList.add('rtl');
    slider.addEventListener('input', () => {
      this.page = Number(slider.value);
      this.renderView();
    });
    this.pager = h(
      'footer',
      { class: 'pager' },
      h('span', { class: 'counter', text: atEnd ? 'end' : `${this.page + 1} / ${pages.length}` }),
      slider,
    );
    this.overlay.append(this.pager);
  }

  private renderText(view: HTMLElement, paragraphs: string[], blocks?: TextBlock[]): void {
    view.classList.add('reading');
    const article = h('article', { class: 'text' });
    if (this.chapter.title) article.append(h('h1', { text: this.chapter.title }));
    if (blocks) this.appendBlocks(article, blocks);
    else for (const text of paragraphs) article.append(h('p', { text }));
    view.append(article, this.endOfChapter());
    view.addEventListener('click', (event) => {
      // Selecting text shouldn't toggle the toolbar.
      if (!(event.target as Element).closest('button') && !getSelection()?.toString()) this.setUiHidden(!this.uiHidden);
    });
  }

  /** Structured text (books from media servers): always as text nodes, never the book's HTML. */
  private appendBlocks(article: HTMLElement, blocks: TextBlock[]): void {
    let list: HTMLElement | null = null;
    blocks.forEach((block, i) => {
      if (block.type !== 'item') list = null;
      switch (block.type) {
        case 'heading':
          // Books usually open a chapter with its title, which the reader already shows.
          if (i === 0 && block.text.toLowerCase().includes((this.chapter.title ?? '\0').toLowerCase())) return;
          article.append(h((['h2', 'h3', 'h4'] as const)[Math.min(Math.max(block.level, 2), 4) - 2]!, { text: block.text }));
          return;
        case 'paragraph':
          article.append(h('p', { text: block.text }));
          return;
        case 'quote':
          article.append(h('blockquote', {}, h('p', { text: block.text })));
          return;
        case 'pre':
          article.append(h('pre', {}, h('code', { text: block.text })));
          return;
        case 'item': {
          const tag = block.ordered ? 'ol' : 'ul';
          if (!list || list.dataset.depth !== String(block.depth) || list.localName !== tag) {
            list = h(tag, { 'data-depth': String(block.depth) });
            list.style.marginLeft = `${block.depth * 1.5}em`;
            article.append(list);
          }
          list.append(h('li', { text: block.text }));
          return;
        }
        case 'image': {
          const img = h('img', { alt: block.alt ?? '', loading: 'lazy', decoding: 'async' });
          if (this.host.pageSrc) this.host.pageSrc(block.src).then((src) => (img.src = src), () => img.remove());
          else img.src = block.src;
          article.append(h('figure', {}, img));
          return;
        }
        case 'rule':
          article.append(h('hr'));
      }
    });
  }

  /** A page image that offers a retry instead of a broken-image icon when it fails. */
  private pageImage(src: string, index: number, loading: 'eager' | 'lazy'): HTMLElement {
    const img = h('img', { alt: `page ${index + 1}`, loading, decoding: 'async' });
    if (this.host.pageSrc) {
      this.host.pageSrc(src).then(
        (resolved) => (img.src = resolved),
        () => img.dispatchEvent(new Event('error')),
      );
    } else {
      img.src = src;
    }
    img.addEventListener('error', () => {
      const retry = button('retry', '', () => {
        const fresh = this.pageImage(src, index, 'eager');
        box.replaceWith(fresh);
      });
      const box = h('div', { class: 'broken' }, h('span', { text: `page ${index + 1} didn’t load.` }), retry);
      img.replaceWith(box);
    });
    return img;
  }

  private endOfChapter(): HTMLElement {
    const { next, prev, title } = this.chapter;
    return h(
      'div',
      { class: 'end' },
      h('p', { class: 'end-label', text: 'finished' }),
      h('p', { class: 'end-title', text: title ?? document.title }),
      next
        ? button('next chapter ›', 'primary', () => this.go(next), 'next chapter (N)')
        : h('p', { class: 'muted', text: 'you’re caught up. new chapters will show up in your library.' }),
      h(
        'div',
        { class: 'end-links' },
        this.chapterButton('‹ previous chapter', prev),
        this.context ? button('series details', '', () => this.openDetails()) : undefined,
      ),
    );
  }

  private chapterButton(label: string, url: string | undefined, title?: string): HTMLButtonElement {
    const el = button(label, '', () => this.go(url), title);
    el.disabled = !url;
    return el;
  }

  // ---- Panels ---------------------------------------------------------------------------

  private setPanel(panel: Panel): void {
    this.panel = panel;
    this.renderPanel();
    this.renderBar();
    if (!panel) this.view.focus({ preventScroll: true });
  }

  private renderPanel(): void {
    this.panelEl?.remove();
    this.panelEl = null;
    if (!this.panel) return;
    const body =
      this.panel === 'settings' ? this.settingsPanel() : this.panel === 'chapters' ? this.chaptersPanel() : this.helpPanel();
    const scrim = h('div', { class: 'scrim' });
    scrim.addEventListener('click', () => this.setPanel(null));
    this.panelEl = h('div', { class: `panel-layer ${this.panel}` }, scrim, body);
    this.overlay.append(this.panelEl);
  }

  private settingsPanel(): HTMLElement {
    const images = this.chapter.body.kind === 'images';
    const p = this.prefs;
    const sections: HTMLElement[] = [];
    if (images) {
      sections.push(
        section(
          'reading mode',
          segmented<Mode>(p.mode, [['webtoon', 'vertical'], ['ltr', 'left → right'], ['rtl', 'right → left']], (mode) => {
            this.page = 0;
            this.update({ mode }, true);
          }),
        ),
      );
      if (p.mode === 'webtoon') {
        sections.push(
          section(
            'page width',
            range(p.stripWidth || 1600, 400, 1600, 50, (v) => (v >= 1600 ? 'full' : `${v}px`), (v) =>
              this.update({ stripWidth: v >= 1600 ? 0 : v }),
            ),
          ),
          checkbox('gaps between pages', p.gap, (gap) => this.update({ gap })),
        );
      } else {
        sections.push(
          section(
            'fit',
            segmented<Fit>(p.fit, [['height', 'screen'], ['width', 'width'], ['original', 'original']], (fit) => this.update({ fit })),
          ),
        );
      }
      sections.push(
        section(
          'background',
          segmented<Backdrop>(p.backdrop, [['black', 'black'], ['gray', 'gray'], ['white', 'white']], (backdrop) => this.update({ backdrop })),
        ),
      );
    } else {
      sections.push(
        section('theme', segmented<Theme>(p.theme, [['dark', 'dark'], ['sepia', 'sepia'], ['light', 'light']], (theme) => this.update({ theme }))),
        section('font', segmented<Font>(p.font, [['serif', 'serif'], ['sans', 'sans'], ['mono', 'mono']], (font) => this.update({ font }))),
        section('text size', range(p.fontSize, 12, 36, 1, (v) => `${v}px`, (fontSize) => this.update({ fontSize }))),
        section('line spacing', range(p.lineHeight * 100, 120, 240, 5, (v) => (v / 100).toFixed(2), (v) => this.update({ lineHeight: v / 100 }))),
        section('line length', range(p.textWidth, 40, 110, 2, (v) => `${v} chars`, (textWidth) => this.update({ textWidth }))),
        checkbox('justify text', p.justify, (justify) => this.update({ justify })),
      );
    }
    sections.push(
      checkbox('hide toolbar while scrolling', p.autoHide, (autoHide) => this.update({ autoHide })),
      button('reset to defaults', 'link', () => {
        this.page = 0;
        const keep = this.chapter.body.kind === 'images' ? TEXT_KEYS : IMAGE_KEYS;
        this.update({ ...DEFAULT_PREFS, ...pick(this.prefs, keep) }, true);
      }),
    );
    return h('aside', { class: 'panel', 'aria-label': 'reader settings' }, panelHead('settings', () => this.setPanel(null)), ...sections);
  }

  private chaptersPanel(): HTMLElement {
    const head = panelHead('chapters', () => this.setPanel(null));
    if (!this.context) {
      return h(
        'aside',
        { class: 'panel left' },
        head,
        h('p', { class: 'muted', text: 'add this series to your library to see its chapter list here.' }),
      );
    }
    const { chapters, readIndex } = this.context;
    const filter = h('input', { type: 'search', placeholder: 'filter chapters', 'aria-label': 'filter chapters' });
    const list = h('ol', { class: 'chapter-list' });
    const fill = () => {
      const needle = filter.value.trim().toLowerCase();
      const rows = chapters
        .map((chapter, index) => ({ chapter, index }))
        .filter(({ chapter }) => !needle || chapter.title.toLowerCase().includes(needle))
        .reverse(); // newest first, like the site lists
      list.replaceChildren(
        ...rows.map(({ chapter, index }) => {
          const current = chapter.url === this.chapter.url;
          const el = button(chapter.title, `${current ? 'current' : ''} ${index <= readIndex ? 'read' : ''}`, () => {
            this.setPanel(null);
            void this.go(chapter.url);
          });
          return h('li', {}, el);
        }),
      );
    };
    filter.addEventListener('input', fill);
    filter.addEventListener('keydown', (event) => event.stopPropagation());
    fill();
    requestAnimationFrame(() => list.querySelector('.current')?.scrollIntoView({ block: 'center' }));
    return h(
      'aside',
      { class: 'panel left', 'aria-label': 'chapters' },
      head,
      h('p', { class: 'muted', text: `${this.context.seriesTitle} · ${chapters.length} chapters` }),
      button('series details ›', 'link', () => this.openDetails()),
      filter,
      list,
    );
  }

  private helpPanel(): HTMLElement {
    return h(
      'aside',
      { class: 'panel', 'aria-label': 'keyboard shortcuts' },
      panelHead('keyboard shortcuts', () => this.setPanel(null)),
      h('dl', { class: 'keys' }, ...SHORTCUTS.flatMap(([key, what]) => [h('dt', {}, h('kbd', { text: key })), h('dd', { text: what })])),
      h('p', { class: 'muted', text: 'tap or click the middle of the page to show or hide the toolbar. in paged modes, tap the sides or swipe to turn pages.' }),
    );
  }

  // ---- Behaviour ------------------------------------------------------------------------

  private update(changes: Partial<Prefs>, rerender = false): void {
    this.prefs = { ...this.prefs, ...changes };
    void savePrefs(this.prefs);
    this.applyAppearance();
    if (rerender) this.renderView();
    this.renderBar();
    this.renderPanel();
  }

  private setUiHidden(hidden: boolean): void {
    if (this.uiHidden === hidden) return;
    this.uiHidden = hidden;
    this.overlay.classList.toggle('ui-hidden', hidden);
  }

  private onScroll(): void {
    const top = this.view.scrollTop;
    if (this.prefs.autoHide && !this.panel) {
      if (top > this.lastScroll + 8 && top > 80) this.setUiHidden(true);
      else if (top < this.lastScroll - 8) this.setUiHidden(false);
    }
    this.lastScroll = top;
    this.updateProgress();
  }

  private updateProgress(): void {
    let ratio: number;
    if (this.chapter.body.kind === 'images' && this.prefs.mode !== 'webtoon') {
      ratio = Math.min(1, (this.page + 1) / this.chapter.body.pages.length);
    } else {
      const max = this.view.scrollHeight - this.view.clientHeight;
      ratio = max > 0 ? this.view.scrollTop / max : 0;
    }
    this.progressFill.style.width = `${Math.round(ratio * 1000) / 10}%`;
  }

  private isEndVisible(): boolean {
    return this.chapter.body.kind === 'images' && this.prefs.mode !== 'webtoon' && this.page >= this.chapter.body.pages.length;
  }

  private turn(delta: number): void {
    if (this.chapter.body.kind !== 'images') return;
    const next = this.page + delta;
    // One step past the last page shows the end-of-chapter page; one more moves on.
    if (next > this.chapter.body.pages.length) return void this.go(this.chapter.next);
    if (next < 0) return void this.go(this.chapter.prev);
    this.page = next;
    this.renderView();
  }

  private scrollBy(direction: 1 | -1): void {
    this.view.scrollBy({ top: direction * this.view.clientHeight * 0.85, behavior: 'smooth' });
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.frame.requestFullscreen().catch((err) => toast(`fullscreen isn’t available: ${errorMessage(err)}`));
  }

  private async go(url: string | undefined): Promise<void> {
    if (!url || this.loading) return;
    this.loading = true;
    this.overlay.classList.add('busy');
    try {
      const loaded = await this.host.load(url, this.chapter);
      if (!loaded) return void this.host.leave(url);
      const chapter = await withNeighbors(loaded);
      this.host.navigated(url, chapter);
      this.show(chapter);
    } catch (err) {
      toast(`couldn't load the chapter: ${errorMessage(err)}`);
    } finally {
      this.loading = false;
      this.overlay.classList.remove('busy');
    }
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // Typing in the chapter filter or a settings field shouldn't trigger shortcuts.
    if (event.composedPath().some((el) => el instanceof HTMLInputElement && el.type !== 'range' && el.type !== 'checkbox')) {
      if (event.key === 'Escape') this.setPanel(null);
      return;
    }
    const paged = this.chapter.body.kind === 'images' && this.prefs.mode !== 'webtoon';
    const rtl = this.prefs.mode === 'rtl';
    const actions: Record<string, () => void> = {
      Escape: () => (this.panel ? this.setPanel(null) : this.close()),
      n: () => void this.go(this.chapter.next),
      p: () => void this.go(this.chapter.prev),
      c: () => this.setPanel(this.panel === 'chapters' ? null : 'chapters'),
      s: () => this.setPanel(this.panel === 'settings' ? null : 'settings'),
      '?': () => this.setPanel(this.panel === 'help' ? null : 'help'),
      f: () => this.toggleFullscreen(),
      h: () => this.setUiHidden(!this.uiHidden),
      ' ': () => (paged ? this.turn(event.shiftKey ? -1 : 1) : this.scrollBy(event.shiftKey ? -1 : 1)),
    };
    if (paged) {
      actions.ArrowRight = () => this.turn(rtl ? -1 : 1);
      actions.ArrowLeft = () => this.turn(rtl ? 1 : -1);
      actions.PageDown = () => this.turn(1);
      actions.PageUp = () => this.turn(-1);
      actions.Home = () => {
        this.page = 0;
        this.renderView();
      };
    }
    const action = actions[event.key.length === 1 && event.key !== ' ' ? event.key.toLowerCase() : event.key];
    if (!action) return;
    // Stop the site's own shortcuts from firing underneath the reader.
    event.preventDefault();
    event.stopPropagation();
    action();
  }
}

// Reset keeps the other content type's settings: resetting comic settings shouldn't touch novels.
const IMAGE_KEYS: (keyof Prefs)[] = ['mode', 'fit', 'stripWidth', 'gap', 'backdrop'];
const TEXT_KEYS: (keyof Prefs)[] = ['fontSize', 'lineHeight', 'font', 'textWidth', 'justify', 'theme'];

/** Horizontal travel that counts as a page-turning swipe. */
const SWIPE_PX = 50;

/** Marks controls that only make sense with a keyboard; touch screens hide them. */
function keysOnly<T extends HTMLElement>(el: T): T {
  el.classList.add('keys-only');
  return el;
}

function pick(prefs: Prefs, keys: (keyof Prefs)[]): Partial<Prefs> {
  return Object.fromEntries(keys.map((k) => [k, prefs[k]]));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// ---- Small form controls for the settings panel ------------------------------------------

function panelHead(title: string, onClose: () => void): HTMLElement {
  return h('div', { class: 'panel-head' }, h('h2', { text: title }), button('✕', 'icon', onClose, 'close (Esc)'));
}

function section(label: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'field' }, h('span', { class: 'label', text: label }), control);
}

function segmented<T extends string>(value: T, options: [T, string][], onChange: (value: T) => void): HTMLElement {
  return h(
    'div',
    { class: 'segmented', role: 'group' },
    ...options.map(([option, label]) => {
      const el = button(label, option === value ? 'on' : '', () => onChange(option));
      el.setAttribute('aria-pressed', String(option === value));
      return el;
    }),
  );
}

function range(value: number, min: number, max: number, step: number, format: (v: number) => string, onChange: (v: number) => void): HTMLElement {
  const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
  const out = h('output', { text: format(value) });
  input.addEventListener('input', () => {
    out.textContent = format(Number(input.value));
  });
  // Apply on release so dragging doesn't rebuild the panel under the pointer.
  input.addEventListener('change', () => onChange(Number(input.value)));
  return h('div', { class: 'range' }, input, out);
}

function checkbox(label: string, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'check' }, input, label);
}

// ---- Boot -------------------------------------------------------------------------------

export async function loadPrefs(): Promise<Prefs> {
  const stored = (await chrome.storage.local.get(PREFS_KEY))[PREFS_KEY] as Partial<Prefs> | undefined;
  return { ...DEFAULT_PREFS, ...stored };
}

async function savePrefs(prefs: Prefs): Promise<void> {
  await chrome.storage.local.set({ [PREFS_KEY]: prefs });
}

export function toast(message: string): void {
  const host = h('div');
  const root = host.attachShadow({ mode: 'open' });
  root.append(h('style', { text: READER_CSS }), h('div', { class: 'toast', role: 'status', text: message }));
  document.documentElement.append(host);
  setTimeout(() => host.remove(), 5000);
}


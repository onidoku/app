export const READER_CSS = `
:host { all: initial; }
.overlay {
  --chrome: #1c1c1f; --chrome-border: #2e2e33; --ui-text: #e4e4e7; --muted: #a1a1aa;
  --control: #2a2a2e; --control-border: #3a3a40; --accent: #a594ff; --accent-text: #111113;
  --page-bg: #111113; --text: #d4d4d8;
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; flex-direction: column;
  background: var(--page-bg); color: var(--ui-text);
  font: 14px/1.4 system-ui, sans-serif;
}
.overlay[data-backdrop='gray'] { --page-bg: #3f3f46; }
.overlay[data-backdrop='white'] { --page-bg: #f4f4f5; }
/* Text themes recolour the page and the chrome, so a light page doesn't sit under a dark bar. */
.overlay.is-text[data-theme='dark'] { --page-bg: #141416; --text: #d4d4d8; }
.overlay.is-text[data-theme='sepia'] {
  --page-bg: #f4ecd8; --text: #433422; --chrome: #ebe0c6; --chrome-border: #d9cba8; --ui-text: #433422;
  --muted: #7a6a52; --control: #f4ecd8; --control-border: #cdbd98; --accent: #8a5a24; --accent-text: #fff;
}
.overlay.is-text[data-theme='light'] {
  --page-bg: #ffffff; --text: #27272a; --chrome: #f4f4f5; --chrome-border: #e4e4e7; --ui-text: #18181b;
  --muted: #71717a; --control: #ffffff; --control-border: #d4d4d8; --accent: #6d4aff; --accent-text: #fff;
}

/* Toolbar */
.bar {
  position: absolute; top: 0; left: 0; right: 0; z-index: 3;
  display: flex; align-items: center; gap: 6px;
  padding: 8px 12px; background: var(--chrome); border-bottom: 1px solid var(--chrome-border);
  transition: transform .2s ease, opacity .2s ease;
}
.ui-hidden .bar { transform: translateY(-100%); opacity: 0; pointer-events: none; }
.heading { flex: 1; min-width: 0; display: grid; }
.title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.subtitle { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--muted); }
button, select {
  font: inherit; color: inherit; background: var(--control); border: 1px solid var(--control-border);
  border-radius: 6px; padding: 4px 10px; cursor: pointer; white-space: nowrap;
}
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: .35; cursor: default; }
button.icon { min-width: 32px; padding: 4px 8px; }
button[aria-pressed='true'] { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 600; padding: 10px 20px; font-size: 15px; }
button.link { background: none; border: 0; padding: 0; color: var(--accent); justify-self: start; }

/* Thin reading progress line under the toolbar (stays visible when the toolbar hides). */
.progress { position: absolute; top: 0; left: 0; right: 0; height: 3px; z-index: 4; pointer-events: none; }
.progress .fill { height: 100%; width: 0; background: var(--accent); transition: width .15s linear; }

/* Content */
.view { flex: 1; overflow: auto; outline: none; padding-top: 50px; scroll-padding-top: 50px; }
.ui-hidden .view { padding-top: 0; }
.busy .view { opacity: .4; pointer-events: none; }
.busy .progress .fill { width: 30% !important; animation: od-loading 1s ease-in-out infinite alternate; }
@keyframes od-loading { from { margin-left: 0; } to { margin-left: 70%; } }

.webtoon img, .webtoon .broken { display: block; width: 100%; max-width: var(--strip-width, 800px); margin: 0 auto; min-height: 200px; }
.gap .webtoon img, .gap .webtoon .broken { margin-bottom: 12px; }

.paged { position: relative; display: flex; user-select: none; padding-bottom: 52px; box-sizing: border-box; }
/* margin:auto centres the page but, unlike justify-content, never clips a page larger than the screen. */
.paged img, .paged .end { display: block; margin: auto; }
.overlay[data-fit='height'] .paged img { max-width: 100%; max-height: 100%; object-fit: contain; }
.overlay[data-fit='width'] .paged img { width: 100%; max-width: 1400px; height: auto; margin-top: 0; }
.overlay[data-fit='original'] .paged img { max-width: none; margin-top: 0; }
.pager {
  position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 2;
  display: flex; align-items: center; gap: 10px; width: min(560px, calc(100% - 24px));
  background: rgba(0,0,0,.7); color: #fff; padding: 6px 12px; border-radius: 999px;
  transition: opacity .2s ease;
}
.ui-hidden .pager { opacity: 0; pointer-events: none; }
.pager input { flex: 1; accent-color: var(--accent); }
.pager input.rtl { direction: rtl; }
.counter { font-size: 12px; font-variant-numeric: tabular-nums; min-width: 56px; text-align: center; }

.broken {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  min-height: 240px; color: var(--muted); background: rgba(127,127,127,.12); border-radius: 8px;
}

.reading { background: var(--page-bg); }
.text {
  max-width: var(--text-width, 68ch); margin: 0 auto; padding: 40px 24px 32px;
  font-family: var(--font); font-size: var(--font-size, 19px); line-height: var(--line-height, 1.75); color: var(--text);
}
.justify .text p { text-align: justify; hyphens: auto; }
.text p { margin: 0 0 1em; }
.text h1 { font: 600 1.4em/1.3 system-ui, sans-serif; margin: 0 0 1.4em; }
.text h2, .text h3, .text h4 { font-family: system-ui, sans-serif; font-weight: 600; line-height: 1.3; margin: 1.6em 0 .6em; }
.text h2 { font-size: 1.25em; }
.text h3 { font-size: 1.1em; }
.text h4 { font-size: 1em; }
.text blockquote { margin: 0 0 1em; padding-left: 1em; border-left: 3px solid var(--muted); opacity: .9; }
.text pre {
  margin: 0 0 1em; padding: .8em 1em; overflow-x: auto; border-radius: 6px; background: color-mix(in srgb, var(--text) 8%, transparent);
  /* Its own size and spacing: the novel text's line height would double-space code. */
  font: .82em/1.5 ui-monospace, 'SF Mono', Menlo, monospace;
}
.text pre code { font: inherit; white-space: pre; }
.text ul, .text ol { margin: 0 0 1em; padding-left: 1.4em; }
.text li { margin: .25em 0; }
.text figure { margin: 1.2em 0; text-align: center; }
.text figure img { max-width: 100%; height: auto; border-radius: 4px; }
.text hr { border: 0; border-top: 1px solid var(--muted); opacity: .4; margin: 2em auto; width: 40%; }

.end {
  display: grid; justify-items: center; gap: 12px; text-align: center;
  padding: 48px 16px 96px; color: var(--ui-text);
}
.paged .end { padding: 24px; }
.end p { margin: 0; }
.end-label { text-transform: lowercase; letter-spacing: .08em; font-size: 12px; color: var(--muted); }
.end-title { font-size: 18px; font-weight: 600; max-width: 32rem; }
.end-links { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 8px; }
.muted { color: var(--muted); margin: 0; }
.overlay[data-backdrop='white']:not(.is-text) .end { color: #18181b; }

/* Panels: settings and help slide in from the right, chapters from the left. */
.panel-layer { position: absolute; inset: 0; z-index: 5; }
.scrim { position: absolute; inset: 0; background: rgba(0,0,0,.35); }
.panel {
  position: absolute; top: 0; bottom: 0; right: 0; width: min(340px, 92vw); box-sizing: border-box;
  display: flex; flex-direction: column; gap: 16px; padding: 16px; overflow: auto;
  background: var(--chrome); color: var(--ui-text); border-left: 1px solid var(--chrome-border);
  box-shadow: -8px 0 30px rgba(0,0,0,.3); animation: od-right .18s ease-out;
}
.panel.left { right: auto; left: 0; border-left: 0; border-right: 1px solid var(--chrome-border); animation-name: od-left; }
@keyframes od-right { from { transform: translateX(24px); opacity: 0; } }
@keyframes od-left { from { transform: translateX(-24px); opacity: 0; } }
.panel-head { display: flex; align-items: center; justify-content: space-between; }
.panel-head h2 { margin: 0; font-size: 16px; }
.field { display: grid; gap: 6px; }
.label { font-size: 12px; text-transform: lowercase; letter-spacing: .05em; color: var(--muted); }
.segmented { display: flex; border: 1px solid var(--control-border); border-radius: 8px; overflow: hidden; }
.segmented button { flex: 1; border: 0; border-radius: 0; padding: 6px 8px; background: var(--control); }
.segmented button + button { border-left: 1px solid var(--control-border); }
.segmented button[aria-pressed='true'] { background: var(--accent); color: var(--accent-text); font-weight: 600; }
.range { display: flex; align-items: center; gap: 10px; }
.range input { flex: 1; accent-color: var(--accent); }
.range output { min-width: 64px; text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px; }
.check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.check input { accent-color: var(--accent); }
.panel input[type='search'] {
  font: inherit; color: inherit; background: var(--control); border: 1px solid var(--control-border);
  border-radius: 6px; padding: 6px 10px;
}
.chapter-list { list-style: none; margin: 0; padding: 0; display: grid; align-content: start; gap: 2px; overflow: auto; flex: 1; }
.chapter-list button {
  width: 100%; text-align: left; border: 0; background: none; padding: 8px 10px; border-radius: 6px;
  overflow: hidden; text-overflow: ellipsis;
}
.chapter-list button:hover { background: var(--control); }
.chapter-list button.read { color: var(--muted); }
.chapter-list button.current { background: var(--accent); color: var(--accent-text); font-weight: 600; }
.keys { display: grid; grid-template-columns: auto 1fr; gap: 8px 14px; margin: 0; align-items: center; }
.keys dd { margin: 0; }
kbd {
  font: 12px ui-monospace, monospace; background: var(--control); border: 1px solid var(--control-border);
  border-bottom-width: 2px; border-radius: 4px; padding: 1px 6px; white-space: nowrap;
}

.toast {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483647;
  background: #1c1c1f; color: #e4e4e7; border: 1px solid #3a3a40; border-radius: 8px;
  padding: 8px 14px; font: 13px/1.4 system-ui, sans-serif; max-width: min(90vw, 480px);
}
@media (pointer: coarse) {
  .bar button { min-height: 38px; min-width: 38px; }
  .keys-only { display: none; }
  .panel button, .panel select { min-height: 38px; }
  .chapter-list button { padding: 11px 10px; }
}
@media (max-width: 640px) {
  .bar { flex-wrap: wrap; row-gap: 6px; padding: 6px 8px; gap: 4px; }
  .bar > button { flex: 1 1 auto; }
  .bar > button:first-child { flex: none; }
  .text { padding: 28px 18px 24px; }
  .heading { flex-basis: calc(100% - 48px); order: -1; }
  .bar > button:first-child { order: -2; }
  .view { padding-top: 100px; scroll-padding-top: 100px; }
  button.quick { display: none; }
}
`;

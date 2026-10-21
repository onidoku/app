/** Styles for the small cards onidoku shows on sites (prompt.ts, detect.ts), inside a shadow root. */
export const CARD_CSS = `
:host { all: initial; }
.od-prompt {
  --bg: #ffffff; --text: #18181b; --muted: #71717a; --border: #e4e4e7;
  --accent: #6d4aff; --accent-text: #ffffff; --secondary: #f4f4f5;
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
  width: 288px; box-sizing: border-box; padding: 12px 14px;
  display: grid; gap: 8px;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, .18);
  font: 13px/1.4 system-ui, sans-serif;
  animation: od-in .18s ease-out;
}
@media (prefers-color-scheme: dark) {
  .od-prompt {
    --bg: #1c1c1f; --text: #f4f4f5; --muted: #a1a1aa; --border: #3f3f46;
    --accent: #a594ff; --accent-text: #18181b; --secondary: #27272a;
  }
}
@media (max-width: 480px) { .od-prompt { left: 12px; right: 12px; bottom: 12px; width: auto; } }
@keyframes od-in { from { opacity: 0; transform: translateY(8px); } }
.head { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; }
.head .site { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
.title { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status { color: var(--muted); }
.status.error { color: #dc2626; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
button { font: inherit; cursor: pointer; border-radius: 8px; padding: 6px 12px; border: 0; }
button:disabled { opacity: .5; cursor: default; }
.primary { background: var(--accent); color: var(--accent-text); font-weight: 600; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.secondary { background: var(--secondary); color: var(--text); }
.continue { flex: 1 1 0; min-width: 0; display: grid; gap: 1px; padding: 7px 12px; text-align: left; }
.continue span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.continue .chapter { font-size: 12px; font-weight: 400; opacity: .85; }
.continue + .secondary { flex: none; }
.primary:hover:not(:disabled) { filter: brightness(1.08); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.close { background: none; color: var(--muted); padding: 0 2px; font-size: 16px; line-height: 1; }
.close:hover { color: var(--text); }
`;

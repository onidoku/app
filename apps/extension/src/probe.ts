// Injected by the popup (via activeTab) on pages no installed source covers, to check whether
// the page looks like a chapter before offering the reader. The popup reads the result back
// with a second executeScript call; both run in the extension's isolated world.
import { detectChapter, type Detection } from '@onidoku/core';

declare global {
  interface Window {
    __onidokuDetection?: Detection | null;
  }
}

window.__onidokuDetection = detectChapter(document, location.href) ?? null;

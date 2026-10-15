# store listings

everything the store submission forms ask for: text, answers, icons and screenshots.

| file | what it's for |
|---|---|
| `summary.txt` | short description, 125 characters (fits Chrome's 132 and AMO's 250 limits) |
| `description.txt` | full description, plain text, works in every store |
| `reviewer-notes.txt` | notes for AMO reviewers (build steps, how to try it) |
| `privacy-policy.md` | the privacy policy, published at https://onidoku.github.io/privacy.html |
| `images/` | the logo at 300 and 512 px (rendered by `pnpm --filter @onidoku/extension icons`) |
| `screenshots/firefox/` | 6 screenshots at 2400x1800 for AMO |
| `screenshots/chrome/` | 5 screenshots at 1280x800 for Chrome and Edge, plus the 440x280 and 1400x560 promo tiles |
| `promo/` | the slide design the screenshots are rendered from |

## screenshots

the screenshots are branded slides around real screenshots of the extension: a headline, and numbered callouts
on the actual buttons and panels. to remake them after the UI changes:

```sh
pnpm --filter @onidoku/extension store-shots            # capture the extension (needs network), then render
pnpm --filter @onidoku/extension store-shots --render   # re-render only, after editing promo/
```

the capture step builds the release extension, fills a library from Pepper&Carrot (CC BY 4.0) and Standard Ebooks
(public domain), and saves screenshots plus where each highlighted element is (`promo/shots/`, not committed).
the render step draws each slide from `promo/slides.html?slide=<name>` in two shapes: 4:3 for AMO, 16:10 for
Chrome. the slides' text is in `promo/slides.js`; colors and type in `promo/slides.css`. to work on the design,
serve `promo/` (`python3 -m http.server -d apps/extension/store/promo`) and open a slide in a 1280x800 or
1200x900 window.

edit `summary.txt`, `description.txt` and `reviewer-notes.txt` here first, then copy them to AMO's form: the
release workflow's AMO submit step (`../scripts/amo-metadata.mjs`) is paused, and new versions go up by hand.

common to every store:

- **name:** onidoku
- **homepage / website:** https://onidoku.github.io
- **support:** https://github.com/onidoku/app/issues
- **email:** onidoku@proton.me
- **privacy policy URL:** https://onidoku.github.io/privacy.html
- **license:** FSL-1.1-MIT (`../../../LICENSE`)

## Firefox (addons.mozilla.org)

- **upload:** `release/onidoku-firefox-<version>.zip`, listed ("On this site").
- **compatibility:** Firefox and Firefox for Android (Android is locked on by the manifest's `gecko_android`).
- **source code:** yes → `release/onidoku-source-<version>.zip`. notes for reviewers: paste `reviewer-notes.txt`.
- **categories:** Games & Entertainment, Alerts & Updates.
- **summary:** `summary.txt`. **description:** `description.txt`.
- **license:** "Custom License". name: `Functional Source License, Version 1.1, MIT Future License (FSL-1.1-MIT)`,
  text: the whole `LICENSE` file.
- **privacy policy:** paste `privacy-policy.md` (AMO takes text, not a link).
- **data collection:** the manifest declares `none`, since nothing reaches the developer. Komga/Kavita logins go to
  a server the user runs; if a reviewer asks for `authenticationInfo`, that's the one to add.
- **icon:** taken from the manifest. **screenshots:** `screenshots/firefox/`, in order, with these captions:

  | file | caption |
  |---|---|
  | `01-hero.png` | one clean reader, one library and new-chapter alerts for every comic and novel you follow. |
  | `02-reader.png` | a distraction-free reader: long-strip comics, and novels in dark, sepia or light with your font and spacing. |
  | `03-library.png` | every series in one library, with unread counts, progress and "continue reading". |
  | `04-alerts.png` | background checks for new chapters, with notifications and a badge count. |
  | `05-sources.png` | explore your sources, write your own in a few lines of JSON, or connect your Komga or Kavita server. |
  | `06-privacy.png` | no ads, no account, no tracking: everything stays in your browser. |

## Chrome Web Store (and Edge Add-ons)

- **upload:** `release/onidoku-chrome-<version>.zip`.
- **category:** Entertainment. **language:** English.
- **summary:** Chrome shows the manifest's `description` (a shorter version of `summary.txt`). **description:**
  `description.txt`.
- **store icon:** `../static/icons/icon-128.png`.
- **screenshots:** `screenshots/chrome/01-…05-*.png` (1280×800, the store's maximum of 5).
- **promo tiles:** small `screenshots/chrome/promo-small-440x280.png`, marquee `promo-marquee-1400x560.png`.

### privacy practices tab

**single purpose:**

> onidoku is a reader for comics and novels: it shows chapters from the sites and media servers the user picks in
> a clean reader, keeps the series they follow in one library, and alerts them to new chapters.

**permission justifications:**

| permission | justification |
|---|---|
| storage | stores the user's library, reading progress, installed sources and settings locally. |
| unlimitedStorage | the library (series, chapter lists, progress) lives in IndexedDB and can outgrow the default quota. |
| alarms | schedules the background check for new chapters in the user's library. |
| notifications | tells the user when a series in their library has new chapters. |
| activeTab | opens the reader on the chapter page the user is on when they click the toolbar button. |
| scripting | injects the reader and the "open in onidoku" card into chapter pages of sources the user added. |
| offscreen | holds the sandboxed frames that run Paperback sources the user installs, isolated from extension APIs. |
| declarativeNetRequestWithHostAccess | adds the headers a Paperback source's site expects (e.g. a referer) to that source's requests and images, for this extension's requests only. |
| cookies | sends the browser's cookies for a Paperback source's own site (e.g. a login or Cloudflare clearance) with requests to that site only. |
| host permissions (optional) | requested per site when the user adds a source, to load its series and chapter pages; all sites only if the user turns on the reader for any site or uses Paperback sources. |

**remote code:** No. site configs are JSON data (CSS selectors), and Paperback sources run only in sandboxed
frames with no access to extension APIs, which the MV3 policy exempts
(https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements). be ready to explain this if a
reviewer asks.

**data usage:** nothing is sent to the developer, but the form counts data the extension handles. tick:

- **Authentication information:** Komga/Kavita API keys or passwords, stored locally and sent only to the user's
  own server.
- **Website content:** chapter pages and images from the user's sources, shown in the reader.
- **Web history:** the series and chapters the user reads, kept as their library and progress.

then certify all three statements (no selling, no unrelated use, no creditworthiness use).

**Edge Add-ons:** same zip, text, answers and screenshots; category Entertainment; it takes the privacy policy as
a URL (https://onidoku.github.io/privacy.html). search terms (max 7, 30 chars each, 21 words total; no
trademarks): `manga reader`, `webcomic reader`, `web novel reader`, `comic reader`, `reader mode`,
`new chapter alerts`, `komga kavita`.

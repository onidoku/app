<p align="center">
  <img src="apps/extension/art/logo.svg" width="112" alt="onidoku logo" />
</p>

<h1 align="center">onidoku</h1>

<p align="center"><b><i>read like a demon.</i></b></p>

<p align="center">
  one clean reader, one library and new-chapter alerts for every comic and novel you follow,<br/>
  right in your browser. no ads, no clutter, no account.
</p>

<p align="center">
  Chrome · <a href="https://microsoftedge.microsoft.com/addons/detail/onidoku/iolhpcmeplfhkigephkjbjolpodlaide">Edge</a> · Firefox · Firefox for Android
</p>

---

you follow a webcomic on its own site, a web novel somewhere else, and your own collection on a Komga
or Kavita server. that's three tabs, three bookmark folders and no idea which one updated today.
**onidoku pulls them into one place.**

### ✦ a reader that gets out of the way
- **distraction-free reading** for comics and novels: no sidebars, pop-ups or autoplaying ads.
- **your way:** long-strip scrolling or page by page, fit to width or height, light, dark and sepia
  themes, and the fonts and spacing you like for novels.
- **keyboard-first:** `N` / `P` for chapters, arrow keys for pages, `C` for the chapter list, `?` for the rest.
- **works on almost any chapter page**, even sites onidoku has never seen: it finds the images or text on its own.
- **read without the site:** open a chapter on onidoku's own page, with none of the site's scripts or ads.

### ✦ one library for everything
- **add any series in one click** from the toolbar, and pick up exactly where you left off.
- **search and explore** across every source you've added: popular lists, latest updates, all in one popup.
- **bring your own server:** browse and read your [Komga](https://komga.org) and
  [Kavita](https://www.kavitareader.com) libraries (comics, CBZ/CBR, PDF and EPUB), with read progress
  synced back to the server.
- **your data stays yours:** everything is stored in your browser, with one-click backup and restore.

### ✦ never miss a chapter
- **background checks** for new chapters across your whole library.
- **notifications and a badge count** the moment something new drops.

### ✦ any site, your choice
onidoku ships with **no sources installed**, and you decide which sites it works with:
- install a suggested source for public-domain and openly licensed sites like
  [Standard Ebooks](https://standardebooks.org) and [Pepper&Carrot](https://www.peppercarrot.com),
- write your own in minutes: a source is a small JSON file of CSS selectors, no code
  ([guide](docs/writing-sources.md)),
- or, on Chrome and Edge, run community sources made for [Paperback](https://paperback.moe), safely sandboxed.

nothing is hosted, mirrored or unlocked: onidoku shows what the site already shows you, the way it should
have looked. see the [content policy](CONTENT_POLICY.md).

### ✦ why "onidoku"?
*onidoku* (鬼読) is a made-up Japanese word: 鬼 (*oni*, demon, and in slang "extremely") plus 読
(*doku*, reading). reading, turned all the way up.

---

## development

```
packages/core     shared TypeScript: site-config format, extraction, library, update checks.
                  no browser APIs, so it can also run in an Android WebView/QuickJS later.
apps/extension    MV3 extension for Chrome and Firefox (popup, in-page reader, background update checks).
apps/test-site    fake comic + novel site on localhost:4173 for testing. generated content only.
configs/          site configs for the test site (bundled into dev builds only).
```

## setup

```sh
pnpm install
pnpm --filter @onidoku/extension exec playwright install chromium   # once, for e2e tests
```

## testing

| command | what it covers | speed |
|---|---|---|
| `pnpm test` | unit tests for core, plus test-site + configs end-to-end without a browser | < 1s |
| `pnpm typecheck` | TypeScript across all packages | few s |
| `pnpm test:e2e` | builds the dev extension, loads it into Chromium, drives the reader, library and update checks against the test site | ~5s |

### manual testing in Chrome

1. `pnpm site` (leave running) and open http://localhost:4173.
2. in another terminal, `pnpm ext:dev` (rebuilds on save).
3. go to `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `apps/extension/dist`.
   after code changes, click the reload icon on the extension card.
4. open http://localhost:4173/series/moon-garden, click the extension icon, and click **add to library**.
   or type "moon" in the popup's search box, or tap **explore** to browse each source's popular and
   latest lists. clicking any title opens its details (chapters, **start reading**) without adding it. **open library** (or the **library** tab) opens the library page, switching to it if it's already open.
5. open a chapter, click the icon, and click **open reader**. try `N`/`P` for chapters, `S` for settings
   (reading mode, fit, themes, fonts), `C` for the chapter list, arrow keys in page mode, `?` for all
   shortcuts, and `Esc` to close.
6. simulate a new chapter: open http://localhost:4173/__admin/add-chapter?series=moon-garden, then click
   the refresh icon (**check for new chapters**) in the popup. you should get a notification and a badge count.
   `/__admin/reset` restores the site.
7. debugging: on `chrome://extensions`, click **service worker** under the extension for background logs;
   reader errors appear in the page's DevTools console.

### Firefox

```sh
pnpm --filter @onidoku/extension dev:firefox   # builds dist-firefox/ and rebuilds on save
pnpm --filter @onidoku/extension firefox       # in another terminal: opens Firefox with it installed
pnpm --filter @onidoku/extension lint:firefox  # Mozilla's add-on linter
```

or load it by hand: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick
`apps/extension/dist-firefox/manifest.json`. Firefox for Android is supported from version 142
(no notifications there; everything else works).

### packaging

`pnpm ext:package` builds both release versions, checks them (no test configs, no localhost access,
no source maps; Firefox must pass `web-ext lint`), and writes `apps/extension/release/`:
`onidoku-chrome-<version>.zip` (Chrome Web Store, Edge Add-ons) and `onidoku-firefox-<version>.zip` (AMO).
it also writes `onidoku-source-<version>.zip` for AMO, which asks for the source of minified add-ons: upload it on
the "source code" step and give reviewers these build steps: Node 22+, pnpm 11 (`corepack enable`), then
`pnpm install --frozen-lockfile && pnpm ext:package`; the Firefox build lands in `apps/extension/dist-firefox/`.
for the listings, `apps/extension/store/` has the text, form answers, icons and screenshots for every store
(see its README).

### website

the website, https://onidoku.github.io, lives in its own repo:
[onidoku/onidoku.github.io](https://github.com/onidoku/onidoku.github.io).

its screenshots are real: with that repo checked out next to this one, `pnpm --filter @onidoku/extension shots`
builds the release extension, adds Pepper&Carrot and a few Standard Ebooks titles, and writes each page in light
and dark as WebP to its `img/`, plus the social preview `og.png` (set `ONIDOKU_SITE` if the checkout is elsewhere).
it needs network access and `cwebp`. pass names to retake only some, e.g. `shots library popup og`.

### icons

the logo lives in `apps/extension/art/` (`logo.svg`, plus `logo-small.svg`, zoomed in a little, for 16/32 px).
after editing them, run `pnpm --filter @onidoku/extension icons` to re-render `static/icons/` and the store icons
in `store/images/`.

### trying real sites

`configs/featured/` has configs for two openly licensed sites: Standard Ebooks (public-domain novels, with
search and explore lists) and Pepper&Carrot (a Creative Commons webcomic). they're the ones the sources page
suggests, so they're also good starting points for writing your own.

1. check a config from the terminal first:
   ```sh
   pnpm try-config configs/featured/standardebooks.json "https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice"
   pnpm try-config configs/featured/standardebooks.json --search "pride and prejudice"
   pnpm try-config configs/featured/standardebooks.json --explore Popular
   ```
   if a site answers 403 (bot protection that blocks Node but not browsers), save the page from Chrome
   and add `--html saved.html`.
2. in the extension: **sources** → **install** it from the suggested list (or paste your own config JSON).
3. open a series page → extension icon → **add to library** (Chrome asks for access to that site).
4. open a chapter → extension icon → **open reader**.

## media servers (Komga, Kavita)

onidoku is also a client for self-hosted [Komga](https://komga.org) and [Kavita](https://www.kavitareader.com)
servers. on **sources → media servers**, pick the server type, enter its address (the one you open its web UI
at, including any sub-path such as `https://example.org/komga`) and an API key (Komga also accepts a
username and password). onidoku checks the login before saving it.

a server then works like any other source: its series appear in search and explore (recently added,
recently updated, all series), can be added to the library, and are checked for new books and chapters.
chapters open on onidoku's own reader page (`reader.html`), since pages and covers need the server's login:
comics, CBZ/CBR and PDFs page by page (the server renders PDF pages), EPUBs as text (images in EPUBs are
left out for now). opening a chapter marks it read on the server, and chapters read in the server's own apps
count as read in onidoku.

server logins stay in the extension's storage and are left out of backups; library entries from a server
come back to life when the server is added again with the same address. the API clients are in
`packages/core/src/servers/`.

**testing without a server:** the test site includes fake Komga and Kavita APIs built from their OpenAPI
specs. with `pnpm site` running, add `http://localhost:4173/komga` (API key `komga-test-key`) or
`http://localhost:4173/kavita` (API key `kavita-test-key`) on the sources page. `/__admin/komga/add-book` and
`/__admin/kavita/add-chapter` simulate new releases.

## Paperback sources (Chrome and Edge)

onidoku can also run sources made for [Paperback](https://paperback.moe), so the community's existing
sources work without rewriting them as configs. on **sources → add source → Paperback repo**, enter the
address of a Paperback 0.8 extension repo (the one you'd add in Paperback, e.g.
`https://someone.github.io/extensions/0.8`), then install sources from its list. they then work like any
other source: search, explore (the source's home page sections), the library, update checks, and chapters on
onidoku's own reader page. onidoku ships, suggests and links to no repos; which ones to add is up to the user.

a Paperback source is a JavaScript bundle, not data, so it runs isolated:

- each source runs in its own sandboxed frame (`paperback-sandbox.html`, listed under `sandbox` in the
  manifest, with a CSP that blocks its own network access), inside an offscreen document that holds the
  frames (`paperback-host.html`). the frame has no extension APIs; the source's only way out is asking the
  background to make a request or keep a setting.
- the background makes its requests. headers browsers don't let pages set (referer, cookie, origin, user
  agent), which sources add in their interceptors, are applied by a `declarativeNetRequest` rule for that one
  request. the browser's own cookies are sent only to the source's own site.
- covers and pages load in extension pages, so a lasting rule per image host adds the headers the source's
  interceptor gives (usually a referer), for this extension's requests only. removing the source removes them.
- sites behind a Cloudflare check: open the site in a tab once; its clearance cookie then goes with the
  source's requests. Cloudflare only accepts it with the browser's own user agent, so sources' own user
  agents are never sent, and requests to the source's site carry the browser's cookies (read with the
  `cookies` permission) plus the source's own. when Cloudflare challenges a request anyway (it can tell
  an extension's requests from the site's own), onidoku repeats it from inside an open tab of the site,
  as that page's own request, so a tab of the site needs to stay open while browsing such a source.

sources need access to all sites (they load from wherever their site keeps pages and images). only the 0.8
extension API is supported (`builtWith.types` 0.8.x in `versioning.json`); 0.6 and 0.9+/1.0 repos are refused
with a message. Firefox builds leave Paperback out: Firefox has no offscreen documents, and AMO doesn't accept
add-ons that run downloaded code. the host side of the API (the `App` global) and the mapping to onidoku's
series and chapters are in `packages/core/src/paperback/`; the extension side is `apps/extension/src/paperback*.ts`.

**on the site itself:** on pages of a Paperback source's site, a small card offers **open in onidoku**. on
click, onidoku searches the source for what the page calls itself (a breadcrumb link to the series, the
heading, the page title) and checks each result's share URL against the page: a match opens the title's
details, or the chapter in the reader when one of its chapter ids is in the rest of the address. without a
match it opens a search for the page's title on that source; the site's home page opens its explore lists.

**testing:** the test site serves a Paperback repo at `http://localhost:4173/paperback` with one hand-written
source, `TestComics` (`apps/test-site/paperback/TestComics/source.js`), reading a JSON API that refuses
requests without the source's referer and cookie, and pages that refuse to load without the referer.

## reading without the site

on series and chapter pages of installed sites, the on-page card also offers **open in onidoku** /
**read in onidoku**: the same page on onidoku's details or reader page, loaded in the background with the
site's config, so none of the site's scripts or ads load (Back returns to the site). the setting **open
chapters in onidoku instead of on the site** does this for chapters opened from the library and details
pages too. pages a site only fills in with scripts may not show this way; the reader then links back to
the site. images get the site as referer (Chrome; a `declarativeNetRequest` rule per image host).

## writing a source

a source (site config) is a JSON file of CSS selectors: where a site's series title, chapter list,
pages or text, search results and explore lists are. no code. **[docs/writing-sources.md](docs/writing-sources.md)**
is the complete guide: a quick start, every field, recipes for lazy-loading and paginated sites,
testing with `pnpm try-config`, and troubleshooting.

## where data is stored

the library lives in the extension's IndexedDB, one record per series, so saving progress writes only that
series. sources and settings live in `chrome.storage.local`. both are the extension's own storage (with the
`unlimitedStorage` permission), not a web page's `localStorage`. it persists across browser
restarts and isn't cleared with browsing data, but it is deleted when the extension is uninstalled, so
the library page has **export backup** / **import backup** (a JSON file; importing merges and never
deletes).

configs are data, not code, which keeps them allowed under Chrome Web Store rules (no remotely loaded code)
and easy to review. without a matching config, the reader falls back to guessing the page images. Paperback
sources are the exception: they're code, which Chrome allows only in sandboxed frames, so that's where they
run (see above). their code is stored with the extension's data when installed and only changes when the user
updates the source; backups leave Paperback sources out (reinstall them from their repo).

## future features

ideas that set onidoku apart from site readers, Komga/Kavita's own UIs and apps like Mihon or Paperback.
the reader, library and alerts stay free. items marked **plus** cost money to run (servers, AI) and are
candidates for a paid tier. everything stays within [CONTENT_POLICY.md](CONTENT_POLICY.md).

### one library for everything

- **cross-source series linking:** link one series across the sites and servers that carry it (an official
  site, your Komga, a webcomic's own site), keep one progress, and continue wherever the next chapter is out first.
- **cloud sync (plus):** library, progress and settings across Chrome, Firefox, Firefox for Android and a
  future Android app. `chrome.storage.sync` is too small for a real library, so this needs a server.
- **tracker sync:** AniList, MyAnimeList and MangaUpdates progress updated as you read, for website and server
  series alike.
- **official-first links:** show where a series is licensed or published officially (from MangaUpdates/AniList
  data), so readers can support creators.

### smarter alerts

- **release schedule:** learn each series' update rhythm and show "usually updates fridays" plus a weekly
  calendar of expected chapters.
- **hiatus and stale detection:** flag series that missed their usual release, or haven't updated in months.
- **instant alerts (plus):** server-side checks with push notifications, so alerts arrive with the browser closed.
- **digest:** one daily or weekly summary of new chapters instead of a notification each time.

### reading help for long series

- **"previously on" recaps (plus):** when you come back to a novel after weeks away, an AI summary of the last
  chapters you read.
- **character and term glossary (plus):** names, places and terms collected as you read a web novel, shown on
  hover, with no spoilers past your current chapter.
- **inline translation (plus):** translate novel text in the reader, and comic speech bubbles via OCR, for
  series not available in your language.
- **text-to-speech:** read novels aloud with the browser's voices for free, and natural voices on **plus**.
- **highlights and notes:** save quotes and notes per chapter, searchable and exportable.

### reader

- **panel-by-panel view:** detect comic panels and step through them, for small screens.
- **image upscaling and cleanup (plus):** sharpen low-resolution scans and tame jpeg artifacts.
- **read-ahead:** prefetch the next few chapters while reading so page turns are instant on slow
  connections (never whole series).

### making sources easy

- **point-and-click source builder:** click the title, a chapter link and a page image on a site, and onidoku writes
  the config, building on `heuristics.ts`.
- **source repos:** add a repo URL (an `index.json` of configs) to install and update community configs that follow
  the content policy.
- **JSON and script data fields:** read values from `__NEXT_DATA__`-style script tags and JSON endpoints, so
  configs work on sites that build pages with JavaScript.
- **more media servers:** Suwayomi, Calibre-Web/OPDS and Jellyfin, alongside Komga and Kavita.

### community

for when there are enough readers. everything social is opt-in and per series: profiles are private until
you make them public, and nsfw series stay hidden from others unless you choose to show them.

- **reader profiles:** what you're reading now, finished series and favorites, on a public page.
- **leaderboards:** most chapters read this week or month, longest streaks, overall and per series or genre,
  plus friends-only boards.
- **trending:** what onidoku readers are starting and finishing this week, from opt-in profiles.
- **reading stats and a yearly recap:** chapters read, streaks and top series, with a shareable card at the end of
  the year.
- **shared libraries:** opt in to make your library visible on your profile. when someone adds one of your
  titles to their own library, the source it comes from is installed along with it, so it works right away.
  configs aren't shared or browsed on their own, only as part of a title.
- **a way in for new users:** onidoku starts with an empty library and no sources. the community page gives new
  users something to try: browse what others read, add a title, and start reading, with sources arriving only for
  titles they picked. it works without an account, and an account is only needed to share.

**what's shared:** only metadata (titles, covers, links to series pages) and the config for each shared title's
source. never chapter pages or text: someone who adds a title still reads it on the site itself, in their own browser.

**moderation:** shared libraries and profiles are user-generated content and follow
[CONTENT_POLICY.md](CONTENT_POLICY.md): titles from unauthorized sites, or whose source gets around paywalls,
are removed from shared libraries. before launch this needs reporting, a DMCA takedown process with a registered
agent, and a repeat-offender policy.

## license

[FSL-1.1-MIT](LICENSE) (Functional Source License). you can read, use, modify and share onidoku for anything except
a competing commercial product or service. each release becomes MIT-licensed two years after it's published.

## contact

open an issue on [GitHub](https://github.com/onidoku/app/issues), or email onidoku@proton.me.

# writing a source

a **source** teaches onidoku how to read one website: where a series' title and chapter list are,
where a chapter's images or text are, and (optionally) how to search and browse the site.

a source is a single JSON file of CSS selectors. it contains no code, so anyone can read it and check
what it does before installing it. if you can use your browser's "inspect element", you can write one.

- [quick start](#quick-start)
- [how onidoku uses a source](#how-onidoku-uses-a-source)
- [reference](#reference): [basics](#basics) · [URL patterns](#url-patterns) · [fields](#fields-selectors-and-attributes) ·
  [`series`](#series) · [`chapter`](#chapter) · [`search`](#search) · [`browse`](#browse) · [`explore`](#explore) · [`coverRewrite`](#coverrewrite)
- [recipes for tricky sites](#recipes-for-tricky-sites)
- [testing with `try-config`](#testing-with-try-config)
- [troubleshooting](#troubleshooting)
- [what a source can't do](#what-a-source-cant-do)
- [rules and good manners](#rules-and-good-manners)
- [sharing your source](#sharing-your-source)

---

## quick start

you need [Node 22+](https://nodejs.org) and [pnpm](https://pnpm.io). from the repo root, run `pnpm install`.

**1. find two example pages** on the site: a series page (the page that lists all the chapters) and one
chapter page. for example:

```
https://example.com/series/moon-garden
https://example.com/series/moon-garden/chapter/12
```

**2. inspect them.** right-click the series title, then **inspect**, and note a selector that finds it
(for example `h1.series-title`). do the same for one chapter link in the list and for the chapter's
images or text.

**3. write the smallest working source** and save it as `my-site.json`:

```json
{
  "schema": 1,
  "id": "example",
  "name": "Example Comics",
  "version": 1,
  "icon": "https://example.com/favicon.ico",
  "developer": "Your Name",
  "nsfw": false,
  "series": {
    "url": "https://example.com/series/*",
    "title": "h1.series-title",
    "chapters": { "item": "ul.chapter-list a" }
  },
  "chapter": {
    "url": "https://example.com/series/*/chapter/*",
    "pages": ".reader img"
  }
}
```

for a novel site, use `"text": ".chapter-content"` in place of `"pages"`.

**4. try it from the terminal.** this loads the live page and prints what onidoku found:

```sh
pnpm try-config my-site.json https://example.com/series/moon-garden
pnpm try-config my-site.json https://example.com/series/moon-garden/chapter/12
```

**5. install it.** in the extension, open **sources**, paste the JSON under **add by pasting JSON**,
and click **install**. then open a series page on the site, click the onidoku icon, and choose
**add to library**.

once that works, add the extras one at a time: cover, description, authors, `next`/`prev` links,
`search`, `explore`. each one is optional.

> **tip:** start from the source in [`configs/featured/`](../configs/featured) that looks most like
> your site. `standardebooks.json` is a novel site whose chapter list is on another page (`from`),
> with search and explore lists, and `peppercarrot-en.json` is a comic site with image pages and
> `next`/`prev` links.

---

## how onidoku uses a source

| when | what onidoku loads | sections used |
|---|---|---|
| you open any page | nothing. it only compares the URL with `series.url` and `chapter.url` | `series.url`, `chapter.url` |
| opening a title (from explore, search, or the popup's **details**) / **add to library** / update checks (every 12 h) | the series page, plus the chapter list's own page(s) if configured | `series` |
| **open reader** | the chapter page, plus its images/text page if configured | `chapter` |
| **search** page | the site's search results page | `search` |
| clicking an author or genre on a details page | the site's author / genre listing | `browse` |
| **explore** page | the site's popular / latest / … listings | `explore` |

onidoku only ever loads pages from the site the source is for. every URL a source produces must
be on the same host as `series.url`, and a source that breaks this rule is rejected when installed.

---

## reference

### basics

| key | required | description |
|---|---|---|
| `schema` | yes | always `1`. |
| `id` | yes | 2–64 characters: lowercase letters, digits, `.`, `_`, `-`. for example `standardebooks` or `peppercarrot.en`. **never change it after release.** library entries are tied to it, and a new id means users lose their progress. |
| `name` | yes | shown everywhere in the app. up to 80 characters. |
| `version` | yes | a whole number. increase it every time you change the source. installing a source with the same `id` replaces the old one. |
| `icon` | yes | an `http(s)` URL (usually the site's favicon or `apple-touch-icon.png`) or a `data:image/…` URL. if it fails to load, onidoku shows the first letter of `name`. |
| `developer` | yes | who maintains this source (you), not the site's owner. |
| `nsfw` | yes | `true` if the site hosts adult content. such sources are hidden from search and explore unless the user turns them on. |
| `series` | yes | see [`series`](#series). |
| `chapter` | yes | see [`chapter`](#chapter). |
| `search`, `browse`, `explore`, `coverRewrite` | no | extras, described below. |

unknown keys are an error, so a typo such as `"titel"` is caught when you install the source.

### URL patterns

`series.url` and `chapter.url` are **URL patterns** that decide which pages the source handles.

| pattern | matches |
|---|---|
| `*` | any text within one path segment (it never crosses `/`, `?` or `#`). |
| `**` | anything, including `/`. |
| everything else | itself, literally. |

- the host must be written out in full. `https://*.example.com/…` is not allowed.
- if the pattern has **no `?`**, a trailing `/` and any query string are allowed. so
  `https://example.com/series/*` matches `https://example.com/series/moon-garden/?ref=home`.
- if the pattern **has a `?`**, the query must match too. use `*` for the values:
  `https://example.com/series?id=*`.
- `#fragments` are always ignored.
- onidoku tests chapter patterns before series patterns. a chapter URL that sits under its series
  URL (`/series/x/chapter/1` under `/series/x`) is therefore fine, as long as the series pattern
  doesn't also match chapters. `https://example.com/series/*` does not match
  `/series/x/chapter/1`, because `*` stops at `/`.

### fields: selectors and attributes

almost every value in a source is a **field**: something to read from the page. a field is either a
CSS selector:

```json
"title": "h1.series-title"
```

or a selector plus the attribute to read:

```json
"cover": { "selector": "meta[property='og:image']", "attr": "content" }
"cover": { "selector": "img.cover", "attr": ["data-lazy", "src"] }
```

when `attr` is a list, the first non-empty one wins. without `attr`, each field reads its natural
value:

| kind of field | reads by default |
|---|---|
| titles, names, status, description | the element's text, with whitespace tidied up |
| links (`link`, `next`, `prev`, `series`, `from`) | `href` |
| images (`cover`, `pages`) | `data-src`, `data-lazy-src`, `data-original`, `data-url`, then `src` |

some other things to know:
- **single fields use the first match.** `pages`, `authors` and `genres` use every match.
- **`data:` placeholders are skipped**, so lazy-loading sites that put a tiny GIF in `src` until the
  real image loads work without extra configuration.
- **relative URLs are fine.** they're resolved against the page they were found on.
- **fields inside a list** (`chapters.title`, `search.title`, and so on) are looked up *inside* each
  `item`, not in the whole page.
- **pages are read as they were sent by the server**, before the site's JavaScript runs. check with
  **view page source** (Ctrl+U), not only the inspect panel. see
  [content loaded by JavaScript](#content-loaded-by-javascript) if something is missing.

### `series`

the page that lists a series' chapters.

| key | required | description |
|---|---|---|
| `url` | yes | [URL pattern](#url-patterns) for series pages. |
| `title` | yes | the series title. adding fails without it. |
| `cover` | no | cover image. `meta[property='og:image']` with `"attr": "content"` is often the most reliable. |
| `description` | no | synopsis. `<p>` paragraphs are kept as paragraphs. elements the site hides are dropped. |
| `authors` | no | every matching element is one author. a single element containing `A / B` or `A, B` is split. |
| `genres` | no | every matching element is one genre or tag. |
| `status` | no | as the site words it: "ongoing", "completed", … |
| `chapters` | yes | see below. |

if an author or genre element is (or sits inside) a link on the same site, onidoku remembers that
link. [`browse`](#browse) can then use it as `{url}`.

#### `series.chapters`

| key | required | description |
|---|---|---|
| `item` | yes | selector for each chapter entry. the entry is either the `<a>` itself or contains one. |
| `link` | no | field for the chapter link inside `item`, if the first `<a>` isn't the right one. |
| `title` | no | field for the chapter title inside `item`. the default is the item's whole text. |
| `order` | no | `"newest-first"` (default) or `"oldest-first"`: the order of the list *as the site shows it*. if this is wrong, "next chapter" and unread counts go backwards. |
| `from` | no | load the chapter list from another URL. see [chapter list on another page](#chapter-list-on-another-page-show-all-buttons). |
| `next` | no | link to the next page of a list split over several pages. see [chapter list split over pages](#chapter-list-split-over-pages). |

duplicate links are dropped, so it doesn't matter if the list also appears in a sidebar.

### `chapter`

a page you read.

| key | required | description |
|---|---|---|
| `url` | yes | [URL pattern](#url-patterns) for chapter pages. |
| `pages` | one of | **comics:** selector matching every page image, in reading order. |
| `text` | one of | **novels:** selector for the element that holds the chapter text. |
| `title` | no | chapter title shown in the reader. |
| `next`, `prev` | no | links to the next and previous chapters. if missing, the reader uses the series' chapter list from the library, so these matter less than you might think. |
| `series` | no | link back to the series page. it lets the in-page prompt add the series from a chapter page. |
| `from` | no | load `pages`/`text` from another URL. see [images or text loaded after the page](#images-or-text-loaded-after-the-page). |

exactly one of `pages` or `text` is required.

**how text is read:** onidoku takes the `<p>` elements inside `text`. if there are none, it splits the
text on line breaks in the HTML. scripts, styles, and anything hidden with `hidden`, inline
`display:none` or a `<style>` rule like `.notice { display: none }` are removed. that covers the
invisible "stolen from …" anti-copy lines some sites insert. only plain text reaches the reader,
never the site's HTML.

### `search`

optional. lets the source be searched from the **search** page and the popup's search box.

```json
"search": {
  "url": "https://example.com/search?q={query}",
  "item": ".result",
  "title": ".result-title",
  "link": "a.result-link",
  "cover": "img"
}
```

| key | required | description |
|---|---|---|
| `url` | yes | must contain `{query}`, which becomes the URL-encoded search text. same host as `series.url`. |
| `item` | yes | selector for each result. the result is the `<a>` itself or contains one. |
| `title` | no | default: the item's whole text. if the title only appears in an attribute, use `{ "selector": "a", "attr": "title" }`. |
| `link` | no | default: the item itself if it's a link, else the first `<a>` in it. |
| `cover` | no | default: the first `img` in the item. |

results that don't link to a page matching `series.url` are dropped, so every result can be added
to the library. if you get `0 results` on a page clearly full of results, check `link` and
`series.url` first.

### `browse`

optional. when someone clicks an author or genre on a series' details page, onidoku lists that
author's or genre's titles from every source that has a `browse` entry for it.

```json
"browse": {
  "authors": { "url": "{url}", "item": ".work", "title": ".work-title", "cover": "img" },
  "genres":  { "url": "https://example.com/genre/{slug}", "item": ".result", "title": ".result-title" }
}
```

`item`, `title`, `link` and `cover` work exactly as in [`search`](#search). `url` must contain at
least one of these placeholders:

| placeholder | becomes | example for "slice of life" |
|---|---|---|
| `{url}` | the link the author/genre had on the series page | `https://example.com/tag/42` |
| `{slug}` | the name as a URL slug | `slice-of-life` |
| `{name}` | the name, URL-encoded | `Slice%20of%20Life` |

`{url}` is the most reliable choice when series pages link to their authors and genres. its only
limit is that it can't list a name the user hasn't seen on a series page from this source. use
`{slug}` or `{name}` when the site's URLs can be built from the name. you can use `{url}` with a
suffix, such as `{url}/works`.

### `explore`

optional. lists shown as tabs for this source on the **explore** page, in the order you write them.
you can have up to 8.

```json
"explore": [
  { "name": "Popular", "url": "https://example.com/popular?page={page}", "item": ".result", "title": ".result-title", "cover": "img" },
  { "name": "Latest",  "url": "https://example.com/latest?page={page}",  "item": ".result" },
  { "name": "Ranking", "url": "https://example.com/ranking",             "item": ".result" }
]
```

| key | required | description |
|---|---|---|
| `name` | yes | tab label, up to 40 characters. keep it short: "popular", "latest", "completed". |
| `url` | yes | same host as `series.url`. `{page}` becomes 1, 2, 3, … as the user scrolls. |
| `item`, `title`, `link`, `cover` | | as in [`search`](#search). |

without `{page}`, the list is a single page. with it, onidoku keeps loading pages until one comes
back empty or repeats titles it already has. if the site pages by item offset (`?offset=0`, `32`,
`64`, …) rather than page number, leave `{page}` out: the first page is still worth showing.

good lists to offer, if the site has them: popular, latest (recently updated), new (recently added),
completed, ranking.

### `coverRewrite`

optional. covers are shown on onidoku's own pages, outside the site. some image servers refuse
those requests (hotlink protection) even though the same files are available from another host
that doesn't check. `coverRewrite` swaps the URL prefix:

```json
"coverRewrite": [{ "from": "https://img.example.com/", "to": "https://cdn.example.com/" }]
```

the first matching rule wins. it applies to covers only, never to chapter images, because those are
loaded on the site itself.

---

## recipes for tricky sites

### lazy-loaded images

these need no configuration in most cases: `data-src`, `data-lazy-src`, `data-original` and `data-url`
are tried before `src`, and `data:` placeholders are skipped. if the site uses another attribute, name
it:

```json
"pages": { "selector": ".reader img", "attr": ["data-lazy", "src"] }
```

### chapter list on another page ("show all" buttons)

many sites show only the newest chapters and fetch the full list when you click a button. open
DevTools → **network**, click the button, and find the request that returns the list. then point
`from` at it in one of two ways.

read the URL from the button, for htmx-style sites:

```json
"chapters": {
  "item": "a[href*='/chapters/']",
  "from": { "selector": "button.show-all", "attr": "hx-get" }
}
```

or build it from the series URL. `{url}` is the series page's own URL:

```json
"chapters": { "item": "ul.chapter-list a", "from": { "template": "{url}/chapters" } }
```

`item` then applies to the page `from` loads, not to the series page. if the button isn't there
(because the list is already complete), onidoku simply reads the series page.

### chapter list split over pages

for lists like "chapters 1–100 · page 1 of 33", give `next` a selector for the "next page" link:

```json
"chapters": {
  "item": "ul.chapter-list li a",
  "order": "oldest-first",
  "from": { "template": "{url}/chapters" },
  "next": "ul.pagination a[rel=next]"
}
```

onidoku follows `next` until there is no next link, stops if a link points back to a page it
already read, and gives up after 150 pages. `order` describes the list as a whole: if page 1 has
chapters 1–100, it's `oldest-first`.

each page is a separate request, every time the series is added or checked for updates. if a site
also offers a single "all chapters" page, prefer that.

### images or text loaded after the page

if the chapter page arrives empty and fills itself in with JavaScript, find the request in DevTools →
**network** that returns the images or text, and load it with `from`:

```json
"chapter": {
  "url": "https://example.com/chapters/*",
  "pages": "img",
  "from": { "template": "{url}/images?reading_style=long_strip" }
}
```

`title`, `next`, `prev` and `series` are still read from the chapter page itself. only `pages`/`text`
come from the `from` page.

### content loaded by JavaScript

onidoku reads the HTML the server sends. it doesn't run the site's JavaScript. to see what it will
see, use **view page source** (Ctrl+U) or `try-config`. if the data is missing there:

1. look in DevTools → **network** → **fetch/XHR** for a request on the **same host** that returns
   **HTML**, and use it with `from` (above).
2. look for the data in `<meta>` tags (`og:title`, `og:image`, `og:description`). they're almost
   always server-rendered.
3. if the data only arrives as JSON or from another host, the site can't be supported yet. see
   [what a source can't do](#what-a-source-cant-do).

### titles only in an attribute

card layouts often have the title only in a `title` or `alt` attribute:

```json
"title": { "selector": "a[href*='/book/']", "attr": "title" }
```

### the site is a single-page app with JSON in the HTML

the data is sometimes embedded in the page as JSON (`<script id="__NEXT_DATA__">`). sources can't read
JSON, so this site isn't supported unless it also renders the data as HTML somewhere. check its
mobile site or an "amp" version.

---

## testing with `try-config`

`try-config` runs your source against the live site with the same code the extension uses, and
prints what it found. run it often. it's much faster than reinstalling the source in the browser.

```sh
# A series page: title, cover, description, authors, genres, status, and the chapter list
pnpm try-config my-site.json https://example.com/series/moon-garden

# A chapter page: title, next/prev/series links, and the pages or paragraphs
pnpm try-config my-site.json https://example.com/series/moon-garden/chapter/12

# Search
pnpm try-config my-site.json --search "moon garden"

# An author or genre listing (add --link for {url} templates)
pnpm try-config my-site.json --browse genres "Fantasy"
pnpm try-config my-site.json --browse authors "Ana Ruiz" --link https://example.com/author/ana-ruiz

# An explore list, by name, and a later page of it
pnpm try-config my-site.json --explore Popular
pnpm try-config my-site.json --explore Popular --page 2
```

**if the site blocks the terminal** (HTTP 403 or 503, bot protection), save the page from your
browser (Ctrl+S, "webpage, HTML only") and pass it with `--html`. the URL is still needed to work
out the page kind and to resolve relative links:

```sh
pnpm try-config my-site.json https://example.com/series/moon-garden --html moon-garden.html
```

**if the site rate-limits** (HTTP 429), `try-config` waits as long as the site asks and retries,
just like the extension does.

before sharing, check at least:
- [ ] a series with many chapters: is the chapter count right? are the first and last chapters the right way round?
- [ ] a series with very few chapters, and one that's completed
- [ ] a chapter in the middle: pages in order, or text without ads or "read at …" notices
- [ ] the first and the latest chapter: `prev`/`next` are empty where they should be
- [ ] search with a common word and with a title that has punctuation
- [ ] each explore list, and page 2 of the paged ones

---

## troubleshooting

| message or symptom | likely cause and fix |
|---|---|
| `invalid site config: <path>: …` | the JSON breaks a rule. `<path>` points at the problem, for example `series.chapters: unrecognized key(s) in object: 'nxt'`. if the key is spelled right and documented here, your copy of onidoku is older than the feature: update it. |
| `must be on the same host as series.url` | a `search`, `browse` or `explore` URL points at another domain, such as `www.` versus no `www.`. |
| `must be an http(s) URL glob with a literal host` | a `*` in the host. write the host out in full. |
| `URL matches neither glob` (try-config) | the URL doesn't match `series.url` or `chapter.url`. check `*` versus `**`, and whether your pattern contains `?`. |
| `series title not found (…)` | the `title` selector found nothing. check it against **view page source**, not only the inspect panel. |
| series added with **0 chapters** | `chapters.item` matches nothing in the page source. the list is probably loaded later: use [`from`](#chapter-list-on-another-page-show-all-buttons). |
| chapters in the **wrong order** / "next" goes backwards | flip `chapters.order`. |
| only some chapters, such as the newest 50 | a "show all" button ([`from`](#chapter-list-on-another-page-show-all-buttons)) or pagination ([`next`](#chapter-list-split-over-pages)). |
| `no pages found (…)` / `chapter text not found (…)` | the selector matches nothing in the page source. use [`from`](#images-or-text-loaded-after-the-page) if the content loads later. |
| reader shows **ads, logos or blank images** | `pages` is too broad. narrow it to the reading area: `.reader img`, not `img`. |
| text has **junk lines** ("find this at …") | if the site hides them with CSS they're removed automatically. otherwise point `text` at a tighter container. |
| `0 results` from search on a page full of results | the result links don't match `series.url`, or `item`/`link` picks the wrong `<a>`. |
| **covers missing** on the library page but fine on the site | hotlink protection: try [`coverRewrite`](#coverrewrite), or an `og:image` from the series page. |
| `HTTP 403` / `HTTP 503` from the terminal | bot protection. use `--html` with a saved page. the extension may still work, because it makes requests as the user's browser. |
| `… is limiting requests (HTTP 429)` | the site allows only so many requests a minute. onidoku waits and retries automatically for pauses up to 30 seconds. if it still fails, the site wants longer pauses. avoid paginated chapter lists on such sites if there's an alternative. |
| `refusing to load … not on the same site` | a `from` or `next` link points at another domain. that's not allowed. |
| `chapter list has more than 150 pages` | `next` is probably matching a link that always exists (such as a "last page" link). use a selector that is missing on the last page, like `a[rel=next]`. |

---

## what a source can't do

sources are declarative on purpose. that's what makes them safe to install, and it's also why
browser stores allow them. it also means some sites can't be supported (yet):

- **data only available as JSON** from an API (common with single-page apps), or only from another
  domain.
- **content behind a login or paywall** that the user's browser session doesn't already have.
  requests do carry the user's cookies for that site.
- **bot challenges** ("checking your browser…") that never let a plain request through.
- **scrambled images** that the site's own JavaScript has to reassemble.
- **arithmetic in URLs**, such as `offset = (page − 1) × 20`.

sources never run code. please don't propose features that add scripting to the format.

---

## rules and good manners

- **same site only.** every URL a source loads must be on the host of `series.url`. this is enforced
  when the source is installed and when it runs.
- **keep `id` stable, bump `version`.** users' libraries are keyed by `id` plus the series URL.
- **set `nsfw` honestly.** it controls whether the source appears in search and explore for people who
  haven't opted in.
- **be gentle with the site.** every chapter list page, search and explore page is a real request
  from the user's browser. prefer a single full-list page over pagination, and keep explore lists to
  the few that are actually useful.
- **respect the people who make the work.** onidoku is a reader for sites people already use. where a
  series is available officially, prefer sources for official or author-run sites.

---

## sharing your source

- **as a link:** host the JSON somewhere that allows cross-site requests. a GitHub gist "raw" link or
  `raw.githubusercontent.com` works. users then paste the link under **sources → add from URL**.
  otherwise, users can paste the JSON itself.
- **as a suggested source in this repo:** if the site's works are in the public domain or openly
  licensed, add it to [`configs/featured/`](../configs/featured) in a pull request (see
  [CONTENT_POLICY.md](../CONTENT_POLICY.md) for what qualifies). `pnpm test` checks that every config
  there is valid. mention in the PR which pages you tested with `try-config`.

when you update a shared source, increase `version`. users install the new copy the same way, and it
replaces the old one without touching their library.

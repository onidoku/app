# content policy

onidoku is a reader, a library and new-chapter alerts for comic and novel sites. it does not host,
mirror or distribute any comics or novels. nothing installs automatically: users choose which sites
it works with, by installing a source (a JSON file of CSS selectors, or a source from a Paperback extension
repo the user adds) or by opening the reader on a page they already have open.

this policy covers what the project itself ships, links to and accepts, and how we handle complaints.

## what onidoku ships

- **no sources are installed by default.** the sources page suggests a short list of sources for
  sites whose works are in the public domain or openly licensed (see `configs/featured/`). each one
  is installed only when the user picks it.
- **featured sources must meet all of these:**
  - the site publishes the works itself, and they are in the public domain or under a license that
    allows free sharing (for example Creative Commons).
  - the site's terms don't forbid reading its pages this way.
  - the config keeps the site's own chapter pages as the source of truth: no re-hosting, no
    downloading whole series.
- test configs for the local test site are included in development builds only.
- onidoku can run sources from Paperback extension repos, but ships, suggests and links to none. users
  add repos by their address, the same way they'd add any source.

## what this project won't accept or link to

in this repository, its issues, pull requests and discussions, and any community it runs:

- sources or configs for sites that host comics or novels without the rights holders' permission
  (aggregators, mirrors and "read free online" sites for licensed works).
- sources, configs or instructions that get around paywalls, logins, coin or ticket systems,
  region locks or other access controls.
- links to lists or repositories of such sources.
- requests for help making onidoku work with such sites.

maintainers remove anything that breaks these rules, and may block repeat posters.

users can install any source they like, and they are responsible for using onidoku in line with the
terms of the sites they read and the law where they live.

## detection on other sites

the reader can be opened on any page, and if the user turns it on, onidoku offers the reader on pages
that look like chapters. this runs on the user's device only: pages are checked locally and nothing
about them is sent anywhere. the reader shows what the page already shows the user, loaded the same way
the site loads it, and does not unlock anything the user couldn't already see.

## reporting a problem

if you are a rights holder or site owner and believe something in this project infringes your rights
or breaks your site's terms, open an issue or email the maintainers at onidoku@proton.me. please include:

- what the content is and where it appears in this project (file, issue or discussion link),
- why you believe it infringes your rights or terms, and
- how to reach you.

we aim to respond within a few days, and we remove infringing material from the project once we've
confirmed the report.

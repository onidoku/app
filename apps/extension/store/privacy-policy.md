# onidoku privacy policy

effective october 12, 2026

onidoku is a browser extension for reading comics and novels. it has no account, no ads, no analytics and no
server of its own. **we don't collect, receive, sell or share any of your data.**

## what stays on your device

everything onidoku keeps is stored in the extension's own storage in your browser:

- **your library:** the series you add (title, cover link, description, chapter list), your reading progress and
  which chapters are new.
- **your sources:** the site configs you install, and on Chrome and Edge, any Paperback sources you install and
  their settings.
- **your settings:** reader preferences (themes, fonts, reading mode) and extension settings.
- **media server logins:** the address of any Komga or Kavita server you connect, and its API key or username and
  password.

none of this is sent to us. it's deleted when you uninstall onidoku. **export backup** saves your library to a file
on your device, and leaves out server logins and Paperback sources.

## what onidoku connects to

onidoku only makes requests to places you chose:

- **sites you added as sources:** to show series and chapters, search and explore them, and check them for new
  chapters in the background. these requests are like visiting the site yourself: the site sees your IP address,
  and your browser sends your cookies for that site. on Chrome and Edge, Paperback sources can read your browser's
  cookies for the source's own site (for example a login or a Cloudflare check) and send them only to that site.
- **your Komga or Kavita server:** to browse your libraries, read, and sync read progress. your login is sent only
  to that server.
- **Paperback repos you add:** to list and download their sources.

with **offer the reader on chapter pages of any site** turned on, onidoku looks at pages you open to see if they're
chapters. that check happens on your device and nothing is sent anywhere.

## permissions

- **storage, unlimited storage:** keep your library, sources and settings in the extension's storage.
- **alarms, notifications:** check for new chapters in the background and tell you when there are some.
- **active tab, scripting:** open the reader and the "open in onidoku" card on the page you're reading.
- **access to sites:** asked for one site at a time when you add a source, or for all sites if you turn on the
  reader for any site or use Paperback sources. you can remove it any time in your browser's extension settings.
- **Chrome and Edge only, for Paperback sources:** offscreen documents (to run each source in its own sandbox),
  declarative net request (to send the headers a source's site expects, like a referer) and cookies (see above).

## children

onidoku isn't directed at children and doesn't knowingly handle any personal information about anyone.

## changes

if this policy changes, the new version will be posted at https://onidoku.github.io/privacy.html with a new date.

## contact

onidoku@proton.me, or open an issue at https://github.com/onidoku/app/issues.

// Series tiles shared by the search and explore pages: cover and title (opening the details view),
// with a small add / in-library button on the cover's corner.
import { configOrigins, type SiteConfig } from '@onidoku/core';
import { button, h } from './dom';
import { detailsUrl, errorMessage, previewUrl, send, type SearchHit } from './messages';
import { setImageSrc } from './servers';

export function resultTile(config: SiteConfig, hit: SearchHit): HTMLElement {
  const cover = hit.cover
    ? setImageSrc(h('img', { class: 'cover', alt: '', loading: 'lazy' }), hit.cover)
    : h('div', { class: 'cover blank', text: hit.title });
  return h(
    'li',
    { class: hit.inLibrary ? 'tile result in-library' : 'tile result', 'data-url': hit.url },
    h(
      'a',
      { class: 'tile-button', href: hit.inLibrary ? detailsUrl(hit.seriesId) : previewUrl(hit.url), title: `${hit.title} — details` },
      cover,
      h('span', { class: 'tile-title', text: hit.title }),
    ),
    hit.inLibrary ? inLibraryButton(hit) : addButton(config, hit),
  );
}

/** The ✓ on a title already in the library: always shown, and opens its details. */
export function inLibraryButton(hit: SearchHit): HTMLButtonElement {
  const el = button('✓', 'tile-action done', () => (location.href = detailsUrl(hit.seriesId)), 'in your library: view details');
  el.setAttribute('aria-label', 'in library');
  return el;
}

/** The + on a cover: shown on hover or focus (always on touch screens), adds without leaving the page. */
export function addButton(config: SiteConfig, hit: SearchHit): HTMLButtonElement {
  const add = button('+', 'tile-action', async () => {
    // Already granted after searching, but asking again is free and keeps this gesture-safe.
    if (!(await chrome.permissions.request({ origins: configOrigins(config) }))) return;
    add.disabled = true;
    add.className = 'tile-action busy';
    add.textContent = '';
    add.setAttribute('aria-label', 'adding to library');
    try {
      await send({ type: 'addSeries', url: hit.url });
      // Keep the state in sync so switching tabs doesn't show + again.
      hit.inLibrary = true;
      const tile = add.closest('.tile');
      tile?.classList.add('in-library');
      tile?.querySelector<HTMLAnchorElement>('.tile-button')?.setAttribute('href', detailsUrl(hit.seriesId));
      const done = inLibraryButton(hit);
      done.classList.add('just-added');
      add.replaceWith(done);
      done.focus();
    } catch (err) {
      add.disabled = false;
      add.className = 'tile-action failed';
      add.textContent = '!';
      add.title = `couldn’t add: ${errorMessage(err)}. click to try again.`;
      add.setAttribute('aria-label', 'retry adding to library');
    }
  }, `add ${hit.title} to your library`);
  add.setAttribute('aria-label', 'add to library');
  return add;
}

export function skeletonRow(n: number): HTMLElement {
  return h('ul', { class: 'tiles strip', 'aria-hidden': 'true' }, ...Array.from({ length: n }, () => h('li', { class: 'tile skeleton' }, h('div', { class: 'cover' }), h('div', { class: 'line' }))));
}

export function skeletonGrid(n: number): HTMLElement {
  const el = skeletonRow(n);
  el.classList.remove('strip');
  return el;
}


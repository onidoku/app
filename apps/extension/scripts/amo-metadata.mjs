// Writes the metadata `web-ext sign` sends to addons.mozilla.org with a new version.
// Usage: node scripts/amo-metadata.mjs <out.json>
// Until the add-on is public on AMO it includes the whole listing (needed to create it); after that only the
// version's license and reviewer notes, so edits made on AMO's listing page aren't overwritten.
import { readFileSync, writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/amo-metadata.mjs <out.json>');

const ID = 'onidoku@proton.me';
const en = (text) => ({ 'en-US': text });

const store = (file) => readFileSync(new URL(`../store/${file}`, import.meta.url), 'utf8').trim();

const version = {
  custom_license: {
    name: en('Functional Source License, Version 1.1, MIT Future License (FSL-1.1-MIT)'),
    text: en(readFileSync(new URL('../../../LICENSE', import.meta.url), 'utf8')),
  },
  approval_notes: store('reviewer-notes.txt'),
};

// The listing text lives in store/ (see store/README.md).
const listing = {
  categories: ['games-entertainment', 'alerts-updates'],
  summary: en(store('summary.txt')),
  description: en(store('description.txt')),
  homepage: en('https://onidoku.github.io'),
  support_url: en('https://github.com/onidoku/app/issues'),
  support_email: en('onidoku@proton.me'),
};

// The public API only knows listed add-ons that passed review.
const res = await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(ID)}/`);
const isPublic = res.ok;
writeFileSync(out, JSON.stringify(isPublic ? { version } : { ...listing, version }, null, 2));
console.log(`Wrote ${out} (${isPublic ? 'new version only' : 'full listing: add-on not public on AMO yet'})`);

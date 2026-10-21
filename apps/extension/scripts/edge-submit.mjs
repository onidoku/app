// Uploads the Chrome package to Microsoft Edge Add-ons as a new draft and submits it for review
// (Edge Add-ons API v1.1: https://learn.microsoft.com/microsoft-edge/extensions/update/api/using-addons-api).
// Usage: node scripts/edge-submit.mjs <package.zip> [notes for certification]
// Needs EDGE_PRODUCT_ID (Partner Center's product id, a GUID: not the store's extension id),
// EDGE_CLIENT_ID and EDGE_API_KEY (Partner Center → Microsoft Edge → Publish API).
import { readFileSync } from 'node:fs';

const [file, notes = ''] = process.argv.slice(2);
if (!file) throw new Error('usage: node scripts/edge-submit.mjs <package.zip> [notes]');
const { EDGE_PRODUCT_ID: product, EDGE_CLIENT_ID: clientId, EDGE_API_KEY: apiKey } = process.env;
if (!product || !clientId || !apiKey) throw new Error('set EDGE_PRODUCT_ID, EDGE_CLIENT_ID and EDGE_API_KEY');

const API = `https://api.addons.microsoftedge.microsoft.com/v1/products/${encodeURIComponent(product)}/submissions`;
const auth = { Authorization: `ApiKey ${apiKey}`, 'X-ClientID': clientId };

/** Starts an operation; Edge answers 202 with the operation's id in Location. */
async function start(url, init) {
  const res = await fetch(url, { method: 'POST', ...init, headers: { ...auth, ...init.headers } });
  if (res.status !== 202) throw new Error(`${url} answered HTTP ${res.status}: ${await res.text()}`);
  const id = res.headers.get('location');
  if (!id) throw new Error(`${url} gave no operation id`);
  return id.split('/').at(-1);
}

/** Polls an operation until it succeeds or fails, for up to ten minutes. */
async function finish(url, what) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const res = await fetch(url, { headers: auth });
    if (!res.ok) throw new Error(`${what}: status check answered HTTP ${res.status}: ${await res.text()}`);
    const op = await res.json();
    if (op.status === 'Succeeded') return op;
    if (op.status === 'Failed') {
      const details = (op.errors ?? []).map((e) => e.message).filter(Boolean);
      throw new Error(`${what} failed: ${[op.message, ...details].filter(Boolean).join(' · ') || JSON.stringify(op)}`);
    }
    console.log(`${what}: ${op.status}…`);
  }
  throw new Error(`${what}: still not done after ten minutes`);
}

const upload = await start(`${API}/draft/package`, { headers: { 'Content-Type': 'application/zip' }, body: readFileSync(file) });
await finish(`${API}/draft/package/operations/${upload}`, 'upload');
console.log(`Uploaded ${file} as the draft.`);

const publish = await start(API, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes }) });
const done = await finish(`${API}/operations/${publish}`, 'submit');
console.log(`Submitted for review. ${done.message ?? ''}`.trim());

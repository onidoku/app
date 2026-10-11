import { createServer } from 'node:http';
import { createKavita, createKomga } from './media-servers.mjs';
import { handlePaperbackRepo } from './paperback.mjs';
import { createSite } from './site.mjs';

// The configs in /configs point at port 4173; change both together.
const port = Number(process.env.PORT ?? 4173);
const origin = `http://localhost:${port}`;
const site = createSite();
// Fake media servers, as if Komga and Kavita were installed under these paths.
let komga = createKomga(`${origin}/komga`);
let kavita = createKavita(`${origin}/kavita`);

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', origin);
  let body = '';
  for await (const chunk of req) body += chunk;
  let result;
  if (url.pathname === '/__admin/reset') {
    komga = createKomga(`${origin}/komga`);
    kavita = createKavita(`${origin}/kavita`);
  }
  if (url.pathname === '/__admin/komga/add-book') {
    komga.addBook(url.searchParams.get('series') ?? undefined);
    result = { status: 200, type: 'text/plain', body: 'Added a book to the Komga series' };
  } else if (url.pathname === '/__admin/kavita/add-chapter') {
    kavita.addChapter(Number(url.searchParams.get('series') ?? 1));
    result = { status: 200, type: 'text/plain', body: 'Added a chapter to the Kavita series' };
  } else if (url.pathname.startsWith('/komga/') || url.pathname.startsWith('/kavita/')) {
    const server = url.pathname.startsWith('/komga/') ? komga : kavita;
    result = server.handle({ method: req.method ?? 'GET', url, headers: req.headers, body });
  } else {
    result = handlePaperbackRepo(url) ?? site.handle(url, { method: req.method ?? 'GET', headers: req.headers, body });
  }
  res.writeHead(result.status, { 'content-type': result.type, 'cache-control': 'no-store', ...result.headers });
  res.end(result.body);
  console.log(`${result.status} ${req.method} ${req.url}`);
}).listen(port, () => {
  console.log(`Test site: http://localhost:${port}`);
  console.log(`New chapter: http://localhost:${port}/__admin/add-chapter?series=moon-garden`);
  console.log(`Paperback repo: ${origin}/paperback (source "TestComics")`);
  console.log(`Fake Komga: ${origin}/komga (API key "komga-test-key"); fake Kavita: ${origin}/kavita (API key "kavita-test-key")`);
});

// Captures des pages publiques (accueil, mentions légales, facture partagée, administration) : contrôle visuel, sans serveur de données.
// Usage : FRAMES_DIR=<dossier> node scripts/audit/pages.js
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..'), PORT = 8292, OUT = process.env.FRAMES_DIR || path.join(require('os').tmpdir(), 'fp-pages');
fs.mkdirSync(OUT, { recursive: true });
const T = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.css': 'text/css', '.woff2': 'font/woff2', '.mp4': 'video/mp4' };
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': T[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT);
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  for (const [label, w, h] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
    const c = await b.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block', locale: 'fr-FR', isMobile: label === 'mobile' });
    const p = await c.newPage(); p.on('pageerror', (e) => console.log('PAGEERROR', label, e.message.slice(0, 160)));
    await p.route(/googleapis|gstatic|hcaptcha|jsdelivr|supabase\.co/, (r) => r.abort());
    for (const [name, url] of [['accueil', 'index.html'], ['accueil-ar', 'index.html?lang=ar'], ['legal', 'legal.html'], ['facture-partagee', 'facture.html'], ['admin', 'admin.html']]) {
      try { await p.goto(`http://localhost:${PORT}/${url}`, { waitUntil: 'load' }); await new Promise(r => setTimeout(r, 900));
        await p.screenshot({ path: path.join(OUT, `pages-${label}-${name}.png`), fullPage: true }); } catch (e) { console.log('ERR', name, e.message.slice(0, 120)); }
    }
    await c.close();
  }
  await b.close(); srv.close(); console.log('captures →', OUT); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

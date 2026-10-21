#!/usr/bin/env node
// Sert app.html / admin.html localement en les pointant vers le projet Supabase de PRÉPRODUCTION.
// Les fichiers du dépôt ne sont pas modifiés : le remplacement se fait en mémoire.
// Usage (aucune clé n'est écrite dans un fichier ni communiquée dans un chat) :
//   export PREPROD_URL='https://<ref-preprod>.supabase.co'
//   export PREPROD_ANON_KEY='<clé « anon / publishable » du projet de préproduction>'
//   node scripts/serve-preprod.js        # puis ouvrir http://localhost:8180/app.html
const http = require('http'), fs = require('fs'), path = require('path');
const { guard } = require('./preprod-guard');
const G = guard(process.env.PREPROD_URL, process.env.PREPROD_ANON_KEY);
const URL_ = G.url, KEY = G.key;
const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };
http.createServer((q, r) => {
  const rel = decodeURIComponent(q.url.split('?')[0]); const f = path.normalize(path.join(ROOT, rel === '/' ? 'app.html' : rel));
  if (!f.startsWith(ROOT) || f.includes('node_modules') || f.includes(path.sep + '.git')) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end('404'); }
    let body = d;
    if (/(app|admin)\.html$/.test(f)) body = d.toString('utf8')
      .replace(/^const SUPABASE_URL = .*$/m, `const SUPABASE_URL = '${URL_.replace(/\/$/, '')}';`)
      .replace(/^const SUPABASE_ANON_KEY = .*$/m, `const SUPABASE_ANON_KEY = '${KEY}';`);
    r.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    r.end(body);
  });
}).listen(8180, '127.0.0.1', () => console.log('PRÉPROD → http://localhost:8180/app.html  (projet : ' + URL_ + ')'));

// Tournage de la vidéo « Votre première facture en 1 minute » (données fictives, base locale).
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('../../tests/integration/backend');
const FAKE = fs.readFileSync(path.join(R, 'tests', 'integration', 'fake_supabase.js'), 'utf8');
const PORT = 8290;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } let body = d;
    if (/(app|admin)\.html$/.test(f)) body = d.toString('utf8').replace(/^const SUPABASE_URL = .*$/m, "const SUPABASE_URL = 'https://fake.supabase.test';").replace(/^const SUPABASE_ANON_KEY = .*$/m, "const SUPABASE_ANON_KEY = 'fake-anon-key';").replace(/ integrity="[^"]*" crossorigin="anonymous"/g, '');
    const t = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.css': 'text/css' }[path.extname(f)] || 'application/octet-stream';
    r.writeHead(200, { 'content-type': t }); r.end(body); });
}).listen(PORT);
const nm = (...s) => path.join(R, 'node_modules', ...s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const OUT = process.env.FRAMES_DIR || path.join(require('os').tmpdir(), 'fp-video-frames');
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  const db = createDb({ stock: true }); const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 432, height: 768 }, deviceScaleFactor: 2.5, serviceWorkers: 'block', locale: 'fr-FR' }); const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160))); p.on('dialog', (d) => d.accept());
  await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
  await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
  // ---- prises de vue ----
  const scenes = {}; let cur = null, n = 0;
  const scene = (name) => { cur = name; scenes[name] = []; };
  const shot = async (hold, page = p) => { const f = path.join(OUT, `${String(++n).padStart(4, '0')}.jpg`); await page.screenshot({ path: f, type: 'jpeg', quality: 92 }); scenes[cur].push([f, hold]); };
  const caption = (num, txt) => p.evaluate(([num, txt]) => {
    let c = document.getElementById('__cap'); if (!c) { c = document.createElement('div'); c.id = '__cap'; document.body.appendChild(c);
      c.style.cssText = 'position:fixed;left:12px;right:12px;bottom:18px;z-index:99999;pointer-events:none;background:rgba(17,32,64,.94);color:#fff;border-radius:16px;padding:12px 16px;font:600 17px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);display:flex;gap:12px;align-items:center'; }
    c.innerHTML = num ? `<span style="flex:none;width:34px;height:34px;border-radius:50%;background:#c9a227;color:#112040;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px">${num}</span><span>${txt}</span>` : `<span>${txt}</span>`;
    c.style.display = txt ? 'flex' : 'none'; }, [num, txt]);
  const type = async (sel, text, per = 0.06, step = 2) => { for (let i = step; i < text.length + step; i += step) { await p.fill(sel, text.slice(0, i)); await shot(per); } };
  const card = async (html, hold) => { const c = await ctx.newPage(); await c.setContent(`<html><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(160deg,#112040 0%,#1d3566 70%,#2a477f 100%);color:#fff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;padding:0 28px;box-sizing:border-box">${html}</body></html>`); await sleep(300); await shot(hold, c); await c.close(); };
  const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(R, 'icon-512.png')).toString('base64');

  // ---- compte de démonstration (fictif) ----
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await p.click('[data-tab=signup]');
  await p.fill('#signupEmail', `demo-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Demo#12345'); await p.fill('#signupConfirm', 'Demo#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque Exemple'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  await p.evaluate(() => { Storage.set('guideSeen', true); Storage.set('checklistDismissed', true);
    Storage.set('products', [{ id: 'p1', name: 'Entretien machine à café', price: 1500, tva: 20, unit: 'forfait' }, { id: 'p2', name: 'Capsules café (boîte)', price: 45, tva: 20, unit: 'boîte' }]); });
  const hideToasts = () => p.addStyleTag({ content: '.toast,#toastContainer{display:none!important}' });
  await hideToasts();

  // 1. titre
  scene('s1');
  await card(`<img src="${logo}" style="width:110px;height:110px;border-radius:26px;box-shadow:0 10px 30px rgba(0,0,0,.35)"><div style="margin-top:26px;font-size:16px;letter-spacing:3px;color:#c9a227;font-weight:700">FACTURAPRO</div><div style="margin-top:14px;font-size:36px;font-weight:800;line-height:1.15">Votre première facture<br>en 1 minute</div><div style="margin-top:18px;font-size:17px;opacity:.85">Clients · Factures · Paiements · Stock</div>`, 3.6);

  // 2. client
  scene('s2');
  await p.evaluate(() => navTo('clients')); await sleep(500); await caption(1, 'Ajoutez votre client'); await shot(1.2);
  await p.evaluate(() => newClient()); await sleep(400); await shot(0.6);
  await type('#modalClientName', 'Café Nour', 0.07, 1);
  await p.fill('#modalClientICE', '001122334455667'); await p.fill('#modalClientIF', '45678912'); await p.fill('#modalClientRC', '112233 Casablanca');
  await p.fill('#modalClientAddress', '24 bd Zerktouni'); await p.fill('#modalClientCity', 'Casablanca'); await p.fill('#modalClientPhone', '06 61 00 00 00');
  await shot(1.6);
  await p.evaluate(() => saveClient()); await sleep(600); await shot(1.4);

  // 3. facture
  scene('s3');
  await p.evaluate(() => { navTo('invoices'); newInvoice(); }); await sleep(600);
  const cid = await p.evaluate(() => Storage.get('clients', [])[0].id);
  await caption(2, 'Créez la facture : les totaux se calculent seuls'); await shot(1.0);
  await p.selectOption('#editorClient', cid); await shot(0.8);
  await p.evaluate(() => { document.getElementById('itemsBody').innerHTML = ''; addItem({ description: 'Entretien machine à café', quantity: 1, price: 1500, tva: 20 }); });
  await sleep(300); await p.evaluate(() => { document.getElementById('itemsBody').scrollIntoView({ block: 'center' }); }); await shot(1.2);
  await p.evaluate(() => { addItem({ description: 'Capsules café (boîte)', quantity: 10, price: 45, tva: 20 }); if (typeof updateTotals === 'function') updateTotals(); if (typeof recalcTotals === 'function') recalcTotals(); });
  await sleep(300); await shot(1.2);
  await p.evaluate(() => { const t = document.querySelector('#totalTTC, .totals, #editorTotals') ; (t || document.getElementById('itemsBody')).scrollIntoView({ block: 'center' }); }); await sleep(200); await shot(2.0);

  // 4. émission
  scene('s4');
  await p.evaluate(async () => { await saveInvoice('sent'); }); await sleep(1500);
  await p.evaluate(() => { document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')); navTo('invoices'); }); await sleep(700);
  await caption(3, 'Émettez-la : numéro automatique, sans trou ni doublon'); await shot(2.0);
  // aperçu du PDF réel
  const fid = await p.evaluate(() => Storage.get('invoices', [])[0].id);
  const pdf = await p.evaluate(async (id) => { const r = await generatePDF(id, 'invoice', { asBlob: true }); const b = new Uint8Array(await r.blob.arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); }, fid);
  fs.writeFileSync(path.join(OUT, 'facture.pdf'), Buffer.from(pdf, 'base64'));
  require('child_process').execFileSync('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '1', path.join(OUT, 'facture.pdf'), path.join(OUT, 'facture')]);
  const pg = fs.readdirSync(OUT).find(f => /^facture.*\.png$/.test(f));
  const img = 'data:image/png;base64,' + fs.readFileSync(path.join(OUT, pg)).toString('base64');
  await card(`<div style="font-size:19px;font-weight:700;margin-bottom:16px;display:flex;gap:10px;align-items:center"><span style="width:34px;height:34px;border-radius:50%;background:#c9a227;color:#112040;display:inline-flex;align-items:center;justify-content:center;font-weight:800">4</span>Envoyez-la : WhatsApp, PDF ou 🖨️</div><img src="${img}" style="width:92%;border-radius:8px;box-shadow:0 16px 40px rgba(0,0,0,.45);background:#fff">`, 3.4);

  // 5. paiement
  scene('s5');
  await p.evaluate(() => { navTo('payments'); recordPayment(); }); await sleep(600);
  await caption(5, 'Encaissez : la facture passe « payée »'); await shot(0.8);
  await p.evaluate((id) => { document.getElementById('paymentInvoice').value = id; document.getElementById('paymentInvoice').dispatchEvent(new Event('change')); }, fid); await sleep(300);
  await p.evaluate(() => { document.getElementById('paymentMethod').value = 'virement'; document.getElementById('paymentMethod').onchange && document.getElementById('paymentMethod').onchange(); });
  await type('#paymentAmount', '2340', 0.12, 1); await shot(1.0);
  await p.evaluate(() => savePayment()); await sleep(1500);
  await p.evaluate(() => { document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active')); navTo('invoices'); }); await sleep(700); await shot(2.2);

  // 6. tableau de bord
  scene('s6');
  await p.evaluate(() => navTo('dashboard')); await sleep(900);
  await caption(6, 'Suivez tout : ventes, paiements, stock, trésorerie'); await shot(2.6);
  await p.evaluate(() => window.scrollBy(0, 300)); await sleep(300); await shot(1.4);

  // 7. fin
  scene('s7');
  await card(`<img src="${logo}" style="width:84px;height:84px;border-radius:20px"><div style="margin-top:22px;font-size:32px;font-weight:800;line-height:1.2">Essai gratuit<br>14 jours</div><div style="margin-top:14px;font-size:17px;opacity:.9">Factures conformes · ICE · TVA<br>Arabe et français</div><div style="margin-top:26px;font-size:16px;color:#c9a227;font-weight:700">facturaproma.github.io/Facturaproma</div>`, 3.6);

  fs.writeFileSync(path.join(OUT, 'scenes.json'), JSON.stringify(scenes, null, 1));
  console.log(Object.entries(scenes).map(([k, v]) => `${k}: ${v.length} images, ${v.reduce((s, x) => s + x[1], 0).toFixed(1)} s`).join('\n'));
  await browser.close(); srv.close(); dropDb(db);
})().catch((e) => { console.error(e); process.exit(1); });

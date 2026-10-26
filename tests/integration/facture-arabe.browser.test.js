// Page publique de facture (facture.html) en français / arabe : sens de lecture, libellés, bascule, langue du navigateur, erreurs, contenu hostile inerte.
// SIMULATION locale : la réponse de get_shared_invoice est fournie par le test (aucun appel réel).
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const PORT = 8235;
const srv = http.createServer((q, r) => {
  let u = '/'; try { u = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
  const f = path.resolve(R, '.' + path.posix.normalize('/' + (u === '/' ? 'index.html' : u)));
  if (f !== R && !f.startsWith(R + path.sep)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png' }[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT);
const TOKEN = 'a'.repeat(64);
const SNAP = { snapshot: { company: { name: 'Atelier Atlas SARL', ice: '001234567000089', city: 'Casablanca', rib: '007 780 0001234567890123 45', bank: 'Banque test' },
  doc: { number: 'FAC-2026-005', date: '2026-10-20', dueDate: '2026-11-20', notes: '<img src=x onerror="window.__pwn=1">' }, client: { name: "L'Atelier <b>X</b>", ice: '009', address: 'Rabat' },
  items: [{ description: 'Câble 5" HDMI <img src=x onerror="window.__pwn=1">', quantity: 2, unitPrice: 500, tva: 20, totalTTC: 1200 }], totals: { ht: 1000, tva: 200, ttc: 1200 }, payment: { state: 'partial', paid: 500, remaining: 700 } }, updated_at: '2026-10-26T10:00:00Z' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  async function open(url, locale, body) {
    const ctx = await browser.newContext({ locale: locale || 'fr-FR', viewport: { width: 420, height: 900 } }); const p = await ctx.newPage();
    await p.route('**/rpc/get_shared_invoice', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body === undefined ? SNAP : body) }));
    await p.goto(`http://localhost:${PORT}/facture.html${url}`); await sleep(600); return p;
  }
  const info = (p) => p.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang, t: document.body.innerText, pwn: window.__pwn || 0, imgs: document.querySelectorAll('main img').length, btn: document.getElementById('langbtn').textContent }));

  let p = await open(`?t=${TOKEN}`, 'fr-FR'); let i = await info(p);
  ok('navigateur français : page en français, sens gauche→droite, bouton « العربية »', i.dir === 'ltr' && i.lang === 'fr' && /Partiellement payée/.test(i.t) && /Reste à payer/.test(i.t) && i.btn === 'العربية');
  await p.click('#langbtn'); await sleep(200); i = await info(p);
  ok('bascule vers l\'arabe : sens droite→gauche, libellés arabes, aucun libellé français résiduel', i.dir === 'rtl' && i.lang === 'ar' && /فاتورة FAC-2026-005/.test(i.t) && /مدفوعة جزئيًا/.test(i.t) && /المتبقي للأداء/.test(i.t) && /التحويل البنكي/.test(i.t) && !/Reste à payer|Facturé à|Désignation|Règlement/.test(i.t) && i.btn === 'Français');
  ok('arabe : montants, société, numéro et RIB restent lisibles (valeurs de l\'émetteur inchangées)', /1\s200,00 DH/.test(i.t) && /700,00 DH/.test(i.t) && /Atelier Atlas SARL/.test(i.t) && /007 780 0001234567890123 45/.test(i.t) && /20\/10\/2026/.test(i.t));
  ok('arabe : RIB lu de gauche à droite dans l\'ordre, montant déjà payé avec son signe moins collé au montant', await p.evaluate(() => { const r = document.querySelector('.rib'); const paidLine = [...document.querySelectorAll('.tot div')].find((d) => /500,00/.test(d.textContent)); return getComputedStyle(r).direction === 'ltr' && /^\u2066− 500,00 DH\u2069$/.test(paidLine.lastChild.textContent); }));
  ok('contenu hostile (description, notes, nom client) : affiché comme texte, aucun code exécuté', i.pwn === 0 && i.imgs === 0 && /<img src=x/.test(i.t) && /<b>X<\/b>/.test(i.t));
  await p.click('#langbtn'); await sleep(200); i = await info(p);
  ok('retour au français', i.dir === 'ltr' && /Reste à payer/.test(i.t));
  await p.close();

  p = await open(`?t=${TOKEN}&lang=ar`, 'fr-FR'); i = await info(p);
  ok('?lang=ar : arabe dès l\'ouverture (lien partageable en arabe)', i.dir === 'rtl' && /مدفوعة جزئيًا/.test(i.t));
  await p.close();
  p = await open(`?t=${TOKEN}`, 'ar-MA'); i = await info(p);
  ok('navigateur en arabe : arabe par défaut', i.dir === 'rtl' && /فاتورة/.test(i.t));
  await p.close();
  p = await open(`?t=${TOKEN}&lang=fr`, 'ar-MA'); i = await info(p);
  ok('?lang=fr prime sur la langue du navigateur', i.dir === 'ltr' && /Reste à payer/.test(i.t));
  await p.close();

  // Erreurs, dans les deux langues
  p = await open('?t=court&lang=ar', 'fr-FR'); i = await info(p);
  ok('lien incomplet : message arabe', /الرابط غير متاح/.test(i.t) && /غير مكتمل/.test(i.t));
  await p.click('#langbtn'); await sleep(200); i = await info(p);
  ok('lien incomplet : bascule en français', /Lien indisponible/.test(i.t) && /incomplet/.test(i.t));
  await p.close();
  p = await open(`?t=${TOKEN}&lang=ar`, 'fr-FR', null); i = await info(p);
  ok('lien expiré / désactivé : message arabe', /لم يعد صالحًا/.test(i.t));
  await p.close();

  // Soldée : état payé en arabe
  const paid = JSON.parse(JSON.stringify(SNAP)); paid.snapshot.payment = { state: 'paid', paid: 1200, remaining: 0 };
  p = await open(`?t=${TOKEN}&lang=ar`, 'fr-FR', paid); i = await info(p);
  ok('facture soldée : statut « مسدّدة » et pas de bloc de virement', /مسدّدة/.test(i.t) && !/التحويل البنكي/.test(i.t));
  await p.close();

  await browser.close(); srv.close();
  const n = R_.filter(Boolean).length; console.log(`\n${n === R_.length ? 'OK' : 'ÉCHEC'} : ${n}/${R_.length} contrôles (facture publique FR/AR)`); process.exit(n === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

// Relevé des déductions de TVA : règlements fournisseurs du mois avec mode de paiement, IF/ICE, ventilation par taux, saisie manuelle,
// mode à compléter, impression, Excel (.xlsx) et fichier XML zippé (contrôles bloquants). SIMULATION locale.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const R = path.join(__dirname, '..', '..');
const { createDb, dropDb, makeBackend } = require('./backend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_supabase.js'), 'utf8');
const PORT = 8269;
const { execFileSync } = require('child_process');
const OUT = process.env.FRAMES_DIR || require('os').tmpdir();
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
  const db = createDb({ stock: true }); const be = makeBackend(db);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, serviceWorkers: 'block', acceptDownloads: true }); const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 160))); p.on('dialog', (d) => d.accept());
  await p.exposeFunction('__srv', (op, args) => be.handle(op, args));
  await p.route(/jsdelivr.*supabase/, (r) => r.fulfill({ body: FAKE, contentType: 'text/javascript' }));
  await p.route('**/jspdf.umd.min.js', (r) => r.fulfill({ path: nm('jspdf', 'dist', 'jspdf.umd.min.js'), contentType: 'text/javascript' }));
  await p.route('**/jspdf.plugin.autotable.min.js', (r) => r.fulfill({ path: nm('jspdf-autotable', 'dist', 'jspdf.plugin.autotable.min.js'), contentType: 'text/javascript' }));
  await p.route(/googleapis|gstatic|hcaptcha/, (r) => r.abort());
  const R_ = []; const ok = (n, c, x = '') => { R_.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n + (x ? ' ' + x : '')); };
  await p.goto(`http://localhost:${PORT}/app.html?mode=login`); await sleep(800);
  await p.click('[data-tab=signup]');
  await p.fill('#signupEmail', `rdd-${process.pid}@facturapro-test.invalid`); await p.fill('#signupPassword', 'Test#12345'); await p.fill('#signupConfirm', 'Test#12345'); await p.click('#signupBtn'); await sleep(2500);
  if (!(await p.isVisible('#mainApp'))) {
    await p.evaluate(() => selectStatus(document.querySelector('[onclick*="selectStatus"]').getAttribute('onclick').match(/'(.*?)'/)[1])); await p.evaluate(() => onboardingNext(1));
    await p.fill('#onbCompanyName', 'Atelier Atlas SARL'); await p.fill('#onbICE', '001234567000089'); await p.evaluate(() => onboardingNext(2));
    await p.fill('#onbBank', 'Banque test'); await p.fill('#onbRIB', '007 780 0001234567890123 45'); await p.evaluate(() => finishOnboarding()); await sleep(1800);
  }
  const T = await p.evaluate(() => todayISO());
  const M = T.slice(0, 7) + '-01';
  await p.evaluate(async (d0) => {
    const c = Storage.get('company', {}) || {}; c.if = '33666706'; Storage.set('company', c);
    Storage.set('fiscalPrefs', { regime: 'monthly', basis: 'paid' });
    Storage.set('suppliers', [{ id: 's1', kind: 'societe', name: 'STAR PNEUMATIQUE', if: '1620155', ice: '000094033000084' }, { id: 's2', kind: 'societe', name: 'MR BRICOLAGE', if: '', ice: '00152504500' }]);
    await supaClient.rpc('cash_account_create', { p: { key: 'r-acc', name: 'Banque', kind: 'bank', opening_balance: 50000, opening_date: d0 } });
    await supaClient.rpc('cash_account_create', { p: { key: 'r-cash', name: 'Caisse', kind: 'cash', opening_balance: 5000, opening_date: d0 } });
    const mk = async (k, sid, sname, ref, lines) => { const r = await supaClient.rpc('purchase_record', { p: { key: k, supplier_id: sid, supplier_name: sname, supplier_ref: ref, date: d0, lines } }); if (r.error) throw new Error(r.error.message); return r.data; };
    await mk('r1', 's1', 'STAR PNEUMATIQUE', 'FCSTAR-25-470', [{ nature: 'expense', category: 'Entretien et réparations', description: 'Pneus', qty: 1, unit_price: 880, tva_rate: 20 }]);
    await mk('r2', 's2', 'MR BRICOLAGE', '0032517700074', [{ nature: 'expense', category: 'Fournitures', description: 'Outillage', qty: 1, unit_price: 1000, tva_rate: 20 }, { nature: 'expense', category: 'Fournitures', description: 'Petit matériel', qty: 1, unit_price: 500, tva_rate: 10 }]);
    await mk('r3', 's1', 'STAR PNEUMATIQUE', 'NON-REGLEE', [{ nature: 'expense', category: 'Fournitures', description: 'Non réglé', qty: 1, unit_price: 300, tva_rate: 20 }]);
    await purLoad(true); await cashLoadAccounts(true);
  }, M);
  // Règlement par l'écran : virement (banque) pour STAR ; règlement de MR BRICOLAGE sans mode (ancien écran), à compléter dans le relevé
  await p.evaluate(() => openSettle(purList().find(x => x.supplierRef === 'FCSTAR-25-470').id)); await sleep(500);
  ok('règlement : mode proposé « 4-Virement » pour un compte bancaire', await p.evaluate(() => document.getElementById('stMode').value === 'virement'));
  await p.evaluate(() => { const s = document.getElementById('stAccount'); s.value = cashActive().find(a => a.kind === 'cash').id; s.dispatchEvent(new Event('change')); });
  ok('règlement : compte caisse → « 1-Espèces »', await p.evaluate(() => document.getElementById('stMode').value === 'especes'));
  await p.evaluate(() => { const s = document.getElementById('stAccount'); s.value = cashActive().find(a => a.kind === 'bank').id; s.dispatchEvent(new Event('change')); document.getElementById('stMode').value = 'prelevement'; });
  await p.evaluate(() => saveSettle()); await sleep(800);
  await p.evaluate(async () => { const pu = purList().find(x => x.supplierRef === '0032517700074'); const r = await supaClient.rpc('supplier_settle', { p: { purchase_id: pu.id, account_id: cashActive()[0].id, date: todayISO(), amount: 900 } }); if (r.error) throw new Error(r.error.message); await purLoad(true); });
  await p.evaluate(() => navTo('taxes')); await sleep(1800);
  await p.evaluate((t) => { document.getElementById('tvaYear').value = t.slice(0, 4); onVatControlChange(false); document.getElementById('tvaPeriod').value = 'M' + (parseInt(t.slice(5, 7), 10) - 1); onVatControlChange(false); }, T); await sleep(300);
  const g = () => p.evaluate(() => ({ rows: [...document.querySelectorAll('#dedBody tr')].map(t => [...t.children].map(c => (c.querySelector('select') ? 'SEL:' + c.querySelector('select').value : c.innerText.trim()))), foot: document.getElementById('dedFoot').innerText, info: document.getElementById('dedInfo').innerText, ded: document.getElementById('tvaDeductible').textContent }));
  let v = await g();
  ok('relevé : 3 lignes (STAR 1 taux, BRICOLAGE ventilé 20 % / 10 %), achat non réglé absent', v.rows.length === 3 && !JSON.stringify(v.rows).includes('NON-REGLEE'), JSON.stringify(v.rows));
  const star = v.rows.find(r => r[1].startsWith('FCSTAR'));
  ok('ligne STAR : IF, ICE, HT 880, taux 20, TVA 176, TTC 1056, mode 3-Prélèvement', star && star[5] === '1620155' && star[6] === '000094033000084' && /880,00/.test(star[7]) && star[8] === '20,00' && /176,00/.test(star[9]) && /1\s?056,00/.test(star[10]) && star[11] === 'SEL:prelevement', JSON.stringify(star));
  const bri = v.rows.filter(r => r[1].startsWith('0032517700074'));
  ok('BRICOLAGE : 900 payés ventilés au prorata (1 750 TTC : TVA 102,86 + 25,71)', bri.length === 2 && /102,86/.test(bri[0][9]) && /25,71/.test(bri[1][9]) && bri.every(r => r[11] === 'SEL:'), JSON.stringify(bri));
  ok('TVA déductible = total du relevé (176 + 128,57 = 304,57)', /304,57/.test(v.ded) && /304,57/.test(v.foot), v.ded + ' | ' + v.foot);
  ok('alertes : IF manquant, ICE invalide (cellules en rouge), mode à compléter', /2 lignes à compléter/.test(v.info) && await p.evaluate(() => document.querySelectorAll('#dedBody td.ded-bad').length === 4));
  // XML refusé tant que les erreurs ne sont pas corrigées
  await p.evaluate(() => exportDeductionsXml()); await sleep(300);
  const errs = await p.evaluate(() => document.getElementById('dedXmlErrors').innerText);
  ok('fichier XML refusé : erreurs listées (IF, ICE, mode)', /Fichier XML non créé/.test(errs) && /IF du fournisseur/.test(errs) && /ICE du fournisseur invalide/.test(errs) && /mode de paiement manquant/.test(errs), errs);
  // Compléter le mode depuis le relevé, corriger la fiche fournisseur
  await p.evaluate(() => { const s = [...document.querySelectorAll('#dedBody select.ded-mode')].find(x => !x.value); s.value = 'cheque'; s.dispatchEvent(new Event('change')); }); await sleep(800);
  v = await g();
  ok('mode complété (2-Chèque) sur le règlement : les 2 lignes de la pièce suivent', v.rows.filter(r => r[1].startsWith('0032517700074')).every(r => r[11] === 'SEL:cheque'), JSON.stringify(v.rows));
  ok('mode enregistré sur le serveur', await p.evaluate(async () => (await supaClient.rpc('vat_deduction_payments', { p_from: null, p_to: null })).data.filter(x => x.mode === 'cheque').length === 1));
  await p.evaluate(() => { const s = Storage.get('suppliers'); s[1].if = '2202961'; s[1].ice = '001525045000091'; Storage.set('suppliers', s); renderVatReport(false); }); await sleep(300);
  ok('liste d\'erreurs tenue à jour après correction (plus d\'erreur → effacée)', await p.evaluate(() => document.getElementById('dedXmlErrors').innerText === ''), await p.evaluate(() => document.getElementById('dedXmlErrors').innerText));
  // Saisie manuelle
  await p.evaluate((d) => { const f = (i, x) => { document.getElementById(i).value = x; };
    f('vpDate', d); f('vpRef', 'AV-FACT'); f('vpSupplier', 'SPAB'); f('vpIF', '18719679'); f('vpICE', '000305480000047'); f('vpDesignation', 'Achats consommables'); f('vpHT', '1000'); vpSuggestTva(); f('vpPayDate', d); }, T);
  await p.evaluate(() => addVatPurchase()); await sleep(200);
  ok('saisie manuelle sans mode refusée', await p.evaluate(() => (Storage.get('vatPurchases', []) || []).length === 0));
  ok('TVA proposée au taux choisi (20 % de 1 000 = 200)', await p.evaluate(() => document.getElementById('vpTVA').value === '200.00'));
  await p.evaluate(() => { document.getElementById('vpMode').value = 'virement'; addVatPurchase(); }); await sleep(300);
  v = await g();
  ok('saisie manuelle ajoutée au relevé : 4 lignes, plus aucune alerte, TVA 504,57', v.rows.length === 4 && v.info === '' && /504,57/.test(v.ded), JSON.stringify([v.rows.length, v.info, v.ded]));
  await p.screenshot({ path: path.join(OUT, 'releve-deductions.png'), fullPage: false, clip: await p.evaluate(() => { const r = document.getElementById('dedCard').getBoundingClientRect(); window.scrollTo(0, window.scrollY + r.top - 20); return null; }) || undefined });
  await p.evaluate(() => document.getElementById('dedCard').scrollIntoView()); await sleep(200);
  await p.screenshot({ path: path.join(OUT, 'releve-deductions.png') });
  // XML zippé
  const [dl] = await Promise.all([p.waitForEvent('download'), p.evaluate(() => exportDeductionsXml())]);
  const zf = path.join(OUT, dl.suggestedFilename()); await dl.saveAs(zf);
  const unz = (f) => JSON.parse(execFileSync('python3', ['-I', '-c', 'import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps({n:z.read(n).decode("utf-8") for n in z.namelist()}))', f]).toString());
  const zx = unz(zf), xname = Object.keys(zx)[0], xml = zx[xname];
  const per = T.slice(5, 7).replace(/^0/, '');
  ok('ZIP : un seul fichier XML, nom IF + année + période', /^releve_deductions_33666706_\d{4}_\d{2}\.zip$/.test(dl.suggestedFilename()) && Object.keys(zx).length === 1 && xname === dl.suggestedFilename().replace('.zip', '.xml'), dl.suggestedFilename() + ' ' + Object.keys(zx));
  ok('XML : en-tête société / année / période / régime mensuel', xml.includes('<identifiantFiscal>33666706</identifiantFiscal>') && xml.includes('<annee>' + T.slice(0, 4) + '</annee>') && xml.includes('<periode>' + per + '</periode>') && xml.includes('<regime>1</regime>'));
  ok('XML : 4 lignes rd, STAR avec mp 3, TVA 176.00, dpai/dfac ISO', (xml.match(/<rd>/g) || []).length === 4 && /<num>FCSTAR-25-470<\/num><des>Charges : Entretien et réparations<\/des><mht>880.00<\/mht><tva>176.00<\/tva><ttc>1056.00<\/ttc><refF><if>1620155<\/if><nom>STAR PNEUMATIQUE<\/nom><ice>000094033000084<\/ice><\/refF><tx>20.00<\/tx><mp><id>3<\/id><\/mp><dpai>\d{4}-\d{2}-\d{2}<\/dpai><dfac>\d{4}-\d{2}-01<\/dfac>/.test(xml), xml.slice(0, 900));
  // Excel
  const [dx] = await Promise.all([p.waitForEvent('download'), p.evaluate(() => exportDeductionsXlsx())]);
  const xf = path.join(OUT, dx.suggestedFilename()); await dx.saveAs(xf);
  const xz = unz(xf);
  ok('Excel : classeur .xlsx valide (5 parties), ICE en texte, HT en nombre', /\.xlsx$/.test(xf) && ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'].every(n => n in xz)
    && /<t xml:space="preserve">000094033000084<\/t>/.test(xz['xl/worksheets/sheet1.xml']) && /<c r="H5" s="2"><v>[\d.]+<\/v><\/c>/.test(xz['xl/worksheets/sheet1.xml']), Object.keys(xz).join(','));
  // Déduction tardive : règlement du mois précédent non déclaré, repris sur ce mois ; puis période marquée déclarée
  const PM = await p.evaluate((m) => dedShiftMonths(m, -1), M);
  await p.evaluate(async (d) => {
    const r = await supaClient.rpc('purchase_record', { p: { key: 'r-old', supplier_id: 's1', supplier_name: 'STAR PNEUMATIQUE', supplier_ref: 'FC-ANCIENNE', date: d, lines: [{ nature: 'expense', category: 'Fournitures', description: 'Ancien', qty: 1, unit_price: 500, tva_rate: 20 }] } });
    if (r.error) throw new Error(r.error.message);
    const acc = cashActive().find(a => a.kind === 'bank').id;
    const s2 = await supaClient.rpc('supplier_settle', { p: { purchase_id: r.data.id, account_id: acc, date: dedShiftMonths(d, 0).slice(0, 8) + '15', amount: 600, mode: 'virement' } });
    if (s2.error) throw new Error(s2.error.message);
    await purLoad(true); await dedLoad(true); renderVatReport(false);
  }, PM); await sleep(400);
  const lateTxt = () => p.evaluate(() => { const d = document.querySelector('#dedLate details'); if (d) d.open = true; return document.getElementById('dedLate').innerText; });
  ok('paiement du mois précédent proposé (période non marquée, TVA 100)', /Paiements antérieurs non déclarés : 1/.test(await lateTxt()) && /Période non marquée/.test(await lateTxt()) && /FC-ANCIENNE/.test(await lateTxt()), await lateTxt());
  await p.evaluate(() => dedIncludeLate(null)); await sleep(300);
  v = await g();
  ok('repris sur ce mois : 5 lignes, badge « Déduction tardive », TVA 604,57', v.rows.length === 5 && v.rows.some(r => /FC-ANCIENNE[\s\S]*Déduction tardive/.test(r[1])) && /604,57/.test(v.ded) && (await lateTxt()) === '', JSON.stringify([v.rows.length, v.ded]));
  ok('mois précédent : la ligne reprise n\'y est plus comptée', await p.evaluate((pm) => { const per = vatPeriods('monthly', parseInt(pm.slice(0, 4), 10)).find(x => x.start === pm); return dedCompute(per).rows.length === 0; }, PM));
  await p.evaluate(() => dedMarkDeclared()); await sleep(300);
  ok('période marquée déclarée : bandeau, 5 lignes figées, bouton d\'ajout masqué', await p.evaluate(() => /Période déclarée le/.test(document.getElementById('dedStatus').innerText) && /5 ligne\(s\)/.test(document.getElementById('dedStatus').innerText)
    && Object.values(Storage.get('vatDeclarations')).length === 1 && !document.querySelector('#dedBody button[onclick^="dedRemoveLate"]')));
  // Règlement saisi après la déclaration : signalé, exclu des exports de la période, proposé le mois suivant
  await p.evaluate(async () => { const pu = purList().find(x => x.supplierRef === 'NON-REGLEE'); const r = await supaClient.rpc('supplier_settle', { p: { purchase_id: pu.id, account_id: cashActive().find(a => a.kind === 'bank').id, date: todayISO(), amount: 360, mode: 'cheque' } }); if (r.error) throw new Error(r.error.message); await purLoad(true); await dedLoad(true); renderVatReport(false); }); await sleep(300);
  ok('règlement après déclaration : « Non déclaré », hors du fichier de la période', await p.evaluate(() => document.querySelectorAll('#dedBody tr.ded-new').length === 1 && /Non déclaré/.test(document.getElementById('dedBody').innerText)
    && (() => { const c = dedCurrent(); return c.rel.rows.length === 5 && !c.rel.rows.some(r => r.facture === 'NON-REGLEE'); })()));
  ok('mois suivant : seul le règlement non déclaré est proposé (omis)', await p.evaluate((m) => { const nx = dedShiftMonths(m, 1), per = vatPeriods('monthly', parseInt(nx.slice(0, 4), 10)).find(x => x.start === nx);
    const r = dedCompute(per); return r.candidates.length === 1 && r.candidates[0].facture === 'NON-REGLEE' && r.candidates[0].homeDeclared; }, M));
  await p.evaluate(() => dedUnmarkDeclared()); await sleep(200);
  ok('marquage annulé : plus de période déclarée', await p.evaluate(() => Object.keys(Storage.get('vatDeclarations') || {}).length === 0 && /Marquer la période comme déclarée/.test(document.getElementById('dedStatus').innerText)));
  await p.evaluate(() => document.getElementById('dedCard').scrollIntoView()); await sleep(200);
  await p.screenshot({ path: path.join(OUT, 'releve-deductions-tardives.png'), fullPage: false });
  // Impression
  await p.evaluate(() => { window.__printed = 0; HTMLIFrameElement.prototype.__p = 1; });
  await p.evaluate(() => printDeductions()); await sleep(1200);
  ok('impression : PDF paysage préparé dans un cadre d\'impression', await p.evaluate(() => !!document.querySelector('iframe.fp-print')));
  // Hors période : rien
  ok('autre mois : relevé vide', await p.evaluate(() => { const s = document.getElementById('tvaPeriod'); for (const o of s.options) { s.value = o.value; renderVatReport(false); if (/Aucune facture payée/.test(document.getElementById('dedBody').innerText)) return true; } return false; }));

  const nOk = R_.filter(Boolean).length;
  console.log(`${nOk === R_.length ? 'OK' : 'ECHEC'} : ${nOk}/${R_.length} contrôles (relevé des déductions, SIMULATION locale)`);
  await browser.close(); srv.close(); dropDb(db); process.exit(nOk === R_.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });

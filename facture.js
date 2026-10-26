// Page publique d'une facture partagée (lien client). Aucune connexion requise : le jeton du lien (?t=…) est la seule clé.
// Sécurité : tout le contenu reçu est inséré avec textContent (jamais innerHTML) ; CSP stricte dans facture.html ; aucun cookie, aucun stockage.
const SUPABASE_URL = 'https://mdozjptoecygmpkjlohr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1kb3pqcHRvZWN5Z21wa2psb2hyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MjE2MzUsImV4cCI6MjA5Mjk5NzYzNX0.Q9D4NV_1NiGq7b9vbViT4iBJM7HMOYk5e8QrfhkZ9-Q';

(function () {
  'use strict';
  var root = document.getElementById('root');

  // Français (par défaut) / arabe. Aucun stockage : la langue vient de ?lang=ar|fr, sinon de la langue du navigateur, et du bouton.
  var T = {
    fr: { loading: 'Chargement…', toggle: 'العربية', company: 'Société', invoice: 'Facture', issued: 'Émise le', due: 'Échéance : ', billedTo: 'Facturé à',
      desc: 'Désignation', qty: 'Qté', unit: 'P.U. HT', vat: 'TVA', ttc: 'Total TTC', ht: 'Total HT', paid: 'Déjà payé', remaining: 'Reste à payer',
      transfer: 'Règlement par virement', ref1: 'Merci d’indiquer « ', ref2: ' » comme référence du virement.', notes: 'Notes', print: 'Imprimer / Enregistrer en PDF',
      st: { paid: 'Soldée', partial: 'Partiellement payée', none: 'À régler', overdue: 'En retard' }, as: 'Situation au ', copy: '. Copie de consultation : en cas de doute, la facture envoyée par ',
      copy2: ' fait foi.', issuer: 'l’émetteur', made: 'Établie avec FacturaPro', unavailable: 'Lien indisponible',
      eIncomplete: 'Ce lien est incomplet. Demandez-en un nouveau à l’émetteur de la facture.', eInvalid: 'Ce lien n’est plus valide (expiré ou désactivé). Demandez-en un nouveau à l’émetteur de la facture.',
      eNet: 'Impossible de charger la facture pour le moment. Vérifiez votre connexion puis réessayez.', locale: 'fr-FR' },
    ar: { loading: 'جارٍ التحميل…', toggle: 'Français', company: 'الشركة', invoice: 'فاتورة', issued: 'تاريخ الإصدار', due: 'تاريخ الاستحقاق: ', billedTo: 'الفاتورة موجّهة إلى',
      desc: 'البيان', qty: 'الكمية', unit: 'الثمن دون ض.ق.م', vat: 'ض.ق.م', ttc: 'المجموع بجميع الرسوم', ht: 'المجموع دون الضريبة', paid: 'المبلغ المؤدّى', remaining: 'المتبقي للأداء',
      transfer: 'الأداء عن طريق التحويل البنكي', ref1: 'المرجو ذكر «', ref2: '» كمرجع للتحويل.', notes: 'ملاحظات', print: 'طباعة / حفظ بصيغة PDF',
      st: { paid: 'مسدّدة', partial: 'مدفوعة جزئيًا', none: 'في انتظار الأداء', overdue: 'متأخرة' }, as: 'الوضعية بتاريخ ', copy: '. هذه نسخة للاطلاع فقط: في حال الشك، تُعتمد الفاتورة التي أرسلها ',
      copy2: '.', issuer: 'المُصدِر', made: 'أُنجزت بواسطة FacturaPro', unavailable: 'الرابط غير متاح',
      eIncomplete: 'هذا الرابط غير مكتمل. اطلب رابطًا جديدًا من مُصدِر الفاتورة.', eInvalid: 'هذا الرابط لم يعد صالحًا (انتهت صلاحيته أو تم تعطيله). اطلب رابطًا جديدًا من مُصدِر الفاتورة.',
      eNet: 'تعذّر تحميل الفاتورة حاليًا. تحقّق من اتصالك بالإنترنت ثم أعد المحاولة.', locale: 'fr-FR' }   // chiffres latins (usage courant au Maroc)
  };
  var lang = 'fr';
  try {
    var q = (new URLSearchParams(location.search).get('lang') || '').toLowerCase();
    lang = (q === 'ar' || q === 'fr') ? q : (/^ar/i.test(navigator.language || '') ? 'ar' : 'fr');
  } catch (e) { lang = 'fr'; }
  function tr() { return T[lang]; }
  var redraw = null;
  function applyLang() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    if (redraw) redraw();
    var b = document.getElementById('langbtn'); if (b) b.textContent = tr().toggle;
  }
  (function () {
    var bar = document.createElement('div'); bar.className = 'langbar';
    var b = document.createElement('button'); b.type = 'button'; b.id = 'langbtn'; b.className = 'langbtn'; b.textContent = tr().toggle;
    b.addEventListener('click', function () { lang = lang === 'ar' ? 'fr' : 'ar'; applyLang(); });
    bar.appendChild(b); root.parentNode.insertBefore(bar, root);
  })();

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function str(v, max) { return (v === undefined || v === null) ? '' : String(v).slice(0, max || 500); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function money(v, sign) { return '\u2066' + (sign || '') + num(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' DH\u2069'; }   // isolat gauche→droite : « 1 234,50 DH » reste lisible en arabe
  function date(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(iso, 40));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }
  function show(node) { root.textContent = ''; root.appendChild(node); }
  function failure(key) {
    redraw = function () {
      var c = el('div', 'card err');
      c.appendChild(el('h1', '', tr().unavailable));
      c.appendChild(el('p', 'muted', tr()[key]));
      show(c);
    };
    redraw();
  }
  function kv(parent, label, value) { if (value) { var d = el('div'); d.appendChild(el('span', 'muted', label + ' ')); d.appendChild(el('span', '', value)); parent.appendChild(d); } }

  function render(res) {
    var L = tr();
    var s = res.snapshot || {}, co = s.company || {}, doc = s.doc || {}, cl = s.client || {}, items = Array.isArray(s.items) ? s.items.slice(0, 300) : [], t = s.totals || {}, pay = s.payment || {};
    var frag = document.createDocumentFragment();

    // En-tête : société + numéro + statut
    var head = el('div', 'card');
    var r1 = el('div', 'row');
    var left = el('div');
    left.appendChild(el('h1', '', str(co.name, 120) || L.company));
    ['ICE', 'IF', 'RC'].forEach(function (k) { var v = str(co[k.toLowerCase()], 40); if (v) left.appendChild(el('div', 'muted', k + ' : ' + v)); });
    var adr = [str(co.address, 200), str(co.city, 80)].filter(Boolean).join(', ');
    if (adr) left.appendChild(el('div', 'muted', adr));
    var ct = [str(co.phone, 40), str(co.email, 120)].filter(Boolean).join(' · ');
    if (ct) left.appendChild(el('div', 'muted', ct));
    r1.appendChild(left);
    var right = el('div');
    right.className = 'end';
    right.appendChild(el('h1', '', L.invoice + ' ' + str(doc.number, 60)));
    var st = str(pay.state, 20), label = L.st[st];
    if (label) right.appendChild(el('span', 'pill ' + (/^(paid|partial|none|overdue)$/.test(st) ? st : 'none'), label));
    if (date(doc.date)) right.appendChild(el('div', 'muted', L.issued + (lang === 'ar' ? ': ' : ' ') + date(doc.date)));
    if (date(doc.dueDate)) right.appendChild(el('div', 'muted', L.due + date(doc.dueDate)));
    r1.appendChild(right);
    head.appendChild(r1);
    frag.appendChild(head);

    // Client
    var cc = el('div', 'card');
    cc.appendChild(el('h2', '', L.billedTo));
    cc.appendChild(el('strong', '', str(cl.name, 150) || '—'));
    if (str(cl.ice, 40)) cc.appendChild(el('div', 'muted', 'ICE : ' + str(cl.ice, 40)));
    if (str(cl.address, 250)) cc.appendChild(el('div', 'muted', str(cl.address, 250)));
    frag.appendChild(cc);

    // Lignes
    var lc = el('div', 'card');
    var tbl = el('table');
    var thead = el('thead'), htr = el('tr');
    [L.desc, L.qty, L.unit, L.vat, L.ttc].forEach(function (h, i) { var th = el('th', i === 2 || i === 3 ? 'hide-sm' : '', h); htr.appendChild(th); });
    thead.appendChild(htr); tbl.appendChild(thead);
    var tb = el('tbody');
    items.forEach(function (it) {
      var tr = el('tr');
      tr.appendChild(el('td', '', str(it.description, 300)));
      tr.appendChild(el('td', '', num(it.quantity).toLocaleString('fr-FR')));
      tr.appendChild(el('td', 'hide-sm', money(it.unitPrice)));
      tr.appendChild(el('td', 'hide-sm', num(it.tva) + ' %'));
      tr.appendChild(el('td', '', money(it.totalTTC)));
      tb.appendChild(tr);
    });
    tbl.appendChild(tb); lc.appendChild(tbl);
    var tot = el('div', 'tot');
    function line(l, v, cls) { var d = el('div', cls || ''); d.appendChild(el('span', '', l)); d.appendChild(el('span', '', v)); tot.appendChild(d); }
    line(L.ht, money(t.ht)); line(L.vat, money(t.tva)); line(L.ttc, money(t.ttc), 'big');
    if (num(pay.paid) > 0) line(L.paid, money(pay.paid, '− '));
    if (st !== 'paid') line(L.remaining, money(pay.remaining !== undefined ? pay.remaining : t.ttc), 'due'); else line(L.remaining, money(0));
    lc.appendChild(tot);
    frag.appendChild(lc);

    // Règlement
    if (st !== 'paid' && (str(co.rib, 60) || str(co.bank, 120))) {
      var pc = el('div', 'card');
      pc.appendChild(el('h2', '', L.transfer));
      if (str(co.bank, 120)) pc.appendChild(el('div', '', str(co.bank, 120)));
      if (str(co.rib, 60)) pc.appendChild(el('div', 'rib', str(co.rib, 60)));
      pc.appendChild(el('div', 'muted', L.ref1 + str(doc.number, 60) + L.ref2));
      frag.appendChild(pc);
    }
    if (str(doc.notes, 1000)) { var nc = el('div', 'card'); nc.appendChild(el('h2', '', L.notes)); nc.appendChild(el('div', '', str(doc.notes, 1000))); nc.lastChild.style.whiteSpace = 'pre-wrap'; frag.appendChild(nc); }

    var btn = el('button', '', L.print);
    btn.type = 'button';
    btn.addEventListener('click', function () { window.print(); });
    frag.appendChild(btn);

    var f = el('footer');
    var asOf = date(str(res.updated_at, 40));
    f.appendChild(el('div', '', L.as + (asOf || date(str(s.asOf, 40))) + L.copy + (str(co.name, 120) || L.issuer) + L.copy2));
    f.appendChild(el('div', 'noprint', L.made));
    frag.appendChild(f);

    document.title = L.invoice + ' ' + str(doc.number, 60) + (co.name ? ' — ' + str(co.name, 80) : '');
    root.textContent = '';
    root.appendChild(frag);
  }

  document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  root.firstChild && (root.firstChild.textContent = tr().loading);
  var token = '';
  try { token = (new URLSearchParams(location.search).get('t') || '').trim(); } catch (e) { token = ''; }
  if (!/^[0-9a-f]{64}$/.test(token)) { failure('eIncomplete'); return; }

  fetch(SUPABASE_URL + '/rest/v1/rpc/get_shared_invoice', {
    method: 'POST',
    headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_token: token }),
    referrerPolicy: 'no-referrer', cache: 'no-store', credentials: 'omit'
  }).then(function (r) {
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }).then(function (data) {
    if (!data || !data.snapshot) { failure('eInvalid'); return; }
    redraw = function () { render(data); };
    applyLang();
  }).catch(function () {
    failure('eNet');
  });
})();

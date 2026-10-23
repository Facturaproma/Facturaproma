// Codes générés : totaux par jour / par mois / par administrateur (y compris ceux venant de « Nouvelles demandes »).
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', '21_tracabilite_codes.sql'), 'utf8');
const cut = (from, to) => { const a = html.indexOf(from), b = html.indexOf(to, a); assert(a > 0 && b > a, 'bloc introuvable : ' + from); return html.slice(a, b); };
const t = (n, c) => { assert(c, n); console.log('PASS ' + n); };
const src = cut('function getDateRange(period, ids) {', 'function onReportPeriodChange') + cut('function isInRange(dateStr, range) {', 'function renderReports()') + cut('function codesGenStats', 'function renderCodesGenerated');
const api = new Function('document', src + '\nreturn { codesGenStats, getDateRange };')({ getElementById: () => null });
const now = new Date(2026, 9, 23, 12, 0, 0);
const iso = (m, d, h = 10) => new Date(2026, m - 1, d, h).toISOString();
const codes = [
  { created_at: iso(10, 23), created_by: 'a@x.com', note: 'Auto-généré depuis demande ab12cd34' },
  { created_at: iso(10, 23, 15), created_by: 'a@x.com', note: '' },
  { created_at: iso(10, 22), created_by: 'B@x.com', note: 'Auto-généré depuis demande 99' },
  { created_at: iso(9, 30), created_by: null, note: '' },
  { created_at: iso(9, 5), created_by: 'a@x.com', note: '' }
];
const all = api.codesGenStats(codes, null, now);
t('total, aujourd\'hui et ce mois', all.total === 5 && all.today === 2 && all.month === 3);
t('par jour (récent d\'abord)', all.byDay[0].key === '2026-10-23' && all.byDay[0].count === 2 && all.byDay[1].key === '2026-10-22' && all.byDay.length === 4);
t('par mois', all.byMonth[0].key === '2026-10' && all.byMonth[0].count === 3 && all.byMonth[1].key === '2026-09' && all.byMonth[1].count === 2);
const a = all.byAdmin.find(x => x.admin === 'a@x.com'), b = all.byAdmin.find(x => x.admin === 'b@x.com'), u = all.byAdmin.find(x => x.admin === 'inconnu');
t('par administrateur : les codes de « Nouvelles demandes » sont comptés (origine séparée)', a.count === 3 && a.demande === 1 && a.manuel === 2 && b.count === 1 && b.demande === 1);
t('auteur absent (anciens codes) => « inconnu »', u && u.count === 1);
const oct = api.codesGenStats(codes, api.getDateRange('custom', { from: 'x', to: 'y' }) && { start: new Date(2026, 9, 1), end: new Date(2026, 9, 31, 23, 59, 59) }, now);
t('la période filtre les totaux', oct.total === 3 && oct.byMonth.length === 1);
t('interface : carte « Codes générés » dans les rapports, branchée sur la période', /id="codesGenCard"/.test(html) && /renderCodesGenerated\(range\);/.test(html) && /id="cgByDay"/.test(html) && /id="cgByMonth"/.test(html) && /id="cgByAdmin"/.test(html));
t('journal : libellés des codes générés / révoqués / supprimés', /code_generated: '🎟️ Code généré'/.test(html) && /code_revoked/.test(html) && /code_deleted/.test(html));
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
t('SQL : auteur imposé, journal, verrou, pas de code complet dans le journal', /NEW\.created_by := COALESCE\(lower\(v_email\), 'sql'\)/.test(code) && /'code_generated'/.test(code) && /code verrouillé/.test(code) && /right\(r\.code, 4\)/.test(code) && !/'code', r\.code/.test(code));
t('SQL : aucune donnée existante modifiée', !/UPDATE public\.admin_codes|DELETE FROM public\.admin_codes|DROP TABLE|TRUNCATE/.test(code));
console.log('OK');

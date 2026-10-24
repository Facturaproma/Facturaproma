// RÉPÉTITION LOCALE du script de préproduction (scripts/preprod-paiements-validation.js) sur une base PostgreSQL jetable : SIMULATION, ni Supabase ni préproduction.
// Vérifie les 4 phases, le retour arrière, et les refus (production, absence d'autorisation, absence de connexion).
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const R = path.join(__dirname, '..', '..');
const DB = 'fp_rehearsal_' + process.pid;
const ps = (db, a) => execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', db, ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
const res = []; const ck = (n, ok, x = '') => { res.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok || !x ? '' : ' -> ' + String(x).slice(0, 400))); };
const run = (args, env = {}) => spawnSync('node', [path.join(R, 'scripts', 'preprod-paiements-validation.js'), ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
try {
  ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`, '-c', `CREATE DATABASE ${DB}`]); ps(DB, ['-f', path.join(R, 'tests/sql/stub_supabase.sql')]);
  for (const f of ['00_setup_complet', '05_admins', '06_securite_rls', '07_licence_serveur', '08_admin_comptes', '09_periode_de_grace', '10_anti_abus', '12_admin_supprimer_compte', '13_profil_assistant', '14_numerotation_et_verrouillage', '19_journal_sans_doublons', '18_contact_public']) ps(DB, ['-f', path.join(R, 'sql', f + '.sql')]);
  ps(DB, ['-c', 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated']);
  for (const f of ['15_documents', '16_migration_donnees', '17_mode_stockage']) ps(DB, ['-f', path.join(R, 'sql', f + '.sql')]);
  ps(DB, ['-c', "GRANT ALL ON public.user_data, public.licenses TO authenticated; GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated; CREATE TABLE public._fp_env(id int PRIMARY KEY, env text, project_ref text); INSERT INTO public._fp_env VALUES (1,'preprod','njjaomichdlnoscrnxlz')"]);
  const L = { LOCAL_REHEARSAL: '1', REHEARSAL_DB: DB };
  const ph = (p, a = []) => { const r = run([p, ...a], L); return { ok: r.status === 0, text: r.stdout + r.stderr }; };
  let r = ph('precheck'); ck('précontrôle (lecture seule) : tout réussi', r.ok && /8\/8/.test(r.text), r.text.slice(-300));
  r = ph('install'); ck('installation de sql/25 + sql/26 : droits conservés, définition précédente sauvegardée', r.ok && /5\/5/.test(r.text), r.text.slice(-300));
  r = ph('test'); ck('essais sur comptes jetables : tous les contrôles du plafond (documents + legacy) réussis', r.ok && !/FAIL|ÉCHEC/.test(r.text) && /plafond legacy \(sql\/26\)/.test(r.text) && /\d+\/\d+ contrôles réussis/.test(r.text), r.text.slice(-400));
  r = ph('cleanup', ['--rollback']); ck('nettoyage + retour arrière de record_payment (empreinte sql/15 retrouvée) + retrait sql/26', r.ok && /record_payment restauré/.test(r.text) && /sql\/26 retiré/.test(r.text) && /table de sauvegarde retirée/.test(r.text) && /6\/6/.test(r.text), r.text.slice(-300));
  const left = execFileSync('psql', ['-At', '-d', DB, '-c', "SELECT count(*) FROM auth.users WHERE email LIKE 'pay-%'"]).toString().trim();
  ck('aucun compte de test restant', left === '0', left);
  let x = run(['install'], {}); ck('REFUS sans autorisation (ops/preprod-paiements.json non autorisé), code 2', x.status === 2 && /REFUS/.test(x.stderr), x.stderr);
  x = run(['precheck'], { PREPROD_DB_URL: 'postgresql://postgres.mdozjptoecygmpkjlohr:x@aws-1-eu-north-1.pooler.supabase.com:5432/postgres' }); ck('REFUS d\'une URL de PRODUCTION (aucune connexion tentée)', x.status !== 0 && /PRODUCTION/.test(x.stderr), x.stderr);
  x = run(['precheck'], { PREPROD_DB_URL: 'postgresql://postgres.abcdefghijklmnopqrst:x@aws-1-eu-north-1.pooler.supabase.com:5432/postgres' }); ck('REFUS d\'un projet inconnu', x.status !== 0 && /non autorisé/.test(x.stderr), x.stderr);
  x = run(['precheck'], { PREPROD_DB_URL: '' }); ck('REFUS sans connexion', x.status !== 0 && /absent/.test(x.stderr), x.stderr);
} catch (e) { ck('exécution', false, e.stack); }
try { ps('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]); } catch (e) {}
const f = res.filter((x) => !x).length; console.log(`\n${res.length - f}/${res.length} contrôles (RÉPÉTITION LOCALE, PAS Supabase)`); process.exit(f ? 1 : 0);

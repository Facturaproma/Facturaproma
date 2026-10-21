# Rapport préproduction — run 39686029618 — action install — commit 50669ee590457d046ee1d9bb9457252f9d3afffc

### install

```
Cible vérifiée : projet njjaomichdlnoscrnxlz (préproduction) — commande « install »
Base vide confirmée : marqueur « préproduction / njjaomichdlnoscrnxlz » posé.
✔ 00_setup_complet.sql : appliqué en 590 ms (sha256 e5ec7d744641)
✔ 05_admins.sql : appliqué en 530 ms (sha256 9b7e433e985a)
✔ 06_securite_rls.sql : appliqué en 539 ms (sha256 01fa6be434ea)
✔ 07_licence_serveur.sql : appliqué en 551 ms (sha256 0e2a5e0b481f)
✔ 08_admin_comptes.sql : appliqué en 546 ms (sha256 ec46318b7fd3)
✔ 09_periode_de_grace.sql : appliqué en 526 ms (sha256 ee89f91ccf2a)
✔ 10_anti_abus.sql : appliqué en 537 ms (sha256 88565440d64a)
✔ 12_admin_supprimer_compte.sql : appliqué en 520 ms (sha256 51fb509713be)
✔ 13_profil_assistant.sql : appliqué en 617 ms (sha256 22e7b9e82137)
✔ 14_numerotation_et_verrouillage.sql : appliqué en 558 ms (sha256 a5a48df0e9e6)
```

### postcheck

```
Cible vérifiée : projet njjaomichdlnoscrnxlz (préproduction) — commande « postcheck »
PASS les 10 scripts du manifeste sont enregistrés
PASS next_doc_number(text,int) existe
PASS RLS activée sur toutes les tables de public
INFO droits de table accordés à anon (protégés par la RLS) : _fp_env, _fp_migrations, doc_counters, doc_events, user_data
PASS fonctions SECURITY DEFINER : search_path fixé
PASS aucune fonction SECURITY DEFINER exécutable par anon
PASS aucune fonction de déclencheur exécutable par anon/authenticated
PASS doc_counters : écriture directe impossible pour authenticated
PASS doc_events : écriture directe impossible pour authenticated
PASS next_doc_number non exécutable par anon, exécutable par authenticated
PASS déclencheurs de verrouillage présents sur user_data
PASS my_license() (création paresseuse de l'essai) existe et n'est pas exécutable par anon
PASS aucun compte utilisateur hors comptes de test

Tous les contrôles de sécurité réussis
```

### status

```
Cible vérifiée : projet njjaomichdlnoscrnxlz (préproduction) — commande « status »
{
 "marqueur": {
  "env": "preprod",
  "project_ref": "njjaomichdlnoscrnxlz"
 },
 "migrations": [
  {
   "name": "00_setup_complet.sql",
   "sha": "e5ec7d744641",
   "applied_at": "2026-10-21T22:22:50.784Z"
  },
  {
   "name": "05_admins.sql",
   "sha": "9b7e433e985a",
   "applied_at": "2026-10-21T22:22:51.505Z"
  },
  {
   "name": "06_securite_rls.sql",
   "sha": "01fa6be434ea",
   "applied_at": "2026-10-21T22:22:52.165Z"
  },
  {
   "name": "07_licence_serveur.sql",
   "sha": "0e2a5e0b481f",
   "applied_at": "2026-10-21T22:22:52.834Z"
  },
  {
   "name": "08_admin_comptes.sql",
   "sha": "ec46318b7fd3",
   "applied_at": "2026-10-21T22:22:53.515Z"
  },
  {
   "name": "09_periode_de_grace.sql",
   "sha": "ee89f91ccf2a",
   "applied_at": "2026-10-21T22:22:54.195Z"
  },
  {
   "name": "10_anti_abus.sql",
   "sha": "88565440d64a",
   "applied_at": "2026-10-21T22:22:54.849Z"
  },
  {
   "name": "12_admin_supprimer_compte.sql",
   "sha": "51fb509713be",
   "applied_at": "2026-10-21T22:22:55.514Z"
  },
  {
   "name": "13_profil_assistant.sql",
   "sha": "22e7b9e82137",
   "applied_at": "2026-10-21T22:22:56.165Z"
  },
  {
   "name": "14_numerotation_et_verrouillage.sql",
   "sha": "a5a48df0e9e6",
   "applied_at": "2026-10-21T22:22:56.912Z"
  }
 ],
 "comptes": 0
}
```

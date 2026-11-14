# 🇲🇦 FacturaPro

> Logiciel de facturation pensé pour le Maroc : Auto-Entrepreneurs, Freelances et petites entreprises. FacturaPro n'est pas certifié par la DGI et ne prend pas en charge la facturation électronique DGI pour le moment.

[![Status](https://img.shields.io/badge/status-pré--lancement-orange)]()
[![Made in Morocco](https://img.shields.io/badge/Made%20in-Morocco%20🇲🇦-red)]()
[![Stack](https://img.shields.io/badge/stack-HTML%20%2B%20Supabase-blue)]()

---

## 🚀 Démo en ligne

- 🏠 **Landing** : [facturaproma.github.io/Facturaproma](https://facturaproma.github.io/Facturaproma/)
- 💼 **Application** : [facturaproma.github.io/Facturaproma/app.html](https://facturaproma.github.io/Facturaproma/app.html)

---

## ✨ Fonctionnalités

### Pour les utilisateurs
- 📄 **Factures avec les mentions usuelles** (ICE, IF, RC, CNSS, Patente), numérotation attribuée par le serveur, facture émise non modifiable (correction par avoir)
- 📋 **Devis convertibles** en facture en 1 clic
- 👥 **Base clients** complète avec ICE et historique
- 📦 **Catalogue produits/services** réutilisable
- 🏥 **Aide au calcul de la cotisation** (1% services / 0,5% commerce) : indicatif, à confirmer avec votre comptable
- 💰 **Aide au suivi fiscal** : TVA collectée, récapitulatifs (indicatif, pas un avis fiscal)
- 💳 **Module Paiements** avec stats et historique
- 🔔 **Relances guidées** en 3 niveaux (J+7, J+15, J+30) : le texte est préparé, l'envoi est manuel (copie ou e-mail)
- 📊 **Dashboard** avec graphique CA 12 mois
- 📥 **Export PDF** (français et arabe), exports CSV / comptable et export JSON complet des données
- 🌍 **Support multi-statuts** : AE, Freelance, SARL, Autre
- ⏰ **Période d'essai 30 jours** (full access)

### Pour l'admin
- 📊 **Dashboard temps réel** avec stats
- 📥 **Gestion des demandes d'abonnement**
- 🎁 **Génération de codes de licence** en 1 clic
- 💳 **Suivi des paiements reçus**
- 📱 **Messages WhatsApp / e-mail préparés** (envoi manuel)
- 🔑 **Connexion via Supabase Auth** (e-mail confirmé, aucun mot de passe stocké dans le code ni dans la base)

---

## 🏗️ Architecture

```
FacturaPro/
├── index.html              # Landing page (vitrine)
├── app.html                # Application principale
├── admin.html              # Backoffice admin
└── docs/                   # Documentation publique
```

Ce dépôt ne contient que le site publié. Les scripts SQL, les tests et les procédures d'exploitation ne sont pas publiés.

### Stack technique
- **Frontend** : HTML5 + CSS3 + JavaScript (vanilla)
- **Backend** : Supabase (PostgreSQL + Auth + Realtime)
- **PDF** : jsPDF + AutoTable
- **Hosting** : GitHub Pages (branche `main`, racine du dépôt)

---

## 🚀 Déploiement

### 1. Base de données

Le site s'appuie sur un projet [Supabase](https://supabase.com) (PostgreSQL + Auth). Le schéma, les règles d'accès (RLS) et les fonctions serveur sont gérés hors de ce dépôt.

### 2. Configurer les credentials

Dans `app.html` et `admin.html`, remplace :

```javascript
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

### 3. Publier le site

Le site est publié par GitHub Pages depuis la branche `main` (racine du dépôt) : chaque fusion sur `main` est mise en ligne automatiquement.

---

## 📚 Documentation

- 📖 [Guide de déploiement complet](docs/DEPLOY.md)
- 🚀 [Plan de lancement](docs/PLAN_LANCEMENT.md)

---

## 💰 Pricing

| Plan | Prix | Description |
|------|------|-------------|
| 📅 **Mensuel** | 49 DH / 30 jours | Toutes les fonctions |
| 🏆 **Annuel** | 449 DH / 365 jours | Toutes les fonctions |
| 🎁 **Fondateur** | 299 DH / 365 jours (30 places) | Sur code personnel à usage unique |

Essai gratuit de 30 jours, sans carte bancaire. Paiement par virement, puis activation par code de licence.

---

## 🎯 Roadmap

- [x] MVP avec auth + factures
- [x] Module CNSS + Impôts
- [x] Système de licences
- [x] Module Paiements & Relances
- [x] Page admin
- [x] Cloud sync Supabase
- [x] Période d'essai 30 jours
- [ ] Application mobile (Capacitor)
- [ ] Intégration paiement CMI
- [ ] Multi-langues (Arabe RTL)
- [ ] Comptabilité de base
- [ ] API publique

---

## 🤝 Contribution

Ce projet est privé pour l'instant. Pour toute question :
- Le contact de support (WhatsApp, e-mail) se configure dans **Admin → Réglages** et s'affiche dans l'application, page Abonnement.

---

## 📄 License

© 2026 FacturaPro. Tous droits réservés.

---

**Made with ❤️ in Morocco 🇲🇦**

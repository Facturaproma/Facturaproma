# 🇲🇦 FacturaPro

> Le logiciel de facturation 100% marocain pour Auto-Entrepreneurs, Freelances et SARL.

[![Status](https://img.shields.io/badge/status-production-success)]()
[![Made in Morocco](https://img.shields.io/badge/Made%20in-Morocco%20🇲🇦-red)]()
[![Stack](https://img.shields.io/badge/stack-HTML%20%2B%20Supabase-blue)]()

---

## 🚀 Démo en ligne

- 🏠 **Landing** : [facturepro-ma.netlify.app](https://facturepro-ma.netlify.app)
- 💼 **Application** : [facturepro-ma.netlify.app/app](https://facturepro-ma.netlify.app/app)
- 🔐 **Admin** : [facturepro-ma.netlify.app/admin](https://facturepro-ma.netlify.app/admin) (privé)

---

## ✨ Fonctionnalités

### Pour les utilisateurs
- 📄 **Factures conformes aux normes marocaines** (ICE, IF, RC, CNSS, Patente)
- 📋 **Devis convertibles** en facture en 1 clic
- 👥 **Base clients** complète avec ICE et historique
- 📦 **Catalogue produits/services** réutilisable
- 🏥 **Calcul cotisation CNSS automatique** (1% services / 0,5% commerce)
- 💰 **Module Impôts** : TVA, IR, Patente
- 💳 **Module Paiements** avec stats et historique
- 🔔 **Relances automatiques** en 3 niveaux (J+7, J+15, J+30)
- 📊 **Dashboard** avec graphique CA 12 mois
- 📥 **Export PDF** professionnel
- 🌍 **Support multi-statuts** : AE, Freelance, SARL, Autre
- ⏰ **Période d'essai 14 jours** (full access)

### Pour l'admin
- 📊 **Dashboard temps réel** avec stats
- 📥 **Gestion des demandes d'abonnement**
- 🎁 **Génération de codes de licence** en 1 clic
- 💳 **Suivi des paiements reçus**
- 📱 **Envoi WhatsApp/Email** automatique
- 🔑 **Mot de passe modifiable** (stocké en base)

---

## 🏗️ Architecture

```
FacturaPro/
├── index.html              # Landing page (vitrine)
├── app.html                # Application principale
├── admin.html              # Backoffice admin
├── netlify.toml            # Configuration Netlify
├── docs/                   # Documentation
└── sql/                    # Scripts SQL Supabase
```

### Stack technique
- **Frontend** : HTML5 + CSS3 + JavaScript (vanilla)
- **Backend** : Supabase (PostgreSQL + Auth + Realtime)
- **PDF** : jsPDF + AutoTable
- **Hosting** : Netlify
- **Domain** : facturapro.ma (ou Netlify subdomain)

---

## 🚀 Déploiement

### 1. Configurer Supabase

Crée un projet sur [supabase.com](https://supabase.com) et exécute les scripts SQL dans l'ordre :

```bash
sql/01_initial.sql           # Tables principales (user_data)
sql/02_admin_tables.sql      # Tables admin (codes, payments)
sql/03_subscriptions.sql     # Demandes d'abonnement
sql/04_admin_settings.sql    # Paramètres admin (password)
```

### 2. Configurer les credentials

Dans `app.html` et `admin.html`, remplace :

```javascript
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

### 3. Déployer sur Netlify

#### Option A : Auto-deploy depuis GitHub (recommandé)
1. Connecte ton repo à Netlify
2. Configuration auto via `netlify.toml`
3. À chaque `git push` → déploiement automatique ✨

#### Option B : Drag & drop manuel
1. Va sur [app.netlify.com](https://app.netlify.com)
2. Drag & drop le dossier complet
3. ✅ En ligne !

---

## 📚 Documentation

- 📖 [Guide de déploiement complet](docs/DEPLOY.md)
- 🔐 [Guide admin](docs/ADMIN_GUIDE.md)
- 🗄️ [Configuration Supabase](docs/SUPABASE_SETUP.md)

---

## 💰 Pricing

| Plan | Prix | Description |
|------|------|-------------|
| 🎁 **Lifetime** | 499 DH une fois | Accès à vie, toutes mises à jour |
| ⭐ **Pro Mensuel** | 99 DH/mois | Tout illimité, support prioritaire |
| 👔 **Business** | 199 DH/mois | Multi-entreprises, multi-utilisateurs |

**Codes promo** : `LANCEMENT2026` (-50%), `FOUNDERS` (-30%), `WELCOME10` (-10%)

---

## 🎯 Roadmap

- [x] MVP avec auth + factures
- [x] Module CNSS + Impôts
- [x] Système de licences
- [x] Module Paiements & Relances
- [x] Page admin
- [x] Cloud sync Supabase
- [x] Période d'essai 14 jours
- [ ] Application mobile (Capacitor)
- [ ] Intégration paiement CMI
- [ ] Multi-langues (Arabe RTL)
- [ ] Comptabilité de base
- [ ] API publique

---

## 🤝 Contribution

Ce projet est privé pour l'instant. Pour toute question :
- 📧 Email : contact@facturapro.ma
- 📱 WhatsApp : +212 6XX XX XX XX

---

## 📄 License

© 2026 FacturaPro. Tous droits réservés.

---

**Made with ❤️ in Morocco 🇲🇦**

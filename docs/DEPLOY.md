# 🚀 Guide de Déploiement

## Pré-requis

- Compte [Supabase](https://supabase.com) (gratuit)
- Compte [Netlify](https://app.netlify.com) (gratuit)
- Compte [GitHub](https://github.com) (gratuit)

---

## Étape 1 : Configurer Supabase

### A. Créer le projet
1. Va sur [supabase.com](https://supabase.com) → **New Project**
2. Nom : `facturapro-prod`
3. Région : **West EU (Paris)** (le plus proche du Maroc)
4. Plan : **Free** (suffisant pour démarrer)

### B. Créer les tables
1. **SQL Editor** → **New query**
2. Copie/colle le contenu de `sql/00_setup_complet.sql`
3. Clique **Run**

### C. Récupérer les credentials
1. **Project Settings** → **API**
2. Note :
   - **Project URL** : `https://xxx.supabase.co`
   - **anon public key** : `eyJ...`

### D. Désactiver la confirmation email (pour tester)
1. **Authentication** → **Providers** → **Email**
2. Désactive **"Confirm email"** (pour démarrer rapidement)
3. Réactive plus tard pour la production

---

## Étape 2 : Configurer le code

Dans `app.html` ET `admin.html`, remplace :

```javascript
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```

Avec tes vraies valeurs récupérées à l'étape 1.C.

---

## Étape 3 : Déployer sur Netlify

### Option A : Via GitHub (recommandé pour auto-deploy)

1. Push ton code sur GitHub
2. Va sur [app.netlify.com](https://app.netlify.com)
3. **Add new site** → **Import an existing project**
4. Sélectionne ton repo GitHub
5. Build settings : laisse par défaut (le `netlify.toml` s'occupe de tout)
6. **Deploy site**

✅ À chaque `git push`, Netlify déploie automatiquement.

### Option B : Manuel (drag & drop)

1. Va sur [app.netlify.com](https://app.netlify.com)
2. **Add new site** → **Deploy manually**
3. Drag & drop le dossier complet
4. Netlify te donne une URL : `https://random-name.netlify.app`

---

## Étape 4 : Domaine personnalisé (Optionnel)

### Acheter `facturapro.ma`

Registrars marocains :
- [genious.net.ma](https://www.genious.net.ma) (~80 DH/an)
- [ifrance.ma](https://www.ifrance.ma)
- [morocco-domain.ma](https://www.morocco-domain.ma)

### Connecter à Netlify

1. Site Netlify → **Domain settings** → **Add custom domain**
2. Entre `facturapro.ma`
3. Configure les DNS chez ton registrar (Netlify donne les valeurs)
4. Attends 1-24h (propagation DNS)

---

## Étape 5 : Vérifier les URLs

Une fois déployé :

| URL | Page |
|-----|------|
| `https://facturapro.ma/` | 🏠 Landing |
| `https://facturapro.ma/app` | 💼 Application |
| `https://facturapro.ma/admin` | 🔐 Admin |

---

## Étape 6 : Tester

### Test 1 : Inscription client
1. Va sur `/app`
2. Crée un compte
3. Complète l'onboarding
4. ✅ Tu vois le dashboard avec banner "Période d'essai 14 jours"

### Test 2 : Admin
1. Va sur `/admin`
2. Mot de passe par défaut : `Saadnawal79@@££` (à changer après !)
3. Tu vois le dashboard admin
4. **Change le mot de passe** dans la sidebar

### Test 3 : Workflow complet
1. Client demande Lifetime depuis l'app
2. Admin reçoit la demande dans `/admin → Demandes`
3. Admin génère le code
4. Client active le code dans son app
5. ✅ Licence active à vie

---

## 🐛 Troubleshooting

### Page blanche
- Vide le cache (`Ctrl+Shift+R`) ou mode incognito
- Console (F12) pour voir les erreurs

### "Could not load from cloud"
- Vérifie SUPABASE_URL et SUPABASE_ANON_KEY
- Vérifie que les tables existent

### Email de confirmation pas reçu
- Regarde dans les spams
- Ou désactive "Confirm email" dans Supabase pour tester

---

## 🔒 Sécurité Production

Avant de lancer en public :

1. **Changer le mot de passe admin** (via interface)
2. **Réactiver "Confirm email"** dans Supabase
3. **Configurer un SMTP custom** (Mailgun/SendGrid)
4. **HTTPS activé** (auto avec Netlify)
5. **Backups Supabase** : automatiques sur plan gratuit

---

## 📊 Monitoring

### Netlify
- **Analytics** : Visiteurs, bandwidth
- **Functions** : Logs si tu ajoutes des serverless functions

### Supabase
- **Database** : Logs en temps réel
- **Auth** : Liste des utilisateurs
- **Storage** : Si tu ajoutes de l'upload de fichiers

---

**Bon déploiement ! 🚀**

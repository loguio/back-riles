# Riles Backend (`riles-back`)

Backend NestJS / Prisma / PostgreSQL conçu pour alimenter l'application mobile React Native **Riles** (Onboarding, Calendrier des séances, Accueil / Check-in RPE, Profil coureur, Coach IA, Webhooks sport-santé).

---

## 🏗️ Architecture & Modules

Le backend est structuré selon les principes du Clean Architecture et de la modularité NestJS :

| Module               | Rôle                                          | Endpoints Principaux                                                                                                                      |
| :------------------- | :-------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------- |
| **AuthModule**       | Gestion des comptes & sessions                | `POST /auth/login`, `POST /auth/social`, `POST /auth/register`                                                                            |
| **OnboardingModule** | Parcours d'intégration en 5 étapes            | `GET /onboarding/state`, `POST /onboarding/step`, `POST /onboarding/complete`, `GET /onboarding/apps`                                     |
| **UsersModule**      | Profil coureur & règles de vie                | `GET /users/profile`, `PATCH /users/profile`, `POST /users/rules`, `DELETE /users/rules/:id`                                              |
| **WorkoutsModule**   | Calendrier, séances, RPE & adaptations        | `GET /workouts/week`, `GET /workouts/month`, `GET /workouts/:id`, `PATCH /workouts/:id`, `POST /workouts/rpe`, `POST /workouts/:id/adapt` |
| **CoachModule**      | Coach IA conversationnel & suggestions        | `POST /coach/chat`, `GET /coach/quick-prompts`, `GET /coach/history`                                                                      |
| **WebhooksModule**   | Ingestion des montres & plateformes sportives | `GET & POST /webhooks/strava`, `POST /webhooks/garmin`, `POST /webhooks/apple-health`                                                     |
| **PrismaModule**     | Accès PostgreSQL & mapping ORM                | Intégration globale `PrismaService`                                                                                                       |

---

## 🚀 Démarrage Rapide

### 1. Installation des dépendances

```bash
cd riles-back
npm install
```

### 2. Démarrage de la base de données PostgreSQL (Docker)

```bash
docker compose up -d postgres
```

### 3. Génération du client Prisma & Migration

```bash
npx prisma generate
npx prisma migrate deploy
npm run prisma:seed -- --force
```

- **`DATABASE_URL` et `DIRECT_URL` sont tous deux requis** par les commandes
  Prisma (migrations incluses) : voir `.env.example`.
- **Production / déploiement** : `npx prisma migrate deploy`
  (alias `npm run prisma:deploy`) applique uniquement les migrations versionnées
  dans `prisma/migrations/` — c'est **la seule commande à utiliser en prod**.
  Elle ne modifie jamais le schéma par « push » silencieux et se rejoue de
  façon idempotente.
- **Développement local** : `npx prisma migrate dev --name <description>`
  crée une nouvelle migration à partir de `prisma/schema.prisma`.
- `npx prisma db push` reste réservé au **prototypage local jetable** : il
  n'écrit aucun historique et n'a pas de rollback. Ni le CI ni le déploiement
  ne l'utilisent : le CI applique les migrations sur une base vide à chaque PR
  et vérifie qu'elles ne dérivent pas de `schema.prisma`.

### 3bis. Scripts destructeurs (`seed`, `clean` / `db:wipe`)

`prisma/seed.ts` et `prisma/clean.ts` suppriment **toutes les tables**,
utilisateurs compris (RILES-033). Ils refusent de s'exécuter — message clair
en français, code de sortie 1, aucun accès à la base — sauf si **les trois**
conditions suivantes sont réunies :

1. le drapeau explicite `--force` est passé ;
2. `NODE_ENV` n'est pas `production` ;
3. `DATABASE_URL` pointe vers une base **locale** (`localhost`, `127.0.0.1`,
   `::1` ou socket unix) et est bien renseigné.

```bash
npm run db:wipe            # refuse : aucun --force
npm run db:wipe:dev        # vide la base LOCALE uniquement (--force passé)
npm run prisma:seed        # refuse : aucun --force
npm run prisma:seed:dev    # seed de démonstration, base locale uniquement
```

### 4. Lancement du serveur NestJS

```bash
# Mode développement (watch)
npm run start:dev

# Mode production
npm run build
npm run start:prod
```

Le serveur sera accessible sur : `http://localhost:3000/api/v1`  
La documentation Swagger interactive sera disponible sur : `http://localhost:3000/api/docs`

### 5. Secret JWT requis (démarrage fail-closed)

Le serveur **refuse de démarrer** si ni `SUPABASE_JWT_SECRET` ni `JWT_SECRET` n'est défini
(variable d'environnement ou fichier `.env`, jamais committé) :

```bash
# .env (untracked)
SUPABASE_JWT_SECRET=$(openssl rand -hex 32)
```

⚠️ **Rotation** : un secret par défaut était embarqué dans le code source, dans `.env.example`
et dans `docker-compose.yml`. Il est désormais public : **considérez-le comme compromis**,
ne le réutilisez jamais, régénérez-le et révoquez-le côté Supabase
(Project Settings → API → JWT Secret) ainsi que partout où il avait été copié.

---

## 📄 Schéma de la Base de Données (`schema.prisma`)

- **User** : Profil utilisateur, readiness score, objectif actif (`Semi-marathon de Paris`), statistiques (`totalKm`, `activeWeeks`), type d'abonnement (`basic` / `pro`).
- **LifeRule** : Règles de vie et contraintes personnelles (constance, plaisir, jours verrouillés).
- **Workout** : Séances d'entraînement indexées par date (`dateKey`), blocs d'efforts structurés (`effortBlocks`), zones cardiaques cibles (`targetZoneSegments`), statuts (`done`, `selected`, `rest`, `upcoming`).
- **RpeCheckIn** : Évaluations post-séance (1 à 10) et messages de préservation physiologique générés par l'IA.
- **SyncToken** : Connexions OAuth / API vers les plateformes tierces (Strava, Garmin, Apple Health, Suunto, Polar, Coros).
- **ChatMessage** : Historique des conversations et actions d'adaptation recommandées par le Coach IA.
- **WebhookEvent** : Logs d'ingestion des événements sport-santé.

# Riles — API (`back-riles`)

[![CI](https://github.com/loguio/back-riles/actions/workflows/ci.yml/badge.svg)](https://github.com/loguio/back-riles/actions/workflows/ci.yml)

API **NestJS / Prisma / PostgreSQL** qui alimente l'application mobile Riles :
onboarding, calendrier des séances, check-in RPE, coach IA, communauté
(running clubs), webhooks sport-santé (Strava / Garmin / Apple Santé), data lake
et facturation.

**Aperçu produit :** <https://web-riles.netlify.app/> — l'API n'a pas de démo
publique ; la documentation **Swagger** est servie localement sur `/api/docs`.

## Architecture & modules

Backend structuré selon les principes du Clean Architecture et de la modularité
NestJS. Toutes les routes sont préfixées par `/api/v1`.

| Module | Rôle | Endpoints principaux |
| :--- | :--- | :--- |
| **AuthModule** | Comptes & sessions | `POST /auth/login`, `POST /auth/social`, `POST /auth/register` |
| **OnboardingModule** | Parcours d'intégration en 5 étapes | `GET /onboarding/state`, `POST /onboarding/step`, `POST /onboarding/complete`, `GET /onboarding/apps` |
| **UsersModule** | Profil coureur & règles de vie | `GET /users/profile`, `PATCH /users/profile`, `POST /users/rules`, `DELETE /users/rules/:id` |
| **WorkoutsModule** | Calendrier, séances, RPE & adaptations | `GET /workouts/week`, `GET /workouts/month`, `PATCH /workouts/:id`, `POST /workouts/rpe`, `POST /workouts/:id/adapt` |
| **CoachModule** | Coach IA conversationnel | `POST /coach/chat`, `GET /coach/quick-prompts`, `GET /coach/history` |
| **CommunityModule** | Running clubs & défis mensuels | `GET /community/runs`, `POST /community/runs/:id/toggle`, `GET /community/challenges` |
| **WebhooksModule** | Ingestion montres & plateformes | `GET & POST /webhooks/strava`, `POST /webhooks/garmin`, `POST /webhooks/apple-health` |
| **BillingModule** | Facturation (RevenueCat) — *stub* | `POST /billing/webhook` |
| **DatalakeModule** | Anonymisation & exports d'entraînement | — |
| **LlmModule** | Passerelle LLM multi-provider | — |
| **HealthModule** | Santé du service | `GET /health` |
| **WaitlistModule** | Capture bêta | `POST /waitlist` |

Les contrats d'API détaillés sont versionnés dans le dépôt, par exemple
[`CONTRACT-community.md`](./CONTRACT-community.md) et [`BILLING.md`](./BILLING.md).

## Démarrage rapide

### 1. Dépendances

```bash
npm install
```

### 2. Base de données PostgreSQL (Docker)

```bash
docker compose up -d postgres
```

### 3. Client Prisma & migrations

```bash
npx prisma generate
npx prisma migrate deploy
npm run prisma:seed -- --force
```

- **`DATABASE_URL` et `DIRECT_URL` sont tous deux requis** par les commandes
  Prisma (migrations incluses) : voir [`.env.example`](./.env.example).
- **Production** : `npx prisma migrate deploy` (alias `npm run prisma:deploy`)
  applique uniquement les migrations versionnées de `prisma/migrations/` —
  c'est **la seule commande à utiliser en prod** (idempotente, jamais de
  « push » silencieux).
- **Développement** : `npx prisma migrate dev --name <description>` crée une
  nouvelle migration à partir de `prisma/schema.prisma`.
- `npx prisma db push` reste réservé au **prototypage local jetable**.

### 3 bis. Scripts destructeurs (`seed`, `clean` / `db:wipe`)

`prisma/seed.ts` et `prisma/clean.ts` suppriment **toutes les tables**,
utilisateurs compris. Ils refusent de s'exécuter sauf si **les trois**
conditions suivantes sont réunies :

1. le drapeau explicite `--force` est passé ;
2. `NODE_ENV` n'est pas `production` ;
3. `DATABASE_URL` pointe vers une base **locale**.

```bash
npm run db:wipe            # refuse : aucun --force
npm run db:wipe:dev        # vide la base LOCALE uniquement
npm run prisma:seed        # refuse : aucun --force
npm run prisma:seed:dev    # seed de démonstration, base locale uniquement
```

### 4. Serveur NestJS

```bash
npm run start:dev    # développement (watch)
npm run build && npm run start:prod   # production
```

- API : `http://localhost:3000/api/v1`
- Swagger : `http://localhost:3000/api/docs`

### 5. Secrets requis (démarrage *fail-closed*)

Le serveur **refuse de démarrer** si ni `SUPABASE_JWT_SECRET` ni `JWT_SECRET`
n'est défini (variable d'environnement ou `.env`, jamais committé) :

```bash
# .env (untracked)
SUPABASE_JWT_SECRET=$(openssl rand -hex 32)
```

> ⚠️ **Rotation** : un secret par défaut était embarqué dans le code source, dans
> `.env.example` et dans `docker-compose.yml`. Il est public désormais :
> **considérez-le comme compromis**, régénérez-le et révoquez-le côté Supabase.

## Tests & qualité

```bash
npm run type-check      # tsc --noEmit
npm run lint            # eslint
npm test                # jest (unitaires, 33 suites)
npm run test:integration  # scripts d'intégration (auth guard, data lake)
npm run build           # nest build
```

## Base de données (`schema.prisma`)

- **User** — profil, readiness, objectif actif, statistiques, plan (`basic` / `pro`, `trialEndsAt`).
- **LifeRule** — règles de vie et contraintes personnelles.
- **Workout** — séances (blocs d'efforts, zones cibles, statuts, métriques réelles Strava / Garmin).
- **RpeCheckIn** — évaluations post-séance (1 à 10).
- **SyncToken** — connexions OAuth / API tierces (Strava, Garmin, Apple Santé…).
- **ChatMessage** — historique du coach IA et actions d'adaptation.
- **RunningClub**, **CommunityRun**, **CommunityRunParticipant**, **MonthlyChallenge** — communauté.
- **WebhookEvent** — journal d'ingestion (idempotence).

## Liens

- Méta-dépôt : <https://github.com/loguio/riles>
- Application mobile : <https://github.com/loguio/front-riles>
- Landing : <https://github.com/loguio/web-riles>

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
npx prisma db push
npm run prisma:seed
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

---

## 📄 Schéma de la Base de Données (`schema.prisma`)

- **User** : Profil utilisateur, readiness score, objectif actif (`Semi-marathon de Paris`), statistiques (`totalKm`, `activeWeeks`), type d'abonnement (`basic` / `pro`).
- **LifeRule** : Règles de vie et contraintes personnelles (constance, plaisir, jours verrouillés).
- **Workout** : Séances d'entraînement indexées par date (`dateKey`), blocs d'efforts structurés (`effortBlocks`), zones cardiaques cibles (`targetZoneSegments`), statuts (`done`, `selected`, `rest`, `upcoming`).
- **RpeCheckIn** : Évaluations post-séance (1 à 10) et messages de préservation physiologique générés par l'IA.
- **SyncToken** : Connexions OAuth / API vers les plateformes tierces (Strava, Garmin, Apple Health, Suunto, Polar, Coros).
- **ChatMessage** : Historique des conversations et actions d'adaptation recommandées par le Coach IA.
- **WebhookEvent** : Logs d'ingestion des événements sport-santé.

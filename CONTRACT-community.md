# CONTRACT — Community API (Phase 5B, X1)

Published by the back-riles team so the front-end can build in parallel against
these shapes before the `CommunityModule` controller lands (B2, iteration 1).

- Base URL: `{API_PREFIX}` (default `api/v1`) → full paths below assume `api/v1`.
- Auth: bearer JWT (Supabase), same guard as `/workouts`. `userId` is derived
  from the token, never from the body.
- Content type: `application/json`.
- Timestamps: ISO-8601 UTC strings.
- Canonical DTO source: `src/modules/community/dto/community.dto.ts`.
- Validation: DTO validation runs through the global Nest `ValidationPipe`
  (`src/main.ts`). A rejected DTO is answered **`400 Bad Request`** — the
  exception status is passed straight through by `AllExceptionsFilter`, so the
  API never emits `422`.
- `prisma validate` / `prisma format` / `prisma generate` read the datasource
  from the environment: export `DATABASE_URL` and `DIRECT_URL` (see
  `.env.example`) before running them, otherwise Prisma aborts on an unset env
  var.

## Shared types

`CommunityRunParticipant`:

| field    | type    | notes              |
| -------- | ------- | ------------------ |
| userId   | string  |                    |
| name     | string  | display name       |
| initials | string  | 2 chars, e.g. `CD` |
| isMe     | boolean | current user       |

`ChallengeMetric` = `"distance" | "duration" | "elevation" | "sessions"`.

## 1. `GET /api/v1/community/runs`

Optional query: `clubId` (string) — filter to one club.

**Scope: upcoming only.** The endpoint returns runs whose `scheduledAt` is at or
after the server's current time (`scheduledAt >= now`), ordered by
`scheduledAt` ascending. Past runs are **never** returned — the front-end must
not expect historical rows from this endpoint (there is no pagination or
history parameter). A run that has already started disappears from the list.

**200 response** — JSON array of `CommunityRun`:

```json
[
  {
    "id": "run-01",
    "clubId": "club-01",
    "clubName": "Riles Paris",
    "scheduledAt": "2026-10-20T18:30:00.000Z",
    "location": "Parc des Buttes-Chaumont, Paris",
    "theme": "Sortie seuil en groupe",
    "participantCount": 12,
    "isJoined": true,
    "participants": [
      { "userId": "user-01", "name": "Camille D.", "initials": "CD", "isMe": true }
    ]
  }
]
```

`theme` is optional: the field may be **absent** or **`null`** (the DTO types it
as `theme?: string | null`). Empty list ⇒ `[]` (never `null`).

## 2. `POST /api/v1/community/runs/:id/toggle`

Path param `id` = run id. Body optional:

```json
{ "action": "join" }   // or "leave"; omit entirely to toggle
```

- `action: "join"` → idempotently ensure joined.
- `action: "leave"` → idempotently ensure not joined.
- no body / `{}` → flip current state.

`join` and `leave` are **idempotent and race-free** (backed by an atomic
`upsert` / `deleteMany`). The bodyless **toggle** reads the current state then
writes, all inside a single database transaction, but with the default
read-committed isolation it remains **best-effort** under two *identical*
concurrent toggle requests: the outcome is still a consistent `isJoined` +
`participantCount` pair (never a half-written state), but it is
last-writer-wins rather than a guaranteed double-flip. Clients that need a
deterministic result should send an explicit `action`.

**200 response** — `ToggleRunParticipationResponse`:

```json
{ "runId": "run-01", "isJoined": true, "participantCount": 13 }
```

Errors: `404` if the run does not exist.

## 3. `GET /api/v1/community/challenges`

**Scope: active period only.** The endpoint returns challenges whose period
covers the server's current time (`periodStart <= now <= periodEnd`), ordered by
`periodStart` ascending. Challenges that have not started or have already ended
are **never** returned — the front-end must not expect historical or future
rows from this endpoint.

**200 response** — JSON array of `MonthlyChallenge`:

```json
[
  {
    "id": "challenge-01",
    "title": "100 km en octobre",
    "metric": "distance",
    "target": 100,
    "unit": "km",
    "progress": 42.5,
    "progressRatio": 0.425,
    "periodStart": "2026-10-01T00:00:00.000Z",
    "periodEnd": "2026-10-31T23:59:59.999Z"
  }
]
```

`unit`, `progress` and `progressRatio` are derived from the challenge's
`metric`, aggregating the current user's own completed workouts whose
`completedAt` falls inside `[periodStart, periodEnd]`:

| metric      | unit       | progress                                       |
| ----------- | ---------- | ---------------------------------------------- |
| `distance`  | `km`       | Σ `actualDistanceKm`                           |
| `duration`  | `min`      | Σ `actualDurationSec` ÷ 60                     |
| `elevation` | `m`        | Σ `actualElevationGain`                        |
| `sessions`  | `sessions` | count of completed workouts in the period      |

`progressRatio = clamp(progress / target, 0, 1)`. Empty list ⇒ `[]`.

## Status codes

| code | meaning                                          |
| ---- | ------------------------------------------------ |
| 200  | success (all three endpoints)                    |
| 400  | validation failure (bad `action`, bad `clubId`)  |
| 401  | missing/invalid bearer token                     |
| 404  | run not found (toggle only)                      |

Validation failures are **`400`**, not `422`: the global `ValidationPipe`
throws a `BadRequestException`, and `AllExceptionsFilter` forwards that status
unchanged.

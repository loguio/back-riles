# CONTRACT — Community API (Phase 5B, X1)

Published by the back-riles team so the front-end can build in parallel against
these shapes before the `CommunityModule` controller lands (B2, iteration 1).

- Base URL: `{API_PREFIX}` (default `api/v1`) → full paths below assume `api/v1`.
- Auth: bearer JWT (Supabase), same guard as `/workouts`. `userId` is derived
  from the token, never from the body.
- Content type: `application/json`.
- Timestamps: ISO-8601 UTC strings.
- Canonical DTO source: `src/modules/community/dto/community.dto.ts`.

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

`theme` is optional (may be absent or `null`). Empty list ⇒ `[]` (never `null`).

## 2. `POST /api/v1/community/runs/:id/toggle`

Path param `id` = run id. Body optional:

```json
{ "action": "join" }   // or "leave"; omit entirely to toggle
```

- `action: "join"` → idempotently ensure joined.
- `action: "leave"` → idempotently ensure not joined.
- no body / `{}` → flip current state.

**200 response** — `ToggleRunParticipationResponse`:

```json
{ "runId": "run-01", "isJoined": true, "participantCount": 13 }
```

Errors: `404` if the run does not exist.

## 3. `GET /api/v1/community/challenges`

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

`progressRatio = clamp(progress / target, 0, 1)`. Empty list ⇒ `[]`.

## Status codes

| code | meaning                                          |
| ---- | ------------------------------------------------ |
| 200  | success (all three endpoints)                    |
| 401  | missing/invalid bearer token                     |
| 404  | run not found (toggle only)                      |
| 422  | validation failure (bad `action`, bad `clubId`)  |

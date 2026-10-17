# BILLING — seam de facturation (Phase 5B, B4)

Statut : **stub**. Aucun credential RevenueCat n'est encore disponible, donc on
construit la **couture** (seam), pas le fournisseur. Le comportement bêta est
strictement inchangé.

## Architecture

```
src/modules/billing/
  billing.types.ts          # interface BillingProvider + types neutres + token BILLING_PROVIDER
  fake-billing.provider.ts  # FakeBillingProvider : déterministe, hors-réseau
  billing.service.ts        # vérifie → mappe → applique (Prisma) + idempotence
  billing.controller.ts     # POST /api/v1/billing/webhook
  billing.module.ts         # liaison du token → provider
  dto/billing.dto.ts        # payload canonique du stub (Swagger + validation)
```

`BillingProvider` (neutre vis-à-vis du vendeur) expose deux responsabilités :

- `verifyAndParseWebhook(payload, signature?, rawBody?)` → authentifie la
  livraison et la normalise en `BillingEvent` (ou la rejette) ;
- `mapEventToPlanChange(event)` → `PlanChange | null` (`planType`,
  `trialEndsAt`, `status`). `null` = événement acquitté sans changement de plan.

Le `rawBody` est transmis tel quel pour que la vérification de signature porte
sur les octets exacts reçus (même règle que les webhooks sportifs, RILES-005).

## Endpoint

`POST /api/v1/billing/webhook` — `@Public()` (authentifié par signature, comme
les webhooks Strava/Garmin/Apple), en-tête `x-billing-signature`.

Payload canonique du stub :

```json
{
  "id": "evt_123",
  "type": "initial_purchase",
  "userId": "user_abc",
  "trialEndsAt": "2026-11-01T00:00:00.000Z",
  "status": "active"
}
```

Signature : `sha256=<hex HMAC-SHA256(BILLING_WEBHOOK_SECRET, corps brut)>`.

**Fail-closed (RILES-005).** `BILLING_WEBHOOK_SECRET` est **requis** : le module
ne substitue **aucun** secret par défaut repo-connu (même convention que
`requireWebhookSecret` dans `webhooks.service.ts`). Sans secret configuré, le
endpoint public rejette toute livraison en 401 — jamais de plan appliqué avec un
secret connu de tous. Poser le secret avant d'exposer l'endpoint.

Mapping `type` → plan (déterministe) :

| `type`                                            | planType | trialEndsAt | status     |
| ------------------------------------------------- | -------- | ----------- | ---------- |
| `initial_purchase`, `renewal`, `uncancellation`, `product_change` | PRO      | effacé      | `active`   |
| `trial_started`                                   | BASIC    | déclaré     | `trialing` |
| `cancellation`                                    | BASIC    | effacé      | `canceled` |
| `expiration`                                      | BASIC    | effacé      | `expired`  |
| autre                                             | —        | —           | acquitté (`null`) |

Un essai se modélise en `BASIC` + `trialEndsAt` futur : c'est exactement la
règle `isPro()` (B3).

### Codes de statut

| code | sens                                                              |
| ---- | ----------------------------------------------------------------- |
| 200  | livraison traitée, ou rejeu ignoré (`success: false`), ou no-op    |
| 401  | signature absente/invalide, payload malformé, ou secret non configuré (fail-closed) |
| 404  | utilisateur cible inconnu                                          |

### Idempotence

Chaque livraison est écrite dans `webhook_events` avec la clé unique
`(provider="billing", eventType, objectId=event.id)` — la même table et la même
contrainte que les webhooks sportifs (RILES-006). Un rejeu, y compris après
redémarrage, est intercepté par la contrainte `P2002` et n'entraîne aucune
seconde écriture. Un événement pour un utilisateur inconnu n'est **pas**
enregistré : il reste rejouable une fois l'utilisateur créé.

L'enregistrement d'idempotence et l'application du plan (`User.planType` /
`User.trialEndsAt`) sont faits dans **une seule transaction** : si l'`update`
échoue, l'enregistrement est annulé (rollback) et la livraison reste rejouable —
elle n'est jamais « consommée sans effet ».

### Ordre des livraisons

Le traitement est **last-write-wins** : il n'y a **aucune garde d'ordre**. Une
livraison applique l'état qu'elle porte, quel que soit l'ordre d'arrivée, et
chaque `event.id` distinct est traité indépendamment (seuls les rejeux du *même*
id sont ignorés). Un `cancellation` arrivé après un `renewal` plus récent
écraserait donc le plan avec l'état le plus ancien. C'est acceptable pour le stub
(les livraisons sont acquittées rapidement et le provider les ordonne côté
émetteur) ; un provider réel devra ajouter un horodatage (`event_timestamp`) et
un garde « n'appliquer que si plus récent que `webhook_events.processedAt` »
avant mise en production.

## Basculer vers le vrai fournisseur (RevenueCat)

C'est une **liaison unique**. Dans `billing.module.ts`, remplacer :

```ts
{ provide: BILLING_PROVIDER, useFactory: ... FakeBillingProvider ... }
```

par :

```ts
{ provide: BILLING_PROVIDER, useClass: RevenueCatBillingProvider }
```

puis implémenter `RevenueCatBillingProvider implements BillingProvider`
(traduction du payload RevenueCat → `BillingEvent`, vérification du secret SDK)
et poser `BILLING_WEBHOOK_SECRET`. Ni le service, ni le contrôleur, ni la table
d'idempotence ne changent.

## Activer le paywall (lancement)

Aujourd'hui `PAYWALL_ENFORCED` vaut `false` (défaut) : `ProEntitlementGuard`
laisse passer tout le monde, même sur les routes `@RequirePro()`. Le défaut
`User.planType = PRO` n'a **pas** été touché.

Étapes de lancement, dans cet ordre :

1. **Basculer le défaut Prisma** — une ligne dans `prisma/schema.prisma` :

   ```prisma
   planType PlanType @default(BASIC)   // était @default(PRO)
   ```

   puis générer la migration (additive, elle ne modifie **aucune ligne
   existante**, elle ne change que le défaut de colonne) :

   ```bash
   npx prisma migrate dev --name riles_035_default_plan_basic
   ```

2. **Poser le drapeau** : `PAYWALL_ENFORCED=true` dans l'environnement.
3. **Redéployer** : `npx prisma migrate deploy` puis redémarrer l'API.

À partir de là, un utilisateur `BASIC` sans essai actif reçoit `403` sur les
routes `@RequirePro()` ; un abonné `PRO` ou un essai non expiré passe. Revenir
en arrière = `PAYWALL_ENFORCED=false` (aucune migration à annuler).

## Tests

- `fake-billing.provider.test.ts` — vérification (signature, payload, secret
  vide fail-closed) et mapping événement → plan/essai (`product_change` inclus).
- `billing.webhook.test.ts` — application du plan, essai, idempotence (rejeu +
  rejeu après redémarrage), atomicité (rollback si l'`update` échoue), 401, 404,
  no-op, et câblage de la route (`@Public()` + `POST billing/webhook`). Pas de
  test HTTP supertest : le repo n'a pas cette dépendance (test au niveau
  métadonnées Nest).
- `pro-entitlement.guard.test.ts` — comportement de la garde sous
  `PAYWALL_ENFORCED=false` (défaut) et `true` (casse + espaces).

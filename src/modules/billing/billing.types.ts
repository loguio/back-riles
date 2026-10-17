import { PlanType } from "@prisma/client";

/**
 * Phase 5B (B4) — types de facturation, volontairement **neutres vis-à-vis du
 * fournisseur**. Aucun type RevenueCat / Stripe / autre ne fuit ici : un vrai
 * provider est branché plus tard derrière la même interface (`BillingProvider`)
 * en traduisant ses payloads vers ces formes normalisées.
 */

/** État d'abonnement normalisé (sous-ensemble commun aux fournisseurs). */
export type BillingSubscriptionStatus =
  "active" | "trialing" | "past_due" | "canceled" | "expired";

export const BILLING_SUBSCRIPTION_STATUSES: readonly BillingSubscriptionStatus[] =
  ["active", "trialing", "past_due", "canceled", "expired"];

/**
 * Événement fournisseur **vérifié et normalisé** (résultat de
 * `BillingProvider.verifyAndParseWebhook`). `trialEndsAt` et `status` sont les
 * valeurs *déclarées par le payload* ; c'est `mapEventToPlanChange` qui décide
 * du changement de plan final.
 */
export interface BillingEvent {
  /** Identifiant d'événement stable du fournisseur (clé d'idempotence). */
  eventId: string;
  /** Type d'événement normalisé, ex. "initial_purchase", "renewal". */
  eventType: string;
  /** Utilisateur applicatif (Riles `User.id`) concerné. */
  userId: string;
  /** Fin d'essai déclarée, `null` si l'événement n'en porte pas. */
  trialEndsAt: Date | null;
  /** État d'abonnement déclaré. */
  status: BillingSubscriptionStatus;
  /** Payload brut, conservé pour l'audit (journalisé / stocké). */
  raw: unknown;
}

/** Résultat de la vérification : authentique + exploitable, ou non. */
export interface VerifiedBillingWebhook {
  valid: boolean;
  event?: BillingEvent;
  /** Motif du rejet, pour les logs — jamais renvoyé tel quel au client. */
  reason?: string;
}

/**
 * Changement de plan à appliquer à l'utilisateur. `planType` + `trialEndsAt`
 * sont persistés (`User.planType` / `User.trialEndsAt`) ; `status` sert au
 * journal / à un futur suivi d'abonnement (pas de colonne dédiée aujourd'hui).
 */
export interface PlanChange {
  userId: string;
  planType: PlanType;
  trialEndsAt: Date | null;
  status: BillingSubscriptionStatus;
}

/** Résultat renvoyé au fournisseur par le endpoint webhook. */
export interface BillingWebhookResult {
  success: boolean;
  message: string;
}

/**
 * Seam de facturation (Phase 5B, B4).
 *
 * Deux responsabilités, indépendantes du fournisseur :
 *  (a) `verifyAndParseWebhook` — authentifier une livraison entrante et la
 *      normaliser en `BillingEvent` (ou la rejeter) ;
 *  (b) `mapEventToPlanChange` — traduire un `BillingEvent` en changement de
 *      plan (`planType`, `trialEndsAt`, `status`), ou `null` si l'événement
 *      n'entraîne aucun changement de plan.
 *
 * `rawBody` est transmis tel quel pour que la vérification de signature porte
 * sur les octets exacts reçus (comme les webhooks sportifs, RILES-005).
 */
export interface BillingProvider {
  verifyAndParseWebhook(
    payload: unknown,
    signature?: string,
    rawBody?: Buffer | string,
  ): VerifiedBillingWebhook;

  mapEventToPlanChange(event: BillingEvent): PlanChange | null;
}

/**
 * Jeton d'injection Nest du provider de facturation. Pour passer en production,
 * changer **une seule** liaison de provider (`billing.module.ts`) :
 *
 *   { provide: BILLING_PROVIDER, useClass: RevenueCatBillingProvider }
 */
export const BILLING_PROVIDER = Symbol("BILLING_PROVIDER");

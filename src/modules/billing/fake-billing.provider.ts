import * as crypto from "crypto";
import { PlanType } from "@prisma/client";
import {
  BILLING_SUBSCRIPTION_STATUSES,
  BillingEvent,
  BillingProvider,
  BillingSubscriptionStatus,
  PlanChange,
  VerifiedBillingWebhook,
} from "./billing.types";

/**
 * Secret **de test** du provider factice. Il n'a de sens que pour les tests du
 * stub : `billing.module.ts` ne le substitue **jamais** à
 * `BILLING_WEBHOOK_SECRET` (fail-closed — cf. `requireWebhookSecret` dans
 * `webhooks.service.ts`, RILES-005). Sans secret configuré, le endpoint public
 * rejette toute livraison en 401. Le provider RevenueCat réel utilisera son
 * propre secret (clé SDK / header `X-RevenueCat-Signature`).
 */
export const FAKE_BILLING_WEBHOOK_SECRET = "fake-billing-dev-secret";

/**
 * Phase 5B (B4) — implémentation **déterministe** et **hors-réseau** du seam de
 * facturation. Elle fixe le contrat attendu par le endpoint webhook tant que
 * les credentials RevenueCat ne sont pas disponibles :
 *
 *   payload canonique :
 *   {
 *     "id": "evt_123",
 *     "type": "initial_purchase" | "renewal" | "trial_started" |
 *             "cancellation" | "expiration" | ...,
 *     "userId": "user_abc",
 *     "trialEndsAt": "2026-11-01T00:00:00.000Z" | null,   // optionnel
 *     "status": "active" | "trialing" | "past_due" | "canceled" | "expired"
 *   }
 *
 * Signature : `x-billing-signature: sha256=<hex HMAC-SHA256(secret, corps brut)>`,
 * comparée en temps constant. Aucun appel réseau, aucune horloge : deux appels
 * identiques produisent le même résultat.
 */
export class FakeBillingProvider implements BillingProvider {
  /**
   * Le secret est **requis** : aucun défaut repo-connu n'est appliqué. Un
   * secret vide/absent fait échouer `verifySignature` (fail-closed), donc
   * toute livraison est rejetée en 401.
   */
  constructor(private readonly webhookSecret: string) {}

  verifyAndParseWebhook(
    payload: unknown,
    signature?: string,
    rawBody?: Buffer | string,
  ): VerifiedBillingWebhook {
    const body =
      rawBody !== undefined && rawBody !== null
        ? rawBody
        : Buffer.from(JSON.stringify(payload ?? {}));

    if (!this.verifySignature(body, signature)) {
      return { valid: false, reason: "invalid webhook signature" };
    }

    const event = this.parsePayload(payload);
    if (!event) {
      return { valid: false, reason: "malformed billing payload" };
    }

    return { valid: true, event };
  }

  /**
   * Table de mapping déterministe événement → changement de plan.
   * Un événement inconnu (ou un essai sans date de fin) n'entraîne aucun
   * changement : `null` (livraison acquittée, plan inchangé).
   */
  mapEventToPlanChange(event: BillingEvent): PlanChange | null {
    switch (event.eventType) {
      case "initial_purchase":
      case "renewal":
      case "uncancellation":
      case "product_change":
        return {
          userId: event.userId,
          planType: PlanType.PRO,
          trialEndsAt: null,
          status: "active",
        };

      case "trial_started":
        // Un essai se modélise en BASIC + `trialEndsAt` futur (cf. `isPro`).
        if (!event.trialEndsAt) {
          return null;
        }
        return {
          userId: event.userId,
          planType: PlanType.BASIC,
          trialEndsAt: event.trialEndsAt,
          status: "trialing",
        };

      case "cancellation":
        return {
          userId: event.userId,
          planType: PlanType.BASIC,
          trialEndsAt: null,
          status: "canceled",
        };

      case "expiration":
        return {
          userId: event.userId,
          planType: PlanType.BASIC,
          trialEndsAt: null,
          status: "expired",
        };

      default:
        return null;
    }
  }

  // -------------------------------------------------------------------------
  // Interne
  // -------------------------------------------------------------------------

  private verifySignature(body: Buffer | string, signature?: string): boolean {
    if (!this.webhookSecret || this.webhookSecret.trim().length === 0) {
      return false; // fail-closed : sans secret, aucune livraison acceptée
    }
    if (!signature || signature.trim().length === 0) {
      return false;
    }
    const provided = signature.trim().replace(/^sha256=/i, "");
    const expected = crypto
      .createHmac("sha256", this.webhookSecret)
      .update(body)
      .digest("hex");
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  private parsePayload(payload: unknown): BillingEvent | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const raw = payload as Record<string, unknown>;

    const eventId = this.readNonEmptyString(raw.id);
    const eventType = this.readNonEmptyString(raw.type);
    const userId = this.readNonEmptyString(raw.userId);
    if (!eventId || !eventType || !userId) {
      return null;
    }

    const status = this.readStatus(raw.status);
    if (!status) {
      return null;
    }

    const trialEndsAt = this.readTrialEndsAt(raw.trialEndsAt);
    if (trialEndsAt === "invalid") {
      return null;
    }

    return {
      eventId,
      eventType,
      userId,
      trialEndsAt,
      status,
      raw: payload,
    };
  }

  private readNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    return value.trim();
  }

  private readStatus(value: unknown): BillingSubscriptionStatus | null {
    if (value === undefined || value === null) {
      return "active";
    }
    if (typeof value !== "string") {
      return null;
    }
    return (BILLING_SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
      ? (value as BillingSubscriptionStatus)
      : null;
  }

  /** `null` = absent, `"invalid"` = présent mais illisible, sinon `Date`. */
  private readTrialEndsAt(value: unknown): Date | null | "invalid" {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string") {
      return "invalid";
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "invalid" : parsed;
  }
}

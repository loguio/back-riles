import { PlanType } from "@prisma/client";
import {
  FAKE_BILLING_WEBHOOK_SECRET,
  FakeBillingProvider,
} from "./fake-billing.provider";
import { BillingEvent } from "./billing.types";
import { signBillingBody, signBillingPayload } from "./billing.harness";

/**
 * Phase 5B (B4) — FakeBillingProvider : vérification (a) et mapping (b).
 * Déterministe, hors-réseau.
 */

const TRIAL_END = "2026-11-01T00:00:00.000Z";

function baseEvent(overrides: Partial<BillingEvent> = {}): BillingEvent {
  return {
    eventId: "evt_1",
    eventType: "initial_purchase",
    userId: "user-A",
    trialEndsAt: null,
    status: "active",
    raw: {},
    ...overrides,
  };
}

describe("FakeBillingProvider.verifyAndParseWebhook", () => {
  const provider = new FakeBillingProvider();

  it("accepte un payload canonique correctement signé", () => {
    const payload = {
      id: "evt_100",
      type: "initial_purchase",
      userId: "user-A",
      status: "active",
    };
    const { rawBody, signature } = signBillingPayload(payload);

    const result = provider.verifyAndParseWebhook(payload, signature, rawBody);

    expect(result.valid).toBe(true);
    expect(result.event).toMatchObject({
      eventId: "evt_100",
      eventType: "initial_purchase",
      userId: "user-A",
      status: "active",
      trialEndsAt: null,
    });
  });

  it("rejette une signature invalide", () => {
    const payload = {
      id: "evt_101",
      type: "renewal",
      userId: "user-A",
    };
    const { rawBody } = signBillingPayload(payload);
    const badSignature = signBillingBody(rawBody, "wrong-secret");

    const result = provider.verifyAndParseWebhook(
      payload,
      badSignature,
      rawBody,
    );

    expect(result.valid).toBe(false);
    expect(result.event).toBeUndefined();
    expect(result.reason).toContain("signature");
  });

  it("rejette une signature absente", () => {
    const payload = { id: "evt_102", type: "renewal", userId: "user-A" };
    const result = provider.verifyAndParseWebhook(payload, undefined);
    expect(result.valid).toBe(false);
  });

  it("rejette un payload malformé même correctement signé", () => {
    const payload = { id: "evt_103", type: "renewal" }; // userId manquant
    const { rawBody, signature } = signBillingPayload(payload);

    const result = provider.verifyAndParseWebhook(payload, signature, rawBody);

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("malformed");
  });

  it("rejette un statut hors enum", () => {
    const payload = {
      id: "evt_104",
      type: "renewal",
      userId: "user-A",
      status: "not_a_status",
    };
    const { rawBody, signature } = signBillingPayload(payload);

    const result = provider.verifyAndParseWebhook(payload, signature, rawBody);
    expect(result.valid).toBe(false);
  });

  it("normalise trialEndsAt en Date et status par défaut à active", () => {
    const payload = {
      id: "evt_105",
      type: "trial_started",
      userId: "user-A",
      trialEndsAt: TRIAL_END,
    };
    const { rawBody, signature } = signBillingPayload(payload);

    const result = provider.verifyAndParseWebhook(payload, signature, rawBody);

    expect(result.valid).toBe(true);
    expect(result.event?.trialEndsAt?.toISOString()).toBe(TRIAL_END);
    expect(result.event?.status).toBe("active");
  });

  it("fail-closed : un secret vide n'accepte aucune livraison", () => {
    const provider = new FakeBillingProvider("");
    const payload = { id: "evt_106", type: "renewal", userId: "user-A" };
    const { rawBody, signature } = signBillingPayload(
      payload,
      FAKE_BILLING_WEBHOOK_SECRET,
    );

    const result = provider.verifyAndParseWebhook(payload, signature, rawBody);
    expect(result.valid).toBe(false);
  });
});

describe("FakeBillingProvider.mapEventToPlanChange", () => {
  const provider = new FakeBillingProvider();

  it("achat initial / renouvellement → PRO actif, essai effacé", () => {
    for (const eventType of ["initial_purchase", "renewal", "uncancellation"]) {
      const change = provider.mapEventToPlanChange(
        baseEvent({ eventType, trialEndsAt: new Date(TRIAL_END) }),
      );
      expect(change).toEqual({
        userId: "user-A",
        planType: PlanType.PRO,
        trialEndsAt: null,
        status: "active",
      });
    }
  });

  it("trial_started → BASIC + trialEndsAt déclaré, statut trialing", () => {
    const change = provider.mapEventToPlanChange(
      baseEvent({
        eventType: "trial_started",
        trialEndsAt: new Date(TRIAL_END),
      }),
    );
    expect(change).toEqual({
      userId: "user-A",
      planType: PlanType.BASIC,
      trialEndsAt: new Date(TRIAL_END),
      status: "trialing",
    });
  });

  it("trial_started sans date de fin → aucun changement (null)", () => {
    const change = provider.mapEventToPlanChange(
      baseEvent({ eventType: "trial_started", trialEndsAt: null }),
    );
    expect(change).toBeNull();
  });

  it("cancellation → BASIC, statut canceled", () => {
    const change = provider.mapEventToPlanChange(
      baseEvent({ eventType: "cancellation" }),
    );
    expect(change).toMatchObject({
      planType: PlanType.BASIC,
      trialEndsAt: null,
      status: "canceled",
    });
  });

  it("expiration → BASIC, statut expired", () => {
    const change = provider.mapEventToPlanChange(
      baseEvent({ eventType: "expiration" }),
    );
    expect(change).toMatchObject({
      planType: PlanType.BASIC,
      trialEndsAt: null,
      status: "expired",
    });
  });

  it("événement inconnu → aucun changement (null)", () => {
    const change = provider.mapEventToPlanChange(
      baseEvent({ eventType: "mystery_event" }),
    );
    expect(change).toBeNull();
  });
});

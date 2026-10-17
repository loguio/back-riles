import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { PlanType } from "@prisma/client";
import {
  createBillingHarness,
  createBillingStore,
  signBillingPayload,
} from "./billing.harness";

/**
 * Phase 5B (B4) — webhook de facturation : application du plan, codes de
 * statut, idempotence (y compris après redémarrage).
 */

function initialPurchase(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_500",
    type: "initial_purchase",
    userId: "user-A",
    status: "active",
    ...overrides,
  };
}

describe("POST /billing/webhook", () => {
  it("applique le plan PRO et enregistre la livraison", async () => {
    const { controller, prisma, store } = createBillingHarness();
    const payload = initialPurchase();
    const { rawBody, signature } = signBillingPayload(payload);

    const result = await controller.handleWebhook(
      { rawBody } as any,
      payload as any,
      signature,
    );

    expect(result.success).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({
      planType: PlanType.PRO,
      trialEndsAt: null,
    });
    expect(store.webhookRows).toHaveLength(1);
    expect(store.users.get("user-A").planType).toBe(PlanType.PRO);
  });

  it("applique un essai (BASIC + trialEndsAt) sur trial_started", async () => {
    const { controller, prisma, store } = createBillingHarness();
    const trialEnd = "2026-11-01T00:00:00.000Z";
    const payload = {
      id: "evt_501",
      type: "trial_started",
      userId: "user-A",
      trialEndsAt: trialEnd,
      status: "trialing",
    };
    const { rawBody, signature } = signBillingPayload(payload);

    const result = await controller.handleWebhook(
      { rawBody } as any,
      payload as any,
      signature,
    );

    expect(result.success).toBe(true);
    expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({
      planType: PlanType.BASIC,
      trialEndsAt: new Date(trialEnd),
    });
    expect(store.users.get("user-A").trialEndsAt).toEqual(new Date(trialEnd));
  });

  it("rejoue la même livraison : une seule écriture (idempotent)", async () => {
    const { controller, prisma, store } = createBillingHarness();
    const payload = initialPurchase();
    const { rawBody, signature } = signBillingPayload(payload);

    const first = await controller.handleWebhook(
      { rawBody } as any,
      payload as any,
      signature,
    );
    const replay = await controller.handleWebhook(
      { rawBody } as any,
      payload as any,
      signature,
    );

    expect(first.success).toBe(true);
    expect(replay.success).toBe(false);
    expect(replay.message).toContain("Duplicate");
    expect(store.webhookRows).toHaveLength(1);
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("rejeu après redémarrage : la contrainte unique en base fait foi", async () => {
    const store = createBillingStore();
    const payload = initialPurchase({ id: "evt_502" });
    const { rawBody, signature } = signBillingPayload(payload);

    const before = createBillingHarness({ store });
    const first = await before.controller.handleWebhook(
      { rawBody } as any,
      payload as any,
      signature,
    );
    expect(first.success).toBe(true);

    // Nouveau service : plus de cache en processus, la contrainte unique P2002
    // intercepte le rejeu.
    const after = createBillingHarness({ store });
    const replay = await after.controller.handleWebhook(
      { rawBody } as any,
      payload as any,
      signature,
    );

    expect(replay.success).toBe(false);
    expect(replay.message).toContain("Duplicate");
    expect(store.webhookRows).toHaveLength(1);
    expect(after.prisma.user.update).not.toHaveBeenCalled();
  });

  it("signature invalide → 401, aucune écriture", async () => {
    const { controller, prisma, store } = createBillingHarness();
    const payload = initialPurchase({ id: "evt_503" });
    const { rawBody } = signBillingPayload(payload);

    await expect(
      controller.handleWebhook(
        { rawBody } as any,
        payload as any,
        "sha256=deadbeef",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(store.webhookRows).toHaveLength(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("utilisateur inconnu → 404, livraison non consommée", async () => {
    const { controller, prisma, store } = createBillingHarness();
    const payload = initialPurchase({ id: "evt_504", userId: "ghost" });
    const { rawBody, signature } = signBillingPayload(payload);

    await expect(
      controller.handleWebhook({ rawBody } as any, payload as any, signature),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(store.webhookRows).toHaveLength(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("événement sans changement de plan → 200, aucun effet", async () => {
    const { controller, prisma, store } = createBillingHarness();
    const payload = {
      id: "evt_505",
      type: "mystery_event",
      userId: "user-A",
    };
    const { rawBody, signature } = signBillingPayload(payload);

    const result = await controller.handleWebhook(
      { rawBody } as any,
      payload as any,
      signature,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain("no plan change");
    expect(store.webhookRows).toHaveLength(0);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

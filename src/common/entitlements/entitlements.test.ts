import { PlanType } from "@prisma/client";
import { isPro } from "./entitlements";

/**
 * Phase 5B (B3) — règle d'entitlement Pro : abonné OU essai non expiré.
 * `now` est fixé pour rendre les cas d'essai déterministes.
 */
const NOW = new Date("2026-10-17T12:00:00.000Z");
const ACTIVE_TRIAL = new Date("2026-11-01T00:00:00.000Z"); // après NOW
const EXPIRED_TRIAL = new Date("2026-10-01T00:00:00.000Z"); // avant NOW

describe("isPro", () => {
  it("renvoie true pour un abonné PRO (sans essai)", () => {
    expect(
      isPro({ planType: PlanType.PRO, trialEndsAt: null }, NOW),
    ).toBe(true);
  });

  it("renvoie true pour BASIC avec un essai encore actif", () => {
    expect(
      isPro({ planType: PlanType.BASIC, trialEndsAt: ACTIVE_TRIAL }, NOW),
    ).toBe(true);
  });

  it("renvoie false pour BASIC avec un essai expiré", () => {
    expect(
      isPro({ planType: PlanType.BASIC, trialEndsAt: EXPIRED_TRIAL }, NOW),
    ).toBe(false);
  });

  it("renvoie false pour BASIC sans essai", () => {
    expect(isPro({ planType: PlanType.BASIC, trialEndsAt: null }, NOW)).toBe(
      false,
    );
  });

  it("renvoie false pour un utilisateur absent", () => {
    expect(isPro(null, NOW)).toBe(false);
    expect(isPro(undefined, NOW)).toBe(false);
  });

  it("traite la fin d'essai exactement à `now` comme expirée", () => {
    expect(
      isPro({ planType: PlanType.BASIC, trialEndsAt: NOW }, NOW),
    ).toBe(false);
  });
});

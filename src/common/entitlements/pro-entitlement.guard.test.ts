import "reflect-metadata";
import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PlanType } from "@prisma/client";
import { ProEntitlementGuard } from "./pro-entitlement.guard";
import { REQUIRE_PRO_KEY, RequirePro } from "./require-pro.decorator";

/**
 * Phase 5B (B3/B7) — ProEntitlementGuard.
 *
 * La garde ne s'active que sur les routes `@RequirePro()` : un utilisateur non
 * entitled reçoit un `403`, les routes sans métadonnée passent sans changement.
 * L'entitlement vient de `request.user`, jamais d'un en-tête client.
 *
 * La garde lit l'horloge réelle (`isPro(user)` sans `now`) : les essais sont
 * donc exprimés en dates relatives pour rester indépendants de la date
 * d'exécution (un `ACTIVE_TRIAL` figé expirerait un jour).
 */

const DAY_MS = 864e5;
const ACTIVE_TRIAL = new Date(Date.now() + 30 * DAY_MS);
const EXPIRED_TRIAL = new Date(Date.now() - 30 * DAY_MS);

function createGuard(required: boolean, enforced = true) {
  const reflector: any = { getAllAndOverride: jest.fn(() => required) };
  const configService: any = {
    get: jest.fn((key: string) =>
      key === "PAYWALL_ENFORCED" ? (enforced ? "true" : "false") : undefined,
    ),
  };
  return {
    guard: new ProEntitlementGuard(reflector, configService),
    reflector,
    configService,
  };
}

function createContext(user?: unknown) {
  const request = { user };
  const context: any = {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return { context, request };
}

describe("ProEntitlementGuard", () => {
  it("bloque (403) une route @RequirePro() pour un utilisateur BASIC sans essai", () => {
    const { guard } = createGuard(true);
    const { context } = createContext({
      planType: PlanType.BASIC,
      trialEndsAt: null,
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it("bloque (403) une route @RequirePro() pour un utilisateur BASIC à essai expiré", () => {
    const { guard } = createGuard(true);
    const { context } = createContext({
      planType: PlanType.BASIC,
      trialEndsAt: EXPIRED_TRIAL,
    });

    try {
      guard.canActivate(context);
      throw new Error("expected ForbiddenException");
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getStatus()).toBe(403);
    }
  });

  it("bloque (403) une route @RequirePro() sans utilisateur authentifié", () => {
    const { guard } = createGuard(true);
    const { context } = createContext(undefined);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it("laisse passer un abonné PRO sur une route @RequirePro()", () => {
    const { guard } = createGuard(true);
    const { context } = createContext({
      planType: PlanType.PRO,
      trialEndsAt: null,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("laisse passer un utilisateur en essai actif sur une route @RequirePro()", () => {
    const { guard } = createGuard(true);
    const { context } = createContext({
      planType: PlanType.BASIC,
      trialEndsAt: ACTIVE_TRIAL,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("laisse passer toute route sans métadonnée, même sans utilisateur", () => {
    const { guard } = createGuard(false);
    const { context } = createContext(undefined);

    expect(guard.canActivate(context)).toBe(true);
  });

  it("lit la métadonnée @RequirePro() sur le handler et la classe", () => {
    const { guard, reflector } = createGuard(false);
    const { context } = createContext(undefined);

    guard.canActivate(context);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(REQUIRE_PRO_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
  });

  it("câble @RequirePro() → clé via un vrai Reflector (handler décoré)", () => {
    // Bout-en-bout du décorateur : le `SetMetadata` de `@RequirePro()` est
    // réellement lu par le `Reflector` de Nest, pas simulé.
    const guard = new ProEntitlementGuard(new Reflector(), {
      get: (key: string) => (key === "PAYWALL_ENFORCED" ? "true" : undefined),
    } as any);

    class ProtectedController {
      @RequirePro()
      handler() {}
    }

    const request: any = {
      user: { planType: PlanType.BASIC, trialEndsAt: null },
    };
    const context: any = {
      getHandler: () => ProtectedController.prototype.handler,
      getClass: () => ProtectedController,
      switchToHttp: () => ({ getRequest: () => request }),
    };

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);

    request.user = { planType: PlanType.PRO, trialEndsAt: null };
    expect(guard.canActivate(context)).toBe(true);
  });
});

/**
 * Phase 5B (B4) — interrupteur de lancement `PAYWALL_ENFORCED`.
 *
 * Par défaut (`false` ou variable absente) la garde n'applique aucun 403, même
 * sur une route `@RequirePro()` : le comportement bêta actuel est préservé.
 * Ce n'est qu'avec `PAYWALL_ENFORCED=true` que l'entitlement est réellement
 * appliqué.
 */
describe("ProEntitlementGuard — PAYWALL_ENFORCED", () => {
  function guardWithFlag(required: boolean, raw: string | undefined) {
    const reflector: any = { getAllAndOverride: jest.fn(() => required) };
    const configService: any = { get: jest.fn(() => raw) };
    return new ProEntitlementGuard(reflector, configService);
  }

  function basicContext() {
    const request = {
      user: { planType: PlanType.BASIC, trialEndsAt: null },
    };
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as any;
  }

  it("PAYWALL_ENFORCED=false → laisse passer un BASIC sans essai (bêta)", () => {
    const guard = guardWithFlag(true, "false");
    expect(guard.canActivate(basicContext())).toBe(true);
  });

  it("PAYWALL_ENFORCED absent → défaut false, laisse passer (bêta)", () => {
    const guard = guardWithFlag(true, undefined);
    expect(guard.canActivate(basicContext())).toBe(true);
  });

  it("PAYWALL_ENFORCED=true → applique le 403 sur un BASIC sans essai", () => {
    const guard = guardWithFlag(true, "true");
    expect(() => guard.canActivate(basicContext())).toThrow(ForbiddenException);
  });

  it("PAYWALL_ENFORCED=true (casse/espaces) → applique le 403", () => {
    const guard = guardWithFlag(true, "  TRUE  ");
    expect(() => guard.canActivate(basicContext())).toThrow(ForbiddenException);
  });

  it("le drapeau n'a aucun effet sur une route sans @RequirePro()", () => {
    const guard = guardWithFlag(false, "true");
    expect(guard.canActivate(basicContext())).toBe(true);
  });
});

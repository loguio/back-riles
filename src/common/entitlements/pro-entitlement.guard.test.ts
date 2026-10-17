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

function createGuard(required: boolean) {
  const reflector: any = { getAllAndOverride: jest.fn(() => required) };
  return { guard: new ProEntitlementGuard(reflector), reflector };
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
    const guard = new ProEntitlementGuard(new Reflector());

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

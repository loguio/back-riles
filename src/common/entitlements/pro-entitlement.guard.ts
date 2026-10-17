import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { User } from "@prisma/client";
import { isPro } from "./entitlements";
import { REQUIRE_PRO_KEY } from "./require-pro.decorator";

/**
 * Phase 5B (B3) — garde d'entitlement Pro.
 *
 * Ne s'active que sur les routes marquées `@RequirePro()` ; les autres passent
 * sans changement. Sur une route Pro, un utilisateur non entitled reçoit un
 * `403 Forbidden`. L'identité provient de `request.user` (posé par le
 * SupabaseAuthGuard global) : jamais d'un en-tête client.
 */
@Injectable()
export class ProEntitlementGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(REQUIRE_PRO_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: User | null }>();

    if (!isPro(request.user)) {
      throw new ForbiddenException(
        "Fonctionnalité réservée à l'offre Pro (abonnement ou essai actif).",
      );
    }

    return true;
  }
}

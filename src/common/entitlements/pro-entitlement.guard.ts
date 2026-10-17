import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { User } from "@prisma/client";
import { isPro } from "./entitlements";
import { REQUIRE_PRO_KEY } from "./require-pro.decorator";

/**
 * Phase 5B (B3/B4) — garde d'entitlement Pro.
 *
 * Ne s'active que sur les routes marquées `@RequirePro()` ; les autres passent
 * sans changement. Sur une route Pro, un utilisateur non entitled reçoit un
 * `403 Forbidden`. L'identité provient de `request.user` (posé par le
 * SupabaseAuthGuard global) : jamais d'un en-tête client.
 *
 * **Interrupteur de lancement (`PAYWALL_ENFORCED`, défaut `false`).** Tant que
 * le drapeau n'est pas `"true"`, la garde laisse passer **tout le monde** sur
 * les routes `@RequirePro()` : le comportement bêta actuel est strictement
 * inchangé. Le jour du lancement payant, poser `PAYWALL_ENFORCED=true` active
 * réellement le 403 (voir `BILLING.md`).
 */
@Injectable()
export class ProEntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  /** `true` uniquement si `PAYWALL_ENFORCED` vaut explicitement `"true"`. */
  private isPaywallEnforced(): boolean {
    const raw = this.configService?.get<string>("PAYWALL_ENFORCED");
    return String(raw ?? "false").toLowerCase() === "true";
  }

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRE_PRO_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      return true;
    }

    // Bêta : le paywall n'est pas encore appliqué, on ne bloque personne.
    if (!this.isPaywallEnforced()) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{ user?: User | null }>();

    if (!isPro(request.user)) {
      throw new ForbiddenException(
        "Fonctionnalité réservée à l'offre Pro (abonnement ou essai actif).",
      );
    }

    return true;
  }
}

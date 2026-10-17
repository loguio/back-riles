import { SetMetadata } from "@nestjs/common";

export const REQUIRE_PRO_KEY = "requirePro";

/**
 * Décorateur @RequirePro() (Phase 5B, B3).
 *
 * Marque une route comme réservée aux utilisateurs Pro (abonnement ou essai
 * actif). Il doit être associé au `ProEntitlementGuard` :
 *
 *   @RequirePro()
 *   @UseGuards(ProEntitlementGuard)
 *   @Get("...")
 *
 * Le défaut `User.planType = PRO` n'étant pas encore basculé, aucune route
 * existante n'est bloquée tant qu'elle ne porte pas ce décorateur.
 */
export const RequirePro = () => SetMetadata(REQUIRE_PRO_KEY, true);

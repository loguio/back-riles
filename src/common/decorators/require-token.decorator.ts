import { SetMetadata } from "@nestjs/common";

export const REQUIRE_TOKEN_KEY = "requireAuthToken";

/**
 * Décorateur @RequireToken()
 * Exige un jeton Bearer présent sur la requête, quel que soit l'environnement.
 *
 * Contrairement à @Public() (qui désactive totalement la garde), ce décorateur
 * est vérifié par le SupabaseAuthGuard AVANT le fallback "invité" de
 * développement (NODE_ENV !== production → utilisateur user-01 sans jeton).
 * Sans lui, un endpoint simplement non-@Public resterait lisible sans
 * authentification en dev/test.
 */
export const RequireToken = () => SetMetadata(REQUIRE_TOKEN_KEY, true);

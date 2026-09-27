import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { User } from "@prisma/client";

/**
 * Décorateur @CurrentUserId()
 * Récupère l'ID de l'utilisateur authentifié depuis request.user (Prisma/Supabase)
 */
export const CurrentUserId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();

    // 1. Depuis l'utilisateur Prisma / JWT injecté par SupabaseAuthGuard
    if (request.user?.id) {
      return request.user.id;
    }

    // 2. Depuis le payload Supabase JWT brut (sub)
    if (request.supabaseUser?.sub) {
      return request.supabaseUser.sub;
    }

    // 3. Depuis le header x-user-id en mode développement
    const headerUserId = request.headers["x-user-id"];
    if (headerUserId && typeof headerUserId === "string") {
      return headerUserId;
    }

    // 4. Fallback utilisateur de test développement
    return "user-01";
  },
);

/**
 * Décorateur @CurrentUser()
 * Récupère l'objet User Prisma complet attaché à la requête
 */
export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): User | null => {
    const request = ctx.switchToHttp().getRequest();
    return request.user ?? null;
  },
);

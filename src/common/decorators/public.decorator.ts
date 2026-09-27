import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/**
 * Décorateur @Public() pour exclure un endpoint ou un contrôleur du SupabaseAuthGuard
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

import { PlanType, User } from "@prisma/client";

/** Champs d'un utilisateur suffisants pour décider de son entitlement Pro. */
export type EntitlementUser =
  | Pick<User, "planType" | "trialEndsAt">
  | null
  | undefined;

/**
 * Phase 5B (B3) — entitlement Pro.
 *
 * Un utilisateur est Pro s'il est abonné (`planType === PRO`) **ou** s'il est
 * en période d'essai non expirée (`trialEndsAt` dans le futur). `now` est
 * injectable pour rendre la règle testable sans horloge globale.
 *
 * `planType` vaut `PRO` par défaut aujourd'hui : `isPro` renvoie donc `true`
 * pour tout le monde tant que le défaut n'est pas basculé. Ce helper ne bloque
 * rien à lui seul — c'est le rôle de `ProEntitlementGuard`.
 */
export function isPro(user: EntitlementUser, now: Date = new Date()): boolean {
  if (!user) {
    return false;
  }
  if (user.planType === PlanType.PRO) {
    return true;
  }
  return user.trialEndsAt != null && user.trialEndsAt.getTime() > now.getTime();
}

-- RILES-034 : essai Pro (Phase 5B, B3) — date de fin d'essai optionnelle.
-- Strictement additif : colonne nullable, aucune donnée existante modifiée.
-- `planType` reste `pro` par défaut : rien n'est bloqué tant que le gating
-- (ProEntitlementGuard) n'est pas branché sur un endpoint.
ALTER TABLE "users" ADD COLUMN "trialEndsAt" TIMESTAMP(3);

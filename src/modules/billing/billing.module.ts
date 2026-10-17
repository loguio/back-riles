import { Logger, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { FakeBillingProvider } from "./fake-billing.provider";
import { BILLING_PROVIDER } from "./billing.types";

/**
 * Phase 5B (B4) — module de facturation.
 *
 * **Point de bascule vers le vrai fournisseur.** Aujourd'hui le seam est
 * branché sur `FakeBillingProvider` (aucun réseau). Pour passer à RevenueCat,
 * remplacer UNIQUEMENT la liaison ci-dessous :
 *
 *   { provide: BILLING_PROVIDER, useClass: RevenueCatBillingProvider }
 *
 * **Fail-closed (RILES-005).** `BILLING_WEBHOOK_SECRET` est requis : aucun
 * secret par défaut repo-connu n'est substitué (cf. `requireWebhookSecret` dans
 * `webhooks.service.ts`). Sans secret, le endpoint public `POST
 * /api/v1/billing/webhook` rejette toute livraison en 401.
 *
 * Voir `BILLING.md`.
 */
@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    {
      provide: BILLING_PROVIDER,
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>("BILLING_WEBHOOK_SECRET");
        if (!secret || secret.trim().length === 0) {
          new Logger(BillingModule.name).error(
            "BILLING_WEBHOOK_SECRET is not configured: every billing webhook delivery is rejected (401, fail-closed).",
          );
          // Secret vide → `verifySignature` refuse toute livraison (401).
          return new FakeBillingProvider("");
        }
        return new FakeBillingProvider(secret);
      },
      inject: [ConfigService],
    },
  ],
  exports: [BillingService],
})
export class BillingModule {}

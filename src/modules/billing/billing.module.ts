import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import {
  FAKE_BILLING_WEBHOOK_SECRET,
  FakeBillingProvider,
} from "./fake-billing.provider";
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
 * Voir `BILLING.md`.
 */
@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    {
      provide: BILLING_PROVIDER,
      useFactory: (config: ConfigService) =>
        new FakeBillingProvider(
          config.get<string>("BILLING_WEBHOOK_SECRET") ||
            FAKE_BILLING_WEBHOOK_SECRET,
        ),
      inject: [ConfigService],
    },
  ],
  exports: [BillingService],
})
export class BillingModule {}

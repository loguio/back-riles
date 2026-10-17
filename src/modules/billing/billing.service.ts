import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { runInTransaction, TransactionClient } from "../../prisma/transaction";
import {
  BILLING_PROVIDER,
  BillingEvent,
  BillingProvider,
  BillingWebhookResult,
} from "./billing.types";

/**
 * Phase 5B (B4) — application des événements de facturation.
 *
 * Le service ne connaît que l'interface `BillingProvider` (injectée via
 * `BILLING_PROVIDER`) : la vérification de signature et le mapping événement →
 * plan sont délégués au provider. Lui se charge de l'**idempotence** et de la
 * persistance (`User.planType` / `User.trialEndsAt`).
 *
 * Idempotence : chaque livraison est enregistrée dans `webhook_events`
 * (provider `billing`, clé unique `(provider, eventType, objectId=eventId)`),
 * exactement comme les webhooks sportifs (RILES-006). Un rejeu — y compris
 * après redémarrage — est intercepté par la contrainte unique.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  async handleWebhook(
    payload: unknown,
    signature?: string,
    rawBody?: Buffer | string,
  ): Promise<BillingWebhookResult> {
    const verified = this.provider.verifyAndParseWebhook(
      payload,
      signature,
      rawBody,
    );
    if (!verified.valid || !verified.event) {
      // Fail-closed : signature/payload invalide rejeté avant toute écriture.
      throw new UnauthorizedException(
        "Invalid billing webhook signature or payload",
      );
    }

    const event = verified.event;
    const change = this.provider.mapEventToPlanChange(event);
    if (!change) {
      this.logger.log(
        `Billing event ${event.eventId} (${event.eventType}) acknowledged with no plan change.`,
      );
      return {
        success: true,
        message: "Billing event acknowledged with no plan change",
      };
    }

    // Utilisateur résolu AVANT d'enregistrer la livraison : un événement pour
    // un utilisateur inconnu n'est pas consommé, il reste rejouable.
    const user = await this.prisma.user.findUnique({
      where: { id: change.userId },
      select: { id: true },
    });
    if (!user) {
      this.logger.warn(
        `Billing event ${event.eventId} dropped: no user ${change.userId}.`,
      );
      throw new NotFoundException("Unknown user for billing event");
    }

    // Livraison + application du plan dans une **seule** transaction : si
    // l'update échoue, l'enregistrement d'idempotence est annulé (rollback) et
    // la livraison reste rejouable — jamais « consommée sans effet ».
    const applied = await runInTransaction(this.prisma, async (tx) => {
      if (await this.recordEvent(event, tx)) {
        return false;
      }

      await tx.user.update({
        where: { id: change.userId },
        data: {
          planType: change.planType,
          trialEndsAt: change.trialEndsAt,
        },
      });
      return true;
    });

    if (!applied) {
      return {
        success: false,
        message: "Duplicate billing delivery ignored (idempotent replay)",
      };
    }

    this.logger.log(
      `Billing plan applied for user ${change.userId}: ${change.planType} (${change.status}).`,
    );
    return {
      success: true,
      message: `Plan updated to ${change.planType} (${change.status})`,
    };
  }

  /** `true` si la livraison est un doublon (déjà enregistrée). */
  private async recordEvent(
    event: BillingEvent,
    client: TransactionClient,
  ): Promise<boolean> {
    try {
      await client.webhookEvent.create({
        data: {
          provider: "billing",
          eventType: event.eventType,
          objectId: event.eventId,
          payload: (event.raw ?? {}) as any,
          processed: true,
          processedAt: new Date(),
        },
      });
      return false;
    } catch (err: any) {
      if (err?.code === "P2002" || err?.meta?.code === "P2002") {
        this.logger.warn(
          `Duplicate billing delivery dropped: billing|${event.eventType}|${event.eventId}`,
        );
        return true;
      }
      throw err;
    }
  }
}

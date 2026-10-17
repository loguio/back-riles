import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { BillingService } from "./billing.service";
import { BillingWebhookDto } from "./dto/billing.dto";

/**
 * Phase 5B (B4) — webhook de facturation.
 *
 * Public comme les webhooks sportifs : la requête est authentifiée par la
 * **signature** du provider (`x-billing-signature`), vérifiée sur le corps brut
 * avant toute écriture. Le prefix global `api/v1` s'applique :
 * `POST /api/v1/billing/webhook`.
 */
@ApiTags("Billing")
@Controller("billing")
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  @Public() // Signature vérifiée par le BillingProvider (fail-closed)
  @ApiOperation({
    summary:
      "Réception d'un événement de facturation (abonnement / essai) — vérifié par signature et idempotent",
  })
  @ApiResponse({
    status: 200,
    description: "Livraison traitée (ou rejeu ignoré)",
  })
  @ApiResponse({ status: 401, description: "Signature ou payload invalide" })
  @ApiResponse({ status: 404, description: "Utilisateur inconnu" })
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: BillingWebhookDto,
    @Headers("x-billing-signature") signature?: string,
  ) {
    // Vérification de signature sur les octets exacts reçus (RILES-005).
    const rawBody = req?.rawBody ?? Buffer.from(JSON.stringify(payload ?? {}));
    return this.billingService.handleWebhook(payload, signature, rawBody);
  }
}

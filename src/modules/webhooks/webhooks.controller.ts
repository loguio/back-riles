import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  RawBodyRequest,
} from "@nestjs/common";
import type { Request } from "express";
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from "@nestjs/swagger";
import { WebhooksService } from "./webhooks.service";
import {
  StravaEventDto,
  GarminWebhookEventDto,
  AppleHealthSyncDto,
  WebhookResponseDto,
} from "./dto/webhook.dto";
import { Public } from "../../common/decorators/public.decorator";

@ApiTags("Webhooks (Sports & Health)")
@Controller("webhooks")
@Public()
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Get("strava")
  @ApiOperation({
    summary:
      "Validation du challenge Strava Webhook (GET Subscription Verification)",
  })
  @ApiQuery({ name: "hub.mode", example: "subscribe" })
  @ApiQuery({
    name: "hub.challenge",
    example: "15f7d8a6fc4e464c3f10151010f459c4",
  })
  @ApiQuery({
    name: "hub.verify_token",
    example: "riles_strava_webhook_token_2026",
  })
  verifyStravaSubscription(
    @Query("hub.mode") mode: string,
    @Query("hub.verify_token") verifyToken: string,
    @Query("hub.challenge") challenge: string,
  ): { "hub.challenge": string } {
    return this.webhooksService.verifyStravaSubscription(
      mode,
      verifyToken,
      challenge,
    );
  }

  @Get("strava/subscription")
  @ApiOperation({
    summary:
      "Consulte la souscription webhook Strava active enregistrée auprès de l'API Strava v3",
  })
  async getStravaSubscription() {
    return this.webhooksService.getStravaSubscription();
  }

  @Post("strava/subscription")
  @ApiOperation({
    summary:
      "Crée ou remplace la souscription webhook push auprès de Strava (nécessite une callbackUrl publique)",
  })
  async createStravaSubscription(
    @Body() body: { callbackUrl: string; verifyToken?: string },
  ) {
    return this.webhooksService.createStravaSubscription(
      body.callbackUrl,
      body.verifyToken,
    );
  }

  @Delete("strava/subscription")
  @ApiOperation({
    summary: "Supprime la souscription webhook push auprès de Strava",
  })
  async deleteStravaSubscription(@Query("id") id?: string) {
    return this.webhooksService.deleteStravaSubscription(
      id ? Number(id) : undefined,
    );
  }

  @Post("strava/sync-recent")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Synchronisation incrémentale à la demande des activités récentes Strava (safety net / app open / pull-to-refresh)",
  })
  async syncRecentActivities(
    @Body() body: { userId?: string; daysLookback?: number },
    @Query("userId") queryUserId?: string,
    @Query("days") queryDays?: string,
  ) {
    const targetUserId =
      body?.userId || queryUserId || "f2b3a1dc-a7ef-4f76-81fa-1533ea06dbe4";
    const days = body?.daysLookback || (queryDays ? Number(queryDays) : 7);
    return this.webhooksService.syncRecentStravaActivities(targetUserId, days);
  }

  @Get("strava/oauth/url")
  @ApiOperation({
    summary:
      "Génère l'URL d'autorisation OAuth2 Strava (scope activity:read_all,profile:read_all)",
  })
  @ApiQuery({ name: "redirectUri", required: false })
  getStravaOAuthUrl(@Query("redirectUri") redirectUri?: string) {
    return this.webhooksService.getStravaOAuthAuthorizeUrl(redirectUri);
  }

  @Get("strava/oauth/callback")
  @ApiOperation({
    summary:
      "Callback OAuth2 Strava direct : échange le code contre access_token/refresh_token et synchronise les 6 derniers mois d'activités",
  })
  @ApiQuery({ name: "code", required: false })
  @ApiQuery({ name: "state", required: false, description: "userId optionnel" })
  async handleStravaOAuthCallback(
    @Query("code") code?: string,
    @Query("state") state?: string,
    @Res() res?: any,
  ) {
    const userId = state || "demo-user-marius-2026";
    const summary = await this.webhooksService.syncStravaSixMonthsHistory(
      userId,
      {
        code,
        forceRefresh: true,
      },
    );
    if (res && typeof res.redirect === "function") {
      return res.redirect(
        "http://localhost:8081/onboarding?step=4&strava_synced=true",
      );
    }
    return {
      status: "ok",
      provider: "strava",
      userId,
      oauthCodeExchanged: Boolean(code),
      sixMonthsSummary: summary,
    };
  }

  @Post("strava")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Réception d’un événement d’activité Strava (POST Activity Event)",
  })
  @ApiResponse({ status: 200, type: WebhookResponseDto })
  async handleStravaEvent(
    @Req() req: RawBodyRequest<Request>,
    @Body() event: StravaEventDto,
  ): Promise<WebhookResponseDto> {
    // RILES-005 : vérification HMAC sur le corps brut AVANT toute écriture.
    this.webhooksService.verifyStravaSignature(
      req?.rawBody,
      req?.headers?.["x-hub-signature"],
    );
    return this.webhooksService.handleStravaEvent(event);
  }

  @Post("garmin")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Réception des données Garmin Health / Activités" })
  @ApiResponse({ status: 200, type: WebhookResponseDto })
  async handleGarminEvent(
    @Req() req: RawBodyRequest<Request>,
    @Body() event: GarminWebhookEventDto,
  ): Promise<WebhookResponseDto> {
    // RILES-005 : vérification HMAC sur le corps brut AVANT toute écriture.
    this.webhooksService.verifyGarminSignature(
      req?.rawBody,
      req?.headers?.["x-garmin-signature"],
    );
    return this.webhooksService.handleGarminEvent(event);
  }

  @Post("apple-health")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Synchronisation sécurisée des séances Apple Santé",
  })
  @ApiResponse({ status: 200, type: WebhookResponseDto })
  async handleAppleHealthSync(
    @Req() req: RawBodyRequest<Request>,
    @Body() dto: AppleHealthSyncDto,
  ): Promise<WebhookResponseDto> {
    // RILES-005 : secret partagé vérifié AVANT toute écriture.
    this.webhooksService.verifyAppleHealthSecret(
      req?.headers?.["x-apple-health-secret"],
    );
    return this.webhooksService.handleAppleHealthSync(dto);
  }
}

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
  ForbiddenException,
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
import { CurrentUserId } from "../../common/decorators/current-user.decorator";

@ApiTags("Webhooks (Sports & Health)")
@Controller("webhooks")
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
  @Public() // Authentifié par hub.verify_token (fail-closed, RILES-007)
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
    @CurrentUserId() currentUserId: string,
    @Body() body: { userId?: string; daysLookback?: number },
    @Query("userId") queryUserId?: string,
    @Query("days") queryDays?: string,
  ) {
    // RILES-007 : l'appelant ne peut synchroniser que SES propres données.
    const requestedUserId = body?.userId || queryUserId;
    if (requestedUserId && requestedUserId !== currentUserId) {
      throw new ForbiddenException(
        "You can only synchronize your own activities",
      );
    }
    const targetUserId = requestedUserId || currentUserId;
    const days = body?.daysLookback || (queryDays ? Number(queryDays) : 7);
    return this.webhooksService.syncRecentStravaActivities(targetUserId, days);
  }

  @Get("strava/oauth/url")
  @ApiOperation({
    summary:
      "Génère l'URL d'autorisation OAuth2 Strava (scope activity:read_all,profile:read_all)",
  })
  @ApiQuery({ name: "redirectUri", required: false })
  getStravaOAuthUrl(
    @CurrentUserId() userId: string,
    @Query("redirectUri") redirectUri?: string,
  ) {
    // RILES-007 : le state est émis pour l'utilisateur authentifié appelant.
    return this.webhooksService.getStravaOAuthAuthorizeUrl(redirectUri, userId);
  }

  @Get("strava/oauth/callback")
  @ApiOperation({
    summary:
      "Callback OAuth2 Strava direct : échange le code contre access_token/refresh_token et synchronise les 6 derniers mois d'activités",
  })
  @ApiQuery({ name: "code", required: false })
  @ApiQuery({
    name: "state",
    required: false,
    description: "state émis par /webhooks/strava/oauth/url (userId.nonce)",
  })
  @Public() // Redirection navigateur Strava : protégée par la vérification du state
  async handleStravaOAuthCallback(
    @Query("code") code?: string,
    @Query("state") state?: string,
    @Res() res?: any,
  ) {
    // RILES-007 : state = nonce aléatoire lié à l'appelant, vérifié et
    // consommé côté serveur (anti login-CSRF).Tout échec est rejeté.
    const userId = this.webhooksService.verifyOAuthState(state);
    const summary = await this.webhooksService.syncStravaSixMonthsHistory(
      userId,
      {
        code,
        forceRefresh: true,
      },
    );
    if (res && typeof res.redirect === "function") {
      return res.redirect(this.webhooksService.getOAuthSuccessRedirect());
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
  @Public() // Signature HMAC vérifiée dans le handler (RILES-005)
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
  @Public() // Signature HMAC vérifiée dans le handler (RILES-005)
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
  @Public() // Secret partagé vérifié dans le handler (RILES-005)
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

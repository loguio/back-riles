import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
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

  @Post("strava")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Réception d’un événement d’activité Strava (POST Activity Event)",
  })
  @ApiResponse({ status: 200, type: WebhookResponseDto })
  async handleStravaEvent(
    @Body() event: StravaEventDto,
  ): Promise<WebhookResponseDto> {
    return this.webhooksService.handleStravaEvent(event);
  }

  @Post("garmin")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Réception des données Garmin Health / Activités" })
  @ApiResponse({ status: 200, type: WebhookResponseDto })
  async handleGarminEvent(
    @Body() event: GarminWebhookEventDto,
  ): Promise<WebhookResponseDto> {
    return this.webhooksService.handleGarminEvent(event);
  }

  @Post("apple-health")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Synchronisation sécurisée des séances Apple Santé",
  })
  @ApiResponse({ status: 200, type: WebhookResponseDto })
  async handleAppleHealthSync(
    @Body() dto: AppleHealthSyncDto,
  ): Promise<WebhookResponseDto> {
    return this.webhooksService.handleAppleHealthSync(dto);
  }
}

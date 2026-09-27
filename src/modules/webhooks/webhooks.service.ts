import { Injectable, UnauthorizedException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import {
  StravaEventDto,
  GarminWebhookEventDto,
  AppleHealthSyncDto,
  WebhookResponseDto,
} from "./dto/webhook.dto";
import { WorkoutStatus } from "@prisma/client";

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  verifyStravaSubscription(
    mode: string,
    verifyToken: string,
    challenge: string,
  ): { "hub.challenge": string } {
    const expectedToken = this.configService.get<string>(
      "STRAVA_VERIFY_TOKEN",
      "riles_strava_webhook_token_2026",
    );

    if (mode === "subscribe" && verifyToken === expectedToken) {
      this.logger.log("Strava Webhook subscription verified successfully.");
      return { "hub.challenge": challenge };
    }

    throw new UnauthorizedException("Invalid Strava verification token");
  }

  async handleStravaEvent(event: StravaEventDto): Promise<WebhookResponseDto> {
    this.logger.log(`Received Strava webhook event: ${JSON.stringify(event)}`);

    // Log raw webhook event
    await this.prisma.webhookEvent.create({
      data: {
        provider: "strava",
        eventType: `${event.object_type}.${event.aspect_type}`,
        payload: event as any,
        processed: true,
        processedAt: new Date(),
      },
    });

    if (event.object_type === "activity" && event.aspect_type === "create") {
      // Find matching sync token to determine user
      const syncToken = await this.prisma.syncToken.findFirst({
        where: {
          provider: "strava",
          externalUserId: String(event.owner_id),
        },
      });

      const userId = syncToken?.userId || "user-01";

      // Automatically mark current active workout as done
      const todayKey = new Date().toISOString().split("T")[0];
      const workout = await this.prisma.workout.findFirst({
        where: {
          userId,
          OR: [{ dateKey: todayKey }, { status: WorkoutStatus.SELECTED }],
        },
      });

      if (workout) {
        await this.prisma.workout.update({
          where: { id: workout.id },
          data: {
            status: WorkoutStatus.DONE,
            aiAdjustmentNote: "Séance synchronisée et validée depuis Strava.",
          },
        });
        this.logger.log(`Workout ${workout.id} marked as DONE from Strava.`);
      }
    }

    return {
      success: true,
      message: "Strava activity ingested successfully",
    };
  }

  async handleGarminEvent(
    event: GarminWebhookEventDto,
  ): Promise<WebhookResponseDto> {
    this.logger.log(`Received Garmin webhook event for user: ${event.userId}`);

    await this.prisma.webhookEvent.create({
      data: {
        provider: "garmin",
        eventType: event.type,
        payload: event as any,
        processed: true,
        processedAt: new Date(),
      },
    });

    return {
      success: true,
      message: "Garmin data ingested successfully",
    };
  }

  async handleAppleHealthSync(
    dto: AppleHealthSyncDto,
  ): Promise<WebhookResponseDto> {
    this.logger.log(`Received Apple Health sync for user: ${dto.userId}`);

    await this.prisma.webhookEvent.create({
      data: {
        provider: "apple_health",
        eventType: dto.activityType,
        payload: dto as any,
        processed: true,
        processedAt: new Date(),
      },
    });

    // Mark matching workout as completed if running
    if (dto.activityType === "running") {
      const dateKey = dto.startDate.split("T")[0];
      const workout = await this.prisma.workout.findFirst({
        where: {
          userId: dto.userId,
          OR: [{ dateKey }, { status: WorkoutStatus.SELECTED }],
        },
      });

      if (workout) {
        await this.prisma.workout.update({
          where: { id: workout.id },
          data: {
            status: WorkoutStatus.DONE,
            aiAdjustmentNote: `Séance synchronisée via Apple Santé (${(dto.distanceMeters / 1000).toFixed(1)} km).`,
          },
        });
      }
    }

    return {
      success: true,
      message: "Apple Health data synced successfully",
    };
  }
}

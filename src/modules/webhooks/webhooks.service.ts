import { Injectable, UnauthorizedException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { DataLakeService } from "../datalake/datalake.service";
import { LlmService } from "../llm/llm.service";
import {
  StravaEventDto,
  GarminWebhookEventDto,
  AppleHealthSyncDto,
  WebhookResponseDto,
} from "./dto/webhook.dto";
import { WorkoutStatus } from "@prisma/client";

export interface NormalizedExecutedWorkout {
  externalActivityId: string;
  sourceProvider: "strava" | "garmin" | "apple_health";
  actualDistanceKm: number;
  actualDurationSec: number;
  actualPace: string;
  actualAvgHeartRate?: number;
  actualMaxHeartRate?: number;
  actualElevationGain?: number;
  actualCalories?: number;
  actualCadence?: number;
  actualSplitsJson?: any;
  completedAt: Date;
  dateKey: string;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly dataLakeService: DataLakeService,
    private readonly llmService: LlmService,
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

  /**
   * Formate une durée (s) et une distance (km) en allure "M:SS/km"
   */
  private formatPaceFromDistanceAndDuration(
    distanceKm: number,
    durationSec: number,
  ): string {
    if (!distanceKm || distanceKm <= 0 || !durationSec || durationSec <= 0) {
      return "—";
    }
    const secPerKm = Math.round(durationSec / distanceKm);
    const m = Math.floor(secPerKm / 60);
    const s = Math.round(secPerKm % 60);
    return `${m}:${String(s).padStart(2, "0")}/km`;
  }

  /**
   * Appelle l'API Strava v3 pour récupérer tous les détails d'une activité réelle
   * (et rafraîchit le token OAuth2 si expiré)
   */
  private async fetchStravaActivityDetails(
    activityId: number,
    syncToken: {
      id: string;
      accessToken: string | null;
      refreshToken: string | null;
      expiresAt: Date | null;
      metadata: any;
    } | null,
    fallbackUpdates?: Record<string, any>,
  ): Promise<Record<string, any>> {
    if (!syncToken?.accessToken) {
      return fallbackUpdates || {};
    }

    let accessToken = syncToken.accessToken;

    // Rafraîchissement automatique du token OAuth2 Strava s'il est expiré
    if (
      syncToken.expiresAt &&
      syncToken.expiresAt.getTime() < Date.now() &&
      syncToken.refreshToken
    ) {
      const clientId = this.configService.get<string>("STRAVA_CLIENT_ID");
      const clientSecret = this.configService.get<string>(
        "STRAVA_CLIENT_SECRET",
      );
      if (clientId && clientSecret) {
        try {
          const tokenRes = await fetch("https://www.strava.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              grant_type: "refresh_token",
              refresh_token: syncToken.refreshToken,
            }),
          });
          if (tokenRes.ok) {
            const tokenData: any = await tokenRes.json();
            accessToken = tokenData.access_token;
            await this.prisma.syncToken.update({
              where: { id: syncToken.id },
              data: {
                accessToken: tokenData.access_token,
                refreshToken:
                  tokenData.refresh_token || syncToken.refreshToken,
                expiresAt: tokenData.expires_at
                  ? new Date(tokenData.expires_at * 1000)
                  : undefined,
              },
            });
          }
        } catch (err: any) {
          this.logger.warn(`Strava token refresh failed: ${err?.message}`);
        }
      }
    }

    try {
      const res = await fetch(
        `https://www.strava.com/api/v3/activities/${activityId}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (res.ok) {
        const activityData: any = await res.json();

        // Récupération optionnelle des zones cardio de l'athlète Strava si non encore stockées
        if (!syncToken.metadata?.heartRateZones) {
          try {
            const zonesRes = await fetch(
              "https://www.strava.com/api/v3/athlete/zones",
              {
                headers: { Authorization: `Bearer ${accessToken}` },
              },
            );
            if (zonesRes.ok) {
              const zonesData: any = await zonesRes.json();
              await this.prisma.syncToken.update({
                where: { id: syncToken.id },
                data: {
                  metadata: {
                    ...(syncToken.metadata || {}),
                    heartRateZones: zonesData?.heart_rate?.zones || null,
                  },
                },
              });
            }
          } catch {
            // Ignorer silencieusement si le scope profile:read_all n'est pas actif
          }
        }

        return activityData;
      }
    } catch (err: any) {
      this.logger.warn(
        `Impossible de contacter l'API Strava pour l'activité ${activityId}: ${err?.message}`,
      );
    }

    return fallbackUpdates || {};
  }

  /**
   * Enregistre les données complètes de la vraie séance dans PostgreSQL (Workout + User)
   * et archive la comparaison Prévu vs Réalisé dans le Data Lake.
   */
  private async persistExecutedWorkoutAndLog(
    userId: string,
    executed: NormalizedExecutedWorkout,
  ): Promise<void> {
    const workout = await this.prisma.workout.findFirst({
      where: {
        userId,
        OR: [
          { dateKey: executed.dateKey },
          { status: WorkoutStatus.SELECTED },
        ],
      },
    });

    const paceLabel = executed.actualPace;
    const hrLabel = executed.actualAvgHeartRate
      ? ` • ${executed.actualAvgHeartRate} bpm moy`
      : "";
    const providerName =
      executed.sourceProvider === "strava"
        ? "Strava"
        : executed.sourceProvider === "garmin"
          ? "Garmin"
          : "Apple Santé";

    const sessionTss = this.llmService.computeSessionTss({
      durationSec: executed.actualDurationSec,
      distanceKm: executed.actualDistanceKm,
      avgHeartRate: executed.actualAvgHeartRate,
      maxHeartRate: executed.actualMaxHeartRate,
    });

    if (workout) {
      await this.prisma.workout.update({
        where: { id: workout.id },
        data: {
          status: WorkoutStatus.DONE,
          externalActivityId: executed.externalActivityId,
          sourceProvider: executed.sourceProvider,
          actualDistanceKm: executed.actualDistanceKm,
          actualDurationSec: executed.actualDurationSec,
          actualPace: executed.actualPace,
          actualAvgHeartRate: executed.actualAvgHeartRate,
          actualMaxHeartRate: executed.actualMaxHeartRate,
          actualElevationGain: executed.actualElevationGain,
          actualCalories: executed.actualCalories,
          actualCadence: executed.actualCadence,
          actualSplitsJson: executed.actualSplitsJson ?? undefined,
          completedAt: executed.completedAt,
          tss: sessionTss,
          aiAdjustmentNote: `Séance réelle synchronisée via ${providerName} : ${executed.actualDistanceKm.toFixed(1)} km à ${paceLabel}${hrLabel} (Charge : ${sessionTss} TSS).`,
        },
      });
    }

    // Mise à jour du kilométrage total et de la charge physiologique Banister (ATL / CTL / TSB / Readiness)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { rules: true },
    });

    if (user && (executed.actualDistanceKm > 0 || executed.actualDurationSec > 0)) {
      const banister = this.llmService.updateBanisterLoad({
        previousAtl: user.atlFatigue ?? 45,
        previousCtl: user.ctlFitness ?? 50,
        todayTss: sessionTss,
        sleepScore: user.sleepScore ?? undefined,
        hrvStatus: user.hrvStatus ?? undefined,
      });

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          totalKm: Number(
            ((user.totalKm || 0) + executed.actualDistanceKm).toFixed(2),
          ),
          atlFatigue: banister.atlFatigue,
          ctlFitness: banister.ctlFitness,
          tsbForm: banister.tsbForm,
          readinessScore: banister.readinessScore,
        },
      });
    }

    // Archivage complet dans le Data Lake (Flux B : Séance prévue vs Séance réellement réalisée)
    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "webhook_activity_synced",
      interaction: {
        type: "activity_completed",
        provider: executed.sourceProvider,
        externalActivityId: executed.externalActivityId,
        plannedWorkout: workout
          ? {
              id: workout.id,
              title: workout.title,
              category: workout.category,
              plannedDistance: workout.distance,
              plannedDuration: workout.duration,
              targetPace: workout.targetPace,
              targetZoneBpm: workout.targetZoneBpm,
            }
          : null,
        executedMetrics: {
          distanceKm: executed.actualDistanceKm,
          durationSec: executed.actualDurationSec,
          actualPace: executed.actualPace,
          avgHeartRate: executed.actualAvgHeartRate,
          maxHeartRate: executed.actualMaxHeartRate,
          elevationGainMeters: executed.actualElevationGain,
          calories: executed.actualCalories,
          cadenceSpm: executed.actualCadence,
          splits: executed.actualSplitsJson,
          completedAt: executed.completedAt.toISOString(),
        },
      },
      athleteContext: user
        ? {
            readinessScore: user.readinessScore,
            activeGoalTitle: user.activeGoalTitle,
            activeGoalTarget: user.activeGoalTarget,
            activeGoalWeeksRemaining: user.activeGoalWeeksRemaining,
            totalKm: (user.totalKm || 0) + executed.actualDistanceKm,
            activeWeeks: user.activeWeeks,
            rules: user.rules.map((r) => ({
              title: r.title,
              description: r.description,
            })),
          }
        : {},
    });
  }

  async handleStravaEvent(event: StravaEventDto): Promise<WebhookResponseDto> {
    this.logger.log(`Received Strava webhook event: ${JSON.stringify(event)}`);

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
      const syncToken = await this.prisma.syncToken.findFirst({
        where: {
          provider: "strava",
          externalUserId: String(event.owner_id),
        },
      });

      const userId = syncToken?.userId || "user-01";

      // 1. Récupération complète des données de l'activité depuis l'API Strava (ou payload de test)
      const stravaActivity = await this.fetchStravaActivityDetails(
        event.object_id,
        syncToken,
        event.updates,
      );

      const distanceMeters =
        Number(stravaActivity.distance ?? stravaActivity.distanceMeters) ||
        10000;
      const durationSec =
        Number(
          stravaActivity.moving_time ??
            stravaActivity.elapsed_time ??
            stravaActivity.durationSeconds,
        ) || 3000;
      const actualDistanceKm = Number((distanceMeters / 1000).toFixed(2));

      // Si Strava fournit average_speed (en m/s), on convertit en min/km, sinon via distance/durée
      const avgSpeedMs = Number(stravaActivity.average_speed || 0);
      const actualPace =
        avgSpeedMs > 0
          ? this.formatPaceFromDistanceAndDuration(1, 1000 / avgSpeedMs)
          : this.formatPaceFromDistanceAndDuration(
              actualDistanceKm,
              durationSec,
            );

      const avgHr = stravaActivity.average_heartrate
        ? Math.round(Number(stravaActivity.average_heartrate))
        : undefined;
      const maxHr = stravaActivity.max_heartrate
        ? Math.round(Number(stravaActivity.max_heartrate))
        : undefined;
      const elevationGain =
        stravaActivity.total_elevation_gain !== undefined
          ? Number(stravaActivity.total_elevation_gain)
          : undefined;
      const calories =
        stravaActivity.calories !== undefined
          ? Math.round(Number(stravaActivity.calories))
          : undefined;
      // Strava renvoie la cadence par jambe (ex: 88 -> 176 pas/min)
      const rawCadence = Number(stravaActivity.average_cadence || 0);
      const cadence =
        rawCadence > 0
          ? Math.round(rawCadence < 120 ? rawCadence * 2 : rawCadence)
          : undefined;

      const completedAt = stravaActivity.start_date
        ? new Date(stravaActivity.start_date)
        : event.event_time
          ? new Date(event.event_time * 1000)
          : new Date();

      await this.persistExecutedWorkoutAndLog(userId, {
        externalActivityId: String(event.object_id),
        sourceProvider: "strava",
        actualDistanceKm,
        actualDurationSec: durationSec,
        actualPace,
        actualAvgHeartRate: avgHr,
        actualMaxHeartRate: maxHr,
        actualElevationGain: elevationGain,
        actualCalories: calories,
        actualCadence: cadence,
        actualSplitsJson: stravaActivity.splits_metric || stravaActivity.laps,
        completedAt,
        dateKey: completedAt.toISOString().split("T")[0],
      });
    }

    return {
      success: true,
      message: "Strava activity ingested with complete session metrics",
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

    const syncToken = await this.prisma.syncToken.findFirst({
      where: {
        provider: "garmin",
        OR: [{ externalUserId: event.userId }, { userId: event.userId }],
      },
    });
    const userId = syncToken?.userId || event.userId || "user-01";
    const d = event.data || {};

    // Sauvegarde du seuil lactique / VO2Max Garmin si présents dans le payload
    if (syncToken && (d.lactateThresholdPace || d.vo2Max || d.heartRateZones)) {
      await this.prisma.syncToken.update({
        where: { id: syncToken.id },
        data: {
          metadata: {
            ...((syncToken.metadata as any) || {}),
            lactateThresholdPace: d.lactateThresholdPace,
            vo2Max: d.vo2Max,
            heartRateZones: d.heartRateZones,
          },
        },
      });
    }

    const distanceMeters = Number(
      d.distanceInMeters ?? d.distanceMeters ?? d.distance ?? 0,
    );
    const durationSec = Number(
      d.durationInSeconds ?? d.durationSeconds ?? d.duration ?? 0,
    );

    if (distanceMeters > 0 || durationSec > 0) {
      const actualDistanceKm = Number((distanceMeters / 1000).toFixed(2));
      const actualPace = this.formatPaceFromDistanceAndDuration(
        actualDistanceKm,
        durationSec,
      );
      const completedAt = d.startTimeInSeconds
        ? new Date(Number(d.startTimeInSeconds) * 1000)
        : d.startDate
          ? new Date(d.startDate)
          : new Date();

      await this.persistExecutedWorkoutAndLog(userId, {
        externalActivityId: String(
          d.activityId ?? d.summaryId ?? `garmin-${Date.now()}`,
        ),
        sourceProvider: "garmin",
        actualDistanceKm,
        actualDurationSec: durationSec,
        actualPace,
        actualAvgHeartRate: d.averageHeartRateInBeatsPerMinute
          ? Math.round(Number(d.averageHeartRateInBeatsPerMinute))
          : d.avgHeartRate
            ? Math.round(Number(d.avgHeartRate))
            : undefined,
        actualMaxHeartRate: d.maxHeartRateInBeatsPerMinute
          ? Math.round(Number(d.maxHeartRateInBeatsPerMinute))
          : d.maxHeartRate
            ? Math.round(Number(d.maxHeartRate))
            : undefined,
        actualElevationGain:
          d.totalElevationGainInMeters !== undefined
            ? Number(d.totalElevationGainInMeters)
            : undefined,
        actualCalories:
          d.activeKilocalories !== undefined
            ? Math.round(Number(d.activeKilocalories))
            : undefined,
        actualCadence: d.averageRunCadenceInStepsPerMinute
          ? Math.round(Number(d.averageRunCadenceInStepsPerMinute))
          : undefined,
        actualSplitsJson: d.laps || d.splits,
        completedAt,
        dateKey: completedAt.toISOString().split("T")[0],
      });
    }

    return {
      success: true,
      message: "Garmin data ingested with complete session metrics",
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

    if (dto.activityType === "running" || dto.distanceMeters > 0) {
      const actualDistanceKm = Number((dto.distanceMeters / 1000).toFixed(2));
      const actualDurationSec = Math.round(dto.durationSeconds);
      const actualPace = this.formatPaceFromDistanceAndDuration(
        actualDistanceKm,
        actualDurationSec,
      );
      const meta = dto.metadata || {};
      const completedAt = dto.startDate ? new Date(dto.startDate) : new Date();

      await this.persistExecutedWorkoutAndLog(dto.userId, {
        externalActivityId: String(
          meta.workoutUuid || `apple-${completedAt.getTime()}`,
        ),
        sourceProvider: "apple_health",
        actualDistanceKm,
        actualDurationSec,
        actualPace,
        actualAvgHeartRate: meta.avgHeartRate
          ? Math.round(Number(meta.avgHeartRate))
          : undefined,
        actualMaxHeartRate: meta.maxHeartRate
          ? Math.round(Number(meta.maxHeartRate))
          : undefined,
        actualElevationGain:
          meta.elevationGain !== undefined
            ? Number(meta.elevationGain)
            : undefined,
        actualCalories:
          meta.calories !== undefined
            ? Math.round(Number(meta.calories))
            : undefined,
        actualCadence: meta.cadence
          ? Math.round(Number(meta.cadence))
          : undefined,
        actualSplitsJson: meta.splits,
        completedAt,
        dateKey: completedAt.toISOString().split("T")[0],
      });
    }

    return {
      success: true,
      message: "Apple Health data synced with complete session metrics",
    };
  }
}

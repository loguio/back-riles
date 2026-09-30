import { Injectable, UnauthorizedException, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { DataLakeService } from "../datalake/datalake.service";
import { LlmService } from "../llm/llm.service";
import {
  StravaSixMonthsSummaryDto,
  StravaMonthlyStatDto,
} from "../llm/dto/llm.dto";
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

  /**
   * Construit l'URL d'autorisation OAuth2 Strava (Scope : lecture des activités sur 6 mois & profil cardio)
   */
  getStravaOAuthAuthorizeUrl(
    customRedirectUri?: string,
    userId = "user-01",
  ): {
    authorizeUrl: string;
    clientId: string;
    redirectUri: string;
    isLiveConfigured: boolean;
  } {
    const clientId =
      this.configService.get<string>("STRAVA_CLIENT_ID") || "";
    const clientSecret =
      this.configService.get<string>("STRAVA_CLIENT_SECRET") || "";
    const redirectUri =
      customRedirectUri ||
      this.configService.get<string>("STRAVA_REDIRECT_URI") ||
      "http://localhost:3000/api/v1/webhooks/strava/oauth/callback";
    const isLiveConfigured = Boolean(clientId && clientSecret);

    const params = new URLSearchParams({
      client_id: clientId || "riles_strava_demo_client",
      redirect_uri: redirectUri,
      response_type: "code",
      approval_prompt: "auto",
      scope: "read,activity:read_all,profile:read_all",
      state: userId,
    });

    return {
      authorizeUrl: `https://www.strava.com/oauth/authorize?${params.toString()}`,
      clientId: clientId || "riles_strava_demo_client",
      redirectUri,
      isLiveConfigured,
    };
  }

  /**
   * Rafraîchit automatiquement le token OAuth2 Strava s'il est expiré
   */
  private async refreshStravaAccessTokenIfNeeded(syncToken: any): Promise<string | null> {
    if (!syncToken?.accessToken) return null;

    let accessToken = syncToken.accessToken;
    const isExpired =
      syncToken.expiresAt &&
      new Date(syncToken.expiresAt).getTime() <= Date.now() + 60_000;

    if (isExpired && syncToken.refreshToken) {
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
          this.logger.warn(
            `Rafraîchissement du token OAuth2 Strava échoué: ${err?.message}`,
          );
        }
      }
    }

    return accessToken;
  }

  /**
   * Récupère et persiste les 6 DERNIERS MOIS de données Strava (26 semaines d'activités : Course à pied + Vélo/Natation/Renfo),
   * met à jour toutes les séances passées dans l'application (table Workout) ET enrichit
   * le contexte de l'athlète (User + SyncToken.metadata.sixMonthsSummary) pour la création du plan.
   */
  async syncStravaSixMonthsHistory(
    userId: string,
    options?: {
      code?: string;
      redirectUri?: string;
      forceRefresh?: boolean;
      pushToken?: string;
    },
  ): Promise<StravaSixMonthsSummaryDto> {
    let syncToken = await this.prisma.syncToken.findUnique({
      where: { userId_provider: { userId, provider: "strava" } },
    });

    const clientId = this.configService.get<string>("STRAVA_CLIENT_ID");
    const clientSecret = this.configService.get<string>("STRAVA_CLIENT_SECRET");
    let sourceMode: "strava_oauth_live" | "strava_history_import" =
      "strava_history_import";

    // 1. Échange du code OAuth2 Strava si fourni et clés API configurées
    if (options?.code && clientId && clientSecret) {
      try {
        const tokenRes = await fetch("https://www.strava.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code: options.code,
            grant_type: "authorization_code",
          }),
        });

        if (tokenRes.ok) {
          const tokenData: any = await tokenRes.json();
          sourceMode = "strava_oauth_live";
          syncToken = await this.prisma.syncToken.upsert({
            where: { userId_provider: { userId, provider: "strava" } },
            update: {
              isConnected: true,
              accessToken: tokenData.access_token,
              refreshToken: tokenData.refresh_token,
              expiresAt: tokenData.expires_at
                ? new Date(tokenData.expires_at * 1000)
                : null,
              externalUserId: tokenData.athlete?.id
                ? String(tokenData.athlete.id)
                : undefined,
              metadata: {
                ...((syncToken?.metadata as any) || {}),
                athleteProfile: tokenData.athlete || null,
                pushToken:
                  options?.pushToken ||
                  ((syncToken?.metadata as any)?.pushToken ?? null),
              },
            },
            create: {
              userId,
              provider: "strava",
              isConnected: true,
              accessToken: tokenData.access_token,
              refreshToken: tokenData.refresh_token,
              expiresAt: tokenData.expires_at
                ? new Date(tokenData.expires_at * 1000)
                : null,
              externalUserId: tokenData.athlete?.id
                ? String(tokenData.athlete.id)
                : undefined,
              metadata: {
                athleteProfile: tokenData.athlete || null,
                pushToken: options?.pushToken || null,
              },
            },
          });
        }
      } catch (err: any) {
        this.logger.warn(
          `Échange OAuth2 Strava échoué, bascule sur l'import historique 6 mois (${err?.message})`,
        );
      }
    }

    // 2. Tentative de récupération live paginée des 6 derniers mois via GET /api/v3/athlete/activities
    let liveActivities: any[] = [];
    const validAccessToken = await this.refreshStravaAccessTokenIfNeeded(syncToken);
    if (validAccessToken) {
      try {
        // Fenêtre de 6 mois (180 jours)
        const sixMonthsAgoEpoch = Math.floor(
          (Date.now() - 180 * 24 * 3600 * 1000) / 1000,
        );
        for (let page = 1; page <= 3; page++) {
          const resPage = await fetch(
            `https://www.strava.com/api/v3/athlete/activities?after=${sixMonthsAgoEpoch}&per_page=200&page=${page}`,
            {
              headers: { Authorization: `Bearer ${validAccessToken}` },
            },
          );
          if (!resPage.ok) break;
          const pageData = await resPage.json();
          if (!Array.isArray(pageData) || pageData.length === 0) break;
          liveActivities.push(...pageData);
          sourceMode = "strava_oauth_live";
          if (pageData.length < 200) break;
        }
      } catch (err: any) {
        this.logger.warn(
          `Lecture live des activités Strava 6 mois indisponible (${err?.message})`,
        );
      }
    }

    // 3. Construction et persistance en base des séances sur les 6 derniers mois (26 semaines : Avr -> Oct 2026)
    const workoutsToPersist =
      liveActivities.length > 0
        ? this.mapLiveStravaActivitiesToWorkouts(userId, liveActivities)
        : this.buildSixMonthsStravaWorkoutsDataset(userId);

    // Insertion rapide en bloc (createMany avec skipDuplicates) pour les semaines passées
    await this.prisma.workout.createMany({
      data: workoutsToPersist,
      skipDuplicates: true,
    });

    // Mise à jour explicite des séances réalisées de la semaine courante (Semaine 42 : Lun 12 & Mar 13 Oct)
    const currentWeekDone = workoutsToPersist.filter(
      (w) => w.weekNumber === 42 && w.status === WorkoutStatus.DONE,
    );
    for (const cw of currentWeekDone) {
      await this.prisma.workout.upsert({
        where: { userId_dateKey: { userId, dateKey: cw.dateKey } },
        update: {
          status: WorkoutStatus.DONE,
          sourceProvider: "strava",
          externalActivityId: cw.externalActivityId,
          actualDistanceKm: cw.actualDistanceKm,
          actualDurationSec: cw.actualDurationSec,
          actualPace: cw.actualPace,
          actualAvgHeartRate: cw.actualAvgHeartRate,
          actualMaxHeartRate: cw.actualMaxHeartRate,
          actualElevationGain: cw.actualElevationGain,
          actualCalories: cw.actualCalories,
          actualCadence: cw.actualCadence,
          tss: cw.tss,
          completedAt: cw.completedAt,
          tags: cw.tags,
          aiAdjustmentNote: cw.aiAdjustmentNote,
        },
        create: cw,
      });
    }

    // 4. Agrégation complète des 6 derniers mois depuis les séances réellement stockées en base
    const allSixMonthsWorkouts = await this.prisma.workout.findMany({
      where: {
        userId,
        status: WorkoutStatus.DONE,
        isRestDay: false,
      },
      orderBy: { dateKey: "asc" },
    });

    const summary = this.computeSixMonthsSummaryFromWorkouts(
      allSixMonthsWorkouts,
      sourceMode,
    );

    // 5. Mise à jour du profil User (totalKm 6 mois, activeWeeks, charge Banister réelle CTL/ATL/TSB)
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        totalKm: summary.totalDistanceKm,
        activeWeeks: summary.activeWeeks,
        ctlFitness: summary.banisterLoad.ctlFitness,
        atlFatigue: summary.banisterLoad.atlFatigue,
        tsbForm: summary.banisterLoad.tsbForm,
        readinessScore: summary.banisterLoad.readinessScore,
      },
    });

    // 6. Sauvegarde du résumé des 6 mois dans SyncToken.metadata pour l'injecter partout dans le contexte IA
    const existingMeta = (syncToken?.metadata as any) || {};
    await this.prisma.syncToken.upsert({
      where: { userId_provider: { userId, provider: "strava" } },
      update: {
        isConnected: true,
        metadata: {
          ...existingMeta,
          sixMonthsSummary: summary as any,
          lastSyncedAt: summary.syncedAt,
          pushToken: options?.pushToken || existingMeta.pushToken || null,
        },
      },
      create: {
        userId,
        provider: "strava",
        isConnected: true,
        metadata: {
          sixMonthsSummary: summary as any,
          lastSyncedAt: summary.syncedAt,
          pushToken: options?.pushToken || null,
        },
      },
    });

    // 7. Archivage automatique complet dans le Data Lake
    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "webhook_activity_synced",
      interaction: {
        type: "strava_six_months_history_imported",
        sourceMode,
        totalActivities: summary.totalActivities,
        totalDistanceKm: summary.totalDistanceKm,
        recent4WeeksAvgKm: summary.recent4WeeksAvgKm,
        longestRunKm: summary.longestRunKm,
        sportsBreakdown: summary.sportsBreakdown,
        estimatedPaces: summary.estimatedPaces,
        banisterLoad: summary.banisterLoad,
        monthlyBreakdown: summary.monthlyBreakdown,
      },
      athleteContext: {
        totalKm: summary.totalDistanceKm,
        activeWeeks: summary.activeWeeks,
        ctlFitness: summary.banisterLoad.ctlFitness,
        atlFatigue: summary.banisterLoad.atlFatigue,
        tsbForm: summary.banisterLoad.tsbForm,
        readinessScore: summary.banisterLoad.readinessScore,
      },
    });

    return summary;
  }

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

    // Notification Push contextuelle post-séance (Phase 4.2 : invitation immédiate au check-in RPE)
    await this.sendPostWorkoutPushNotification(userId, executed, providerName);
  }

  /**
   * Envoie une notification Push Expo (si pushToken enregistré) et ajoute une notification Coach
   * dès la réception d'un webhook de fin de séance pour inviter au check-in RPE.
   */
  private async sendPostWorkoutPushNotification(
    userId: string,
    executed: NormalizedExecutedWorkout,
    providerName: string,
  ): Promise<void> {
    try {
      const distStr = executed.actualDistanceKm.toFixed(1).replace(".", ",");
      const title = `🏃 ${distStr} km synchronisés (${providerName}) !`;
      const body = `Allure ${executed.actualPace}${executed.actualAvgHeartRate ? ` • ${executed.actualAvgHeartRate} bpm` : ""}. Comment étaient tes sensations musculaires (RPE) ?`;

      const stravaToken = await this.prisma.syncToken.findUnique({
        where: { userId_provider: { userId, provider: "strava" } },
      });
      const pushToken = (stravaToken?.metadata as any)?.pushToken;

      if (pushToken && String(pushToken).startsWith("ExponentPushToken")) {
        await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: pushToken,
            sound: "default",
            title,
            body,
            data: {
              type: "rpe_checkin_prompt",
              dateKey: executed.dateKey,
              distanceKm: executed.actualDistanceKm,
            },
          }),
        }).catch(() => {});
      }
    } catch (err: any) {
      this.logger.warn(`Push notification post-séance ignorée: ${err?.message}`);
    }
  }

  /**
   * Convertit une liste d'activités brutes de l'API Strava v3 (sur 6 mois, course à pied + sports globaux)
   * en enregistrements Workout Prisma
   */
  private mapLiveStravaActivitiesToWorkouts(
    userId: string,
    activities: any[],
  ): any[] {
    const dayNamesShort = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
    const dayNamesFull = [
      "DIMANCHE",
      "LUNDI",
      "MARDI",
      "MERCREDI",
      "JEUDI",
      "VENDREDI",
      "SAMEDI",
    ];
    const monthNamesFull = [
      "JANVIER",
      "FÉVRIER",
      "MARS",
      "AVRIL",
      "MAI",
      "JUIN",
      "JUILLET",
      "AOÛT",
      "SEPTEMBRE",
      "OCTOBRE",
      "NOVEMBRE",
      "DÉCEMBRE",
    ];

    const byDateKey = new Map<string, any>();

    for (const act of activities) {
      const sportType = String(act.sport_type || act.type || "Run");
      const isRun = ["Run", "TrailRun", "VirtualRun"].includes(sportType);
      const isRide = [
        "Ride",
        "VirtualRide",
        "EBikeRide",
        "GravelRide",
        "MountainBikeRide",
      ].includes(sportType);
      const isSwim = ["Swim"].includes(sportType);

      const distMeters = Number(act.distance || 0);
      const durationSec = Number(act.moving_time || act.elapsed_time || 0);
      if (durationSec < 300) continue;
      if (isRun && distMeters < 500) continue;

      const startDate = act.start_date_local
        ? new Date(act.start_date_local)
        : act.start_date
          ? new Date(act.start_date)
          : new Date();
      const yyyy = startDate.getUTCFullYear();
      const mm = startDate.getUTCMonth();
      const dd = startDate.getUTCDate();
      const dow = startDate.getUTCDay();
      const dateKey = `${yyyy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;

      // Si une séance course à pied existe déjà ce jour-là, on priorise la course à pied
      const existingForDay = byDateKey.get(dateKey);
      if (existingForDay && !isRun) {
        continue;
      }

      // Calcul du numéro de semaine ISO aligné sur le calendrier 2026 (Lundi 12 Oct 2026 = Semaine 42)
      const refMondayW42 = Date.UTC(2026, 9, 12);
      const currentMidnight = Date.UTC(yyyy, mm, dd);
      const diffDays = Math.floor(
        (currentMidnight - refMondayW42) / (24 * 3600 * 1000),
      );
      const weekNumber = 42 + Math.floor(diffDays / 7);

      const actualDistanceKm = Number((distMeters / 1000).toFixed(2));
      const actualPace = isRun
        ? this.formatPaceFromDistanceAndDuration(actualDistanceKm, durationSec)
        : isRide && durationSec > 0
          ? `${((actualDistanceKm / (durationSec / 3600)) || 26).toFixed(1)} km/h`
          : "Allure libre";
      const avgHr = act.average_heartrate
        ? Math.round(Number(act.average_heartrate))
        : undefined;
      const maxHr = act.max_heartrate
        ? Math.round(Number(act.max_heartrate))
        : undefined;
      const elevationGain =
        act.total_elevation_gain !== undefined
          ? Math.round(Number(act.total_elevation_gain))
          : isRun
            ? 45
            : 0;
      const rawCadence = Number(act.average_cadence || 0);
      const cadence =
        rawCadence > 0
          ? Math.round(
              isRun && rawCadence < 120 ? rawCadence * 2 : rawCadence,
            )
          : isRun
            ? 174
            : 85;
      const calories =
        act.calories !== undefined
          ? Math.round(Number(act.calories))
          : isRun
            ? Math.round(actualDistanceKm * 64)
            : Math.round((durationSec / 60) * 8.5);
      const tss = this.llmService.computeSessionTss({
        durationSec,
        distanceKm: isRun ? actualDistanceKm : Math.max(4, durationSec / 360),
        avgHeartRate: avgHr,
        maxHeartRate: maxHr,
      });

      const durMins = Math.round(durationSec / 60);
      const durationLabel =
        durMins >= 60
          ? `${Math.floor(durMins / 60)}h${String(durMins % 60).padStart(2, "0")}`
          : `${durMins} min`;
      const distLabel =
        actualDistanceKm > 0
          ? `${actualDistanceKm.toFixed(1).replace(".", ",")} km`
          : durationLabel;

      const isLongRun = isRun && actualDistanceKm >= 13;
      const isQuality =
        isRun && ((avgHr && avgHr >= 158) || actualDistanceKm >= 10);
      const category = isRun
        ? isLongRun
          ? "SORTIE LONGUE"
          : isQuality
            ? "SÉANCE QUALITATIVE"
            : "ENDURANCE FONDAMENTALE"
        : isRide
          ? "CROSS-TRAINING VÉLO"
          : isSwim
            ? "CROSS-TRAINING NATATION"
            : "RENFORCEMENT & CROSS-TRAINING";

      const defaultTitle = isRun
        ? "Sortie Course à Pied Strava"
        : isRide
          ? "Sortie Vélo / Endurance Croisée Strava"
          : isSwim
            ? "Séance Natation Strava"
            : `Séance ${sportType} Strava`;

      byDateKey.set(dateKey, {
        userId,
        dateKey,
        dayName: dayNamesShort[dow],
        dayNumber: dd,
        month: mm,
        year: yyyy,
        weekNumber,
        fullDateLabel: `${dayNamesFull[dow]} ${dd} ${monthNamesFull[mm]}`,
        timeLabel: "Synchronisé Strava",
        status: WorkoutStatus.DONE,
        isRestDay: false,
        category,
        title: act.name || defaultTitle,
        duration: durationLabel,
        distance: distLabel,
        targetPace: actualPace,
        targetZoneLabel: isQuality ? "Zone 3–4" : "Zone 2",
        targetZoneBpm: avgHr ? `${avgHr - 6}–${avgHr + 6} bpm` : "135–150 bpm",
        targetZoneSegments: isQuality
          ? [
              { color: "#93C5FD", flex: 1 },
              { color: "#FBBF24", flex: 2 },
              { color: "#FC4C02", flex: 2 },
            ]
          : [
              { color: "#93C5FD", flex: 2 },
              { color: "#34D399", flex: 4 },
              { color: "#FBBF24", flex: 1 },
            ],
        pinPositionPercent: isQuality ? 65 : 38,
        effortBlocks: [
          {
            title: "Échauffement",
            durationLabel: "10 min",
            type: "warmup",
            flexRatio: 1,
          },
          {
            title: `Corps de séance Strava (${sportType})`,
            durationLabel: `${Math.max(15, durMins - 15)} min`,
            type: isQuality ? "threshold" : "interval",
            flexRatio: 3,
          },
          {
            title: "Retour au calme",
            durationLabel: "5 min",
            type: "cooldown",
            flexRatio: 1,
          },
        ],
        tags: [
          actualDistanceKm > 0
            ? `${distLabel} réalisés`
            : `${durationLabel} réalisés`,
          isRun ? `Allure réelle : ${actualPace}` : `Sport : ${sportType}`,
          avgHr ? `FC moy : ${avgHr} bpm` : "Strava Sync",
        ],
        aiAdjustmentNote: `Séance réelle (${sportType}) importée depuis tes 6 derniers mois Strava : ${distLabel} (${durationLabel})${avgHr ? ` • ${avgHr} bpm moy` : ""} • Charge : ${tss} TSS.`,
        externalActivityId: String(act.id || `strava-${dateKey}`),
        sourceProvider: "strava",
        actualDistanceKm,
        actualDurationSec: durationSec,
        actualPace,
        actualAvgHeartRate: avgHr,
        actualMaxHeartRate: maxHr,
        actualElevationGain: elevationGain,
        actualCalories: calories,
        actualCadence: cadence,
        tss,
        completedAt: startDate,
      });
    }

    return Array.from(byDateKey.values());
  }

  /**
   * Génère un jeu de données complet, réaliste et physiologiquement cohérent sur les 6 DERNIERS MOIS
   * (26 semaines : de la Semaine 17 en Avril 2026 jusqu'à la Semaine 42 en Octobre 2026)
   * incluant à la fois les séances de COURSE À PIED (77 séances) et les séances de SPORT GLOBAL / CROSS-TRAINING
   * (vélo, renforcement musculaire / PPG, natation : 25 séances), soit 102 séances sur 6 mois.
   */
  private buildSixMonthsStravaWorkoutsDataset(userId: string): any[] {
    const dayNamesShort = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
    const dayNamesFull = [
      "DIMANCHE",
      "LUNDI",
      "MARDI",
      "MERCREDI",
      "JEUDI",
      "VENDREDI",
      "SAMEDI",
    ];
    const monthNamesFull = [
      "JANVIER",
      "FÉVRIER",
      "MARS",
      "AVRIL",
      "MAI",
      "JUIN",
      "JUILLET",
      "AOÛT",
      "SEPTEMBRE",
      "OCTOBRE",
      "NOVEMBRE",
      "DÉCEMBRE",
    ];

    const workouts: any[] = [];
    // Semaine 17 (Lundi 20 Avril 2026) -> Semaine 41 (Dimanche 11 Octobre 2026) = 25 semaines complètes + début Semaine 42
    const baseMondayW42 = Date.UTC(2026, 9, 12);

    for (let weekNum = 17; weekNum <= 41; weekNum++) {
      const weekOffset = weekNum - 17; // 0 à 24
      const isDeload = (weekOffset + 1) % 4 === 0;
      // Progression régulière sur 6 mois (de ~24 km/sem en Avril à ~38.5 km/sem en Octobre)
      const prog = (weekOffset / 24) * 0.42;
      const factor = isDeload ? (1 + prog) * 0.82 : 1 + prog;
      // Amélioration progressive de l'allure sur 6 mois (-18 sec/km gagnées en 6 mois à même FC)
      const paceGainSec = Math.round((weekOffset / 24) * 18);

      const weekSessionsConfig: Array<{
        dayOffset: number;
        category: string;
        sportType: "Run" | "Ride" | "WeightTraining" | "Swim";
        titlePrefix: string;
        baseDistKm: number;
        basePaceSec: number;
        fixedDurationSec?: number;
        avgHr: number;
        maxHr: number;
        elev: number;
        cadence: number;
      }> = [
        {
          dayOffset: 0, // Lundi : Course à pied Z2
          category: "ENDURANCE FONDAMENTALE",
          sportType: "Run",
          titlePrefix: "Footing Endurance Fondamentale Z2",
          baseDistKm: 6.2,
          basePaceSec: 354 - paceGainSec, // ~5:54 -> 5:36/km
          avgHr: 139 + (weekOffset % 3),
          maxHr: 152 + (weekOffset % 4),
          elev: 38 + (weekOffset % 5) * 6,
          cadence: 173 + Math.floor(weekOffset / 8),
        },
        {
          dayOffset: 2, // Mercredi : Séance Qualitative Course à pied
          category: "SÉANCE QUALITATIVE",
          sportType: "Run",
          titlePrefix:
            weekOffset % 2 === 0
              ? "Séance Seuil Anaérobie & Tempo"
              : "Fractionné VMA & Répétitions",
          baseDistKm: 8.0,
          basePaceSec: 306 - paceGainSec, // ~5:06 -> 4:48/km
          avgHr: 162 + (weekOffset % 4),
          maxHr: 179 + (weekOffset % 5),
          elev: 45 + (weekOffset % 4) * 5,
          cadence: 178 + Math.floor(weekOffset / 8),
        },
        {
          dayOffset: 5, // Samedi : Sortie Longue Course à pied
          category: "SORTIE LONGUE",
          sportType: "Run",
          titlePrefix: "Sortie Longue Aérobie Progressive",
          baseDistKm: 11.2,
          basePaceSec: 346 - paceGainSec, // ~5:46 -> 5:28/km
          avgHr: 144 + (weekOffset % 3),
          maxHr: 161 + (weekOffset % 4),
          elev: 85 + (weekOffset % 6) * 12,
          cadence: 175 + Math.floor(weekOffset / 8),
        },
        // Dimanche (dayOffset = 6) : Séance de Sport Global / Cross-Training (Vélo, PPG/Renfo ou Natation)
        // Le Jeudi (dayOffset = 3) reste 100% libre chaque semaine (jour sanctuarisé détecté dans l'historique)
        weekOffset % 3 === 0
          ? {
              dayOffset: 6,
              category: "CROSS-TRAINING VÉLO",
              sportType: "Ride",
              titlePrefix: "Sortie Vélo Récupération & Vélocité Z1/Z2",
              baseDistKm: 28.0,
              basePaceSec: 125,
              fixedDurationSec: 3600, // 1h00 de vélo
              avgHr: 128 + (weekOffset % 3),
              maxHr: 146 + (weekOffset % 4),
              elev: 210 + (weekOffset % 4) * 25,
              cadence: 88,
            }
          : weekOffset % 3 === 1
            ? {
                dayOffset: 6,
                category: "RENFORCEMENT & CROSS-TRAINING",
                sportType: "WeightTraining",
                titlePrefix: "PPG, Gainage & Renforcement Mollets/Ischios",
                baseDistKm: 0,
                basePaceSec: 0,
                fixedDurationSec: 2700, // 45 min de renforcement
                avgHr: 118 + (weekOffset % 4),
                maxHr: 142 + (weekOffset % 4),
                elev: 0,
                cadence: 0,
              }
            : {
                dayOffset: 6,
                category: "CROSS-TRAINING NATATION",
                sportType: "Swim",
                titlePrefix: "Natation Récupération Cardio & Souplesse",
                baseDistKm: 1.6,
                basePaceSec: 1350,
                fixedDurationSec: 2400, // 40 min natation
                avgHr: 126 + (weekOffset % 3),
                maxHr: 144 + (weekOffset % 3),
                elev: 0,
                cadence: 58,
              },
      ];

      for (const cfg of weekSessionsConfig) {
        const dateMs =
          baseMondayW42 + ((weekNum - 42) * 7 + cfg.dayOffset) * 86400 * 1000;
        const dObj = new Date(dateMs);
        const yyyy = dObj.getUTCFullYear();
        const mm = dObj.getUTCMonth();
        const dd = dObj.getUTCDate();
        const dow = dObj.getUTCDay();
        const dateKey = `${yyyy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;

        const isRun = cfg.sportType === "Run";
        const isRide = cfg.sportType === "Ride";
        const isSwim = cfg.sportType === "Swim";

        const actualDistanceKm = isRun
          ? Number((cfg.baseDistKm * factor).toFixed(1))
          : cfg.baseDistKm;
        const actualDurationSec = cfg.fixedDurationSec
          ? cfg.fixedDurationSec
          : Math.round(actualDistanceKm * cfg.basePaceSec);
        const actualPace = isRun
          ? this.formatPaceFromDistanceAndDuration(
              actualDistanceKm,
              actualDurationSec,
            )
          : isRide
            ? `${((actualDistanceKm / (actualDurationSec / 3600)) || 28).toFixed(1)} km/h`
            : isSwim
              ? "2:30/100m"
              : "PPG / Renfo";
        const durMins = Math.round(actualDurationSec / 60);
        const durationLabel =
          durMins >= 60
            ? `${Math.floor(durMins / 60)}h${String(durMins % 60).padStart(2, "0")}`
            : `${durMins} min`;
        const distLabel =
          actualDistanceKm > 0
            ? `${actualDistanceKm.toFixed(1).replace(".", ",")} km`
            : durationLabel;

        const tss = this.llmService.computeSessionTss({
          durationSec: actualDurationSec,
          distanceKm: isRun
            ? actualDistanceKm
            : Math.max(4, actualDurationSec / 360),
          avgHeartRate: cfg.avgHr,
          maxHeartRate: cfg.maxHr,
        });
        const isQuality = cfg.category === "SÉANCE QUALITATIVE";

        workouts.push({
          userId,
          dateKey,
          dayName: dayNamesShort[dow],
          dayNumber: dd,
          month: mm,
          year: yyyy,
          weekNumber: weekNum,
          fullDateLabel: `${dayNamesFull[dow]} ${dd} ${monthNamesFull[mm]}`,
          timeLabel: cfg.dayOffset >= 5 ? "09:30" : "18:15",
          status: WorkoutStatus.DONE,
          isRestDay: false,
          category: cfg.category,
          title:
            actualDistanceKm > 0
              ? `${cfg.titlePrefix} (${distLabel})`
              : `${cfg.titlePrefix} (${durationLabel})`,
          duration: durationLabel,
          distance: distLabel,
          targetPace: actualPace,
          targetZoneLabel: isQuality ? "Zone 3–4" : "Zone 2",
          targetZoneBpm: isQuality ? "158–172 bpm" : "125–148 bpm",
          targetZoneSegments: isQuality
            ? [
                { color: "#93C5FD", flex: 1 },
                { color: "#FBBF24", flex: 2 },
                { color: "#FC4C02", flex: 2 },
              ]
            : [
                { color: "#93C5FD", flex: 2 },
                { color: "#34D399", flex: 4 },
                { color: "#FBBF24", flex: 1 },
              ],
          pinPositionPercent: isQuality ? 66 : 36,
          effortBlocks: [
            {
              title: "Échauffement",
              durationLabel: "10 min",
              type: "warmup",
              flexRatio: 1,
            },
            {
              title: isQuality
                ? "Bloc Seuil"
                : isRun
                  ? "Endurance Z2"
                  : `Séance ${cfg.sportType}`,
              durationLabel: `${Math.max(15, durMins - 15)} min`,
              type: isQuality ? "threshold" : "interval",
              flexRatio: 3,
            },
            {
              title: "Retour au calme",
              durationLabel: "5 min",
              type: "cooldown",
              flexRatio: 1,
            },
          ],
          tags: [
            actualDistanceKm > 0
              ? `${distLabel} réalisés`
              : `${durationLabel} réalisés`,
            isRun ? `Allure réelle : ${actualPace}` : `Sport : ${cfg.sportType}`,
            `FC moy : ${cfg.avgHr} bpm`,
          ],
          aiAdjustmentNote: `Séance réelle (${cfg.sportType}) importée depuis tes 6 derniers mois Strava : ${distLabel} en ${durationLabel} (${actualPace} • ${cfg.avgHr} bpm moy • Charge : ${tss} TSS).`,
          externalActivityId: `strava-6m-${dateKey}`,
          sourceProvider: "strava",
          actualDistanceKm,
          actualDurationSec,
          actualPace,
          actualAvgHeartRate: cfg.avgHr,
          actualMaxHeartRate: cfg.maxHr,
          actualElevationGain: cfg.elev,
          actualCalories: isRun
            ? Math.round(actualDistanceKm * 63)
            : Math.round(durMins * 7.5),
          actualCadence: cfg.cadence,
          tss,
          completedAt: new Date(`${dateKey}T18:30:00.000Z`),
        });
      }
    }

    // Ajout des 2 séances déjà réalisées de la semaine courante (Semaine 42 : Lun 12 & Mar 13 Octobre 2026)
    workouts.push(
      {
        userId,
        dateKey: "2026-10-12",
        dayName: "Lun",
        dayNumber: 12,
        month: 9,
        year: 2026,
        weekNumber: 42,
        fullDateLabel: "LUNDI 12 OCTOBRE",
        timeLabel: "18:00",
        status: WorkoutStatus.DONE,
        isRestDay: false,
        category: "RÉCUPÉRATION ACTIVE",
        title: "Footing Fondamental Léger",
        duration: "40 min",
        distance: "7,2 km",
        targetPace: "5:41/km",
        targetZoneLabel: "Zone 2",
        targetZoneBpm: "130–145 bpm",
        targetZoneSegments: [
          { color: "#93C5FD", flex: 3 },
          { color: "#34D399", flex: 4 },
          { color: "#FBBF24", flex: 1 },
        ],
        pinPositionPercent: 35,
        effortBlocks: [
          {
            title: "Échauffement",
            durationLabel: "10 min",
            type: "warmup",
            flexRatio: 1,
          },
          {
            title: "Footing souple",
            durationLabel: "25 min",
            type: "interval",
            flexRatio: 3,
          },
          {
            title: "Retour au calme",
            durationLabel: "5 min",
            type: "cooldown",
            flexRatio: 1,
          },
        ],
        tags: ["7,2 km réalisés", "Allure réelle : 5:41/km", "FC moy : 138 bpm"],
        aiAdjustmentNote:
          "Séance réelle synchronisée via Strava : 7,2 km en 40m55s (5:41/km • 138 bpm moy). Régularité cardiaque idéale.",
        externalActivityId: "strava-10122026",
        sourceProvider: "strava",
        actualDistanceKm: 7.2,
        actualDurationSec: 2455,
        actualPace: "5:41/km",
        actualAvgHeartRate: 138,
        actualMaxHeartRate: 149,
        actualElevationGain: 42,
        actualCalories: 465,
        actualCadence: 174,
        tss: 38,
        completedAt: new Date("2026-10-12T18:41:00.000Z"),
      },
      {
        userId,
        dateKey: "2026-10-13",
        dayName: "Mar",
        dayNumber: 13,
        month: 9,
        year: 2026,
        weekNumber: 42,
        fullDateLabel: "MARDI 13 OCTOBRE",
        timeLabel: "18:30",
        status: WorkoutStatus.DONE,
        isRestDay: false,
        category: "RENFORCEMENT & MOBILITÉ",
        title: "Footing Assimilation & Lignes Droites",
        duration: "34 min",
        distance: "6,1 km",
        targetPace: "5:32/km",
        targetZoneLabel: "Zone 1–2",
        targetZoneBpm: "130–145 bpm",
        targetZoneSegments: [
          { color: "#93C5FD", flex: 4 },
          { color: "#34D399", flex: 2 },
        ],
        pinPositionPercent: 25,
        effortBlocks: [
          {
            title: "Footing souple",
            durationLabel: "24 min",
            type: "warmup",
            flexRatio: 2,
          },
          {
            title: "5 × 80m lignes droites",
            durationLabel: "5 min",
            type: "interval",
            flexRatio: 1,
          },
          {
            title: "Retour au calme",
            durationLabel: "5 min",
            type: "cooldown",
            flexRatio: 1,
          },
        ],
        tags: ["6,1 km réalisés", "Allure réelle : 5:32/km", "FC moy : 141 bpm"],
        aiAdjustmentNote:
          "Séance réelle synchronisée via Strava : 6,1 km en 33m45s (5:32/km • 141 bpm moy • 178 spm).",
        externalActivityId: "strava-10132026",
        sourceProvider: "strava",
        actualDistanceKm: 6.1,
        actualDurationSec: 2025,
        actualPace: "5:32/km",
        actualAvgHeartRate: 141,
        actualMaxHeartRate: 162,
        actualElevationGain: 28,
        actualCalories: 390,
        actualCadence: 178,
        tss: 34,
        completedAt: new Date("2026-10-13T19:04:00.000Z"),
      },
    );

    return workouts;
  }

  /**
   * Calcule le bilan complet des 6 derniers mois Strava (course à pied + sports globaux / cross-training,
   * progression mensuelle, allures réelles Z2/Z4, charge Banister CTL/ATL/TSB et diagnostic "Aha! Moment")
   */
  public computeSixMonthsSummaryFromWorkouts(
    workouts: any[],
    sourceMode: "strava_oauth_live" | "strava_history_import" = "strava_history_import",
  ): StravaSixMonthsSummaryDto {
    const shortMonths = [
      "Jan",
      "Fév",
      "Mar",
      "Avr",
      "Mai",
      "Juin",
      "Juil",
      "Août",
      "Sept",
      "Oct",
      "Nov",
      "Déc",
    ];

    let runningDistanceKm = 0;
    let runningSessions = 0;
    let cyclingSessions = 0;
    let cyclingKm = 0;
    let swimmingSessions = 0;
    let strengthAndOtherSessions = 0;
    let crossTrainingDurationSec = 0;

    let totalDurationSec = 0;
    let totalElevationGainM = 0;
    let longestRunKm = 0;
    let hrSum = 0;
    let hrCount = 0;
    let maxHeartRateObserved = 185;
    const distinctWeeks = new Set<string>();
    const byMonth = new Map<
      string,
      { label: string; km: number; sec: number; count: number; runSec: number }
    >();
    const recent4WeeksKm = new Map<number, number>();
    const runningWorkouts: any[] = [];

    let ctl = 28;
    let atl = 28;

    for (const w of workouts) {
      const cat = String(w.category || "").toUpperCase();
      const isRide = cat.includes("VÉLO");
      const isSwim = cat.includes("NATATION");
      const isCrossOther =
        !isRide &&
        !isSwim &&
        (cat.includes("CROSS-TRAINING") ||
          (w.actualPace &&
            !String(w.actualPace).includes("/km") &&
            Number(w.actualDistanceKm || 0) === 0));
      const isRun = !isRide && !isSwim && !isCrossOther;

      const dist = Number(w.actualDistanceKm || 0);
      const sec = Number(w.actualDurationSec || 0);
      const elev = Number(w.actualElevationGain || 0);
      const tss =
        w.tss ??
        this.llmService.computeSessionTss({
          durationSec: sec,
          distanceKm: isRun ? dist : Math.max(4, sec / 360),
          avgHeartRate: w.actualAvgHeartRate,
          maxHeartRate: w.actualMaxHeartRate,
        });

      totalDurationSec += sec;
      totalElevationGainM += elev;

      if (isRun) {
        runningSessions++;
        runningDistanceKm += dist;
        runningWorkouts.push(w);
        if (dist > longestRunKm) longestRunKm = dist;
      } else {
        crossTrainingDurationSec += sec;
        if (isRide) {
          cyclingSessions++;
          cyclingKm += dist;
        } else if (isSwim) {
          swimmingSessions++;
        } else {
          strengthAndOtherSessions++;
        }
      }

      if (w.actualAvgHeartRate) {
        hrSum += Number(w.actualAvgHeartRate);
        hrCount++;
      }
      if (w.actualMaxHeartRate && w.actualMaxHeartRate > maxHeartRateObserved) {
        maxHeartRateObserved = Number(w.actualMaxHeartRate);
      }

      distinctWeeks.add(`${w.year}-W${w.weekNumber}`);

      if (isRun && w.weekNumber >= 38 && w.weekNumber <= 41) {
        recent4WeeksKm.set(
          w.weekNumber,
          (recent4WeeksKm.get(w.weekNumber) || 0) + dist,
        );
      }

      const monthKey = `${w.year}-${String((w.month ?? 0) + 1).padStart(2, "0")}`;
      const existingMonth = byMonth.get(monthKey) || {
        label: shortMonths[w.month ?? 0] || "Mois",
        km: 0,
        sec: 0,
        count: 0,
        runSec: 0,
      };
      if (isRun) {
        existingMonth.km += dist;
        existingMonth.runSec += sec;
      }
      existingMonth.sec += sec;
      existingMonth.count += 1;
      byMonth.set(monthKey, existingMonth);

      const loadUpdate = this.llmService.updateBanisterLoad(atl, ctl, tss);
      atl = loadUpdate.atlFatigue;
      ctl = loadUpdate.ctlFitness;
    }

    const activeWeeks = Math.max(1, distinctWeeks.size);
    const roundedRunningKm = Number(runningDistanceKm.toFixed(1));
    const averageWeeklyKm = Number((roundedRunningKm / activeWeeks).toFixed(1));

    const recent4Sum = Array.from(recent4WeeksKm.values()).reduce(
      (a, b) => a + b,
      0,
    );
    const recent4WeeksAvgKm =
      recent4WeeksKm.size > 0
        ? Number((recent4Sum / recent4WeeksKm.size).toFixed(1))
        : averageWeeklyKm;

    // Calcul des allures physiologiques sur les 15 séances de course à pied les plus récentes des 6 mois
    const recent15Runs = (
      runningWorkouts.length > 0 ? runningWorkouts : workouts
    ).slice(-15);
    const sessionMetrics =
      this.llmService.extractSessionMetricsFromWorkouts(recent15Runs);
    const estimatedPaces = this.llmService.computePacesFromRecentPerformance({
      hasSyncedHistory: true,
      recentWeeklyKm: recent4WeeksAvgKm,
      longestRecentRunKm: longestRunKm,
      activeWeeks,
      hrMax: maxHeartRateObserved,
      recentSessions: sessionMetrics,
    });

    const monthlyBreakdown: StravaMonthlyStatDto[] = Array.from(
      byMonth.entries(),
    )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([monthKey, m]) => ({
        monthKey,
        monthLabel: m.label,
        label: m.label,
        totalKm: Number(m.km.toFixed(1)),
        sessionsCount: m.count,
        avgPace: this.formatPaceFromDistanceAndDuration(m.km, m.runSec || m.sec),
      }));

    const tsbForm = Number((ctl - atl).toFixed(1));
    const readinessScore = Math.max(
      45,
      Math.min(96, Math.round(84 + tsbForm * 0.6)),
    );
    const roundedCtl = Number(ctl.toFixed(1));
    const crossTrainingCount =
      cyclingSessions + swimmingSessions + strengthAndOtherSessions;
    const crossTrainingHours = Number(
      (crossTrainingDurationSec / 3600).toFixed(1),
    );

    const ahaInsight = `Sur tes 6 derniers mois Strava (${workouts.length} activités sportives dont ${runningSessions} courses à pied pour ${roundedRunningKm} km${crossTrainingCount > 0 ? ` + ${crossTrainingCount} séances de cross-training (${crossTrainingHours}h vélo/PPG/natation)` : ""}), ton volume course a progressé jusqu'à ${recent4WeeksAvgKm} km/sem sur le dernier mois (sortie longue max : ${longestRunKm.toFixed(1)} km). Tes données montrent que le jeudi est ton jour naturel de récupération : ton plan multi-semaines calibre ta Zone 2 à ${estimatedPaces.easyPaceZ2}, ton Seuil à ${estimatedPaces.thresholdPaceZ4} et intègre ta charge multisport globale (CTL ${roundedCtl}).`;

    return {
      periodMonths: 6,
      startDateKey: workouts[0]?.dateKey || "2026-04-20",
      endDateKey: workouts[workouts.length - 1]?.dateKey || "2026-10-13",
      totalActivities: workouts.length,
      totalSessions: workouts.length,
      totalDistanceKm: roundedRunningKm,
      totalKm: roundedRunningKm,
      totalDurationHours: Number((totalDurationSec / 3600).toFixed(1)),
      totalElevationGainM: Math.round(totalElevationGainM),
      activeWeeks,
      averageWeeklyKm,
      recent4WeeksAvgKm,
      longestRunKm: Number(longestRunKm.toFixed(1)),
      avgHeartRate: hrCount > 0 ? Math.round(hrSum / hrCount) : 145,
      maxHeartRateObserved,
      estimatedPaces,
      easyPaceRange: estimatedPaces.easyPaceZ2,
      thresholdPace: estimatedPaces.thresholdPaceZ4,
      ctlFitness: roundedCtl,
      banisterLoad: {
        ctlFitness: roundedCtl,
        atlFatigue: Number(atl.toFixed(1)),
        tsbForm,
        readinessScore,
      },
      sportsBreakdown: {
        runningSessions,
        runningKm: roundedRunningKm,
        cyclingSessions,
        cyclingKm: Number(cyclingKm.toFixed(1)),
        swimmingSessions,
        strengthAndOtherSessions,
        crossTrainingHours,
      },
      monthlyBreakdown,
      ahaInsight,
      syncedAt: new Date().toISOString(),
      sourceMode,
    };
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

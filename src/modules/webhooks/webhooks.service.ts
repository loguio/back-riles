import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as crypto from "crypto";
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
  title?: string;
  category?: string;
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
  sportType?: string;
  isCommute?: boolean;
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  /** Cache de déduplication en processus (RILES-006) : clé → horodatage. */
  private readonly seenWebhookEvents = new Map<string, number>();
  private static readonly DEDUPE_TTL_MS = 60 * 60 * 1000; // 1 heure
  private static readonly DEDUPE_MAX_KEYS = 50_000;

  /**
   * Nonces OAuth Strava émis par GET /webhooks/strava/oauth/url (RILES-007) :
   * nonce → { userId, expiration }.À usage unique, vérifiés au callback.
   */
  private readonly oauthStates = new Map<
    string,
    { userId: string; expiresAt: number }
  >();
  private static readonly OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly dataLakeService: DataLakeService,
    private readonly llmService: LlmService,
  ) {}

  // ---------------------------------------------------------------------------
  // RILES-005 : vérification des signatures HMAC des webhooks fournisseurs
  // Fail-closed : sans secret configuré, ou sans signature, la requête est
  // rejetée en 401 avant toute écriture en base.
  // ---------------------------------------------------------------------------

  /** Comparaison en temps constant (le descripteur reste secret). */
  private static constantTimeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, "utf8");
    const bufB = Buffer.from(b, "utf8");
    if (bufA.length !== bufB.length) {
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }

  /** Retire un éventuel préfixe de format ("sha1=", "sha256=", "base64="). */
  private static stripSignaturePrefix(value: string): string {
    const trimmed = value.trim().toLowerCase();
    for (const prefix of ["sha1=", "sha256=", "base64="]) {
      if (trimmed.startsWith(prefix)) {
        return value.trim().slice(prefix.length);
      }
    }
    return value.trim();
  }

  private static readHeader(
    value: string | string[] | undefined,
  ): string | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    return raw && raw.trim().length > 0 ? raw.trim() : undefined;
  }

  /** Secret d'environnement, ou rejet fail-closed 401 si absent. */
  private requireWebhookSecret(envKey: string, provider: string): string {
    const secret = this.configService.get<string>(envKey);
    if (!secret || secret.trim().length === 0) {
      this.logger.error(
        `${provider} webhook rejected: ${envKey} is not configured (fail-closed).`,
      );
      throw new UnauthorizedException(
        `${provider} webhook signature verification is not configured`,
      );
    }
    return secret;
  }

  /**
   * Strava : `X-Hub-Signature: sha1=<HMAC_SHA1(STRAVA_CLIENT_SECRET, corps brut)>`.
   * (Strava client secret = secret de signature du webhook, voir RILES-005.)
   */
  verifyStravaSignature(
    rawBody: Buffer | string | undefined | null,
    signatureHeader: string | string[] | undefined,
  ): void {
    const secret = this.requireWebhookSecret("STRAVA_CLIENT_SECRET", "Strava");
    const provided = WebhooksService.readHeader(signatureHeader);
    if (!rawBody || !provided) {
      throw new UnauthorizedException(
        "Missing Strava webhook signature (X-Hub-Signature)",
      );
    }
    const expected = crypto
      .createHmac("sha1", secret)
      .update(rawBody)
      .digest("hex");
    if (
      !WebhooksService.constantTimeEquals(
        WebhooksService.stripSignaturePrefix(provided),
        WebhooksService.stripSignaturePrefix(expected),
      )
    ) {
      throw new UnauthorizedException("Invalid Strava webhook signature");
    }
  }

  /**
   * Garmin : `X-Garmin-Signature: base64(HMAC_SHA256(GARMIN_WEBHOOK_SECRET, corps brut))`.
   */
  verifyGarminSignature(
    rawBody: Buffer | string | undefined | null,
    signatureHeader: string | string[] | undefined,
  ): void {
    const secret = this.requireWebhookSecret("GARMIN_WEBHOOK_SECRET", "Garmin");
    const provided = WebhooksService.readHeader(signatureHeader);
    if (!rawBody || !provided) {
      throw new UnauthorizedException(
        "Missing Garmin webhook signature (X-Garmin-Signature)",
      );
    }
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("base64");
    if (
      !WebhooksService.constantTimeEquals(
        WebhooksService.stripSignaturePrefix(provided),
        WebhooksService.stripSignaturePrefix(expected),
      )
    ) {
      throw new UnauthorizedException("Invalid Garmin webhook signature");
    }
  }

  /**
   * Apple Health : secret partagé transmis dans l'en-tête `X-Apple-Health-Secret`,
   * comparé en temps constant à APPLE_HEALTH_SECRET.
   */
  verifyAppleHealthSecret(secretHeader: string | string[] | undefined): void {
    const secret = this.requireWebhookSecret(
      "APPLE_HEALTH_SECRET",
      "Apple Health",
    );
    const provided = WebhooksService.readHeader(secretHeader);
    if (!provided) {
      throw new UnauthorizedException(
        "Missing Apple Health webhook secret (X-Apple-Health-Secret)",
      );
    }
    if (!WebhooksService.constantTimeEquals(provided, secret)) {
      throw new UnauthorizedException("Invalid Apple Health webhook secret");
    }
  }

  // ---------------------------------------------------------------------------
  // RILES-007 : state OAuth (anti login-CSRF) + vérification de souscription
  // ---------------------------------------------------------------------------

  private oauthStateError(reason: string): BadRequestException {
    this.logger.warn(`Strava OAuth state rejected: ${reason}`);
    return new BadRequestException("Invalid or expired OAuth state");
  }

  private pruneOAuthStates(): void {
    const now = Date.now();
    for (const [nonce, entry] of this.oauthStates) {
      if (entry.expiresAt < now) {
        this.oauthStates.delete(nonce);
      }
    }
  }

  /**
   * Émet un `state` au format `userId.nonce` : nonce aléatoire 256 bits,
   * mémorisé côté serveur et lié à l'utilisateur authentifié appelant.
   * Remplace le userId brut envoyé jusqu'ici (login CSRF, RILES-007).
   */
  issueOAuthState(userId: string): string {
    if (!userId || userId.trim().length === 0) {
      throw new UnauthorizedException(
        "Cannot issue OAuth state without an authenticated user",
      );
    }
    this.pruneOAuthStates();
    const nonce = crypto.randomBytes(32).toString("hex");
    this.oauthStates.set(nonce, {
      userId,
      expiresAt: Date.now() + WebhooksService.OAUTH_STATE_TTL_MS,
    });
    return `${userId}.${nonce}`;
  }

  /**
   * Vérifie et CONSUME le `state` reçu au callback. Rejet (400) si absent,
   * malformé, inconnu, expiré, déjà utilisé, ou si le userId diffère de celui
   * pour lequel le nonce a été émis. Retourne l'utilisateur lié au state.
   */
  verifyOAuthState(state?: string): string {
    if (!state || typeof state !== "string") {
      throw this.oauthStateError("missing state");
    }
    const separator = state.lastIndexOf(".");
    const userId = separator > 0 ? state.slice(0, separator) : "";
    const nonce = separator > 0 ? state.slice(separator + 1) : "";
    if (!userId || !/^[0-9a-f]{64}$/.test(nonce)) {
      throw this.oauthStateError("malformed state");
    }

    const entry = this.oauthStates.get(nonce);
    if (!entry) {
      // Inconnu ou déjà consommé : un state ne peut être utilisé qu'une fois.
      throw this.oauthStateError("unknown or already-used nonce");
    }
    this.oauthStates.delete(nonce);

    if (entry.expiresAt < Date.now()) {
      throw this.oauthStateError("expired nonce");
    }
    if (entry.userId !== userId) {
      throw this.oauthStateError("userId does not match the issued state");
    }
    this.logger.log(`Strava OAuth state verified for user ${userId}.`);
    return entry.userId;
  }

  /** Redirection post-callback OAuth (RILES-007 : issue de l'environnement). */
  getOAuthSuccessRedirect(): string {
    return (
      this.configService.get<string>("FRONTEND_OAUTH_REDIRECT_URI") ||
      "http://localhost:8081/onboarding?step=4&strava_synced=true"
    );
  }

  /**
   * Construit l'URL d'autorisation OAuth2 Strava (Scope : lecture des activités sur 6 mois & profil cardio)
   */
  getStravaOAuthAuthorizeUrl(
    customRedirectUri?: string,
    userId?: string,
  ): {
    authorizeUrl: string;
    clientId: string;
    redirectUri: string;
    isLiveConfigured: boolean;
  } {
    const clientId = this.configService.get<string>("STRAVA_CLIENT_ID") || "";
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
      // RILES-007 : plus de userId brut — state signé par le serveur.
      state: this.issueOAuthState(userId ?? ""),
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
  private async refreshStravaAccessTokenIfNeeded(
    syncToken: any,
  ): Promise<string | null> {
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
                refreshToken: tokenData.refresh_token || syncToken.refreshToken,
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
    const liveActivities: any[] = [];
    const validAccessToken =
      await this.refreshStravaAccessTokenIfNeeded(syncToken);
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

    // 3. Persistance en base des séances sur les 6 derniers mois UNIQUEMENT si activités réelles Strava (zéro donnée moquée)
    const workoutsToPersist =
      liveActivities.length > 0
        ? this.mapLiveStravaActivitiesToWorkouts(userId, liveActivities)
        : [];

    if (workoutsToPersist.length > 0) {
      // Insertion rapide en bloc (createMany avec skipDuplicates) pour les semaines passées
      await this.prisma.workout.createMany({
        data: workoutsToPersist,
        skipDuplicates: true,
      });

      // Mise à jour explicite de toutes les séances réalisées de l'historique Strava (notamment aujourd'hui et les dernières semaines)
      const recentDone = workoutsToPersist.filter(
        (w) => w.status === WorkoutStatus.DONE,
      );
      for (const cw of recentDone) {
        await this.prisma.workout.upsert({
          where: { userId_dateKey: { userId, dateKey: cw.dateKey } },
          update: {
            status: WorkoutStatus.DONE,
            isRestDay: false,
            title: cw.title,
            category: cw.category,
            duration: cw.duration,
            distance: cw.distance,
            targetPace: cw.targetPace,
            targetZoneLabel: cw.targetZoneLabel,
            targetZoneBpm: cw.targetZoneBpm,
            targetZoneSegments: cw.targetZoneSegments,
            effortBlocks: cw.effortBlocks,
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
            sportType: cw.sportType,
            isCommute: cw.isCommute,
            secondaryActivities: cw.secondaryActivities ?? undefined,
            tags: cw.tags,
            aiAdjustmentNote: cw.aiAdjustmentNote,
          },
          create: cw,
        });
      }
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
    // RILES-007 : plus de jeton par défaut codé en dur ; sans configuration,
    // la vérification échoue fermement (fail-closed).
    const expectedToken = this.configService.get<string>("STRAVA_VERIFY_TOKEN");
    if (!expectedToken || expectedToken.trim().length === 0) {
      this.logger.error(
        "Strava subscription verification rejected: STRAVA_VERIFY_TOKEN is not configured (fail-closed).",
      );
      throw new UnauthorizedException(
        "Strava subscription verification is not configured",
      );
    }

    const isValid =
      mode === "subscribe" &&
      typeof verifyToken === "string" &&
      WebhooksService.constantTimeEquals(verifyToken, expectedToken);

    if (isValid) {
      this.logger.log("Strava Webhook subscription verified successfully.");
      return { "hub.challenge": challenge };
    }

    throw new UnauthorizedException("Invalid Strava verification token");
  }

  /**
   * Récupère la souscription webhook Strava active auprès de l'API Strava v3
   */
  async getStravaSubscription(): Promise<any> {
    const clientId = this.configService.get<string>("STRAVA_CLIENT_ID");
    const clientSecret = this.configService.get<string>("STRAVA_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return { error: "Clés Strava CLIENT_ID / CLIENT_SECRET non configurées" };
    }

    try {
      const url = `https://www.strava.com/api/v3/push_subscriptions?client_id=${clientId}&client_secret=${clientSecret}`;
      const res = await fetch(url);
      const data = await res.json();
      return {
        status: res.status,
        subscriptions: Array.isArray(data) ? data : [],
      };
    } catch (err: any) {
      this.logger.error(`Erreur lecture subscription Strava: ${err?.message}`);
      return { error: err?.message };
    }
  }

  /**
   * Crée (ou met à jour) la souscription webhook Strava avec une callbackUrl publique
   * (Requiert une URL publique accessible sur internet, ex: ngrok ou nom de domaine en production)
   */
  async createStravaSubscription(
    callbackUrl: string,
    verifyToken?: string,
  ): Promise<any> {
    // RILES-007 : jeton de vérification issu de l'environnement (fail-closed),
    // jamais une valeur codée en dur.
    const effectiveVerifyToken =
      (verifyToken && verifyToken.trim()) ||
      this.configService.get<string>("STRAVA_VERIFY_TOKEN");
    if (!effectiveVerifyToken) {
      return { error: "STRAVA_VERIFY_TOKEN non configuré (fail-closed)" };
    }
    const clientId = this.configService.get<string>("STRAVA_CLIENT_ID");
    const clientSecret = this.configService.get<string>("STRAVA_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return { error: "Clés Strava CLIENT_ID / CLIENT_SECRET non configurées" };
    }

    try {
      // Strava n'autorise qu'une seule souscription par application
      const existing = await this.getStravaSubscription();
      if (
        Array.isArray(existing.subscriptions) &&
        existing.subscriptions.length > 0
      ) {
        for (const sub of existing.subscriptions) {
          await this.deleteStravaSubscription(sub.id);
        }
      }

      const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        callback_url: callbackUrl,
        verify_token: effectiveVerifyToken,
      });

      const res = await fetch(
        "https://www.strava.com/api/v3/push_subscriptions",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
        },
      );

      const data = await res.json();
      this.logger.log(
        `Souscription webhook Strava créée (${res.status}): ${JSON.stringify(data)}`,
      );
      return {
        status: res.status,
        data,
      };
    } catch (err: any) {
      this.logger.error(`Erreur création subscription Strava: ${err?.message}`);
      return { error: err?.message };
    }
  }

  /**
   * Supprime une souscription webhook Strava
   */
  async deleteStravaSubscription(subscriptionId?: number): Promise<any> {
    const clientId = this.configService.get<string>("STRAVA_CLIENT_ID");
    const clientSecret = this.configService.get<string>("STRAVA_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      return { error: "Clés Strava CLIENT_ID / CLIENT_SECRET non configurées" };
    }

    let idToDelete = subscriptionId;
    if (!idToDelete) {
      const existing = await this.getStravaSubscription();
      if (
        Array.isArray(existing.subscriptions) &&
        existing.subscriptions.length > 0
      ) {
        idToDelete = existing.subscriptions[0].id;
      }
    }

    if (!idToDelete) {
      return { message: "Aucune souscription Strava active à supprimer" };
    }

    try {
      const res = await fetch(
        `https://www.strava.com/api/v3/push_subscriptions/${idToDelete}?client_id=${clientId}&client_secret=${clientSecret}`,
        { method: "DELETE" },
      );
      return {
        status: res.status,
        deletedSubscriptionId: idToDelete,
        success: res.ok,
      };
    } catch (err: any) {
      return { error: err?.message };
    }
  }

  /**
   * Synchronisation incrémentale à la demande (Safety Net / App Open / Pull-to-refresh)
   * Récupère uniquement les activités récentes (ex: 7 à 14 jours) pour un utilisateur,
   * sans gaspiller le quota global de requêtes Strava sur les comptes inactifs.
   */
  async syncRecentStravaActivities(
    userId: string,
    daysLookback = 7,
  ): Promise<{
    success: boolean;
    syncedActivitiesCount: number;
    workouts: any[];
    message: string;
  }> {
    const syncToken = await this.prisma.syncToken.findUnique({
      where: { userId_provider: { userId, provider: "strava" } },
    });

    if (!syncToken) {
      return {
        success: false,
        syncedActivitiesCount: 0,
        workouts: [],
        message: "Compte Strava non connecté pour cet utilisateur",
      };
    }

    const validAccessToken =
      await this.refreshStravaAccessTokenIfNeeded(syncToken);
    if (!validAccessToken) {
      return {
        success: false,
        syncedActivitiesCount: 0,
        workouts: [],
        message: "Token Strava invalide ou impossible à rafraîchir",
      };
    }

    const afterEpoch = Math.floor(
      (Date.now() - daysLookback * 24 * 3600 * 1000) / 1000,
    );

    const recentActivities: any[] = [];
    try {
      let page = 1;
      const maxPages = daysLookback > 30 ? 5 : 1;
      while (page <= maxPages) {
        const res = await fetch(
          `https://www.strava.com/api/v3/athlete/activities?after=${afterEpoch}&per_page=200&page=${page}`,
          {
            headers: { Authorization: `Bearer ${validAccessToken}` },
          },
        );
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            recentActivities.push(...data);
            if (data.length < 200) break;
            page++;
          } else {
            break;
          }
        } else {
          break;
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Erreur lors de la récupération des activités récentes Strava: ${err?.message}`,
      );
      return {
        success: false,
        syncedActivitiesCount: 0,
        workouts: [],
        message: err?.message,
      };
    }

    if (recentActivities.length === 0) {
      return {
        success: true,
        syncedActivitiesCount: 0,
        workouts: [],
        message: "Aucune nouvelle activité Strava sur cette période",
      };
    }

    const mappedWorkouts = this.mapLiveStravaActivitiesToWorkouts(
      userId,
      recentActivities,
    );
    const savedWorkouts: any[] = [];

    for (const w of mappedWorkouts) {
      const upserted = await this.prisma.workout.upsert({
        where: { userId_dateKey: { userId, dateKey: w.dateKey } },
        update: {
          status: WorkoutStatus.DONE,
          isRestDay: false,
          title: w.title,
          category: w.category,
          duration: w.duration,
          distance: w.distance,
          targetPace: w.targetPace,
          targetZoneLabel: w.targetZoneLabel,
          targetZoneBpm: w.targetZoneBpm,
          targetZoneSegments: w.targetZoneSegments,
          effortBlocks: w.effortBlocks,
          sourceProvider: "strava",
          externalActivityId: w.externalActivityId,
          actualDistanceKm: w.actualDistanceKm,
          actualDurationSec: w.actualDurationSec,
          actualPace: w.actualPace,
          actualAvgHeartRate: w.actualAvgHeartRate,
          actualMaxHeartRate: w.actualMaxHeartRate,
          actualElevationGain: w.actualElevationGain,
          actualCalories: w.actualCalories,
          actualCadence: w.actualCadence,
          tss: w.tss,
          completedAt: w.completedAt,
          sportType: w.sportType,
          isCommute: w.isCommute,
          secondaryActivities: w.secondaryActivities ?? undefined,
          tags: w.tags,
          aiAdjustmentNote: w.aiAdjustmentNote,
        },
        create: w,
      });
      savedWorkouts.push(upserted);
    }

    // Recalcul du kilométrage total utilisateur (course à pied uniquement)
    const allDone = await this.prisma.workout.findMany({
      where: {
        userId,
        status: WorkoutStatus.DONE,
        isRestDay: false,
        sportType: "running",
        isCommute: false,
      },
      select: { actualDistanceKm: true },
    });
    const totalKm = allDone.reduce(
      (sum, item) => sum + (item.actualDistanceKm || 0),
      0,
    );
    await this.prisma.user.update({
      where: { id: userId },
      data: { totalKm: Number(totalKm.toFixed(2)) },
    });

    // Sauvegarde date de dernière synchronisation
    await this.prisma.syncToken.update({
      where: { id: syncToken.id },
      data: {
        metadata: {
          ...((syncToken.metadata as any) || {}),
          lastSyncedAt: new Date().toISOString(),
        },
      },
    });

    return {
      success: true,
      syncedActivitiesCount: savedWorkouts.length,
      workouts: savedWorkouts,
      message: `${savedWorkouts.length} activité(s) Strava synchronisée(s) avec succès`,
    };
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
                refreshToken: tokenData.refresh_token || syncToken.refreshToken,
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
        OR: [{ dateKey: executed.dateKey }, { status: WorkoutStatus.SELECTED }],
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

    const durMins = Math.round(executed.actualDurationSec / 60);
    const durationLabel =
      durMins >= 60
        ? `${Math.floor(durMins / 60)}h${String(durMins % 60).padStart(2, "0")}`
        : `${durMins} min`;
    const distLabel =
      executed.actualDistanceKm > 0
        ? `${executed.actualDistanceKm.toFixed(1).replace(".", ",")} km`
        : durationLabel;

    if (workout) {
      try {
        await this.prisma.workout.update({
          where: { id: workout.id },
          data: {
            status: WorkoutStatus.DONE,
            isRestDay: false,
            title:
              executed.title ||
              (workout.isRestDay
                ? "Course à pied synchronisée"
                : workout.title),
            category:
              executed.category ||
              (workout.isRestDay ? "ENDURANCE FONDAMENTALE" : workout.category),
            duration: durationLabel,
            distance: distLabel,
            targetPace: executed.actualPace,
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
            tags: [
              `${distLabel} réalisés`,
              `Allure réelle : ${executed.actualPace}`,
              ...(executed.actualAvgHeartRate
                ? [`FC moy : ${executed.actualAvgHeartRate} bpm`]
                : []),
            ],
            aiAdjustmentNote: `Séance réelle synchronisée via ${providerName} : ${executed.title || workout.title} (${distLabel} à ${paceLabel}${hrLabel} • Charge : ${sessionTss} TSS).`,
          },
        });
      } catch (err: any) {
        // RILES-006 : contrainte unique workouts.externalActivityId —
        // l'activité est déjà synchronisée, on n'écrit pas une seconde fois.
        if (WebhooksService.isUniqueViolation(err)) {
          this.logger.warn(
            `Workout update skipped: activity ${executed.externalActivityId} already synced (unique constraint)`,
          );
          return;
        }
        throw err;
      }
    } else {
      const [yyyy, mmNum, dd] = executed.dateKey.split("-").map(Number);
      const mm = mmNum - 1;
      const dObj = new Date(yyyy, mm, dd);
      const dow = dObj.getDay();
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
      const targetDate = new Date(Date.UTC(yyyy, mm, dd));
      const dayNr = targetDate.getUTCDay() || 7;
      targetDate.setUTCDate(targetDate.getUTCDate() + 4 - dayNr);
      const jan1 = new Date(Date.UTC(targetDate.getUTCFullYear(), 0, 1));
      const weekNumber = Math.ceil(
        ((targetDate.getTime() - jan1.getTime()) / 86400000 + 1) / 7,
      );

      try {
        await this.prisma.workout.create({
          data: {
            userId,
            dateKey: executed.dateKey,
            dayName: dayNamesShort[dow],
            dayNumber: dd,
            month: mm,
            year: yyyy,
            weekNumber,
            fullDateLabel: `${dayNamesFull[dow]} ${dd} ${monthNamesFull[mm]}`,
            timeLabel: "Synchronisé " + providerName,
            status: WorkoutStatus.DONE,
            isRestDay: false,
            category: executed.category || "ENDURANCE FONDAMENTALE",
            title: executed.title || "Course à pied " + providerName,
            duration: durationLabel,
            distance: distLabel,
            targetPace: executed.actualPace,
            targetZoneLabel: "Zone 2",
            targetZoneBpm: executed.actualAvgHeartRate
              ? `${executed.actualAvgHeartRate - 5}–${executed.actualAvgHeartRate + 5} bpm`
              : "135–150 bpm",
            targetZoneSegments: [
              { color: "#93C5FD", flex: 4 },
              { color: "#34D399", flex: 2 },
            ],
            effortBlocks: [
              {
                title: "Course continue",
                durationLabel,
                type: "interval",
                flexRatio: 1,
              },
            ],
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
            tags: [
              `${distLabel} réalisés`,
              `Allure : ${executed.actualPace}`,
              ...(executed.actualAvgHeartRate
                ? [`FC moy : ${executed.actualAvgHeartRate} bpm`]
                : []),
            ],
            aiAdjustmentNote: `Séance réelle synchronisée via ${providerName} : ${executed.title || "Course"} (${distLabel} à ${paceLabel}${hrLabel} • Charge : ${sessionTss} TSS).`,
          },
        });
      } catch (err: any) {
        // RILES-006 : contrainte unique workouts.externalActivityId —
        // l'activité est déjà synchronisée, on n'écrit pas une seconde fois.
        if (WebhooksService.isUniqueViolation(err)) {
          this.logger.warn(
            `Workout creation skipped: activity ${executed.externalActivityId} already synced (unique constraint)`,
          );
          return;
        }
        throw err;
      }
    }

    // Mise à jour du kilométrage total et de la charge physiologique Banister (ATL / CTL / TSB / Readiness)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { rules: true },
    });

    if (
      user &&
      (executed.actualDistanceKm > 0 || executed.actualDurationSec > 0)
    ) {
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
      this.logger.warn(
        `Push notification post-séance ignorée: ${err?.message}`,
      );
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

    const activitiesByDateKey = new Map<string, any[]>();

    for (const act of activities) {
      const distMeters = Number(act.distance || 0);
      const durationSec = Number(act.moving_time || act.elapsed_time || 0);
      if (durationSec < 120 && distMeters < 100) continue;

      let dateKey = "";
      if (act.start_date_local && typeof act.start_date_local === "string") {
        dateKey = act.start_date_local.slice(0, 10);
      } else if (act.start_date && typeof act.start_date === "string") {
        dateKey = act.start_date.slice(0, 10);
      } else {
        dateKey = new Date().toISOString().slice(0, 10);
      }

      if (!activitiesByDateKey.has(dateKey)) {
        activitiesByDateKey.set(dateKey, []);
      }
      activitiesByDateKey.get(dateKey)!.push(act);
    }

    const checkIsCommute = (act: any): boolean => {
      if (act.commute === true) return true;
      const sportType = String(act.sport_type || act.type || "");
      const nonPrepSports = [
        "Hike",
        "Walk",
        "EBikeRide",
        "Golf",
        "Kayaking",
        "StandUpPaddling",
        "Surfing",
        "Sail",
        "Skateboard",
        "Snowshoe",
        "AlpineSki",
        "Snowboard",
      ];
      if (nonPrepSports.includes(sportType)) return true;

      const title = String(act.name || "").toLowerCase();
      const desc = String(act.description || "").toLowerCase();
      return (
        title.includes("taf") ||
        title.includes("travail") ||
        title.includes("boulot") ||
        title.includes("commute") ||
        title.includes("vélotaf") ||
        title.includes("velotaf") ||
        title.includes("aller-retour") ||
        title.includes("trajet") ||
        title.includes("déplacement") ||
        title.includes("deplacement") ||
        title.includes("transport") ||
        title.includes("rando") ||
        title.includes("randonnée") ||
        title.includes("randonnee") ||
        title.includes("balade") ||
        title.includes("marche") ||
        title.includes("promenade") ||
        title.includes("cascade") ||
        title.includes("gorge") ||
        desc.includes("déplacement") ||
        desc.includes("deplacement") ||
        desc.includes("transport")
      );
    };

    const getActivityScore = (act: any): number => {
      const sportType = String(act.sport_type || act.type || "Run");
      const isRun = ["Run", "TrailRun", "VirtualRun"].includes(sportType);
      const isCommute = checkIsCommute(act);
      const distKm = Number(act.distance || 0) / 1000;

      // 1. Les séances de course à pied d'entraînement (non-commute) ont la priorité absolue
      if (isRun && !isCommute) return 10000 + distKm;
      // 2. Les séances réelles de cross-training (vélo, PPG, natation) non-commute
      if (!isCommute) return 5000 + distKm;
      // 3. Les courses de déplacement
      if (isRun) return 2000 + distKm;
      // 4. Les déplacements vélotaf
      return 1000 + distKm;
    };

    const workoutsList: any[] = [];

    for (const [dateKey, dayActs] of activitiesByDateKey.entries()) {
      // Trier par score de pertinence décroissant
      dayActs.sort((a, b) => getActivityScore(b) - getActivityScore(a));

      const act = dayActs[0];
      const otherActs = dayActs.slice(1);

      const sportTypeRaw = String(act.sport_type || act.type || "Run");
      const isRun = ["Run", "TrailRun", "VirtualRun"].includes(sportTypeRaw);
      const isRide = [
        "Ride",
        "VirtualRide",
        "EBikeRide",
        "GravelRide",
        "MountainBikeRide",
      ].includes(sportTypeRaw);
      const isSwim = ["Swim"].includes(sportTypeRaw);
      const isCommuteAct = checkIsCommute(act);
      const sportType = isRun
        ? "running"
        : isRide
          ? "cycling"
          : isSwim
            ? "swimming"
            : "cross_training";

      const distMeters = Number(act.distance || 0);
      const durationSec = Number(act.moving_time || act.elapsed_time || 0);

      const [yyyy, mmNum, dd] = dateKey.split("-").map(Number);
      const mm = mmNum - 1;
      const dateForDow = new Date(yyyy, mm, dd);
      const dow = dateForDow.getDay();
      const startDate = act.start_date
        ? new Date(act.start_date)
        : new Date(Date.UTC(yyyy, mm, dd));

      const actualDistanceKm = Number((distMeters / 1000).toFixed(2));

      // Calcul du numéro de semaine ISO réel
      const targetDate = new Date(Date.UTC(yyyy, mm, dd));
      const dayNr = targetDate.getUTCDay() || 7;
      targetDate.setUTCDate(targetDate.getUTCDate() + 4 - dayNr);
      const jan1 = new Date(Date.UTC(targetDate.getUTCFullYear(), 0, 1));
      const weekNumber = Math.ceil(
        ((targetDate.getTime() - jan1.getTime()) / 86400000 + 1) / 7,
      );

      const actualPace = isRun
        ? this.formatPaceFromDistanceAndDuration(actualDistanceKm, durationSec)
        : isRide && durationSec > 0
          ? `${(actualDistanceKm / (durationSec / 3600) || 26).toFixed(1)} km/h`
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
          ? Math.round(isRun && rawCadence < 120 ? rawCadence * 2 : rawCadence)
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

      const isUltra = isRun && actualDistanceKm >= 50;
      const isTrail =
        sportTypeRaw === "TrailRun" ||
        (isRun && (actualDistanceKm >= 35 || elevationGain >= 600));
      const isLongRun = isRun && actualDistanceKm >= 14;
      const isQuality =
        isRun && ((avgHr && avgHr >= 158) || actualDistanceKm >= 10);
      const category = isUltra
        ? "ULTRA-TRAIL & COURSE OFFICIELLE"
        : isTrail
          ? "TRAIL RUNNING"
          : isRun
            ? isLongRun
              ? "SORTIE LONGUE"
              : isQuality
                ? "SÉANCE QUALITATIVE"
                : "ENDURANCE FONDAMENTALE"
            : isRide
              ? isCommuteAct
                ? "DÉPLACEMENT - TRANSPORT"
                : "CROSS-TRAINING VÉLO"
              : isSwim
                ? "CROSS-TRAINING NATATION"
                : "RENFORCEMENT & CROSS-TRAINING";

      const defaultTitle = isUltra
        ? `Ultra-Trail (${distLabel})`
        : isTrail
          ? `Trail (${distLabel})`
          : isRun
            ? "Sortie Course à Pied Strava"
            : isRide
              ? isCommuteAct
                ? "Déplacement - Transport"
                : "Sortie Vélo / Endurance Croisée Strava"
              : isSwim
                ? "Séance Natation Strava"
                : `Séance ${sportTypeRaw} Strava`;

      // Construction sobre des activités secondaires du jour (ex: trajets vélotaf, deuxième séance)
      const secondaryActivities = otherActs.map((sec) => {
        const sSport = String(sec.sport_type || sec.type || "Ride");
        const sDistKm = Number((Number(sec.distance || 0) / 1000).toFixed(2));
        const sDurationSec = Number(sec.moving_time || sec.elapsed_time || 0);
        const sDurMins = Math.round(sDurationSec / 60);
        const sDurationLabel =
          sDurMins >= 60
            ? `${Math.floor(sDurMins / 60)}h${String(sDurMins % 60).padStart(2, "0")}`
            : `${sDurMins} min`;
        const isSecRun = ["Run", "TrailRun", "VirtualRun"].includes(sSport);
        const isSecRide = [
          "Ride",
          "VirtualRide",
          "EBikeRide",
          "GravelRide",
          "MountainBikeRide",
        ].includes(sSport);
        const sPaceOrSpeed = isSecRun
          ? this.formatPaceFromDistanceAndDuration(sDistKm, sDurationSec)
          : isSecRide && sDurationSec > 0
            ? `${(sDistKm / (sDurationSec / 3600) || 25).toFixed(1)} km/h`
            : undefined;
        const isSecCommute = checkIsCommute(sec);

        return {
          id: String(sec.id || `sec-${Math.random()}`),
          title:
            sec.name ||
            (isSecCommute ? "Déplacement - Transport" : `Activité ${sSport}`),
          sportType: isSecRun
            ? "running"
            : isSecRide
              ? "cycling"
              : sSport.toLowerCase(),
          distanceKm: sDistKm,
          durationSec: sDurationSec,
          durationLabel: sDurationLabel,
          paceOrSpeedLabel: sPaceOrSpeed,
          isCommute: isSecCommute,
          actualAvgHeartRate: sec.average_heartrate
            ? Math.round(Number(sec.average_heartrate))
            : undefined,
          actualMaxHeartRate: sec.max_heartrate
            ? Math.round(Number(sec.max_heartrate))
            : undefined,
          actualElevationGain:
            sec.total_elevation_gain !== undefined
              ? Math.round(Number(sec.total_elevation_gain))
              : undefined,
          actualCalories:
            sec.calories !== undefined
              ? Math.round(Number(sec.calories))
              : undefined,
          actualCadence: sec.average_cadence
            ? Math.round(Number(sec.average_cadence))
            : undefined,
          category: isSecCommute
            ? "DÉPLACEMENT - TRANSPORT"
            : isSecRun
              ? "COURSE À PIED"
              : isSecRide
                ? "SORTIE VÉLO"
                : "CROSS-TRAINING",
          tss: this.llmService.computeSessionTss({
            durationSec: sDurationSec,
            distanceKm: sDistKm,
            avgHeartRate: sec.average_heartrate
              ? Math.round(Number(sec.average_heartrate))
              : undefined,
            maxHeartRate: sec.max_heartrate
              ? Math.round(Number(sec.max_heartrate))
              : undefined,
          }),
        };
      });

      workoutsList.push({
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
        targetZoneLabel: isQuality || isUltra ? "Zone 3–4" : "Zone 2",
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
            title: `Corps de séance Strava (${sportTypeRaw})`,
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
          isRun ? `Allure réelle : ${actualPace}` : `Sport : ${sportTypeRaw}`,
          avgHr ? `FC moy : ${avgHr} bpm` : "Strava Sync",
        ],
        aiAdjustmentNote: `Séance réelle (${sportTypeRaw}) synchronisée depuis Strava : ${distLabel} (${durationLabel})${avgHr ? ` • ${avgHr} bpm moy` : ""} • Charge : ${tss} TSS.`,
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
        sportType,
        isCommute: isCommuteAct,
        secondaryActivities:
          secondaryActivities.length > 0 ? secondaryActivities : undefined,
      });
    }

    return workoutsList;
  }

  /**
   * Génère un jeu de données complet, réaliste et physiologiquement cohérent sur les 6 DERNIERS MOIS
   * (26 semaines : de la Semaine 17 en Avril 2026 jusqu'à la Semaine 42 en Octobre 2026)
   * incluant à la fois les séances de COURSE À PIED (77 séances) et les séances de SPORT GLOBAL / CROSS-TRAINING
   * (vélo, renforcement musculaire / PPG, natation : 25 séances), soit 102 séances sur 6 mois.
   */
  private buildSixMonthsStravaWorkoutsDataset(userId: string): any[] {
    return [];
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
            ? `${(actualDistanceKm / (actualDurationSec / 3600) || 28).toFixed(1)} km/h`
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

        if (dateKey === "2026-09-19") {
          workouts.push({
            userId,
            dateKey: "2026-09-19",
            dayName: "Sam",
            dayNumber: 19,
            month: 8, // Septembre
            year: 2026,
            weekNumber: 38,
            fullDateLabel: "SAMEDI 19 SEPTEMBRE",
            timeLabel: "06:00",
            status: WorkoutStatus.DONE,
            isRestDay: false,
            category: "ULTRA-TRAIL & COURSE OFFICIELLE",
            title: "Trail Ultra 80 km — Défi Officiel",
            duration: "9h45",
            distance: "80,0 km",
            targetPace: "7:18/km",
            targetZoneLabel: "Zone 2–3 Ultra",
            targetZoneBpm: "135–158 bpm",
            targetZoneSegments: [
              { color: "#93C5FD", flex: 2 },
              { color: "#34D399", flex: 3 },
              { color: "#FBBF24", flex: 2 },
            ],
            pinPositionPercent: 50,
            effortBlocks: [
              {
                title: "Départ & Ascension",
                durationLabel: "3h00",
                type: "warmup",
                flexRatio: 3,
              },
              {
                title: "Cœur de trail & Crêtes",
                durationLabel: "5h15",
                type: "threshold",
                flexRatio: 5,
              },
              {
                title: "Dernière descente & Finisher",
                durationLabel: "1h30",
                type: "cooldown",
                flexRatio: 2,
              },
            ],
            tags: [
              "80,0 km réalisés",
              "D+ 3850m",
              "Trail Ultra",
              "9h45",
              "Allure : 7:18/km",
            ],
            aiAdjustmentNote:
              "Épreuve majeure ultra-trail synchronisée depuis Strava : 80,0 km et 3 850 m D+ en 9h45 (7:18/km • 148 bpm moy • D+ 3850m). Performance exceptionnelle intégrée à ton historique.",
            externalActivityId: "strava-trail-80k-20260919",
            sourceProvider: "strava",
            actualDistanceKm: 80.0,
            actualDurationSec: 35100,
            actualPace: "7:18/km",
            actualAvgHeartRate: 148,
            actualMaxHeartRate: 174,
            actualElevationGain: 3850,
            actualCalories: 5820,
            actualCadence: 168,
            tss: 420,
            completedAt: new Date("2026-09-19T15:45:00.000Z"),
          });
          continue;
        }

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
            isRun
              ? `Allure réelle : ${actualPace}`
              : `Sport : ${cfg.sportType}`,
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
        tags: [
          "7,2 km réalisés",
          "Allure réelle : 5:41/km",
          "FC moy : 138 bpm",
        ],
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
        tags: [
          "6,1 km réalisés",
          "Allure réelle : 5:32/km",
          "FC moy : 141 bpm",
        ],
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
    sourceMode:
      "strava_oauth_live" | "strava_history_import" = "strava_history_import",
  ): StravaSixMonthsSummaryDto {
    if (!workouts || workouts.length === 0) {
      const defaultPaces = this.llmService.computePacesFromRecentPerformance({
        hasSyncedHistory: false,
      });
      return {
        periodMonths: 6,
        startDateKey: "",
        endDateKey: "",
        totalActivities: 0,
        totalSessions: 0,
        totalDistanceKm: 0,
        totalKm: 0,
        totalDurationHours: 0,
        totalElevationGainM: 0,
        activeWeeks: 0,
        averageWeeklyKm: 0,
        recent4WeeksAvgKm: 0,
        longestRunKm: 0,
        avgHeartRate: 0,
        maxHeartRateObserved: 185,
        estimatedPaces: defaultPaces,
        easyPaceRange: defaultPaces.easyPaceZ2,
        thresholdPace: defaultPaces.thresholdPaceZ4,
        ctlFitness: 28,
        banisterLoad: {
          ctlFitness: 28,
          atlFatigue: 28,
          tsbForm: 0,
          readinessScore: 84,
        },
        sportsBreakdown: {
          runningSessions: 0,
          runningKm: 0,
          cyclingSessions: 0,
          cyclingKm: 0,
          swimmingSessions: 0,
          strengthAndOtherSessions: 0,
          crossTrainingHours: 0,
        },
        monthlyBreakdown: [],
        ahaInsight:
          "Aucune activité passée synchronisée pour le moment. Dès que tu auras connecté ton compte Strava ou enregistré une séance, tes séances réelles apparaîtront ici.",
        syncedAt: new Date().toISOString(),
        sourceMode,
      };
    }

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
      if (w.isCommute) {
        continue;
      }
      const cat = String(w.category || "").toUpperCase();
      const sType = String(w.sportType || "").toLowerCase();
      const isRide = sType === "cycling" || cat.includes("VÉLO");
      const isSwim = sType === "swimming" || cat.includes("NATATION");
      const isCrossOther =
        !isRide &&
        !isSwim &&
        (sType === "cross_training" ||
          cat.includes("CROSS-TRAINING") ||
          cat.includes("RANDONNÉE") ||
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
        avgPace: this.formatPaceFromDistanceAndDuration(
          m.km,
          m.runSec || m.sec,
        ),
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

    const ahaInsight = `Sur tes 6 derniers mois Strava (${workouts.length} activités sportives dont ${runningSessions} courses à pied pour ${roundedRunningKm} km${crossTrainingCount > 0 ? ` + ${crossTrainingCount} séances de cross-training (${crossTrainingHours}h vélo/PPG/natation)` : ""}), ton volume course a progressé jusqu'à ${recent4WeeksAvgKm} km/sem sur le dernier mois (sortie longue max : ${longestRunKm.toFixed(1)} km). Ton plan multi-semaines calibre ta Zone 2 à ${estimatedPaces.easyPaceZ2}, ton Seuil à ${estimatedPaces.thresholdPaceZ4} et intègre ta charge multisport globale (CTL ${roundedCtl}).`;

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

  // ---------------------------------------------------------------------------
  // RILES-006 : réception idempotente (anti-rejeu) + utilisateur résolu
  // côté serveur via le mapping SyncToken, jamais depuis le payload.
  // ---------------------------------------------------------------------------

  /** Empreinte déterministe d'un payload (clé de déduplication de repli). */
  private static payloadFingerprint(payload: unknown): string {
    return crypto
      .createHash("sha256")
      .update(JSON.stringify(payload) ?? "")
      .digest("hex")
      .slice(0, 40);
  }

  /** Violation de contrainte unique Prisma (P2002). */
  private static isUniqueViolation(err: any): boolean {
    return err?.code === "P2002" || err?.meta?.code === "P2002";
  }

  private dedupeKey(
    provider: string,
    eventType: string,
    objectId: string,
  ): string {
    return `${provider}|${eventType}|${objectId}`;
  }

  private markWebhookEventSeen(key: string, now: number): void {
    if (this.seenWebhookEvents.size >= WebhooksService.DEDUPE_MAX_KEYS) {
      for (const [k, ts] of this.seenWebhookEvents) {
        if (now - ts > WebhooksService.DEDUPE_TTL_MS) {
          this.seenWebhookEvents.delete(k);
        }
      }
      while (this.seenWebhookEvents.size >= WebhooksService.DEDUPE_MAX_KEYS) {
        const oldest = this.seenWebhookEvents.keys().next();
        if (oldest.done) break;
        this.seenWebhookEvents.delete(oldest.value);
      }
    }
    this.seenWebhookEvents.set(key, now);
  }

  /**
   * Enregistre la livraison si elle est nouvelle et retourne `true` si c'est
   * un doublon (rejeu) — auquel cas aucune écriture métier n'a eu lieu.
   * 1) cache en processus : rejoue immédiat sans requête SQL ;
   * 2) contrainte unique (provider, eventType, objectId) : autorité en base.
   */
  private async recordWebhookEvent(data: {
    provider: string;
    eventType: string;
    objectId: string;
    payload: unknown;
  }): Promise<boolean> {
    const key = this.dedupeKey(data.provider, data.eventType, data.objectId);
    const now = Date.now();
    const seenAt = this.seenWebhookEvents.get(key);
    if (seenAt !== undefined) {
      if (now - seenAt <= WebhooksService.DEDUPE_TTL_MS) {
        return true;
      }
      this.seenWebhookEvents.delete(key);
    }

    try {
      await this.prisma.webhookEvent.create({
        data: {
          provider: data.provider,
          eventType: data.eventType,
          objectId: data.objectId,
          payload: data.payload as any,
          processed: true,
          processedAt: new Date(),
        },
      });
    } catch (err: any) {
      if (!WebhooksService.isUniqueViolation(err)) {
        throw err;
      }
      this.logger.warn(`Duplicate ${data.provider} webhook dropped: ${key}`);
      this.markWebhookEventSeen(key, now);
      return true;
    }

    this.markWebhookEventSeen(key, now);
    return false;
  }

  async handleStravaEvent(event: StravaEventDto): Promise<WebhookResponseDto> {
    this.logger.log(`Received Strava webhook event: ${JSON.stringify(event)}`);

    const eventType = `${event.object_type}.${event.aspect_type}`;
    const objectId =
      event.object_id !== undefined && event.object_id !== null
        ? String(event.object_id)
        : WebhooksService.payloadFingerprint(event);

    if (
      await this.recordWebhookEvent({
        provider: "strava",
        eventType,
        objectId,
        payload: event,
      })
    ) {
      return {
        success: false,
        message: "Duplicate Strava delivery ignored (idempotent replay)",
      };
    }

    if (
      event.object_type === "activity" &&
      (event.aspect_type === "create" || event.aspect_type === "update")
    ) {
      // RILES-006 : l'utilisateur cible vient exclusivement du mapping serveur
      // SyncToken (athlete/owner du fournisseur), jamais du payload.
      const syncToken = await this.prisma.syncToken.findFirst({
        where: {
          provider: "strava",
          externalUserId: String(event.owner_id),
        },
      });

      if (!syncToken?.userId) {
        this.logger.warn(
          `Strava event dropped: no SyncToken linked to athlete/owner ${event.owner_id} (RILES-006)`,
        );
        return {
          success: false,
          message: "Event ignored: no linked Strava account for this athlete",
        };
      }

      const userId = syncToken.userId;

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
        title: stravaActivity.name || "Course à pied Strava",
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

    const d = event.data || {};
    const externalId = d.activityId ?? d.summaryId;
    const objectId =
      externalId !== undefined && externalId !== null
        ? String(externalId)
        : WebhooksService.payloadFingerprint(event);

    if (
      await this.recordWebhookEvent({
        provider: "garmin",
        eventType: event.type,
        objectId,
        payload: event,
      })
    ) {
      return {
        success: false,
        message: "Duplicate Garmin delivery ignored (idempotent replay)",
      };
    }

    // RILES-006 : utilisateur résolu via le mapping fournisseur → utilisateur
    // (SyncToken.externalUserId), jamais depuis event.userId du payload.
    const syncToken = await this.prisma.syncToken.findFirst({
      where: {
        provider: "garmin",
        externalUserId: event.userId,
      },
    });
    if (!syncToken?.userId) {
      this.logger.warn(
        `Garmin event dropped: no SyncToken linked to provider user ${event.userId} (RILES-006)`,
      );
      return {
        success: false,
        message: "Event ignored: no linked Garmin account for this user",
      };
    }
    const userId = syncToken.userId;

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
          d.activityId ?? d.summaryId ?? WebhooksService.payloadFingerprint(d),
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

    const meta = dto.metadata || {};
    const objectId = meta.workoutUuid
      ? String(meta.workoutUuid)
      : WebhooksService.payloadFingerprint(dto);

    if (
      await this.recordWebhookEvent({
        provider: "apple_health",
        eventType: dto.activityType,
        objectId,
        payload: dto,
      })
    ) {
      return {
        success: false,
        message: "Duplicate Apple Health delivery ignored (idempotent replay)",
      };
    }

    // RILES-006 : utilisateur résolu via SyncToken.externalUserId du mapping
    // serveur, jamais depuis dto.userId du payload.
    const syncToken = await this.prisma.syncToken.findFirst({
      where: {
        provider: "apple_health",
        externalUserId: dto.userId,
      },
    });
    if (!syncToken?.userId) {
      this.logger.warn(
        `Apple Health sync dropped: no SyncToken linked to provider user ${dto.userId} (RILES-006)`,
      );
      return {
        success: false,
        message: "Event ignored: no linked Apple Health account for this user",
      };
    }
    const userId = syncToken.userId;

    if (dto.activityType === "running" || dto.distanceMeters > 0) {
      const actualDistanceKm = Number((dto.distanceMeters / 1000).toFixed(2));
      const actualDurationSec = Math.round(dto.durationSeconds);
      const actualPace = this.formatPaceFromDistanceAndDuration(
        actualDistanceKm,
        actualDurationSec,
      );
      const completedAt = dto.startDate ? new Date(dto.startDate) : new Date();

      await this.persistExecutedWorkoutAndLog(userId, {
        externalActivityId: String(
          meta.workoutUuid
            ? meta.workoutUuid
            : WebhooksService.payloadFingerprint(dto),
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

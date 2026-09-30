import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DataLakeService } from "../datalake/datalake.service";
import { LlmService } from "../llm/llm.service";
import { WorkoutsService } from "../workouts/workouts.service";
import { WebhooksService } from "../webhooks/webhooks.service";
import {
  ReformulateGoalResultDto,
  StravaSixMonthsSummaryDto,
} from "../llm/dto/llm.dto";
import {
  ConnectedAppDto,
  OnboardingStateDto,
  SaveOnboardingStepDto,
  CompleteOnboardingDto,
  SyncStravaSixMonthsDto,
} from "./dto/onboarding.dto";
import { AuthProvider, PlanType } from "@prisma/client";

export const CONNECTED_APPS_CATALOG: ConnectedAppDto[] = [
  {
    id: "garmin",
    name: "Garmin",
    code: "G",
    color: "#0F172A",
    isConnected: false,
  },
  {
    id: "strava",
    name: "Strava",
    code: "S",
    color: "#FC4C02",
    isConnected: false,
  },
  {
    id: "coros",
    name: "COROS",
    code: "C",
    color: "#0F172A",
    isConnected: false,
  },
  {
    id: "polar",
    name: "Polar",
    code: "P",
    color: "#D32F2F",
    isConnected: false,
  },
  {
    id: "suunto",
    name: "Suunto",
    code: "S",
    color: "#1E293B",
    isConnected: false,
  },
  {
    id: "apple_health",
    name: "Apple Santé",
    code: "A",
    color: "#0F172A",
    isConnected: false,
  },
];

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly dataLakeService: DataLakeService,
    private readonly workoutsService: WorkoutsService,
    private readonly webhooksService: WebhooksService,
  ) {}

  getStravaOAuthUrl(redirectUri?: string) {
    return this.webhooksService.getStravaOAuthAuthorizeUrl(redirectUri);
  }

  async syncStravaSixMonths(
    userId: string,
    dto?: SyncStravaSixMonthsDto,
  ): Promise<StravaSixMonthsSummaryDto> {
    return this.webhooksService.syncStravaSixMonthsHistory(userId, {
      code: dto?.code,
      redirectUri: dto?.redirectUri,
      pushToken: dto?.pushToken,
      forceRefresh: dto?.forceRefresh,
    });
  }

  async reformulateGoal(
    userId: string,
    rawGoal: string,
  ): Promise<ReformulateGoalResultDto> {
    const [user, recentWorkouts] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: { syncTokens: { where: { isConnected: true } } },
      }),
      this.prisma.workout.findMany({
        where: { userId, isRestDay: false },
        orderBy: { dateKey: "desc" },
        take: 25,
      }),
    ]);

    const stravaToken = user?.syncTokens?.find((t) => t.provider === "strava");
    const sixMonthsSummary: StravaSixMonthsSummaryDto | undefined = (
      stravaToken?.metadata as any
    )?.sixMonthsSummary;

    const recentSessions =
      this.llmService.extractSessionMetricsFromWorkouts(recentWorkouts);
    const hasSyncedHistory = Boolean(
      user?.syncTokens && user.syncTokens.length > 0,
    );
    const recentWeeklyKm =
      sixMonthsSummary?.recent4WeeksAvgKm ??
      (hasSyncedHistory && user?.totalKm && user?.activeWeeks
        ? user.totalKm / Math.max(1, user.activeWeeks)
        : undefined);
    const longestRecentRunKm =
      sixMonthsSummary?.longestRunKm ??
      (recentSessions && recentSessions.length > 0
        ? Math.max(...recentSessions.map((s) => s.distanceKm || 0))
        : undefined);

    const result = await this.llmService.reformulateOnboardingGoal(rawGoal, {
      hasSyncedHistory,
      recentWeeklyKm,
      recent4WeeksAvgKm: sixMonthsSummary?.recent4WeeksAvgKm,
      totalKm6Months: sixMonthsSummary?.totalDistanceKm ?? user?.totalKm,
      longestRecentRunKm,
      activeWeeks: sixMonthsSummary?.activeWeeks ?? user?.activeWeeks,
      hrMax: sixMonthsSummary?.maxHeartRateObserved,
      recentSessions,
      sixMonthsSummary,
    });

    // Log asynchrone dans le Data Lake
    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "onboarding_goal_reformulation",
      interaction: {
        type: "goal_reformulation",
        userPrompt: rawGoal,
        aiResponse: result.reformulatedGoal,
        extractedGoal: result.extractedGoal,
        extractedRules: result.extractedRules,
        eligibility: result.eligibility,
      },
      athleteContext: {
        totalKm: sixMonthsSummary?.totalDistanceKm ?? user?.totalKm,
        activeWeeks: sixMonthsSummary?.activeWeeks ?? user?.activeWeeks,
        recent4WeeksAvgKm: sixMonthsSummary?.recent4WeeksAvgKm,
      },
    });

    return result;
  }

  async getOnboardingState(userId: string): Promise<OnboardingStateDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        syncTokens: { where: { isConnected: true } },
      },
    });

    if (!user) {
      return {
        currentStep: 1,
        authMethod: null,
        userEmail: "",
        mainGoal: "Me préparer pour mon premier semi-marathon sans me blesser",
        selectedSports: ["running"],
        connectedApps: ["garmin", "strava"],
        selectedPlan: "pro",
        isCompleted: false,
      };
    }

    const connectedApps = user.syncTokens.map((t) => t.provider);
    const stravaToken = user.syncTokens.find((t) => t.provider === "strava");
    const stravaMeta = (stravaToken?.metadata as any) || {};
    const stravaSixMonthsSummary: StravaSixMonthsSummaryDto | undefined =
      stravaMeta.sixMonthsSummary;

    return {
      currentStep: user.isOnboardingCompleted ? 5 : 1,
      authMethod:
        user.authProvider === AuthProvider.APPLE
          ? "apple"
          : user.authProvider === AuthProvider.GOOGLE
            ? "google"
            : "email",
      userEmail: user.email,
      mainGoal:
        user.mainGoal ||
        user.activeGoalTarget ||
        "Me préparer pour mon premier semi-marathon sans me blesser",
      selectedSports: user.selectedSports || ["running"],
      connectedApps:
        connectedApps.length > 0 ? connectedApps : ["garmin", "strava"],
      selectedPlan: user.planType === PlanType.PRO ? "pro" : "basic",
      isCompleted: user.isOnboardingCompleted,
      stravaSixMonthsSummary,
      generatedPlanSummary: stravaMeta.generatedPlanSummary,
      generatedPlan: stravaMeta.generatedPlan,
    };
  }

  async getAppsCatalog(userId: string): Promise<ConnectedAppDto[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { syncTokens: true },
    });

    const userConnectedTokens = new Set(
      user?.syncTokens.filter((t) => t.isConnected).map((t) => t.provider) ||
        [],
    );

    return CONNECTED_APPS_CATALOG.map((app) => ({
      ...app,
      isConnected: userConnectedTokens.has(app.id),
    }));
  }

  async saveStepData(
    userId: string,
    dto: SaveOnboardingStepDto,
  ): Promise<OnboardingStateDto> {
    const dataToUpdate: any = {};

    // Si Strava est connecté pendant l'onboarding (ex: Étape 4), on s'assure que les 6 derniers mois de données Strava sont bien récupérés et sauvegardés
    if (dto.connectedApps) {
      for (const provider of dto.connectedApps) {
        await this.prisma.syncToken.upsert({
          where: { userId_provider: { userId, provider } },
          update: { isConnected: true },
          create: { userId, provider, isConnected: true },
        });
      }

      if (dto.connectedApps.includes("strava")) {
        const stravaTok = await this.prisma.syncToken.findUnique({
          where: { userId_provider: { userId, provider: "strava" } },
        });
        if (!(stravaTok?.metadata as any)?.sixMonthsSummary) {
          await this.webhooksService.syncStravaSixMonthsHistory(userId);
        }
      }
    }

    if (dto.mainGoal) {
      const parsed = await this.reformulateGoal(userId, dto.mainGoal);
      dataToUpdate.mainGoal = dto.mainGoal;
      dataToUpdate.activeGoalTitle = parsed.extractedGoal.title;
      dataToUpdate.activeGoalTarget = parsed.extractedGoal.target;
      dataToUpdate.activeGoalRaceDate = parsed.extractedGoal.raceDate;
      dataToUpdate.activeGoalWeeksRemaining =
        parsed.extractedGoal.weeksRemaining;
    }
    if (dto.selectedSports) {
      dataToUpdate.selectedSports = dto.selectedSports;
    }
    if (dto.selectedPlan) {
      dataToUpdate.planType =
        dto.selectedPlan === "pro" ? PlanType.PRO : PlanType.BASIC;
    }
    if (dto.isCompleted !== undefined) {
      dataToUpdate.isOnboardingCompleted = dto.isCompleted;
    }

    if (dto.extractedRules && dto.extractedRules.length > 0) {
      const existingRules = await this.prisma.lifeRule.findMany({
        where: { userId },
      });
      const existingTitles = new Set(
        existingRules.map((r) => r.title.toLowerCase()),
      );
      for (const rule of dto.extractedRules) {
        if (!existingTitles.has(rule.title.toLowerCase())) {
          await this.prisma.lifeRule.create({
            data: {
              userId,
              title: rule.title,
              description: rule.description,
              icon: rule.icon || "calendar-lock",
            },
          });
        }
      }
    }

    if (Object.keys(dataToUpdate).length > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: dataToUpdate,
      });
    }

    return this.getOnboardingState(userId);
  }

  async completeOnboarding(
    userId: string,
    dto?: CompleteOnboardingDto,
  ): Promise<OnboardingStateDto> {
    const dataToUpdate: any = {
      isOnboardingCompleted: true,
    };

    // 1. Enregistrement des applications connectées et synchronisation des 6 derniers mois Strava si Strava est sélectionné
    if (dto?.connectedApps) {
      for (const provider of dto.connectedApps) {
        await this.prisma.syncToken.upsert({
          where: { userId_provider: { userId, provider } },
          update: { isConnected: true },
          create: { userId, provider, isConnected: true },
        });
      }
    }

    const stravaConnected =
      dto?.connectedApps?.includes("strava") ?? true;
    if (stravaConnected) {
      const stravaTok = await this.prisma.syncToken.findUnique({
        where: { userId_provider: { userId, provider: "strava" } },
      });
      if (!(stravaTok?.metadata as any)?.sixMonthsSummary) {
        await this.webhooksService.syncStravaSixMonthsHistory(userId);
      }
    }

    // 2. Reformulation & calibration de l'objectif avec le contexte des 6 mois de données Strava
    if (dto?.mainGoal) {
      const parsed = await this.reformulateGoal(userId, dto.mainGoal);
      dataToUpdate.mainGoal = dto.mainGoal;
      dataToUpdate.activeGoalTitle = parsed.extractedGoal.title;
      dataToUpdate.activeGoalTarget = parsed.extractedGoal.target;
      dataToUpdate.activeGoalRaceDate = parsed.extractedGoal.raceDate;
      dataToUpdate.activeGoalWeeksRemaining =
        parsed.extractedGoal.weeksRemaining;

      const rulesToSave =
        dto.extractedRules && dto.extractedRules.length > 0
          ? dto.extractedRules
          : parsed.extractedRules;

      if (rulesToSave && rulesToSave.length > 0) {
        const existingRules = await this.prisma.lifeRule.findMany({
          where: { userId },
        });
        const existingTitles = new Set(
          existingRules.map((r) => r.title.toLowerCase()),
        );
        for (const rule of rulesToSave) {
          if (!existingTitles.has(rule.title.toLowerCase())) {
            await this.prisma.lifeRule.create({
              data: {
                userId,
                title: rule.title,
                description: rule.description,
                icon: rule.icon || "calendar-lock",
              },
            });
          }
        }
      }
    }

    if (dto?.selectedSports) {
      dataToUpdate.selectedSports = dto.selectedSports;
    }
    if (dto?.selectedPlan) {
      dataToUpdate.planType =
        dto.selectedPlan === "pro" ? PlanType.PRO : PlanType.BASIC;
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: dataToUpdate,
    });

    // 3. Génération automatique du plan multi-semaines par LLM_PRO_MODEL en s'appuyant sur :
    //    - les 6 derniers mois de données Strava (volume récent, sortie longue max, charge CTL/ATL/TSB, sports globaux)
    //    - les allures physiologiques réelles (Z2, Z3, Z4, Z5)
    //    - l'objectif et les LifeRules de l'utilisateur
    const planResult = await this.workoutsService.generateAndSaveMultiWeekPlan(
      userId,
      {
        startWeekNumber: 42,
        year: 2026,
        weeksToGenerate: 4,
      },
    );

    // Construction du résumé structuré semaine par semaine pour affichage en fin d'onboarding
    const byWeek = new Map<
      number,
      {
        weekNumber: number;
        plannedRunningSessions: number;
        restDays: number;
        keySessions: string[];
      }
    >();

    for (const w of planResult.workouts) {
      const wk = w.weekNumber ?? 42;
      const entry = byWeek.get(wk) || {
        weekNumber: wk,
        plannedRunningSessions: 0,
        restDays: 0,
        keySessions: [],
      };
      if (w.isRestDay) {
        entry.restDays += 1;
      } else {
        entry.plannedRunningSessions += 1;
        entry.keySessions.push(`${w.dayName} : ${w.title} (${w.distance})`);
      }
      byWeek.set(wk, entry);
    }

    const generatedPlan = {
      planSummary: planResult.planSummary,
      weeksGenerated: planResult.weeksGenerated,
      startWeekNumber: 42,
      year: 2026,
      modelUsed: planResult.modelUsed,
      totalPlannedSessions: planResult.workouts.filter((w) => !w.isRestDay)
        .length,
      weeklyBreakdown: Array.from(byWeek.values()).sort(
        (a, b) => a.weekNumber - b.weekNumber,
      ),
    };

    // Sauvegarde du résumé du plan dans les métadonnées Strava pour persistance dans getOnboardingState
    const existingStravaTok = await this.prisma.syncToken.findUnique({
      where: { userId_provider: { userId, provider: "strava" } },
    });
    if (existingStravaTok) {
      const currentMeta = (existingStravaTok.metadata as any) || {};
      await this.prisma.syncToken.update({
        where: { id: existingStravaTok.id },
        data: {
          metadata: {
            ...currentMeta,
            generatedPlanSummary: planResult.planSummary,
            generatedPlan,
          } as any,
        },
      });
    }

    const finalState = await this.getOnboardingState(userId);

    // 4. Archivage automatique de la complétion d'onboarding et du plan généré dans le Data Lake
    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "onboarding_goal_reformulation",
      interaction: {
        type: "onboarding_completed_with_plan",
        mainGoal: finalState.mainGoal,
        selectedSports: finalState.selectedSports,
        connectedApps: finalState.connectedApps,
        selectedPlan: finalState.selectedPlan,
        generatedPlanSummary: planResult.planSummary,
        generatedPlan,
      },
      athleteContext: {
        sixMonthsSummary: finalState.stravaSixMonthsSummary,
      },
    });

    return {
      ...finalState,
      generatedPlanSummary: planResult.planSummary,
      generatedPlan,
    };
  }

  async resetOnboarding(userId: string): Promise<OnboardingStateDto> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        isOnboardingCompleted: false,
      },
    });

    return this.getOnboardingState(userId);
  }
}

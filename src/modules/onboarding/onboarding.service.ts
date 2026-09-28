import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DataLakeService } from "../datalake/datalake.service";
import { LlmService } from "../llm/llm.service";
import { WorkoutsService } from "../workouts/workouts.service";
import { ReformulateGoalResultDto } from "../llm/dto/llm.dto";
import {
  ConnectedAppDto,
  OnboardingStateDto,
  SaveOnboardingStepDto,
  CompleteOnboardingDto,
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
  ) {}

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
        take: 10,
      }),
    ]);

    const recentSessions =
      this.llmService.extractSessionMetricsFromWorkouts(recentWorkouts);
    const hasSyncedHistory = Boolean(
      user?.syncTokens && user.syncTokens.length > 0,
    );
    const recentWeeklyKm =
      hasSyncedHistory && user?.totalKm && user?.activeWeeks
        ? user.totalKm / Math.max(1, user.activeWeeks)
        : undefined;
    const longestRecentRunKm =
      recentSessions && recentSessions.length > 0
        ? Math.max(...recentSessions.map((s) => s.distanceKm || 0))
        : undefined;

    const result = await this.llmService.reformulateOnboardingGoal(rawGoal, {
      hasSyncedHistory,
      recentWeeklyKm,
      longestRecentRunKm,
      activeWeeks: user?.activeWeeks,
      recentSessions,
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
        totalKm: user?.totalKm,
        activeWeeks: user?.activeWeeks,
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
        connectedApps: ["garmin"],
        selectedPlan: "pro",
        isCompleted: false,
      };
    }

    const connectedApps = user.syncTokens.map((t) => t.provider);

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
    if (dto.mainGoal) {
      const parsed = await this.llmService.reformulateOnboardingGoal(
        dto.mainGoal,
      );
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

    if (dto.connectedApps) {
      for (const provider of dto.connectedApps) {
        await this.prisma.syncToken.upsert({
          where: { userId_provider: { userId, provider } },
          update: { isConnected: true },
          create: { userId, provider, isConnected: true },
        });
      }
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

    if (dto?.mainGoal) {
      const parsed = await this.llmService.reformulateOnboardingGoal(
        dto.mainGoal,
      );
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

    if (dto?.connectedApps) {
      for (const provider of dto.connectedApps) {
        await this.prisma.syncToken.upsert({
          where: { userId_provider: { userId, provider } },
          update: { isConnected: true },
          create: { userId, provider, isConnected: true },
        });
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: dataToUpdate,
    });

    // Génération automatique du plan multi-semaines par le meilleur LLM (LLM_PRO_MODEL)
    // en tenant compte du profil, des allures réelles et des LifeRules fraîchement enregistrées
    await this.workoutsService.generateAndSaveMultiWeekPlan(userId, {
      startWeekNumber: 42,
      year: 2026,
      weeksToGenerate: 4,
    });

    return this.getOnboardingState(userId);
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

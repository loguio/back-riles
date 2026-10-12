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
        mainGoal: "",
        selectedSports: ["running"],
        connectedApps: [],
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
      mainGoal: user.mainGoal || user.activeGoalTarget || "",
      selectedSports: user.selectedSports || ["running"],
      connectedApps: connectedApps,
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
    let parsed: any = null;
    if (dto?.mainGoal) {
      parsed = await this.reformulateGoal(userId, dto.mainGoal);
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

    // Détermination dynamique de la date d'objectif et de la durée du plan :
    // - Si pas de date précisée : plan par défaut sur 4 mois (16 semaines)
    // - Si date précisée : plan jusqu'à la date d'objectif prévue
    const now = new Date();
    const currentWeekNumber = this.workoutsService.getIsoWeekNumber(now);
    const currentYear = now.getFullYear();

    const rawDateCandidate =
      dto?.targetRaceDate ||
      parsed?.extractedGoal?.raceDate ||
      (dto?.mainGoal ? this.extractDateMention(dto.mainGoal) : undefined);

    const { targetDate, weeks: calculatedWeeks } =
      this.parseTargetRaceDate(rawDateCandidate);

    const weeksToGenerate = dto?.weeksToGenerate && dto.weeksToGenerate > 0
      ? dto.weeksToGenerate
      : calculatedWeeks;

    if (targetDate) {
      dataToUpdate.activeGoalRaceDate = targetDate.toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
      dataToUpdate.activeGoalWeeksRemaining = weeksToGenerate;
    } else {
      dataToUpdate.activeGoalRaceDate = "Dans 16 semaines (4 mois)";
      dataToUpdate.activeGoalWeeksRemaining = 16;
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
    //    - les 6 derniers mois de données Strava (volume récent, sortie longue max, charge CTL/ATL/TSB)
    //    - les allures physiologiques réelles (Z2, Z3, Z4, Z5)
    //    - l'objectif et la durée personnalisée (jusqu'à la date d'épreuve ou 12 semaines par défaut)
    const planResult = await this.workoutsService.generateAndSaveMultiWeekPlan(
      userId,
      {
        startWeekNumber: currentWeekNumber,
        year: currentYear,
        weeksToGenerate,
      },
    );

    // Calcul du volume hebdomadaire moyen de référence
    const stravaToken = await this.prisma.syncToken.findUnique({
      where: { userId_provider: { userId, provider: "strava" } },
    });
    const sixMonthsSummary = (stravaToken?.metadata as any)?.sixMonthsSummary;
    const baseWeeklyKm = sixMonthsSummary?.recent4WeeksAvgKm || 30;

    // Découpage automatique des 4 phases de la préparation
    const phases = this.computePreparationPhases(weeksToGenerate, baseWeeklyKm);

    // Construction du résumé structuré semaine par semaine
    const byWeek = new Map<
      string,
      {
        weekNumber: number;
        relativeWeek: number;
        firstDateKey: string;
        phaseName: string;
        weekType: string;
        estimatedKm: number;
        plannedRunningSessions: number;
        restDays: number;
        keySessions: string[];
      }
    >();

    for (const w of planResult.workouts) {
      const wk = w.weekNumber ?? currentWeekNumber;
      const weekYear = w.year ?? currentYear;
      const weekKey = `${weekYear}-W${String(wk).padStart(2, "0")}`;
      const entry = byWeek.get(weekKey) || {
        weekNumber: wk,
        relativeWeek: 1,
        firstDateKey: w.dateKey,
        phaseName: "Phase 1 : Socle Aérobie",
        weekType: "Endurance & Volume",
        estimatedKm: 0,
        plannedRunningSessions: 0,
        restDays: 0,
        keySessions: [],
      };
      if (w.isRestDay) {
        entry.restDays += 1;
      } else {
        entry.plannedRunningSessions += 1;
        entry.keySessions.push(`${w.dayName} : ${w.title} (${w.distance})`);
        const distNum =
          parseFloat(
            (w.distance || "0").replace(",", ".").replace(/[^0-9.]/g, ""),
          ) || 0;
        entry.estimatedKm += distNum;
      }
      byWeek.set(weekKey, entry);
    }

    const sortedWeeks = Array.from(byWeek.values()).sort(
      (a, b) => a.firstDateKey.localeCompare(b.firstDateKey),
    );

    sortedWeeks.forEach((item, index) => {
      item.relativeWeek = index + 1;
      item.estimatedKm = Math.round(item.estimatedKm);
      const pct = (index + 1) / Math.max(1, sortedWeeks.length);
      if (pct <= 0.35) {
        item.phaseName = "Phase 1 : Socle Aérobie";
        item.weekType =
          (index + 1) % 4 === 0
            ? "Assimilation (Deload)"
            : "Volume & Endurance Z2";
      } else if (pct <= 0.65) {
        item.phaseName = "Phase 2 : Seuil & Allure Cible";
        item.weekType =
          (index + 1) % 4 === 0
            ? "Assimilation (Deload)"
            : "Fractions Seuil Z4";
      } else if (pct <= 0.85) {
        item.phaseName = "Phase 3 : Pic Spécifique";
        item.weekType = "Allure Course & Sortie Longue";
      } else {
        item.phaseName = "Phase 4 : Affûtage";
        item.weekType = "Affûtage & Fraîcheur";
      }
    });

    const generatedPlan = {
      planSummary: planResult.planSummary,
      weeksGenerated: planResult.weeksGenerated,
      startWeekNumber: currentWeekNumber,
      year: currentYear,
      targetRaceDate: dataToUpdate.activeGoalRaceDate,
      modelUsed: planResult.modelUsed,
      totalPlannedSessions: planResult.workouts.filter((w) => !w.isRestDay)
        .length,
      phases,
      weeklyBreakdown: sortedWeeks,
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

  public extractDateMention(text: string): string | undefined {
    const frMatch = text.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/);
    if (frMatch) return frMatch[0];
    const textDateMatch = text.match(/\b\d{1,2}\s+[a-zéû]+\s+\d{4}\b/i);
    if (textDateMatch) return textDateMatch[0];
    const weeksMatch = text.match(/\b\d+\s*semaines?\b/i);
    if (weeksMatch) return weeksMatch[0];
    const monthsMatch = text.match(/\b\d+\s*mois\b/i);
    if (monthsMatch) return monthsMatch[0];

    // Détection d'un mois cible seul, ex: "pour février", "en février", "février"
    const singleMonthMatch = text.match(
      /\b(?:pour|en|début|mi|fin)?\s*(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)\b/i,
    );
    if (singleMonthMatch) return singleMonthMatch[0];

    return undefined;
  }

  public parseTargetRaceDate(
    dateStr?: string,
  ): { targetDate: Date | null; weeks: number } {
    const defaultWeeks = 16; // 4 mois par défaut si pas de date d'objectif
    if (!dateStr || !dateStr.trim()) {
      return { targetDate: null, weeks: defaultWeeks };
    }

    const trimmed = dateStr.trim();
    const now = new Date();

    // 1. Format ISO "YYYY-MM-DD"
    const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoMatch) {
      const d = new Date(
        parseInt(isoMatch[1], 10),
        parseInt(isoMatch[2], 10) - 1,
        parseInt(isoMatch[3], 10),
      );
      if (!isNaN(d.getTime()) && d > now) {
        const weeks = Math.max(
          1,
          Math.round((d.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000)),
        );
        return { targetDate: d, weeks };
      }
    }

    // 2. Format FR "DD/MM/YYYY" ou "DD-MM-YYYY"
    const frMatch = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (frMatch) {
      const d = new Date(
        parseInt(frMatch[3], 10),
        parseInt(frMatch[2], 10) - 1,
        parseInt(frMatch[1], 10),
      );
      if (!isNaN(d.getTime()) && d > now) {
        const weeks = Math.max(
          1,
          Math.round((d.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000)),
        );
        return { targetDate: d, weeks };
      }
    }

    // 3. Mois en français dans le texte complet, ex: "18 mai 2027", "12 octobre 2026"
    const monthsFr: Record<string, number> = {
      janvier: 0,
      février: 1,
      fevrier: 1,
      mars: 2,
      avril: 3,
      mai: 4,
      juin: 5,
      juillet: 6,
      août: 7,
      aout: 7,
      septembre: 8,
      octobre: 9,
      novembre: 10,
      décembre: 11,
      decembre: 11,
    };
    const textDateMatch = trimmed
      .toLowerCase()
      .match(/(\d{1,2})\s+([a-zéû]+)\s+(\d{4})/i);
    if (textDateMatch && monthsFr[textDateMatch[2]] !== undefined) {
      const d = new Date(
        parseInt(textDateMatch[3], 10),
        monthsFr[textDateMatch[2]],
        parseInt(textDateMatch[1], 10),
      );
      if (!isNaN(d.getTime()) && d > now) {
        const weeks = Math.max(
          1,
          Math.round((d.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000)),
        );
        return { targetDate: d, weeks };
      }
    }

    // 4. "Dans X semaines" ou "Dans X mois"
    const weeksMatch = trimmed.match(/(\d+)\s*semaine/i);
    if (weeksMatch) {
      const w = parseInt(weeksMatch[1], 10);
      if (w > 0) {
        const d = new Date(now.getTime() + w * 7 * 24 * 3600 * 1000);
        return { targetDate: d, weeks: w };
      }
    }

    const monthsMatch = trimmed.match(/(\d+)\s*mois/i);
    if (monthsMatch) {
      const m = parseInt(monthsMatch[1], 10);
      if (m > 0) {
        const d = new Date(now.getTime() + m * 30 * 24 * 3600 * 1000);
        return { targetDate: d, weeks: m * 4 };
      }
    }

    // 5. Mention d'un mois seul, ex: "pour février", "en février", "février"
    const lower = trimmed.toLowerCase();
    for (const [mName, mIdx] of Object.entries(monthsFr)) {
      if (lower.includes(mName)) {
        let targetYear = now.getFullYear();
        // Si le mois demandé est passé ou en cours cette année (ex: février alors qu'on est en octobre), c'est l'année suivante
        if (mIdx <= now.getMonth()) {
          targetYear += 1;
        }
        // Par défaut, cible au 3ème dimanche de ce mois (les marathons ont lieu le dimanche)
        const targetDay = 21;
        const d = new Date(targetYear, mIdx, targetDay);
        const weeks = Math.max(
          4,
          Math.round((d.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000)),
        );
        return { targetDate: d, weeks };
      }
    }

    return { targetDate: null, weeks: defaultWeeks };
  }

  public computePreparationPhases(
    totalWeeks: number,
    baseWeeklyKm = 30,
  ): Array<{
    name: string;
    weeksRangeLabel: string;
    focus: string;
    weekType: string;
    avgKm: number;
    sessionsPerWeek: number;
  }> {
    const w = Math.max(4, totalWeeks);
    const p1End = Math.max(1, Math.round(w * 0.3));
    const p2End = Math.max(p1End + 1, Math.round(w * 0.65));
    const p3End = Math.max(p2End + 1, Math.max(p2End + 1, w - 2));

    // Démarrage calme et progressif basé sur son socle actuel (ex: 80% du volume récent)
    const startKm = Math.max(18, Math.round(baseWeeklyKm * 0.82));
    const peakKm = Math.max(44, Math.round(baseWeeklyKm * 1.55));
    const km1 = Math.round(startKm * 1.08); // Phase 1 : Socle aérobie progressif
    const km2 = Math.round(startKm * 1.32); // Phase 2 : Seuil et montée de charge
    const km3 = Math.round(peakKm * 0.96);  // Phase 3 : Pic spécifique
    const km4 = Math.round(startKm * 0.72); // Phase 4 : Affûtage & fraîcheur

    return [
      {
        name: "Phase 1 : Socle & Volume Aérobie",
        weeksRangeLabel: `Semaines 1 à ${p1End}`,
        focus:
          "Démarrage tranquille et progressif en Zone 2, renforcement et habitude d'entraînement sans surcharge.",
        weekType: "Endurance & Socle",
        avgKm: km1,
        sessionsPerWeek: 3,
      },
      {
        name: "Phase 2 : Développement Seuil & Allure Cible",
        weeksRangeLabel: `Semaines ${p1End + 1} à ${p2End}`,
        focus:
          "Progression continue (+10 %/semaine), fractions au seuil anaérobie (Z4) et cycles d'assimilation.",
        weekType: "Seuil & Tempo",
        avgKm: km2,
        sessionsPerWeek: 4,
      },
      {
        name: "Phase 3 : Pic Spécifique & Sorties Clés",
        weeksRangeLabel: `Semaines ${p2End + 1} à ${p3End}`,
        focus:
          "Volume maximal, sorties longues clés et maintien de l'allure cible marathon.",
        weekType: "Pic Spécifique",
        avgKm: km3,
        sessionsPerWeek: 4,
      },
      {
        name: "Phase 4 : Affûtage & Fraîcheur",
        weeksRangeLabel:
          p3End < w ? `Semaines ${p3End + 1} à ${w}` : `Semaine ${w}`,
        focus:
          "Baisse progressive du volume (-40 %), conservation de l'intensité et fraîcheur maximale le jour J.",
        weekType: "Affûtage",
        avgKm: km4,
        sessionsPerWeek: 3,
      },
    ];
  }

  async resetOnboarding(userId: string): Promise<OnboardingStateDto> {
    await this.prisma.$transaction(async (tx) => {
      await tx.rpeCheckIn.deleteMany({ where: { userId } });
      await tx.workout.deleteMany({ where: { userId } });
      await tx.chatMessage.deleteMany({ where: { userId } });
      await tx.lifeRule.deleteMany({ where: { userId } });
      await tx.syncToken.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          isOnboardingCompleted: false,
          mainGoal: null,
          selectedSports: ["running"],
          activeGoalTitle: "",
          activeGoalTarget: "",
          activeGoalRaceDate: "",
          activeGoalWeeksRemaining: 0,
          activeGoalProgressPercentage: 0,
          totalKm: 0,
          activeWeeks: 0,
          completedRaces: 0,
        },
      });
    });

    return this.getOnboardingState(userId);
  }
}

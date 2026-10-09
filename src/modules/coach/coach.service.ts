import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DataLakeService } from "../datalake/datalake.service";
import { LlmService } from "../llm/llm.service";
import {
  SendChatMessageDto,
  ChatResponseDto,
  ChatMessageDto,
  QuickPromptDto,
  SuggestedActionDto,
} from "./dto/coach.dto";
import { WorkoutStatus } from "@prisma/client";

@Injectable()
export class CoachService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataLakeService: DataLakeService,
    private readonly llmService: LlmService,
  ) {}

  async getHistory(userId: string): Promise<ChatMessageDto[]> {
    const messages = await this.prisma.chatMessage.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });

    return messages.map((m) => ({
      id: m.id,
      sender: m.sender as "user" | "coach" | "system",
      text: m.text,
      timestamp: m.timestamp,
      suggestedAction: (m.suggestedAction as any) || undefined,
    }));
  }

  async getQuickPrompts(): Promise<QuickPromptDto[]> {
    const prompts = await this.prisma.quickPrompt.findMany({
      orderBy: { order: "asc" },
    });

    return prompts.map((p) => ({
      id: p.id,
      label: p.label,
      message: p.message,
    }));
  }

  async processMessage(
    userId: string,
    dto: SendChatMessageDto,
  ): Promise<ChatResponseDto> {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;

    // 1. Sauvegarde du message utilisateur
    const userMsgRecord = await this.prisma.chatMessage.create({
      data: {
        userId,
        sender: "user",
        text: dto.text,
        timestamp: timeStr,
      },
    });

    const today = new Date();
    const todayDateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoDateKey = `${sevenDaysAgo.getFullYear()}-${String(sevenDaysAgo.getMonth() + 1).padStart(2, "0")}-${String(sevenDaysAgo.getDate()).padStart(2, "0")}`;

    const sevenDaysAhead = new Date(today);
    sevenDaysAhead.setDate(sevenDaysAhead.getDate() + 7);
    const sevenDaysAheadDateKey = `${sevenDaysAhead.getFullYear()}-${String(sevenDaysAhead.getMonth() + 1).padStart(2, "0")}-${String(sevenDaysAhead.getDate()).padStart(2, "0")}`;

    // 2. Context Builder (RAG ciblé) : profil anonyme, règles de vie, fenêtre glissante -7j/+7j
    const [user, activeWorkout, recentWorkoutsRaw, upcomingWorkouts, lastRpe] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          include: {
            rules: { orderBy: { createdAt: "asc" } },
            syncTokens: { where: { isConnected: true } },
          },
        }),
        this.prisma.workout.findFirst({
          where: {
            userId,
            OR: [
              { dateKey: todayDateKey },
              { status: WorkoutStatus.SELECTED },
            ],
          },
        }),
        this.prisma.workout.findMany({
          where: {
            userId,
            isRestDay: false,
            dateKey: { gte: sevenDaysAgoDateKey, lte: todayDateKey },
            status: WorkoutStatus.DONE,
          },
          orderBy: { dateKey: "desc" },
          take: 7,
        }),
        this.prisma.workout.findMany({
          where: {
            userId,
            dateKey: { gt: todayDateKey, lte: sevenDaysAheadDateKey },
          },
          orderBy: { dateKey: "asc" },
          take: 7,
        }),
        this.prisma.rpeCheckIn.findFirst({
          where: { userId },
          orderBy: { submittedAt: "desc" },
        }),
      ]);

    // Fallback : si aucune séance faite dans les 7 derniers jours (ex: coupure ou reprise),
    // on récupère les 2 dernières séances terminées pour que l'IA connaisse le passé récent
    let recentWorkouts = recentWorkoutsRaw;
    if (recentWorkouts.length === 0) {
      recentWorkouts = await this.prisma.workout.findMany({
        where: {
          userId,
          isRestDay: false,
          status: WorkoutStatus.DONE,
        },
        orderBy: { dateKey: "desc" },
        take: 3,
      });
    }

    const stravaToken = user?.syncTokens?.find((t) => t.provider === "strava");
    const sixMonthsSummary = (stravaToken?.metadata as any)?.sixMonthsSummary;

    const recentSessions =
      this.llmService.extractSessionMetricsFromWorkouts(recentWorkouts);
    const longestRecentRunKm =
      sixMonthsSummary?.longestRunKm ??
      (recentSessions && recentSessions.length > 0
        ? Math.max(...recentSessions.map((s) => s.distanceKm || 0))
        : undefined);
    const recentWeeklyKm =
      sixMonthsSummary?.recent4WeeksAvgKm ??
      (user?.totalKm && user?.activeWeeks
        ? user.totalKm / Math.max(1, user.activeWeeks)
        : undefined);
    const hasSyncedHistory =
      Boolean(user?.syncTokens && user.syncTokens.length > 0) ||
      recentWorkouts.some((w) => w.status === WorkoutStatus.DONE);

    const athleteContext = {
      userName: "l'athlète", // 100% anonymisé (pas de prénom personnel envoyé au LLM)
      readinessScore: dto.context?.readinessScore ?? user?.readinessScore ?? 88,
      activeGoalTitle: user?.activeGoalTitle || "Semi-marathon de Paris",
      activeGoalTarget: user?.activeGoalTarget || "Passer sous les 2h",
      activeGoalRaceDate: user?.activeGoalRaceDate || "17 mars 2025",
      activeGoalWeeksRemaining: user?.activeGoalWeeksRemaining ?? 6,
      totalKm: sixMonthsSummary?.totalDistanceKm ?? user?.totalKm ?? 684,
      activeWeeks: sixMonthsSummary?.activeWeeks ?? user?.activeWeeks ?? 25,
      atlFatigue: user?.atlFatigue ?? 42,
      ctlFitness: user?.ctlFitness ?? 48,
      tsbForm: user?.tsbForm ?? 6,
      selectedSports: user?.selectedSports || ["running"],
      rules:
        user?.rules.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          icon: r.icon,
        })) || [],
      trainingContext: {
        hasSyncedHistory,
        recentWeeklyKm,
        recent4WeeksAvgKm: sixMonthsSummary?.recent4WeeksAvgKm,
        totalKm6Months: sixMonthsSummary?.totalDistanceKm ?? user?.totalKm,
        longestRecentRunKm,
        activeWeeks: sixMonthsSummary?.activeWeeks ?? user?.activeWeeks ?? 25,
        hrMax: sixMonthsSummary?.maxHeartRateObserved,
        recentSessions,
      },
      activeWorkout: activeWorkout
        ? {
            id: activeWorkout.id,
            dateKey: activeWorkout.dateKey,
            title: activeWorkout.title,
            category: activeWorkout.category,
            duration: activeWorkout.duration,
            distance: activeWorkout.distance,
            targetPace: activeWorkout.targetPace,
            targetZoneLabel: activeWorkout.targetZoneLabel,
          }
        : dto.context?.activeSessionTitle
          ? { title: dto.context.activeSessionTitle }
          : undefined,
      todayDate: todayDateKey,
      pastCompletedWorkouts: recentWorkouts.map((w) => ({
        id: w.id,
        dateKey: w.dateKey,
        title: w.title,
        duration: w.duration,
        distance: w.distance,
        actualDistanceKm: w.actualDistanceKm,
        actualPace: w.actualPace,
        actualAvgHeartRate: w.actualAvgHeartRate,
        sourceProvider: w.sourceProvider,
        completedAt: w.completedAt,
      })),
      upcomingPlannedWorkouts: upcomingWorkouts.map((w) => ({
        id: w.id,
        dateKey: w.dateKey,
        dayName: w.dayName,
        title: w.title,
        duration: w.duration,
        distance: w.distance,
        targetPace: w.targetPace,
        category: w.category,
        isRestDay: w.isRestDay,
      })),
      currentWeekWorkouts: upcomingWorkouts.map((w) => ({
        id: w.id,
        dateKey: w.dateKey,
        dayName: w.dayName,
        status: w.status,
        isRestDay: w.isRestDay,
        title: w.title,
        duration: w.duration,
        distance: w.distance,
        targetPace: w.targetPace,
        actualDistanceKm: w.actualDistanceKm,
        actualPace: w.actualPace,
        actualAvgHeartRate: w.actualAvgHeartRate,
      })),
      lastRpe: lastRpe
        ? {
            rating: lastRpe.rating,
            feedbackLabel: lastRpe.feedbackLabel,
          }
        : dto.context?.lastRpe
          ? { rating: dto.context.lastRpe }
          : undefined,
    };

    // 3. Génération de la réponse via LlmService (Garde-fous + LLM Multi-Provider / Fallback Hybride)
    const llmReply = await this.llmService.generateCoachReply({
      userPrompt: dto.text,
      athleteContext,
    });

    // Si l'utilisateur a exprimé une nouvelle règle de vie dans son message, l'IA la reformule et l'enregistre automatiquement avec vérification anti-doublon stricte
    let autoAppliedRule = false;
    if (
      llmReply.suggestedAction?.type === "add_life_rule" &&
      llmReply.suggestedAction.ruleData
    ) {
      const ruleData = llmReply.suggestedAction.ruleData;
      const cleanTitle = (ruleData.title || "").trim().toLowerCase();
      const cleanDesc = (ruleData.description || "").trim().toLowerCase();
      const alreadyExists = (user?.rules || []).some((r) => {
        const rTitle = (r.title || "").trim().toLowerCase();
        const rDesc = (r.description || "").trim().toLowerCase();
        return (
          rTitle === cleanTitle ||
          rDesc === cleanDesc ||
          (cleanTitle.length > 3 && rTitle.includes(cleanTitle)) ||
          (cleanDesc.length > 5 && rDesc.includes(cleanDesc))
        );
      });
      if (!alreadyExists && user && cleanTitle.length > 0) {
        await this.prisma.lifeRule.create({
          data: {
            userId,
            title: ruleData.title.trim(),
            description: ruleData.description.trim(),
            icon: ruleData.icon || "calendar-lock",
          },
        });
      }
      autoAppliedRule = true;
    }

    // Si le Coach IA a recalculé la semaine complète suite au message de l'utilisateur, on applique automatiquement les changements en BDD
    let autoRecalculatedWeek = false;
    if (
      llmReply.recalculatedWeekWorkouts &&
      llmReply.recalculatedWeekWorkouts.length > 0
    ) {
      for (const item of llmReply.recalculatedWeekWorkouts) {
        if (!item.dateKey) continue;
        await this.prisma.workout.updateMany({
          where: { userId, dateKey: item.dateKey },
          data: {
            isRestDay: item.isRestDay ?? false,
            status: item.isRestDay ? WorkoutStatus.REST : undefined,
            category: item.category || undefined,
            title: item.title,
            duration: item.duration,
            distance: item.distance,
            targetPace: item.targetPace || undefined,
            targetZoneLabel: item.targetZoneLabel || undefined,
            targetZoneBpm: item.targetZoneBpm || undefined,
            aiAdjustmentNote: item.aiAdjustmentNote || undefined,
            tags: item.tags || undefined,
          },
        });
      }
      autoRecalculatedWeek = true;
    }

    const suggestedAction: SuggestedActionDto | undefined =
      llmReply.suggestedAction
        ? {
            type: llmReply.suggestedAction.type as any,
            label: autoAppliedRule
              ? `Règle reformulée & enregistrée : « ${llmReply.suggestedAction.ruleData?.title} »`
              : llmReply.suggestedAction.label,
            applied:
              autoAppliedRule ||
              autoRecalculatedWeek ||
              Boolean(llmReply.suggestedAction.applied),
            workoutId:
              llmReply.suggestedAction.workoutId || activeWorkout?.id,
            details: llmReply.suggestedAction.details,
            ruleData: llmReply.suggestedAction.ruleData,
          }
        : undefined;

    // 4. Sauvegarde de la réponse du Coach
    const coachMsgRecord = await this.prisma.chatMessage.create({
      data: {
        userId,
        sender: "coach",
        text: llmReply.replyText,
        timestamp: timeStr,
        suggestedAction: suggestedAction ? (suggestedAction as any) : undefined,
      },
    });

    // 5. Enregistrement asynchrone non-bloquant dans le Data Lake (avec athleteContext complet)
    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "coach_chat",
      interaction: {
        type: "chat",
        userPrompt: dto.text,
        reformulatedIntent: llmReply.reformulatedIntent,
        aiResponse: llmReply.replyText,
        safetyStatus: llmReply.safetyStatus,
        suggestedAction,
        modelUsed: llmReply.modelUsed,
      },
      athleteContext,
      feedback: lastRpe
        ? {
            rating: lastRpe.rating,
            feedbackLabel: lastRpe.feedbackLabel,
          }
        : undefined,
    });

    return {
      userMsg: {
        id: userMsgRecord.id,
        sender: "user",
        text: userMsgRecord.text,
        timestamp: userMsgRecord.timestamp,
      },
      coachReply: {
        id: coachMsgRecord.id,
        sender: "coach",
        text: coachMsgRecord.text,
        timestamp: coachMsgRecord.timestamp,
        suggestedAction,
      },
    };
  }

  async resetChat(userId: string): Promise<void> {
    await this.prisma.chatMessage.deleteMany({
      where: { userId },
    });
  }
}

import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DataLakeService } from "../datalake/datalake.service";
import { LlmService } from "../llm/llm.service";
import {
  WorkoutSessionDto,
  UpdateWorkoutDto,
  RpeCheckInRequestDto,
  RpeCheckInResponseDto,
  AdaptWorkoutDto,
  GenerateMultiWeekPlanRequestDto,
  GenerateMultiWeekPlanResponseDto,
} from "./dto/workout.dto";
import { WorkoutStatus } from "@prisma/client";

@Injectable()
export class WorkoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataLakeService: DataLakeService,
    private readonly llmService: LlmService,
  ) {}

  async getWeekWorkouts(
    userId: string,
    weekNumber = 42,
    year = 2026,
  ): Promise<WorkoutSessionDto[]> {
    let workouts = await this.prisma.workout.findMany({
      where: {
        userId,
        weekNumber: Number(weekNumber),
        year: Number(year),
      },
      orderBy: { dateKey: "asc" },
    });

    // Uniquement pour l'initialisation du compte de démo sur la semaine courante (42) si la base est totalement vide.
    // Aucune séance n'est générée à la volée lorsqu'on navigue sur d'autres semaines dans le calendrier.
    if (workouts.length === 0 && Number(weekNumber) === 42 && Number(year) === 2026) {
      const totalUserWorkouts = await this.prisma.workout.count({
        where: { userId },
      });
      if (totalUserWorkouts === 0) {
        await this.provisionDefaultWeekWorkouts(userId, 42, 2026);
        workouts = await this.prisma.workout.findMany({
          where: {
            userId,
            weekNumber: 42,
            year: 2026,
          },
          orderBy: { dateKey: "asc" },
        });
      }
    }

    return workouts.map((w) => this.mapToDto(w));
  }

  async getMonthWorkouts(
    userId: string,
    month = 9,
    year = 2026,
  ): Promise<Record<string, WorkoutSessionDto>> {
    let workouts = await this.prisma.workout.findMany({
      where: {
        userId,
        month: Number(month),
        year: Number(year),
      },
      orderBy: { dateKey: "asc" },
    });

    if (workouts.length === 0 && Number(month) === 9 && Number(year) === 2026) {
      const totalUserWorkouts = await this.prisma.workout.count({
        where: { userId },
      });
      if (totalUserWorkouts === 0) {
        await this.provisionDefaultWeekWorkouts(userId, 42, 2026);
        workouts = await this.prisma.workout.findMany({
          where: {
            userId,
            month: 9,
            year: 2026,
          },
          orderBy: { dateKey: "asc" },
        });
      }
    }

    const result: Record<string, WorkoutSessionDto> = {};
    for (const w of workouts) {
      result[w.dateKey] = this.mapToDto(w);
    }
    return result;
  }

  async getWorkoutByIdOrDateKey(
    userId: string,
    identifier: string,
  ): Promise<WorkoutSessionDto> {
    const workout = await this.prisma.workout.findFirst({
      where: {
        userId,
        OR: [{ id: identifier }, { dateKey: identifier }],
      },
    });

    if (!workout) {
      throw new NotFoundException(`Workout ${identifier} not found`);
    }

    return this.mapToDto(workout);
  }

  async updateWorkout(
    userId: string,
    identifier: string,
    dto: UpdateWorkoutDto,
  ): Promise<WorkoutSessionDto> {
    const existing = await this.prisma.workout.findFirst({
      where: {
        userId,
        OR: [{ id: identifier }, { dateKey: identifier }],
      },
    });

    if (!existing) {
      throw new NotFoundException(`Workout ${identifier} not found`);
    }

    const dataToUpdate: any = {};
    if (dto.status) {
      dataToUpdate.status =
        dto.status === "done"
          ? WorkoutStatus.DONE
          : dto.status === "selected"
            ? WorkoutStatus.SELECTED
            : dto.status === "rest"
              ? WorkoutStatus.REST
              : WorkoutStatus.UPCOMING;
    }
    if (dto.title) dataToUpdate.title = dto.title;
    if (dto.duration) dataToUpdate.duration = dto.duration;
    if (dto.distance) dataToUpdate.distance = dto.distance;
    if (dto.targetPace) dataToUpdate.targetPace = dto.targetPace;
    if (dto.targetZoneLabel) dataToUpdate.targetZoneLabel = dto.targetZoneLabel;
    if (dto.targetZoneBpm) dataToUpdate.targetZoneBpm = dto.targetZoneBpm;
    if (dto.aiAdjustmentNote !== undefined)
      dataToUpdate.aiAdjustmentNote = dto.aiAdjustmentNote;
    if (dto.tags) dataToUpdate.tags = dto.tags;

    const updated = await this.prisma.workout.update({
      where: { id: existing.id },
      data: dataToUpdate,
    });

    return this.mapToDto(updated);
  }

  async submitRpeCheckIn(
    userId: string,
    dto: RpeCheckInRequestDto,
  ): Promise<RpeCheckInResponseDto> {
    let feedbackLabel = "Modéré";
    let aiPreservationMessage =
      "L'IA a calibré ta charge pour préserver tes mollets aujourd'hui.";

    if (dto.rating <= 3) {
      feedbackLabel = "Très facile";
      aiPreservationMessage =
        "Parfait ! Ton niveau de forme est excellent, nous maintenons les allures cibles.";
    } else if (dto.rating <= 6) {
      feedbackLabel = "Modéré";
      aiPreservationMessage =
        "L'IA a ajusté le seuil pour préserver tes mollets aujourd'hui.";
    } else if (dto.rating <= 8) {
      feedbackLabel = "Difficile";
      aiPreservationMessage =
        "Séance intense détectée. L'IA a allégé le volume de demain pour optimiser ta récupération.";
    } else {
      feedbackLabel = "À fond";
      aiPreservationMessage =
        "Charge maximale atteinte. Un jour de repos actif a été automatiquement inséré.";
    }

    const checkIn = await this.prisma.rpeCheckIn.create({
      data: {
        userId,
        workoutId: dto.workoutId,
        rating: dto.rating,
        feedbackLabel,
        textComment: dto.textComment,
        perceivedLegs: dto.perceivedLegs,
        aiPreservationMessage,
      },
    });

    // Enregistrement asynchrone non-bloquant dans le Data Lake
    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "rpe_check_in",
      interaction: {
        type: "rpe_check_in",
        workoutId: dto.workoutId,
      },
      feedback: {
        rating: dto.rating,
        feedbackLabel,
        textComment: dto.textComment,
        perceivedLegs: dto.perceivedLegs,
        aiPreservationMessage,
      },
    });

    return {
      rating: checkIn.rating,
      feedbackLabel: checkIn.feedbackLabel,
      textComment: checkIn.textComment || undefined,
      perceivedLegs: checkIn.perceivedLegs || undefined,
      submittedAt: checkIn.submittedAt.toISOString(),
      aiPreservationMessage: checkIn.aiPreservationMessage,
    };
  }

  async adaptSessionWithAI(
    userId: string,
    identifier: string,
    dto: AdaptWorkoutDto,
  ): Promise<WorkoutSessionDto> {
    const existing = await this.prisma.workout.findFirst({
      where: {
        userId,
        OR: [{ id: identifier }, { dateKey: identifier }],
      },
    });

    if (!existing) {
      throw new NotFoundException(`Workout ${identifier} not found`);
    }

    let updates: any = {};

    switch (dto.adaptationType) {
      case "lighten":
        updates = {
          title: "Footing Léger & Lignes Droites (Adapté IA)",
          duration: "35 min",
          distance: "6,0 km",
          targetPace: "5:30/km",
          targetZoneLabel: "Zone 2",
          targetZoneBpm: "135–148 bpm",
          aiAdjustmentNote:
            "Séance allégée : volume réduit de 40% pour compenser la fatigue.",
          tags: ["6,0 km", "Allure : 5:30/km", "Zone 2"],
        };
        break;

      case "easy_run":
        updates = {
          title: "30 min Footing Souple Régénérant (Adapté IA)",
          duration: "30 min",
          distance: "5,0 km",
          targetPace: "6:00/km",
          targetZoneLabel: "Zone 1–2",
          targetZoneBpm: "125–138 bpm",
          aiAdjustmentNote:
            "Remplacement validé : footing souple pour favoriser l’oxygénation.",
          tags: ["5,0 km", "Endurance fondamentale", "Zone 1/2"],
        };
        break;

      case "postpone":
        updates = {
          title: "Repos / Récupération (Décalé à demain)",
          isRestDay: true,
          status: WorkoutStatus.REST,
          duration: "—",
          distance: "0 km",
          targetZoneLabel: "Zone 1",
          targetZoneBpm: "< 110 bpm",
          aiAdjustmentNote:
            "Séance clé décalée au lendemain pour respecter tes disponibilités.",
          tags: ["Repos actif", "Hydratation"],
        };
        break;

      case "injury_care":
        updates = {
          title: "Mobilité douce & Glaçage Mollet (Adapté IA)",
          duration: "20 min",
          distance: "0 km",
          targetZoneLabel: "Zone 1",
          targetZoneBpm: "< 115 bpm",
          aiAdjustmentNote:
            "Course suspendue 24h pour prévenir toute contracture du mollet.",
          tags: ["Mobilité", "Prévention blessure"],
        };
        break;
    }

    const updated = await this.prisma.workout.update({
      where: { id: existing.id },
      data: updates,
    });

    // Enregistrement asynchrone non-bloquant dans le Data Lake
    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "workout_adaptation",
      interaction: {
        type: "adaptation",
        workoutId: existing.id,
        adaptationType: dto.adaptationType,
        appliedUpdates: updates,
        previousTitle: existing.title,
      },
    });

    return this.mapToDto(updated);
  }

  /**
   * Génère un plan d'entraînement multi-semaines complet via le modèle Pro (LLM_PRO_MODEL)
   * en prenant tout le contexte athlète (profil, allures réelles, charge Banister, séances passées, LifeRules)
   * et l'enregistre automatiquement en base PostgreSQL.
   */
  async generateAndSaveMultiWeekPlan(
    userId: string,
    dto: GenerateMultiWeekPlanRequestDto,
  ): Promise<GenerateMultiWeekPlanResponseDto> {
    const startWeek = dto.startWeekNumber ?? 42;
    const year = dto.year ?? 2026;
    const weeksToGenerate = Math.min(Math.max(dto.weeksToGenerate ?? 4, 1), 12);

    // S'assurer que l'utilisateur existe et récupérer son contexte complet
    let user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { rules: true, syncTokens: true },
    });

    if (!user) {
      await this.provisionDefaultWeekWorkouts(userId, 42, year);
      user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: { rules: true, syncTokens: true },
      });
    }

    // Récupération des séances réalisées sur les 6 derniers mois (jusqu'à 80 séances Strava/Garmin)
    const recentDoneWorkouts = await this.prisma.workout.findMany({
      where: {
        userId,
        status: WorkoutStatus.DONE,
        isRestDay: false,
      },
      orderBy: { dateKey: "desc" },
      take: 80,
    });

    // Récupération du bilan 6 mois Strava et des métadonnées capteurs
    const stravaToken = user?.syncTokens?.find((t) => t.provider === "strava");
    const garminToken = user?.syncTokens?.find((t) => t.provider === "garmin");
    const garminMeta = (garminToken?.metadata as any) || {};
    const stravaMeta = (stravaToken?.metadata as any) || {};
    const sixMonthsSummary = stravaMeta.sixMonthsSummary || undefined;

    const sessionMetrics = this.llmService.extractSessionMetricsFromWorkouts(
      recentDoneWorkouts.slice(0, 20),
    );
    const recentWeeklyKm =
      sixMonthsSummary?.recent4WeeksAvgKm ??
      (user?.totalKm && user?.activeWeeks
        ? Number((user.totalKm / Math.max(1, user.activeWeeks)).toFixed(1))
        : 36);
    const longestRecentRunKm =
      sixMonthsSummary?.longestRunKm ??
      (sessionMetrics && sessionMetrics.length > 0
        ? Math.max(...sessionMetrics.map((s) => s.distanceKm || 0))
        : 15);

    const calculatedPaces = this.llmService.computePacesFromRecentPerformance({
      hasSyncedHistory: true,
      recentWeeklyKm,
      recent4WeeksAvgKm: sixMonthsSummary?.recent4WeeksAvgKm,
      totalKm6Months: sixMonthsSummary?.totalDistanceKm ?? user?.totalKm,
      longestRecentRunKm,
      activeWeeks: sixMonthsSummary?.activeWeeks ?? user?.activeWeeks ?? 24,
      hrMax: sixMonthsSummary?.maxHeartRateObserved ?? 188,
      importedThresholdPaceSecPerKm: garminMeta.lactateThresholdPace,
      recentSessions: sessionMetrics,
      sixMonthsSummary,
    });

    // Construction des créneaux calendaires pour les N semaines demandées
    // La semaine 42 commence le Lundi 12 Octobre 2026
    const baseMonday = new Date(Date.UTC(year, 9, 12 + (startWeek - 42) * 7));
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

    const calendarDays: Array<{
      dateKey: string;
      dayName: string;
      dayNumber: number;
      month: number;
      year: number;
      weekNumber: number;
      fullDateLabel: string;
    }> = [];

    for (let w = 0; w < weeksToGenerate; w++) {
      const currentWeekNum = startWeek + w;
      for (let d = 0; d < 7; d++) {
        const dateObj = new Date(
          baseMonday.getTime() + (w * 7 + d) * 24 * 3600 * 1000,
        );
        const yyyy = dateObj.getUTCFullYear();
        const mm = dateObj.getUTCMonth(); // 0-indexed (9 = Octobre)
        const dd = dateObj.getUTCDate();
        const dow = dateObj.getUTCDay();
        const dateKey = `${yyyy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;

        calendarDays.push({
          dateKey,
          dayName: dayNamesShort[dow],
          dayNumber: dd,
          month: mm,
          year: yyyy,
          weekNumber: currentWeekNum,
          fullDateLabel: `${dayNamesFull[dow]} ${dd} ${monthNamesFull[mm]}`,
        });
      }
    }

    const llmPlan = await this.llmService.generateMultiWeekPlan({
      userProfile: {
        name: user?.name || "Marius",
        mainGoal: user?.mainGoal || undefined,
        activeGoalTitle: user?.activeGoalTitle || "Semi-marathon de Paris",
        activeGoalTarget: user?.activeGoalTarget || "Passer sous les 2h",
        activeGoalRaceDate: user?.activeGoalRaceDate || "Dans 12 semaines",
        activeGoalWeeksRemaining: user?.activeGoalWeeksRemaining ?? 12,
        selectedSports: user?.selectedSports || ["running"],
      },
      physiologicalState: {
        readinessScore: user?.readinessScore ?? 88,
        totalKm: sixMonthsSummary?.totalDistanceKm ?? user?.totalKm ?? 684,
        activeWeeks: sixMonthsSummary?.activeWeeks ?? user?.activeWeeks ?? 25,
        recentWeeklyKm,
        atlFatigue: user?.atlFatigue ?? 42,
        ctlFitness: user?.ctlFitness ?? 48,
        tsbForm: user?.tsbForm ?? 6,
        sleepScore: user?.sleepScore ?? 82,
        hrvStatus: user?.hrvStatus || "balanced",
      },
      sixMonthsStravaSummary: sixMonthsSummary,
      calculatedPaces,
      lifeRules: (user?.rules || []).map((r) => ({
        title: r.title,
        description: r.description,
        icon: r.icon,
      })),
      recentCompletedSessions: recentDoneWorkouts.slice(0, 15).map((w) => ({
        dateKey: w.dateKey,
        title: w.title,
        actualDistanceKm: w.actualDistanceKm ?? undefined,
        actualPace: w.actualPace ?? undefined,
        actualAvgHeartRate: w.actualAvgHeartRate ?? undefined,
        actualMaxHeartRate: w.actualMaxHeartRate ?? undefined,
      })),
      calendarSlots: calendarDays,
    });

    // Sauvegarde automatique en base PostgreSQL sans écraser les séances déjà réalisées (DONE)
    const existingDoneWorkouts = await this.prisma.workout.findMany({
      where: {
        userId,
        dateKey: { in: calendarDays.map((c) => c.dateKey) },
        status: WorkoutStatus.DONE,
      },
      select: { dateKey: true },
    });
    const doneDateKeys = new Set(existingDoneWorkouts.map((w) => w.dateKey));

    for (const item of llmPlan.workouts) {
      if (doneDateKeys.has(item.dateKey)) {
        continue; // On conserve précieusement les vraies séances passées (Strava 6 mois)
      }

      const isTodayDefault = item.dateKey === "2026-10-14";
      const status = item.isRestDay
        ? WorkoutStatus.REST
        : isTodayDefault
          ? WorkoutStatus.SELECTED
          : WorkoutStatus.UPCOMING;

      await this.prisma.workout.upsert({
        where: {
          userId_dateKey: {
            userId,
            dateKey: item.dateKey,
          },
        },
        update: {
          dayName: item.dayName,
          dayNumber: item.dayNumber,
          month: item.month,
          year: item.year,
          weekNumber: item.weekNumber,
          fullDateLabel: item.fullDateLabel,
          timeLabel: item.timeLabel,
          status,
          isRestDay: item.isRestDay,
          category: item.category,
          title: item.title,
          duration: item.duration,
          distance: item.distance,
          targetPace: item.targetPace,
          targetZoneLabel: item.targetZoneLabel,
          targetZoneBpm: item.targetZoneBpm,
          targetZoneSegments: item.targetZoneSegments as any,
          pinPositionPercent: item.pinPositionPercent,
          effortBlocks: item.effortBlocks as any,
          tags: item.tags,
          aiAdjustmentNote: item.aiAdjustmentNote,
          tss: item.tss,
        },
        create: {
          userId,
          dateKey: item.dateKey,
          dayName: item.dayName,
          dayNumber: item.dayNumber,
          month: item.month,
          year: item.year,
          weekNumber: item.weekNumber,
          fullDateLabel: item.fullDateLabel,
          timeLabel: item.timeLabel,
          status,
          isRestDay: item.isRestDay,
          category: item.category,
          title: item.title,
          duration: item.duration,
          distance: item.distance,
          targetPace: item.targetPace,
          targetZoneLabel: item.targetZoneLabel,
          targetZoneBpm: item.targetZoneBpm,
          targetZoneSegments: item.targetZoneSegments as any,
          pinPositionPercent: item.pinPositionPercent,
          effortBlocks: item.effortBlocks as any,
          tags: item.tags,
          aiAdjustmentNote: item.aiAdjustmentNote,
          tss: item.tss,
        },
      });
    }

    // Si on génère un plan complet (>= 2 semaines), on ajoute un message de présentation dans le Chat Coach
    if (weeksToGenerate >= 2 && user) {
      await this.prisma.chatMessage.create({
        data: {
          userId,
          sender: "coach",
          text: `📋 Plan multi-semaines généré (Semaines ${startWeek} à ${startWeek + weeksToGenerate - 1}) :\n\n${llmPlan.planSummary}`,
          timestamp: new Date().toLocaleTimeString("fr-FR", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      });
    }

    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "workout_adaptation",
      interaction: {
        type: "multi_week_plan_generated",
        startWeekNumber: startWeek,
        weeksToGenerate,
        modelUsed: llmPlan.modelUsed,
        planSummary: llmPlan.planSummary,
        workoutsCount: llmPlan.workouts.length,
      },
      athleteContext: {
        calculatedPaces,
        sixMonthsSummary,
        lifeRulesCount: user?.rules?.length ?? 0,
        readinessScore: user?.readinessScore,
        ctlFitness: user?.ctlFitness,
        atlFatigue: user?.atlFatigue,
        tsbForm: user?.tsbForm,
      },
    });

    const savedWorkouts = await this.prisma.workout.findMany({
      where: {
        userId,
        dateKey: { in: calendarDays.map((c) => c.dateKey) },
      },
      orderBy: { dateKey: "asc" },
    });

    return {
      success: true,
      planSummary: llmPlan.planSummary,
      weeksGenerated: weeksToGenerate,
      modelUsed: llmPlan.modelUsed,
      workouts: savedWorkouts.map((w) => this.mapToDto(w)),
    };
  }

  /**
   * Provisionne les séances modèles de la semaine 42 si l'utilisateur est nouveau
   * (avec les vraies données exécutées pour les séances passées de Lundi et Mardi)
   */
  private async provisionDefaultWeekWorkouts(
    userId: string,
    weekNumber = 42,
    year = 2026,
  ): Promise<void> {
    const defaultWeekWorkouts = [
      {
        userId,
        dateKey: "2026-10-12",
        dayName: "Lun",
        dayNumber: 12,
        month: 9,
        year,
        weekNumber,
        fullDateLabel: "LUNDI 12 OCTOBRE",
        timeLabel: "18:00",
        status: WorkoutStatus.DONE,
        isRestDay: false,
        category: "RÉCUPÉRATION ACTIVE",
        title: "Footing Fondamental Léger",
        duration: "40 min",
        distance: "7,0 km",
        targetPace: "5:45/km",
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
        year,
        weekNumber,
        fullDateLabel: "MARDI 13 OCTOBRE",
        timeLabel: "18:30",
        status: WorkoutStatus.DONE,
        isRestDay: false,
        category: "RENFORCEMENT & MOBILITÉ",
        title: "Footing Assimilation & Lignes Droites",
        duration: "35 min",
        distance: "6,0 km",
        targetPace: "5:35/km",
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
            durationLabel: "25 min",
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
          "Séance réelle synchronisée via Garmin : 6,1 km en 33m45s (5:32/km • 141 bpm moy • 178 spm).",
        externalActivityId: "garmin-10132026",
        sourceProvider: "garmin",
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
      {
        userId,
        dateKey: "2026-10-14",
        dayName: "Mer",
        dayNumber: 14,
        month: 9,
        year,
        weekNumber,
        fullDateLabel: "MERCREDI 14 OCTOBRE",
        timeLabel: "AUJOURD'HUI • 18:30",
        status: WorkoutStatus.SELECTED,
        isRestDay: false,
        category: "SÉANCE QUALITATIVE",
        title: "Sortie Seuil & Allure Cible",
        duration: "1h15",
        distance: "14 km",
        targetPace: "4:50/km",
        targetZoneLabel: "Zone 3–4",
        targetZoneBpm: "158–172 bpm",
        targetZoneSegments: [
          { color: "#93C5FD", flex: 1.2 },
          { color: "#FBBF24", flex: 2 },
          { color: "#FC4C02", flex: 2 },
        ],
        pinPositionPercent: 68,
        effortBlocks: [
          {
            title: "Échauffement",
            durationLabel: "15 min",
            type: "warmup",
            flexRatio: 1,
          },
          {
            title: "Seuil",
            durationLabel: "3 × 8 min",
            type: "threshold",
            flexRatio: 2,
          },
          {
            title: "Retour au calme",
            durationLabel: "10 min",
            type: "cooldown",
            flexRatio: 1,
          },
        ],
        tags: ["8,5 km", "Allure cible : 4:45/km", "Zone 3/4"],
        aiAdjustmentNote:
          "L'IA a ajusté le seuil pour préserver tes mollets aujourd'hui.",
      },
      {
        userId,
        dateKey: "2026-10-15",
        dayName: "Jeu",
        dayNumber: 15,
        month: 9,
        year,
        weekNumber,
        fullDateLabel: "JEUDI 15 OCTOBRE",
        timeLabel: "Jour de repos",
        status: WorkoutStatus.REST,
        isRestDay: true,
        category: "RÉCUPÉRATION PASSIVE",
        title: "Repos complet & Hydratation",
        duration: "—",
        distance: "0 km",
        targetPace: "—",
        targetZoneLabel: "Zone 1",
        targetZoneBpm: "< 110 bpm",
        targetZoneSegments: [{ color: "#93C5FD", flex: 1 }],
        pinPositionPercent: 10,
        effortBlocks: [
          {
            title: "Repos",
            durationLabel: "Toute la journée",
            type: "recovery",
            flexRatio: 1,
          },
        ],
        tags: ["Jour verrouillé", "Hydratation"],
        aiAdjustmentNote:
          "Règle de vie respectée : pas d'entraînement le jeudi.",
      },
      {
        userId,
        dateKey: "2026-10-16",
        dayName: "Ven",
        dayNumber: 16,
        month: 9,
        year,
        weekNumber,
        fullDateLabel: "VENDREDI 16 OCTOBRE",
        timeLabel: "12:30",
        status: WorkoutStatus.UPCOMING,
        isRestDay: false,
        category: "ALLURE SPÉCIFIQUE",
        title: "Allure Spécifique Semi 3 × 2000m",
        duration: "55 min",
        distance: "10,5 km",
        targetPace: "4:50/km",
        targetZoneLabel: "Zone 3–4",
        targetZoneBpm: "160–174 bpm",
        targetZoneSegments: [
          { color: "#93C5FD", flex: 1.5 },
          { color: "#FBBF24", flex: 2 },
          { color: "#FC4C02", flex: 2 },
        ],
        pinPositionPercent: 70,
        effortBlocks: [
          {
            title: "Échauffement",
            durationLabel: "15 min",
            type: "warmup",
            flexRatio: 1,
          },
          {
            title: "3 × 2000m",
            durationLabel: "30 min",
            type: "threshold",
            flexRatio: 3,
          },
          {
            title: "Retour au calme",
            durationLabel: "10 min",
            type: "cooldown",
            flexRatio: 1,
          },
        ],
        tags: ["10,5 km", "Allure cible : 4:50/km", "Zone 4"],
        aiAdjustmentNote:
          "Séance déterminante pour calibrer le cardio avant la sortie longue.",
      },
      {
        userId,
        dateKey: "2026-10-17",
        dayName: "Sam",
        dayNumber: 17,
        month: 9,
        year,
        weekNumber,
        fullDateLabel: "SAMEDI 17 OCTOBRE",
        timeLabel: "09:00",
        status: WorkoutStatus.UPCOMING,
        isRestDay: false,
        category: "SORTIE LONGUE",
        title: "Sortie Longue Progressive 1h30 (16 km)",
        duration: "1h30",
        distance: "16,0 km",
        targetPace: "5:30/km",
        targetZoneLabel: "Zone 2–3",
        targetZoneBpm: "138–155 bpm",
        targetZoneSegments: [
          { color: "#93C5FD", flex: 2 },
          { color: "#34D399", flex: 3 },
          { color: "#FBBF24", flex: 2 },
        ],
        pinPositionPercent: 55,
        effortBlocks: [
          {
            title: "Endurance",
            durationLabel: "60 min",
            type: "warmup",
            flexRatio: 4,
          },
          {
            title: "Allure semi fin",
            durationLabel: "20 min",
            type: "threshold",
            flexRatio: 2,
          },
          {
            title: "Retour au calme",
            durationLabel: "10 min",
            type: "cooldown",
            flexRatio: 1,
          },
        ],
        tags: ["16,0 km", "Bloc endurance clé", "Zone 2/3"],
        aiAdjustmentNote:
          "Prévoir hydratation tous les 4 km et un gel énergétique à mi-parcours.",
      },
      {
        userId,
        dateKey: "2026-10-18",
        dayName: "Dim",
        dayNumber: 18,
        month: 9,
        year,
        weekNumber,
        fullDateLabel: "DIMANCHE 18 OCTOBRE",
        timeLabel: "Jour de repos",
        status: WorkoutStatus.REST,
        isRestDay: true,
        category: "BILAN DE SEMAINE",
        title: "Repos complet & Bilan de Semaine",
        duration: "—",
        distance: "0 km",
        targetPace: "—",
        targetZoneLabel: "Zone 1",
        targetZoneBpm: "< 110 bpm",
        targetZoneSegments: [{ color: "#93C5FD", flex: 1 }],
        pinPositionPercent: 10,
        effortBlocks: [
          {
            title: "Repos",
            durationLabel: "Toute la journée",
            type: "recovery",
            flexRatio: 1,
          },
        ],
        tags: ["Bilan hebdo", "Récupération"],
        aiAdjustmentNote:
          "Total prévu : 47,5 km. Semaine à fort volume de préparation.",
      },
    ];

    for (const item of defaultWeekWorkouts) {
      await this.prisma.workout.upsert({
        where: {
          userId_dateKey: {
            userId: item.userId,
            dateKey: item.dateKey,
          },
        },
        update: {
          ...(item.status === WorkoutStatus.DONE
            ? {
                actualDistanceKm: item.actualDistanceKm,
                actualDurationSec: item.actualDurationSec,
                actualPace: item.actualPace,
                actualAvgHeartRate: item.actualAvgHeartRate,
                actualMaxHeartRate: item.actualMaxHeartRate,
                actualElevationGain: item.actualElevationGain,
                actualCalories: item.actualCalories,
                actualCadence: item.actualCadence,
                sourceProvider: item.sourceProvider,
                externalActivityId: item.externalActivityId,
                tss: item.tss,
                completedAt: item.completedAt,
              }
            : {}),
        },
        create: item,
      });
    }
  }

  private mapToDto(w: any): WorkoutSessionDto {
    const statusMap: Record<
      WorkoutStatus,
      "done" | "selected" | "rest" | "upcoming"
    > = {
      [WorkoutStatus.DONE]: "done",
      [WorkoutStatus.SELECTED]: "selected",
      [WorkoutStatus.REST]: "rest",
      [WorkoutStatus.UPCOMING]: "upcoming",
    };

    return {
      id: w.id,
      dateKey: w.dateKey,
      dayName: w.dayName,
      dayNumber: w.dayNumber,
      month: w.month,
      year: w.year,
      weekNumber: w.weekNumber,
      fullDateLabel: w.fullDateLabel,
      timeLabel: w.timeLabel || undefined,
      status: statusMap[w.status as WorkoutStatus] || "upcoming",
      isRestDay: w.isRestDay,
      category: w.category,
      title: w.title,
      duration: w.duration,
      distance: w.distance,
      targetPace: w.targetPace,
      targetZoneLabel: w.targetZoneLabel,
      targetZoneBpm: w.targetZoneBpm,
      targetZoneSegments: (w.targetZoneSegments as any) || [],
      pinPositionPercent: w.pinPositionPercent,
      effortBlocks: (w.effortBlocks as any) || [],
      tags: w.tags || [],
      aiAdjustmentNote: w.aiAdjustmentNote || undefined,
      externalActivityId: w.externalActivityId || undefined,
      sourceProvider: w.sourceProvider || undefined,
      actualDistanceKm: w.actualDistanceKm ?? undefined,
      actualDurationSec: w.actualDurationSec ?? undefined,
      actualPace: w.actualPace || undefined,
      actualAvgHeartRate: w.actualAvgHeartRate ?? undefined,
      actualMaxHeartRate: w.actualMaxHeartRate ?? undefined,
      actualElevationGain: w.actualElevationGain ?? undefined,
      actualCalories: w.actualCalories ?? undefined,
      actualCadence: w.actualCadence ?? undefined,
      actualSplitsJson: w.actualSplitsJson ?? undefined,
      tss: w.tss ?? undefined,
      completedAt: w.completedAt ? w.completedAt.toISOString() : undefined,
    };
  }
}

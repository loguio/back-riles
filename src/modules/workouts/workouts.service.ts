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
import { runInTransaction } from "../../prisma/transaction";

/**
 * Convertit une durée d'affichage ("1h15", "45 min", "—") en minutes.
 * Retourne 0 pour les valeurs vides/non parsées.
 */
function parseDurationStringToMin(duration?: string | null): number {
  if (!duration) return 0;
  const hourMatch = duration.match(/(\d+)\s*h\s*(\d+)?/i);
  if (hourMatch) {
    const h = parseInt(hourMatch[1], 10);
    const m = hourMatch[2] ? parseInt(hourMatch[2], 10) : 0;
    return h * 60 + m;
  }
  const minMatch = duration.match(/(\d+)\s*min/i);
  if (minMatch) return parseInt(minMatch[1], 10);
  const bare = duration.match(/^(\d+)$/);
  return bare ? parseInt(bare[1], 10) : 0;
}

@Injectable()
export class WorkoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataLakeService: DataLakeService,
    private readonly llmService: LlmService,
  ) {}

  public getIsoWeekNumber(d: Date): number {
    const target = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
    const dayNr = target.getUTCDay() || 7;
    target.setUTCDate(target.getUTCDate() + 4 - dayNr);
    const jan1 = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    return Math.ceil(((target.getTime() - jan1.getTime()) / 86400000 + 1) / 7);
  }

  private getMondayOfWeek(year: number, week: number): Date {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7;
    const firstMonday = new Date(Date.UTC(year, 0, 4 - (dayOfWeek - 1)));
    return new Date(firstMonday.getTime() + (week - 1) * 7 * 24 * 3600 * 1000);
  }

  async getWeekWorkouts(
    userId: string,
    weekNumber?: number,
    year?: number,
  ): Promise<WorkoutSessionDto[]> {
    const now = new Date();
    const effectiveYear = year ? Number(year) : now.getFullYear();
    const effectiveWeek = weekNumber
      ? Number(weekNumber)
      : this.getIsoWeekNumber(now);

    const monday = this.getMondayOfWeek(effectiveYear, effectiveWeek);
    const sunday = new Date(monday.getTime() + 6 * 24 * 3600 * 1000);
    const mondayKey = monday.toISOString().split("T")[0];
    const sundayKey = sunday.toISOString().split("T")[0];

    const workouts = await this.prisma.workout.findMany({
      where: {
        userId,
        OR: [
          { dateKey: { gte: mondayKey, lte: sundayKey } },
          { weekNumber: effectiveWeek, year: effectiveYear },
        ],
      },
      orderBy: { dateKey: "asc" },
    });

    return workouts.map((w) => this.mapToDto(w));
  }

  async getMonthWorkouts(
    userId: string,
    month?: number,
    year?: number,
  ): Promise<Record<string, WorkoutSessionDto>> {
    const now = new Date();
    const effectiveMonth = month !== undefined ? Number(month) : now.getMonth();
    const effectiveYear = year !== undefined ? Number(year) : now.getFullYear();

    const monthStr = String(effectiveMonth + 1).padStart(2, "0");
    const prefix = `${effectiveYear}-${monthStr}`;

    const workouts = await this.prisma.workout.findMany({
      where: {
        userId,
        OR: [
          { dateKey: { startsWith: prefix } },
          { month: effectiveMonth, year: effectiveYear },
        ],
      },
      orderBy: { dateKey: "asc" },
    });

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
      // Si c'est un format de date YYYY-MM-DD, renvoyer un créneau de repos propre plutôt qu'une erreur 404
      if (/^\d{4}-\d{2}-\d{2}$/.test(identifier)) {
        const [y, m, d] = identifier.split("-").map(Number);
        const dateObj = new Date(Date.UTC(y, m - 1, d));
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
        const dow = dateObj.getUTCDay();
        const weekNum = this.getIsoWeekNumber(dateObj);
        return {
          id: `rest-${identifier}`,
          dateKey: identifier,
          dayName: dayNamesShort[dow],
          dayNumber: d,
          month: m - 1,
          year: y,
          weekNumber: weekNum,
          fullDateLabel: `${dayNamesFull[dow]} ${d} ${monthNamesFull[m - 1]}`,
          timeLabel: "Jour de repos",
          status: "rest",
          isRestDay: true,
          category: "RÉCUPÉRATION PASSIVE",
          title: "Aucune séance programmée",
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
              durationLabel: "Journée",
              type: "recovery",
              flexRatio: 1,
            },
          ],
          tags: ["Repos", "Assimilation"],
          aiAdjustmentNote: "Aucune séance spécifique prévue ce jour-là.",
        };
      }
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
    // RILES-025 / RILES-018 — Ces messages ne doivent PRÉTENDRE aucun
    // changement de plan (aucun repos inséré, aucun volume allégé n'est
    // écrit ici) : ils décrivent uniquement l'évaluation de l'effort et,
    // le cas échéant, une suggestion clairement formulée comme telle.
    let aiPreservationMessage =
      "Évaluation de ton ressenti enregistrée sur cette séance. Aucun changement de plan n'est appliqué automatiquement.";

    if (dto.rating <= 3) {
      feedbackLabel = "Très facile";
      aiPreservationMessage =
        "Effort très facile : ta fraîcheur est bonne. Si tu le souhaites, on peut en discuter pour augmenter légèrement le volume de la prochaine séance (plafonné à +10 %).";
    } else if (dto.rating <= 6) {
      feedbackLabel = "Modéré";
      aiPreservationMessage =
        "Effort modéré, cohérent avec l'intention de la séance. Rien à ajuster dans ton plan sur cette base.";
    } else if (dto.rating <= 8) {
      feedbackLabel = "Difficile";
      aiPreservationMessage =
        "Effort difficile : prévois une récupération attentive. Suggestion : si la fatigue persiste, allège la prochaine séance.";
    } else {
      feedbackLabel = "À fond";
      aiPreservationMessage =
        "Effort très intense : un vrai repos est recommandé avant la prochaine séance. Suggestion : garde la prochaine séance très légère.";
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

    // RILES-027 : charge interne sRPE = RPE × durée(min), stockée sur la
    // séance. Sert de charge de repli quand la FC manque (voir
    // training-science.computeSessionTss, chemin sRPE).
    if (dto.workoutId) {
      const workout = await this.prisma.workout.findFirst({
        where: { id: dto.workoutId, userId },
      });
      if (workout) {
        const durationMin =
          (workout.actualDurationSec ?? 0) > 0
            ? (workout.actualDurationSec as number) / 60
            : parseDurationStringToMin(workout.duration);
        const sRpe = Math.round(dto.rating * durationMin);
        await this.prisma.workout.update({
          where: { id: workout.id },
          data: { sRpe },
        });
      }
    }

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

    // RILES-018 — Ces adaptations sont des règles déterministes appliquées
    // à la demande de l'utilisateur : aucune n'est générée par une IA, les
    // libellés et notes ne revendiquent donc plus d'« IA » et décrivent
    // exactement la modification réellement écrite en base.
    let updates: any = {};

    switch (dto.adaptationType) {
      case "lighten":
        updates = {
          title: "Footing Léger & Lignes Droites (Adapté)",
          duration: "35 min",
          distance: "6,0 km",
          targetPace: "5:30/km",
          targetZoneLabel: "Zone 2",
          targetZoneBpm: "135–148 bpm",
          aiAdjustmentNote:
            "Séance allégée à ta demande : 35 min en Zone 2 (allure 5:30/km).",
          tags: ["6,0 km", "Allure : 5:30/km", "Zone 2"],
        };
        break;

      case "easy_run":
        updates = {
          title: "30 min Footing Souple Régénérant (Adapté)",
          duration: "30 min",
          distance: "5,0 km",
          targetPace: "6:00/km",
          targetZoneLabel: "Zone 1–2",
          targetZoneBpm: "125–138 bpm",
          aiAdjustmentNote:
            "Remplacement à ta demande : 30 min de footing souple en Zone 1–2.",
          tags: ["5,0 km", "Endurance fondamentale", "Zone 1/2"],
        };
        break;

      case "postpone":
        updates = {
          title: "Repos / Récupération (Adapté)",
          isRestDay: true,
          status: WorkoutStatus.REST,
          duration: "—",
          distance: "0 km",
          targetZoneLabel: "Zone 1",
          targetZoneBpm: "< 110 bpm",
          aiAdjustmentNote:
            "Journée remplacée par un jour de repos à ta demande (la séance n'est pas reportée automatiquement).",
          tags: ["Repos actif", "Hydratation"],
        };
        break;

      case "injury_care":
        updates = {
          title: "Mobilité douce & Glaçage Mollet (Adapté)",
          duration: "20 min",
          distance: "0 km",
          targetZoneLabel: "Zone 1",
          targetZoneBpm: "< 115 bpm",
          aiAdjustmentNote:
            "Séance remplacée par 20 min de mobilité douce à ta demande.",
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
    const now = new Date();
    const startWeek = dto.startWeekNumber ?? this.getIsoWeekNumber(now);
    const year = dto.year ?? now.getFullYear();
    const weeksToGenerate = Math.max(dto.weeksToGenerate ?? 12, 1);

    // S'assurer que l'utilisateur existe et récupérer son contexte complet
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { rules: true, syncTokens: true },
    });

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
        : 30);
    const longestRecentRunKm =
      sixMonthsSummary?.longestRunKm ??
      (sessionMetrics && sessionMetrics.length > 0
        ? Math.max(...sessionMetrics.map((s) => s.distanceKm || 0))
        : 12);

    const calculatedPaces = this.llmService.computePacesFromRecentPerformance({
      hasSyncedHistory: Boolean(
        sixMonthsSummary || recentDoneWorkouts.length > 0,
      ),
      recentWeeklyKm,
      recent4WeeksAvgKm: sixMonthsSummary?.recent4WeeksAvgKm,
      totalKm6Months: sixMonthsSummary?.totalDistanceKm ?? user?.totalKm,
      longestRecentRunKm,
      activeWeeks: sixMonthsSummary?.activeWeeks ?? user?.activeWeeks ?? 0,
      hrMax: sixMonthsSummary?.maxHeartRateObserved ?? 185,
      importedThresholdPaceSecPerKm: garminMeta.lactateThresholdPace,
      recentSessions: sessionMetrics,
      sixMonthsSummary,
    });

    // Construction des créneaux calendaires pour les N semaines demandées
    const baseMonday = this.getMondayOfWeek(year, startWeek);
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
      for (let d = 0; d < 7; d++) {
        const dateObj = new Date(
          baseMonday.getTime() + (w * 7 + d) * 24 * 3600 * 1000,
        );
        const yyyy = dateObj.getUTCFullYear();
        const mm = dateObj.getUTCMonth(); // 0-indexed (9 = Octobre, 10 = Novembre, etc.)
        const dd = dateObj.getUTCDate();
        const dow = dateObj.getUTCDay();
        const dateKey = `${yyyy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
        const weekNumber = this.getIsoWeekNumber(dateObj);

        calendarDays.push({
          dateKey,
          dayName: dayNamesShort[dow],
          dayNumber: dd,
          month: mm,
          year: yyyy,
          weekNumber,
          fullDateLabel: `${dayNamesFull[dow]} ${dd} ${monthNamesFull[mm]}`,
        });
      }
    }

    const llmPlan = await this.llmService.generateMultiWeekPlan({
      userProfile: {
        name: user?.name || "Athlète",
        mainGoal: user?.mainGoal || undefined,
        activeGoalTitle: user?.activeGoalTitle || user?.mainGoal || "",
        activeGoalTarget: user?.activeGoalTarget || "",
        activeGoalRaceDate: user?.activeGoalRaceDate || "",
        activeGoalWeeksRemaining:
          user?.activeGoalWeeksRemaining ?? weeksToGenerate,
        selectedSports: user?.selectedSports || ["running"],
      },
      physiologicalState: {
        // RILES-029 : pas de default fabriqué — 80 n'était pas une mesure.
        readinessScore: user?.readinessScore,
        totalKm: sixMonthsSummary?.totalDistanceKm ?? user?.totalKm ?? 0,
        activeWeeks: sixMonthsSummary?.activeWeeks ?? user?.activeWeeks ?? 0,
        recentWeeklyKm,
        atlFatigue: user?.atlFatigue ?? 0,
        ctlFitness: user?.ctlFitness ?? 0,
        tsbForm: user?.tsbForm ?? 0,
        sleepScore: user?.sleepScore ?? undefined,
        hrvStatus: user?.hrvStatus || undefined,
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
    // RILES-031 : l'écriture complète est atomique (une seule transaction).
    // En cas d'échec en cours de sauvegarde, on retrouve l'ancien plan intact :
    // jamais un plan à moitié écrasé ni un message de chat orphelin.
    await runInTransaction(this.prisma, async (tx) => {
      const existingDoneWorkouts = await tx.workout.findMany({
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

        const todayDateKey = new Date().toISOString().split("T")[0];
        const isToday = item.dateKey === todayDateKey;
        const status = item.isRestDay
          ? WorkoutStatus.REST
          : isToday
            ? WorkoutStatus.SELECTED
            : WorkoutStatus.UPCOMING;

        await tx.workout.upsert({
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

      // Si le chat est encore vierge, on place uniquement un message d'accueil simple et naturel
      if (user) {
        const existingCount = await tx.chatMessage.count({
          where: { userId },
        });
        if (existingCount === 0) {
          await tx.chatMessage.create({
            data: {
              userId,
              sender: "coach",
              text: "Salut ! Je suis ton coach IA. Dis-moi si tu as une question sur une séance, tes sensations ou si tu souhaites adapter ton planning.",
              timestamp: new Date().toLocaleTimeString("fr-FR", {
                hour: "2-digit",
                minute: "2-digit",
              }),
            },
          });
        }
      }
    });

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
      sportType: w.sportType || "running",
      isCommute: w.isCommute ?? false,
      secondaryActivities: w.secondaryActivities ?? undefined,
    };
  }

  async getPlanRoadmap(userId: string): Promise<any> {
    const now = new Date();
    const todayDateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const currentWeekNumber = this.getIsoWeekNumber(now);
    const currentYear = now.getFullYear();

    const [user, recentDoneWorkouts] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          rules: { orderBy: { createdAt: "asc" } },
          syncTokens: { where: { isConnected: true } },
        },
      }),
      this.prisma.workout.findMany({
        where: {
          userId,
          status: WorkoutStatus.DONE,
          isRestDay: false,
        },
        orderBy: { dateKey: "desc" },
        take: 30,
      }),
    ]);

    const stravaToken = user?.syncTokens?.find((t) => t.provider === "strava");
    const stravaMeta = (stravaToken?.metadata as any) || {};
    const sixMonthsSummary = stravaMeta.sixMonthsSummary;
    const savedGenPlan = stravaMeta.generatedPlan;

    const startWeek = savedGenPlan?.startWeekNumber || currentWeekNumber;
    const startYear = savedGenPlan?.year || currentYear;
    const planMonday = this.getMondayOfWeek(startYear, startWeek);
    const planMondayKey = planMonday.toISOString().split("T")[0];

    const planWorkouts = await this.prisma.workout.findMany({
      where: {
        userId,
        dateKey: { gte: planMondayKey },
      },
      orderBy: { dateKey: "asc" },
    });

    const recentSessions =
      this.llmService.extractSessionMetricsFromWorkouts(recentDoneWorkouts);
    const calibratedPaces =
      sixMonthsSummary?.estimatedPaces ||
      this.llmService.computePacesFromRecentPerformance({
        hasSyncedHistory: recentDoneWorkouts.length > 0,
        recentWeeklyKm: sixMonthsSummary?.recent4WeeksAvgKm,
        hrMax: sixMonthsSummary?.maxHeartRateObserved,
        recentSessions,
      });

    const shortMonths = [
      "janv.",
      "févr.",
      "mars",
      "avr.",
      "mai",
      "juin",
      "juil.",
      "août",
      "sept.",
      "oct.",
      "nov.",
      "déc.",
    ];
    const formatShortDate = (dateKey: string) => {
      const parts = dateKey.split("-").map(Number);
      if (parts.length !== 3) return dateKey;
      return `${parts[2]} ${shortMonths[(parts[1] - 1) % 12]}`;
    };

    const byWeek = new Map<
      string,
      {
        weekKey: string;
        weekNumber: number;
        year: number;
        relativeWeek: number;
        firstDateKey: string;
        lastDateKey: string;
        dateRangeLabel: string;
        status: "completed" | "current" | "upcoming";
        phaseNumber: number;
        phaseName: string;
        weekType: string;
        isDeload: boolean;
        isTaper: boolean;
        plannedKm: number;
        completedKm: number;
        plannedRunningSessions: number;
        completedSessions: number;
        restDays: number;
        keySessions: string[];
        sessions: Array<{
          id: string;
          dateKey: string;
          dayName: string;
          dayNumber: number;
          title: string;
          category: string;
          distance: string;
          duration: string;
          targetPace: string;
          targetZoneLabel: string;
          status: string;
          isRestDay: boolean;
          actualDistanceKm?: number;
          actualPace?: string;
          actualAvgHeartRate?: number;
        }>;
      }
    >();

    for (const w of planWorkouts) {
      if (w.isCommute && w.status === WorkoutStatus.DONE) {
        continue;
      }
      const wk = w.weekNumber || this.getIsoWeekNumber(new Date(w.dateKey));
      const yr = w.year || Number(w.dateKey.slice(0, 4));
      const weekKey = `${yr}-W${String(wk).padStart(2, "0")}`;

      let entry = byWeek.get(weekKey);
      if (!entry) {
        entry = {
          weekKey,
          weekNumber: wk,
          year: yr,
          relativeWeek: 1,
          firstDateKey: w.dateKey,
          lastDateKey: w.dateKey,
          dateRangeLabel: "",
          status: "upcoming",
          phaseNumber: 1,
          phaseName: "Phase 1 : Socle Aérobie",
          weekType: "Volume & Endurance Z2",
          isDeload: false,
          isTaper: false,
          plannedKm: 0,
          completedKm: 0,
          plannedRunningSessions: 0,
          completedSessions: 0,
          restDays: 0,
          keySessions: [],
          sessions: [],
        };
        byWeek.set(weekKey, entry);
      }

      if (w.dateKey < entry.firstDateKey) entry.firstDateKey = w.dateKey;
      if (w.dateKey > entry.lastDateKey) entry.lastDateKey = w.dateKey;

      const isRunning = !w.sportType || w.sportType === "running";
      if (w.isRestDay) {
        entry.restDays += 1;
      } else {
        entry.plannedRunningSessions += 1;
        if (isRunning && w.distance) {
          const distNum =
            parseFloat(w.distance.replace(",", ".").replace(/[^0-9.]/g, "")) ||
            0;
          entry.plannedKm += distNum;
        }
        entry.keySessions.push(`${w.dayName} : ${w.title} (${w.distance})`);
      }

      if (w.status === WorkoutStatus.DONE && !w.isCommute) {
        entry.completedSessions += 1;
        if (isRunning && w.actualDistanceKm) {
          entry.completedKm += w.actualDistanceKm;
        }
      }

      if (Array.isArray(w.secondaryActivities)) {
        for (const sec of w.secondaryActivities as any[]) {
          if (
            sec &&
            !sec.isCommute &&
            sec.sportType === "running" &&
            sec.distanceKm
          ) {
            entry.completedKm += Number(sec.distanceKm) || 0;
          }
        }
      }

      entry.sessions.push({
        id: w.id,
        dateKey: w.dateKey,
        dayName: w.dayName,
        dayNumber: w.dayNumber,
        title: w.title,
        category: w.category,
        distance: w.distance,
        duration: w.duration,
        targetPace: w.targetPace,
        targetZoneLabel: w.targetZoneLabel,
        status: w.status.toLowerCase(),
        isRestDay: w.isRestDay,
        actualDistanceKm: w.actualDistanceKm ?? undefined,
        actualPace: w.actualPace ?? undefined,
        actualAvgHeartRate: w.actualAvgHeartRate ?? undefined,
      });
    }

    const sortedWeeks = Array.from(byWeek.values()).sort((a, b) =>
      a.firstDateKey.localeCompare(b.firstDateKey),
    );
    const totalWeeks = Math.max(1, sortedWeeks.length);
    let currentRelativeWeek = 1;

    sortedWeeks.forEach((item, index) => {
      const relW = index + 1;
      item.relativeWeek = relW;
      item.plannedKm = Math.round(item.plannedKm * 10) / 10;
      item.completedKm = Math.round(item.completedKm * 10) / 10;
      item.dateRangeLabel = `${formatShortDate(item.firstDateKey)} – ${formatShortDate(item.lastDateKey)}`;

      if (item.lastDateKey < todayDateKey) {
        item.status = "completed";
      } else if (
        item.firstDateKey <= todayDateKey &&
        todayDateKey <= item.lastDateKey
      ) {
        item.status = "current";
        currentRelativeWeek = relW;
      } else {
        item.status = "upcoming";
      }

      const isTaper = relW >= totalWeeks - 1 && totalWeeks >= 6;
      const isDeload = !isTaper && relW % 4 === 0;
      item.isDeload = isDeload;
      item.isTaper = isTaper;

      const pct = relW / totalWeeks;
      if (pct <= 0.35) {
        item.phaseNumber = 1;
        item.phaseName = "Phase 1 : Socle Aérobie & Régularité";
        item.weekType = isDeload
          ? "Semaine d'assimilation (Deload)"
          : "Volume & Endurance Fondamentale Z2";
      } else if (pct <= 0.65) {
        item.phaseNumber = 2;
        item.phaseName = "Phase 2 : Développement Seuil & Allure";
        item.weekType = isDeload
          ? "Semaine d'assimilation (Deload)"
          : "Fractions Seuil Z4 & Allure Tempo";
      } else if (pct <= 0.85) {
        item.phaseNumber = 3;
        item.phaseName = "Phase 3 : Pic Spécifique & Sortie Longue";
        item.weekType = isDeload
          ? "Semaine d'assimilation (Deload)"
          : "Allure Spécifique Course & Sortie Longue";
      } else {
        item.phaseNumber = 4;
        item.phaseName = "Phase 4 : Affûtage & Fraîcheur";
        item.weekType = "Affûtage pré-compétition & Jus";
      }
    });

    const phaseMeta: Record<
      number,
      { name: string; focus: string; defaultType: string }
    > = {
      1: {
        name: "Phase 1 : Socle Aérobie & Régularité",
        focus:
          "Consolider ton endurance fondamentale en Zone 2, habituer tes tendons au volume hebdomadaire et installer la régularité sans fatigue excessive.",
        defaultType: "Endurance Z2 & Montée progressive",
      },
      2: {
        name: "Phase 2 : Développement Seuil & Allure",
        focus:
          "Élever ton seuil anaérobie (Zone 4) et ton économie de course grâce aux blocs de fractionné maîtrisés et à l'allongement progressif de la sortie longue.",
        defaultType: "Fractions Seuil Z4 & Tempo",
      },
      3: {
        name: "Phase 3 : Pic Spécifique & Sortie Longue",
        focus:
          "Valider ton allure spécifique d'objectif sur des volumes élevés et habituer ton corps à consommer efficacement ses réserves énergétiques.",
        defaultType: "Allure Spécifique & Sorties Longues Clés",
      },
      4: {
        name: "Phase 4 : Affûtage & Fraîcheur Optimale",
        focus:
          "Réduire progressivement le volume kilométrique (-35 à -45%) tout en conservant des rappels d'allure pour arriver à 100% de fraîcheur sur la ligne de départ.",
        defaultType: "Affûtage & Surcompensation",
      },
    };

    const phases = [1, 2, 3, 4]
      .map((phaseNum) => {
        const pWeeks = sortedWeeks.filter((w) => w.phaseNumber === phaseNum);
        if (pWeeks.length === 0) return null;
        const firstW = pWeeks[0];
        const lastW = pWeeks[pWeeks.length - 1];
        const avgKm = Math.round(
          pWeeks.reduce((s, w) => s + w.plannedKm, 0) / pWeeks.length,
        );
        const peakKm = Math.round(Math.max(...pWeeks.map((w) => w.plannedKm)));
        const sessionsPerWeek = Math.round(
          pWeeks.reduce((s, w) => s + w.plannedRunningSessions, 0) /
            pWeeks.length,
        );
        const hasCurrent = pWeeks.some((w) => w.status === "current");
        const allCompleted = pWeeks.every((w) => w.status === "completed");
        const status: "completed" | "current" | "upcoming" = hasCurrent
          ? "current"
          : allCompleted
            ? "completed"
            : "upcoming";

        return {
          phaseNumber: phaseNum,
          name: phaseMeta[phaseNum].name,
          weeksRangeLabel:
            firstW.relativeWeek === lastW.relativeWeek
              ? `Semaine ${firstW.relativeWeek} (${firstW.dateRangeLabel})`
              : `Semaines ${firstW.relativeWeek} à ${lastW.relativeWeek} (${formatShortDate(firstW.firstDateKey)} – ${formatShortDate(lastW.lastDateKey)})`,
          focus: phaseMeta[phaseNum].focus,
          weekType: phaseMeta[phaseNum].defaultType,
          avgKm,
          peakKm,
          sessionsPerWeek,
          weeksCount: pWeeks.length,
          status,
          weeks: pWeeks,
        };
      })
      .filter(Boolean);

    const totalPlannedKm = Math.round(
      sortedWeeks.reduce((s, w) => s + w.plannedKm, 0),
    );
    const completedPlanKm =
      Math.round(sortedWeeks.reduce((s, w) => s + w.completedKm, 0) * 10) / 10;
    const totalPlannedSessions = sortedWeeks.reduce(
      (s, w) => s + w.plannedRunningSessions,
      0,
    );
    const peakWeeklyKm =
      sortedWeeks.length > 0
        ? Math.round(Math.max(...sortedWeeks.map((w) => w.plannedKm)))
        : 0;
    const avgWeeklyKm =
      sortedWeeks.length > 0
        ? Math.round(totalPlannedKm / sortedWeeks.length)
        : 0;

    const currentPhase =
      phases.find((p: any) => p.status === "current") || phases[0] || null;
    const progressPercentage = Math.max(
      5,
      Math.min(100, Math.round((currentRelativeWeek / totalWeeks) * 100)),
    );

    return {
      goal: {
        title: user?.activeGoalTitle || user?.mainGoal || "Objectif Course",
        target: user?.activeGoalTarget || "",
        raceDate: user?.activeGoalRaceDate || "",
        weeksRemaining: Math.max(1, totalWeeks - currentRelativeWeek + 1),
        totalWeeks,
        currentRelativeWeek,
        progressPercentage,
        currentPhaseName: currentPhase?.name || "Phase 1 : Socle Aérobie",
      },
      calibratedPaces,
      summaryStats: {
        totalPlannedKm,
        completedPlanKm,
        totalPlannedSessions,
        avgWeeklyKm,
        peakWeeklyKm,
      },
      lifeRules: (user?.rules || []).map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        icon: r.icon,
      })),
      phases,
      weeklyBreakdown: sortedWeeks,
    };
  }
}

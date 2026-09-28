import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DataLakeService } from "../datalake/datalake.service";
import {
  WorkoutSessionDto,
  UpdateWorkoutDto,
  RpeCheckInRequestDto,
  RpeCheckInResponseDto,
  AdaptWorkoutDto,
} from "./dto/workout.dto";
import { WorkoutStatus } from "@prisma/client";

@Injectable()
export class WorkoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataLakeService: DataLakeService,
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

    if (workouts.length === 0) {
      // Auto-provision default workouts for the week if none exist
      await this.provisionDefaultWeekWorkouts(
        userId,
        Number(weekNumber),
        Number(year),
      );
      workouts = await this.prisma.workout.findMany({
        where: {
          userId,
          weekNumber: Number(weekNumber),
          year: Number(year),
        },
        orderBy: { dateKey: "asc" },
      });
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

    if (workouts.length === 0) {
      await this.provisionDefaultWeekWorkouts(userId, 42, Number(year));
      workouts = await this.prisma.workout.findMany({
        where: {
          userId,
          month: Number(month),
          year: Number(year),
        },
        orderBy: { dateKey: "asc" },
      });
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
    let workout = await this.prisma.workout.findFirst({
      where: {
        userId,
        OR: [{ id: identifier }, { dateKey: identifier }],
      },
    });

    if (!workout) {
      // Si la séance n'existe pas, on tente de provisionner la semaine et on réessaye
      await this.provisionDefaultWeekWorkouts(userId, 42, 2026);
      workout = await this.prisma.workout.findFirst({
        where: {
          userId,
          OR: [{ id: identifier }, { dateKey: identifier }],
        },
      });
    }

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
        aiPreservationMessage,
      },
    });

    return {
      rating: checkIn.rating,
      feedbackLabel: checkIn.feedbackLabel,
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
   * Provisionne les séances modèles de la semaine 42 si l'utilisateur est nouveau
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
        tags: ["7,0 km", "Allure : 5:45/km", "Zone 2"],
        aiAdjustmentNote:
          "Séance réalisée avec une régularité cardiaque parfaite.",
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
        title: "Gainage & Travail de Pied",
        duration: "35 min",
        distance: "0 km",
        targetPace: "—",
        targetZoneLabel: "Zone 1–2",
        targetZoneBpm: "110–135 bpm",
        targetZoneSegments: [
          { color: "#93C5FD", flex: 4 },
          { color: "#34D399", flex: 2 },
        ],
        pinPositionPercent: 25,
        effortBlocks: [
          {
            title: "Mobilité chevilles",
            durationLabel: "10 min",
            type: "warmup",
            flexRatio: 1,
          },
          {
            title: "Circuit gainage",
            durationLabel: "20 min",
            type: "threshold",
            flexRatio: 2,
          },
          {
            title: "Étirements",
            durationLabel: "5 min",
            type: "cooldown",
            flexRatio: 1,
          },
        ],
        tags: ["35 min", "Corps complet", "Zone 1"],
        aiAdjustmentNote:
          "Indispensable pour stabiliser la posture sur le semi-marathon.",
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
        update: {},
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
    };
  }
}

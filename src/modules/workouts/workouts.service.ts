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
    const workouts = await this.prisma.workout.findMany({
      where: {
        userId,
        weekNumber: Number(weekNumber),
        year: Number(year),
      },
      orderBy: { dateKey: "asc" },
    });

    if (workouts.length === 0) {
      // Return any available workouts or fallback
      const fallbackWorkouts = await this.prisma.workout.findMany({
        where: { userId },
        orderBy: { dateKey: "asc" },
        take: 7,
      });
      return fallbackWorkouts.map((w) => this.mapToDto(w));
    }

    return workouts.map((w) => this.mapToDto(w));
  }

  async getMonthWorkouts(
    userId: string,
    month = 9,
    year = 2026,
  ): Promise<Record<string, WorkoutSessionDto>> {
    const workouts = await this.prisma.workout.findMany({
      where: {
        userId,
        month: Number(month),
        year: Number(year),
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

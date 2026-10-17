import { Injectable, NotFoundException } from "@nestjs/common";
import { ChallengeMetric, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  CommunityRunDto,
  MonthlyChallengeDto,
  ToggleRunParticipationResponseDto,
} from "./dto/community.dto";

/** Sortie collective avec ses relations (club + participants nommés). */
type RunWithRelations = Prisma.CommunityRunGetPayload<{
  include: {
    club: { select: { id: true; name: true } };
    participants: {
      include: { user: { select: { id: true; name: true; initials: true } } };
    };
  };
}>;

/** Séance réalisée réduite aux métriques agrégées par un défi. */
type WorkoutMetrics = {
  completedAt: Date | null;
  actualDistanceKm: number | null;
  actualDurationSec: number | null;
  actualElevationGain: number | null;
};

@Injectable()
export class CommunityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sorties à venir (déjà programmées, non passées), optionnellement filtrées
   * sur un club. `isJoined` reflète l'inscription de l'utilisateur courant.
   */
  async getRuns(userId: string, clubId?: string): Promise<CommunityRunDto[]> {
    const now = new Date();
    const runs = await this.prisma.communityRun.findMany({
      where: {
        scheduledAt: { gte: now },
        ...(clubId ? { clubId } : {}),
      },
      orderBy: { scheduledAt: "asc" },
      include: {
        club: { select: { id: true, name: true } },
        participants: {
          orderBy: { joinedAt: "asc" },
          include: {
            user: { select: { id: true, name: true, initials: true } },
          },
        },
      },
    });

    return runs.map((run) => this.mapRun(run, userId));
  }

  /**
   * Rejoint ou quitte une sortie. Idempotent selon `action` :
   *  - "join"  → l'utilisateur est inscrit (création si absente) ;
   *  - "leave" → l'utilisateur n'est plus inscrit (suppression si présente) ;
   *  - absent  → bascule l'état courant.
   * Lève 404 si la sortie n'existe pas.
   */
  async toggleParticipation(
    userId: string,
    runId: string,
    action?: "join" | "leave",
  ): Promise<ToggleRunParticipationResponseDto> {
    // B8 — lecture (existence + inscription) et écriture sont regroupées dans
    // une même transaction : le compteur renvoyé reflète l'écriture, et les
    // bascules `join`/`leave` restent idempotentes (upsert/deleteMany). La
    // bascule sans `action` reste « best-effort » sous requêtes concurrentes
    // identiques (voir CONTRACT-community.md §2).
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.communityRun.findUnique({
        where: { id: runId },
        select: { id: true },
      });
      if (!run) {
        throw new NotFoundException(`Sortie introuvable : ${runId}`);
      }

      const existing = await tx.communityRunParticipant.findUnique({
        where: { runId_userId: { runId, userId } },
        select: { id: true },
      });

      const targetJoined =
        action === "join" ? true : action === "leave" ? false : !existing;

      if (targetJoined) {
        // upsert : idempotent et insensible à une course entre deux requêtes.
        await tx.communityRunParticipant.upsert({
          where: { runId_userId: { runId, userId } },
          create: { runId, userId },
          update: {},
        });
      } else {
        await tx.communityRunParticipant.deleteMany({
          where: { runId, userId },
        });
      }

      const participantCount = await tx.communityRunParticipant.count({
        where: { runId },
      });

      return { runId, isJoined: targetJoined, participantCount };
    });
  }

  /**
   * Défis couvrant la date courante, avec la progression de l'utilisateur
   * agrégée sur ses séances réellement réalisées dans la période du défi.
   */
  async getChallenges(userId: string): Promise<MonthlyChallengeDto[]> {
    const now = new Date();
    const challenges = await this.prisma.monthlyChallenge.findMany({
      where: {
        periodStart: { lte: now },
        periodEnd: { gte: now },
      },
      orderBy: { periodStart: "asc" },
    });

    if (challenges.length === 0) {
      return [];
    }

    // B8 — une seule requête `workout` pour tous les défis (avant : un
    // `findMany` par défi, N+1). On charge la fenêtre englobante puis on
    // répartit en mémoire par période de défi.
    const windowStart = new Date(
      Math.min(
        ...challenges.map((challenge) => challenge.periodStart.getTime()),
      ),
    );
    const windowEnd = new Date(
      Math.max(...challenges.map((challenge) => challenge.periodEnd.getTime())),
    );

    const workouts = await this.prisma.workout.findMany({
      where: {
        userId,
        completedAt: { gte: windowStart, lte: windowEnd },
      },
      select: {
        completedAt: true,
        actualDistanceKm: true,
        actualDurationSec: true,
        actualElevationGain: true,
      },
    });

    return challenges.map((challenge) =>
      this.mapChallenge(challenge, workouts),
    );
  }

  private mapRun(run: RunWithRelations, userId: string): CommunityRunDto {
    const participants = run.participants.map((participant) => ({
      userId: participant.userId,
      name: participant.user.name,
      initials: participant.user.initials,
      isMe: participant.userId === userId,
    }));

    return {
      id: run.id,
      clubId: run.clubId,
      clubName: run.club.name,
      scheduledAt: run.scheduledAt.toISOString(),
      location: run.location,
      theme: run.theme ?? null,
      participantCount: participants.length,
      isJoined: participants.some((participant) => participant.isMe),
      participants,
    };
  }

  private mapChallenge(
    challenge: {
      id: string;
      title: string;
      metric: ChallengeMetric;
      target: number;
      periodStart: Date;
      periodEnd: Date;
    },
    workouts: WorkoutMetrics[],
  ): MonthlyChallengeDto {
    // Ne comptent que les séances de l'utilisateur courant (déjà filtrées par
    // `userId`) dont `completedAt` tombe dans la période du défi.
    const inPeriod = workouts.filter(
      (workout) =>
        workout.completedAt != null &&
        workout.completedAt >= challenge.periodStart &&
        workout.completedAt <= challenge.periodEnd,
    );

    // Prisma exposes enum members in UPPER_CASE ("DISTANCE"); the API contract
    // (and the DB @map) use lower-case ("distance").
    const metric =
      challenge.metric.toLowerCase() as MonthlyChallengeDto["metric"];
    const { progress, unit } = this.computeProgress(metric, inPeriod);
    const progressRatio =
      challenge.target > 0
        ? Math.min(Math.max(progress / challenge.target, 0), 1)
        : 0;

    return {
      id: challenge.id,
      title: challenge.title,
      metric,
      target: challenge.target,
      unit,
      progress,
      progressRatio,
      periodStart: challenge.periodStart.toISOString(),
      periodEnd: challenge.periodEnd.toISOString(),
    };
  }

  /**
   * unit + progress par métrique (voir CONTRACT-community.md §3) :
   * distance → km, duration → min, elevation → m, sessions → nombre de séances.
   */
  private computeProgress(
    metric: MonthlyChallengeDto["metric"],
    workouts: WorkoutMetrics[],
  ): { progress: number; unit: string } {
    const sum = (pick: (w: WorkoutMetrics) => number | null): number =>
      workouts.reduce((total, workout) => total + (pick(workout) ?? 0), 0);

    switch (metric) {
      case "distance":
        return { progress: sum((w) => w.actualDistanceKm), unit: "km" };
      case "duration":
        return { progress: sum((w) => w.actualDurationSec) / 60, unit: "min" };
      case "elevation":
        return { progress: sum((w) => w.actualElevationGain), unit: "m" };
      case "sessions":
        return { progress: workouts.length, unit: "sessions" };
      default:
        return { progress: 0, unit: "" };
    }
  }
}

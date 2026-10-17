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
    const run = await this.prisma.communityRun.findUnique({
      where: { id: runId },
      select: { id: true },
    });
    if (!run) {
      throw new NotFoundException(`Sortie introuvable : ${runId}`);
    }

    const existing = await this.prisma.communityRunParticipant.findUnique({
      where: { runId_userId: { runId, userId } },
      select: { id: true },
    });

    const targetJoined =
      action === "join" ? true : action === "leave" ? false : !existing;

    if (targetJoined) {
      // upsert : idempotent et insensible à une course entre deux requêtes.
      await this.prisma.communityRunParticipant.upsert({
        where: { runId_userId: { runId, userId } },
        create: { runId, userId },
        update: {},
      });
    } else {
      await this.prisma.communityRunParticipant.deleteMany({
        where: { runId, userId },
      });
    }

    const participantCount = await this.prisma.communityRunParticipant.count({
      where: { runId },
    });

    return { runId, isJoined: targetJoined, participantCount };
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

    return Promise.all(
      challenges.map((challenge) => this.mapChallenge(challenge, userId)),
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

  private async mapChallenge(
    challenge: {
      id: string;
      title: string;
      metric: ChallengeMetric;
      target: number;
      periodStart: Date;
      periodEnd: Date;
    },
    userId: string,
  ): Promise<MonthlyChallengeDto> {
    const workouts = await this.prisma.workout.findMany({
      where: {
        userId,
        completedAt: { gte: challenge.periodStart, lte: challenge.periodEnd },
      },
      select: {
        actualDistanceKm: true,
        actualDurationSec: true,
        actualElevationGain: true,
      },
    });

    // Prisma exposes enum members in UPPER_CASE ("DISTANCE"); the API contract
    // (and the DB @map) use lower-case ("distance").
    const metric = challenge.metric.toLowerCase() as MonthlyChallengeDto["metric"];
    const { progress, unit } = this.computeProgress(metric, workouts);
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

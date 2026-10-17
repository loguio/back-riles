import "reflect-metadata";
import { NotFoundException } from "@nestjs/common";
import { ChallengeMetric } from "@prisma/client";
import { CommunityService } from "./community.service";

/**
 * Phase 5B (B5/B7) — CommunityService contre un `PrismaService` simulé.
 *
 * On teste le comportement métier, pas Prisma : inscription idempotente
 * (`join`/`leave`), `isJoined`/`participantCount` exacts, 404 sur sortie
 * inconnue, et progression de défi bornée à l'utilisateur courant dans la
 * période du défi (avec une seule requête `workout` pour tous les défis — B8).
 */

const USER_ID = "user-01";
const OTHER_USER_ID = "user-02";

type ParticipantRow = {
  id: string;
  runId: string;
  userId: string;
  joinedAt: Date;
};

function createPrismaStub() {
  const runs = new Map<string, any>();
  const participants: ParticipantRow[] = [];
  let challengeRows: any[] = [];
  let workoutRows: any[] = [];

  const findParticipant = (runId: string, userId: string) =>
    participants.find((p) => p.runId === runId && p.userId === userId) ?? null;

  const stub: any = {
    communityRun: {
      findMany: jest.fn(async () => Array.from(runs.values())),
      findUnique: jest.fn(async ({ where }: any) => runs.get(where.id) ?? null),
    },
    communityRunParticipant: {
      findUnique: jest.fn(async ({ where }: any) =>
        findParticipant(where.runId_userId.runId, where.runId_userId.userId),
      ),
      upsert: jest.fn(async ({ where, create }: any) => {
        const existing = findParticipant(
          where.runId_userId.runId,
          where.runId_userId.userId,
        );
        if (existing) {
          return existing;
        }
        const row: ParticipantRow = {
          id: `participant-${participants.length + 1}`,
          runId: create.runId,
          userId: create.userId,
          joinedAt: new Date(),
        };
        participants.push(row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        let count = 0;
        for (let i = participants.length - 1; i >= 0; i -= 1) {
          if (
            participants[i].runId === where.runId &&
            participants[i].userId === where.userId
          ) {
            participants.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      }),
      count: jest.fn(
        async ({ where }: any) =>
          participants.filter((p) => p.runId === where.runId).length,
      ),
    },
    monthlyChallenge: {
      findMany: jest.fn(async () => challengeRows),
    },
    workout: {
      // Honore `where.completedAt` : la fenêtre calculée par le service doit
      // réellement filtrer les séances, pas seulement être passée à Prisma.
      findMany: jest.fn(async ({ where }: any = {}) => {
        const range = where?.completedAt;
        return workoutRows.filter((row: any) => {
          if (where?.userId && row.userId && row.userId !== where.userId) {
            return false;
          }
          if (!range) {
            return true;
          }
          const at = row.completedAt?.getTime?.() ?? null;
          if (at == null) {
            return false;
          }
          if (range.gte && at < range.gte.getTime()) {
            return false;
          }
          if (range.lte && at > range.lte.getTime()) {
            return false;
          }
          return true;
        });
      }),
    },
  };

  // Conservé pour prouver que le service n'ouvre plus de transaction
  // interactive (B8 rework) ; `coach.service.test.ts` garde la sienne.
  stub.$transaction = jest.fn(async (fn: any) => fn(stub));

  return {
    stub,
    runs,
    participants,
    setChallenges: (rows: any[]) => {
      challengeRows = rows;
    },
    setWorkouts: (rows: any[]) => {
      workoutRows = rows;
    },
  };
}

function buildService() {
  const harness = createPrismaStub();
  const service = new CommunityService(harness.stub as any);
  return { service, ...harness };
}

function seedRun(
  runs: Map<string, any>,
  id: string,
  participants: any[] = [],
): void {
  runs.set(id, {
    id,
    clubId: "club-01",
    club: { id: "club-01", name: "Riles Paris" },
    scheduledAt: new Date("2026-11-01T18:30:00.000Z"),
    location: "Parc des Buttes-Chaumont, Paris",
    theme: null,
    participants,
  });
}

describe("CommunityService.getRuns", () => {
  it("ne renvoie que les sorties à venir et reflète l'inscription de l'utilisateur courant", async () => {
    const { service, runs, stub } = buildService();
    seedRun(runs, "run-01", [
      {
        userId: USER_ID,
        user: { id: USER_ID, name: "Camille D.", initials: "CD" },
      },
      {
        userId: OTHER_USER_ID,
        user: { id: OTHER_USER_ID, name: "Alex M.", initials: "AM" },
      },
    ]);

    const result = await service.getRuns(USER_ID);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "run-01",
      clubId: "club-01",
      clubName: "Riles Paris",
      participantCount: 2,
      isJoined: true,
      theme: null,
    });
    expect(result[0].participants).toEqual([
      { userId: USER_ID, name: "Camille D.", initials: "CD", isMe: true },
      { userId: OTHER_USER_ID, name: "Alex M.", initials: "AM", isMe: false },
    ]);
    // Fenêtre « à venir » + filtre club passés à Prisma.
    expect(stub.communityRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          scheduledAt: { gte: expect.any(Date) },
        }),
        orderBy: { scheduledAt: "asc" },
      }),
    );
  });

  it("filtre sur un club quand clubId est fourni", async () => {
    const { service, stub } = buildService();

    await service.getRuns(USER_ID, "club-01");

    expect(stub.communityRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clubId: "club-01" }),
      }),
    );
  });

  it("isJoined reste false quand l'utilisateur n'est pas inscrit", async () => {
    const { service, runs } = buildService();
    seedRun(runs, "run-02", [
      {
        userId: OTHER_USER_ID,
        user: { id: OTHER_USER_ID, name: "Alex M.", initials: "AM" },
      },
    ]);

    const [run] = await service.getRuns(USER_ID);

    expect(run.isJoined).toBe(false);
    expect(run.participantCount).toBe(1);
  });
});

describe("CommunityService.toggleParticipation", () => {
  it("lève 404 sur une sortie inconnue", async () => {
    const { service } = buildService();

    await expect(
      service.toggleParticipation(USER_ID, "missing-run", "join"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("join est idempotent (deux appels → une seule inscription)", async () => {
    const { service, runs, participants } = buildService();
    seedRun(runs, "run-01");

    const first = await service.toggleParticipation(USER_ID, "run-01", "join");
    const second = await service.toggleParticipation(USER_ID, "run-01", "join");

    expect(first).toEqual({
      runId: "run-01",
      isJoined: true,
      participantCount: 1,
    });
    expect(second).toEqual({
      runId: "run-01",
      isJoined: true,
      participantCount: 1,
    });
    expect(participants).toHaveLength(1);
  });

  it("leave est idempotent (quitter sans être inscrit ne lève pas)", async () => {
    const { service, runs, participants } = buildService();
    seedRun(runs, "run-01");

    const result = await service.toggleParticipation(
      USER_ID,
      "run-01",
      "leave",
    );

    expect(result).toEqual({
      runId: "run-01",
      isJoined: false,
      participantCount: 0,
    });
    expect(participants).toHaveLength(0);
  });

  it("leave retire l'inscription existante", async () => {
    const { service, runs, participants } = buildService();
    seedRun(runs, "run-01");
    await service.toggleParticipation(USER_ID, "run-01", "join");

    const result = await service.toggleParticipation(
      USER_ID,
      "run-01",
      "leave",
    );

    expect(result.isJoined).toBe(false);
    expect(result.participantCount).toBe(0);
    expect(participants).toHaveLength(0);
  });

  it("sans action, bascule l'état courant", async () => {
    const { service, runs } = buildService();
    seedRun(runs, "run-01");

    const joined = await service.toggleParticipation(USER_ID, "run-01");
    const left = await service.toggleParticipation(USER_ID, "run-01");

    expect(joined.isJoined).toBe(true);
    expect(left.isJoined).toBe(false);
    expect(left.participantCount).toBe(0);
  });

  it("compte les participants de la sortie, pas seulement l'utilisateur courant", async () => {
    const { service, runs } = buildService();
    seedRun(runs, "run-01");
    await service.toggleParticipation(OTHER_USER_ID, "run-01", "join");

    const result = await service.toggleParticipation(USER_ID, "run-01", "join");

    expect(result.participantCount).toBe(2);
  });

  it("n'ouvre pas de transaction interactive (join/leave atomiques)", async () => {
    const { service, runs, stub } = buildService();
    seedRun(runs, "run-01");

    await service.toggleParticipation(USER_ID, "run-01", "join");

    // B8 (rework) — `upsert`/`deleteMany` sont déjà atomiques : inutile
    // d'ajouter `maxWait`/`timeout` (P2028) et la tenue d'une connexion.
    expect(stub.$transaction).not.toHaveBeenCalled();
    expect(stub.communityRunParticipant.upsert).toHaveBeenCalledTimes(1);
  });
});

describe("CommunityService.getChallenges", () => {
  const PERIOD_OCT = {
    periodStart: new Date("2026-10-01T00:00:00.000Z"),
    periodEnd: new Date("2026-10-31T23:59:59.999Z"),
  };
  const PERIOD_SEP = {
    periodStart: new Date("2026-09-01T00:00:00.000Z"),
    periodEnd: new Date("2026-09-30T23:59:59.999Z"),
  };

  function challenge(overrides: any) {
    return {
      id: "challenge-01",
      title: "100 km",
      metric: ChallengeMetric.DISTANCE,
      target: 100,
      ...overrides,
    };
  }

  it("agrège la progression de l'utilisateur courant dans la période du défi", async () => {
    const { service, setChallenges, setWorkouts, stub } = buildService();
    setChallenges([challenge({ id: "c-oct", ...PERIOD_OCT })]);
    setWorkouts([
      {
        completedAt: new Date("2026-10-05T08:00:00.000Z"),
        actualDistanceKm: 12,
        actualDurationSec: 3600,
        actualElevationGain: 50,
      },
      {
        completedAt: new Date("2026-10-20T08:00:00.000Z"),
        actualDistanceKm: 8,
        actualDurationSec: 2400,
        actualElevationGain: 30,
      },
    ]);

    const [result] = await service.getChallenges(USER_ID);

    expect(result).toMatchObject({
      id: "c-oct",
      metric: "distance",
      unit: "km",
      progress: 20,
      progressRatio: 0.2,
    });
    // Ne lit que les séances de l'utilisateur courant, bornées à la fenêtre
    // `completedAt` dérivée des périodes des défis (B8).
    expect(stub.workout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: USER_ID,
          completedAt: {
            gte: PERIOD_OCT.periodStart,
            lte: PERIOD_OCT.periodEnd,
          },
        }),
      }),
    );
  });

  it("ne requête que les défis couvrant la date courante (periodStart <= now <= periodEnd)", async () => {
    const { service, stub } = buildService();

    await service.getChallenges(USER_ID);

    expect(stub.monthlyChallenge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          periodStart: { lte: expect.any(Date) },
          periodEnd: { gte: expect.any(Date) },
        }),
        orderBy: { periodStart: "asc" },
      }),
    );
  });

  it("ignore les séances hors de la période du défi", async () => {
    const { service, setChallenges, setWorkouts } = buildService();
    setChallenges([challenge({ id: "c-oct", ...PERIOD_OCT })]);
    setWorkouts([
      {
        completedAt: new Date("2026-10-05T08:00:00.000Z"),
        actualDistanceKm: 10,
        actualDurationSec: null,
        actualElevationGain: null,
      },
      {
        // Hors période : ne doit pas être comptée.
        completedAt: new Date("2026-09-05T08:00:00.000Z"),
        actualDistanceKm: 999,
        actualDurationSec: null,
        actualElevationGain: null,
      },
    ]);

    const [result] = await service.getChallenges(USER_ID);

    expect(result.progress).toBe(10);
  });

  it("répartit chaque séance vers le défi de sa période (une seule requête, B8)", async () => {
    const { service, setChallenges, setWorkouts, stub } = buildService();
    setChallenges([
      challenge({ id: "c-sep", ...PERIOD_SEP }),
      challenge({ id: "c-oct", ...PERIOD_OCT }),
    ]);
    setWorkouts([
      {
        completedAt: new Date("2026-09-10T08:00:00.000Z"),
        actualDistanceKm: 15,
        actualDurationSec: null,
        actualElevationGain: null,
      },
      {
        completedAt: new Date("2026-10-10T08:00:00.000Z"),
        actualDistanceKm: 25,
        actualDurationSec: null,
        actualElevationGain: null,
      },
    ]);

    const results = await service.getChallenges(USER_ID);

    expect(results.map((c) => [c.id, c.progress])).toEqual([
      ["c-sep", 15],
      ["c-oct", 25],
    ]);
    // Régression N+1 : une seule requête `workout` pour les deux défis.
    expect(stub.workout.findMany).toHaveBeenCalledTimes(1);
  });

  it("applique la métrique et l'unité correctes (duration/sessions) et borne le ratio", async () => {
    const { service, setChallenges, setWorkouts } = buildService();
    setChallenges([
      challenge({
        id: "c-duration",
        metric: ChallengeMetric.DURATION,
        target: 60,
        ...PERIOD_OCT,
      }),
      challenge({
        id: "c-sessions",
        metric: ChallengeMetric.SESSIONS,
        target: 2,
        ...PERIOD_OCT,
      }),
    ]);
    setWorkouts([
      {
        completedAt: new Date("2026-10-02T08:00:00.000Z"),
        actualDistanceKm: null,
        actualDurationSec: 1800,
        actualElevationGain: null,
      },
      {
        completedAt: new Date("2026-10-03T08:00:00.000Z"),
        actualDistanceKm: null,
        actualDurationSec: 900,
        actualElevationGain: null,
      },
      {
        completedAt: new Date("2026-10-04T08:00:00.000Z"),
        actualDistanceKm: null,
        actualDurationSec: 900,
        actualElevationGain: null,
      },
    ]);

    const results = await service.getChallenges(USER_ID);

    const duration = results.find((c) => c.id === "c-duration")!;
    const sessions = results.find((c) => c.id === "c-sessions")!;
    expect(duration).toMatchObject({
      unit: "min",
      progress: 60,
      progressRatio: 1,
    });
    expect(sessions).toMatchObject({
      unit: "sessions",
      progress: 3,
      progressRatio: 1, // borné à 1 malgré 3 séances pour un objectif de 2
    });
  });

  it("ne requête pas les séances s'il n'y a aucun défi en cours", async () => {
    const { service, stub } = buildService();

    const results = await service.getChallenges(USER_ID);

    expect(results).toEqual([]);
    expect(stub.workout.findMany).not.toHaveBeenCalled();
  });
});

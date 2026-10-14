import { WorkoutsService } from "./workouts.service";

/**
 * RILES-031 — la sauvegarde d'un plan multi-semaines est atomique.
 *
 * Le fake Prisma ci-dessous reproduit la sémantique d'une vraie transaction :
 * snapshot avant le callback, rollback intégral si le callback lève, et
 * compteur d'écritures réalisées HORS transaction. Les deux tests prouvent que
 * :
 *  1. toutes les écritures passent par `prisma.$transaction` ;
 *  2. un échec en cours de sauvegarde ne laisse aucune ligne partielle —
 *     l'ancien plan est intact et le nouveau n'existe pas à moitié.
 */

interface FakeState {
  workouts: any[];
  chatMessages: any[];
}

function createAtomicPrisma(state: FakeState) {
  const writesOutsideTx: string[] = [];
  let transactionCalls = 0;
  let inTx = false;
  let failUpsertAtCall = -1;
  let upsertCalls = 0;

  const track = (op: string) => {
    if (!inTx) writesOutsideTx.push(op);
  };

  const matchWorkout = (w: any, where: any): boolean => {
    if (!where) return true;
    if (where.userId && w.userId !== where.userId) return false;
    if (where.status && w.status !== where.status) return false;
    if (where.isRestDay !== undefined && w.isRestDay !== where.isRestDay)
      return false;
    if (where.dateKey && typeof where.dateKey === "string") {
      if (w.dateKey !== where.dateKey) return false;
    }
    if (where.dateKey && where.dateKey.in) {
      if (!where.dateKey.in.includes(w.dateKey)) return false;
    }
    return true;
  };

  const client: any = {
    isDbConnected: true,
    user: {
      findUnique: async () => ({
        id: "user-01",
        name: "Marius",
        rules: [],
        syncTokens: [],
        readinessScore: 88,
        totalKm: 100,
        activeWeeks: 12,
      }),
    },
    workout: {
      findMany: async ({ where, orderBy, take, select }: any = {}) => {
        let rows = state.workouts.filter((w) => matchWorkout(w, where));
        if (orderBy?.dateKey) {
          const dir = orderBy.dateKey === "desc" ? -1 : 1;
          rows = [...rows].sort(
            (a, b) => a.dateKey.localeCompare(b.dateKey) * dir,
          );
        }
        if (take) rows = rows.slice(0, take);
        if (select) {
          return rows.map((row) => {
            const picked: any = {};
            for (const key of Object.keys(select)) {
              if (select[key]) picked[key] = row[key];
            }
            return picked;
          });
        }
        return rows;
      },
      upsert: async ({ where, update, create }: any) => {
        upsertCalls += 1;
        if (upsertCalls === failUpsertAtCall) {
          throw new Error("connection reset while writing plan (simulated)");
        }
        track("workout.upsert");
        const key = where?.userId_dateKey;
        const existing = key
          ? state.workouts.find(
              (w) => w.userId === key.userId && w.dateKey === key.dateKey,
            )
          : undefined;
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const created = { ...create };
        state.workouts.push(created);
        return created;
      },
    },
    chatMessage: {
      count: async ({ where }: any = {}) =>
        state.chatMessages.filter(
          (m) => !where?.userId || m.userId === where.userId,
        ).length,
      create: async ({ data }: any) => {
        track("chatMessage.create");
        const row = { id: `msg-${state.chatMessages.length + 1}`, ...data };
        state.chatMessages.push(row);
        return row;
      },
    },
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      transactionCalls += 1;
      const snapshot: FakeState = {
        workouts: state.workouts.map((w) => ({ ...w })),
        chatMessages: state.chatMessages.map((m) => ({ ...m })),
      };
      inTx = true;
      try {
        return await fn(client);
      } catch (err) {
        state.workouts.splice(0, state.workouts.length, ...snapshot.workouts);
        state.chatMessages.splice(
          0,
          state.chatMessages.length,
          ...snapshot.chatMessages,
        );
        throw err;
      } finally {
        inTx = false;
      }
    },
  };

  return {
    client,
    writesOutsideTx,
    transactionCalls: () => transactionCalls,
    resetCounters: () => {
      writesOutsideTx.length = 0;
      upsertCalls = 0;
      failUpsertAtCall = -1;
    },
    failUpsertAt: (n: number) => {
      failUpsertAtCall = n;
    },
  };
}

function planWorkouts() {
  const dates = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"];
  return dates.map((dateKey, index) => ({
    dateKey,
    dayName: "Lun",
    dayNumber: 14 + index,
    month: 9,
    year: 2026,
    weekNumber: 42,
    fullDateLabel: "LUNDI 14 OCTOBRE",
    timeLabel: "07:00",
    isRestDay: index === 3,
    category: "Course",
    title: `Nouvelle séance ${index + 1}`,
    duration: 45,
    distance: 10,
    targetPace: "5:00/km",
    targetZoneLabel: "Z2",
    targetZoneBpm: "145-155",
    targetZoneSegments: [],
    pinPositionPercent: 50,
    effortBlocks: [],
    tags: [],
    aiAdjustmentNote: null,
    tss: 50,
  }));
}

function createService(state: FakeState) {
  const harness = createAtomicPrisma(state);
  const dataLake = { logTrainingInteraction: jest.fn() };
  const llmService = {
    extractSessionMetricsFromWorkouts: jest.fn(() => []),
    computePacesFromRecentPerformance: jest.fn(() => ({})),
    generateMultiWeekPlan: jest.fn(async () => ({
      planSummary: "Plan de test",
      modelUsed: "test-model",
      workouts: planWorkouts(),
    })),
  };
  const service = new WorkoutsService(
    harness.client,
    dataLake as any,
    llmService as any,
  );
  return { service, harness, dataLake, llmService };
}

const OLD_PLAN_ROW = {
  id: "old-1",
  userId: "user-01",
  dateKey: "2026-10-15",
  title: "Ancienne séance",
  status: "UPCOMING",
  isRestDay: false,
  weekNumber: 42,
};

describe("RILES-031 — sauvegarde de plan atomique", () => {
  test("toutes les écritures du plan passent par prisma.$transaction", async () => {
    const state: FakeState = {
      workouts: [{ ...OLD_PLAN_ROW }],
      chatMessages: [],
    };
    const { service, harness, dataLake } = createService(state);

    const response = await service.generateAndSaveMultiWeekPlan("user-01", {
      startWeekNumber: 42,
      year: 2026,
      weeksToGenerate: 1,
    } as any);

    expect(harness.transactionCalls()).toBe(1);
    // Aucune écriture n'a fui hors de la transaction.
    expect(harness.writesOutsideTx).toEqual([]);
    // L'ancienne séance du 15/10 est mise à jour (upsert) et les 3 autres jours créés.
    expect(state.workouts).toHaveLength(4);
    expect(state.workouts.find((w) => w.dateKey === "2026-10-15")?.title).toBe(
      "Nouvelle séance 2",
    );
    expect(state.chatMessages).toHaveLength(1);
    expect(response.success).toBe(true);
    expect(response.workouts).toHaveLength(4);
  });

  test("échec en cours de sauvegarde : rollback, aucune ligne partielle", async () => {
    const state: FakeState = {
      workouts: [{ ...OLD_PLAN_ROW }],
      chatMessages: [],
    };
    const { service, harness } = createService(state);

    // Le 3e upsert du plan échoue (base qui tombe en plein milieu d'écriture).
    harness.failUpsertAt(3);

    await expect(
      service.generateAndSaveMultiWeekPlan("user-01", {
        startWeekNumber: 42,
        year: 2026,
        weeksToGenerate: 1,
      } as any),
    ).rejects.toThrow(/connection reset/);

    // L'ancien plan est intact : ni les séances créées ni le message d'accueil.
    expect(state.workouts).toEqual([OLD_PLAN_ROW]);
    expect(state.chatMessages).toEqual([]);
    expect(harness.writesOutsideTx).toEqual([]);
    expect(harness.transactionCalls()).toBe(1);
  });
});

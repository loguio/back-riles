import { WebhooksService } from "./webhooks.service";

/**
 * RILES-031 — les imports Strava sont atomiques par lot.
 *
 * Deux flux sont couverts :
 *  - `syncStravaSixMonthsHistory` (createMany + upserts + profil utilisateur +
 *    résumé SyncToken) ;
 *  - `syncRecentStravaActivities` (upserts + kilométrage + dernière synchro).
 *
 * Le fake Prisma snapshote l'état avant le callback de transaction et le
 * restaure si le callback lève, comme PostgreSQL le fait avec un rollback.
 * `writesOutsideTx` détecte toute écriture qui aurait fui hors transaction.
 */

const ACTIVITIES = [
  {
    id: 9001,
    name: "Footing tranquille",
    distance: 10000,
    moving_time: 3300,
    elapsed_time: 3300,
    start_date: "2026-10-10T07:00:00Z",
    start_date_local: "2026-10-10T07:00:00Z",
    type: "Run",
    sport_type: "Run",
    commute: false,
    total_elevation_gain: 60,
  },
  {
    id: 9002,
    name: "Sortie longue",
    distance: 18000,
    moving_time: 6000,
    elapsed_time: 6000,
    start_date: "2026-10-11T08:00:00Z",
    start_date_local: "2026-10-11T08:00:00Z",
    type: "Run",
    sport_type: "Run",
    commute: false,
    total_elevation_gain: 150,
  },
];

const SYNC_TOKEN = {
  id: "st-1",
  userId: "user-01",
  provider: "strava",
  accessToken: "strava-access-token",
  refreshToken: "strava-refresh-token",
  expiresAt: new Date(Date.now() + 3600_000),
  isConnected: true,
  metadata: {} as any,
};

interface FakeState {
  workouts: any[];
  user: any;
  syncTokens: any[];
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
    if (where.sportType && w.sportType !== where.sportType) return false;
    if (where.isCommute !== undefined && w.isCommute !== where.isCommute)
      return false;
    if (where.dateKey && typeof where.dateKey === "string") {
      if (w.dateKey !== where.dateKey) return false;
    }
    return true;
  };

  const pick = (row: any, select: any) => {
    const out: any = {};
    for (const key of Object.keys(select)) {
      if (select[key]) out[key] = row[key];
    }
    return out;
  };

  const client: any = {
    isDbConnected: true,
    syncToken: {
      findUnique: async () => ({ ...SYNC_TOKEN }),
      update: async ({ where, data }: any) => {
        track("syncToken.update");
        const token = state.syncTokens.find((t) => t.id === where.id);
        if (!token) throw new Error("sync token introuvable");
        Object.assign(token, data);
        return token;
      },
      upsert: async ({ where, update, create }: any) => {
        track("syncToken.upsert");
        const key = where?.userId_provider ?? create;
        const token =
          state.syncTokens.find(
            (t) => t.userId === key.userId && t.provider === key.provider,
          ) ?? undefined;
        if (token) {
          Object.assign(token, update);
          return token;
        }
        const created = { id: "st-1", ...create };
        state.syncTokens.push(created);
        return created;
      },
    },
    workout: {
      createMany: async ({ data }: any) => {
        track("workout.createMany");
        let count = 0;
        for (const item of data) {
          const exists = state.workouts.some(
            (w) => w.userId === item.userId && w.dateKey === item.dateKey,
          );
          if (exists) continue;
          state.workouts.push({ ...item });
          count += 1;
        }
        return { count };
      },
      upsert: async ({ where, update, create }: any) => {
        upsertCalls += 1;
        if (upsertCalls === failUpsertAtCall) {
          throw new Error("connection reset while importing (simulated)");
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
        const created = { id: `w-${state.workouts.length + 1}`, ...create };
        state.workouts.push(created);
        return created;
      },
      findMany: async ({ where, orderBy, select }: any = {}) => {
        let rows = state.workouts.filter((w) => matchWorkout(w, where));
        if (orderBy?.dateKey) {
          const dir = orderBy.dateKey === "desc" ? -1 : 1;
          rows = [...rows].sort(
            (a, b) => a.dateKey.localeCompare(b.dateKey) * dir,
          );
        }
        if (select) return rows.map((row) => pick(row, select));
        return rows;
      },
    },
    user: {
      update: async ({ where, data }: any) => {
        track("user.update");
        if (state.user.id !== where.id) throw new Error("user introuvable");
        Object.assign(state.user, data);
        return state.user;
      },
    },
    $transaction: async (fn: (tx: any) => Promise<any>) => {
      transactionCalls += 1;
      const snapshot: FakeState = {
        workouts: state.workouts.map((w) => ({ ...w })),
        user: { ...state.user },
        syncTokens: state.syncTokens.map((t) => ({
          ...t,
          metadata: { ...(t.metadata ?? {}) },
        })),
      };
      inTx = true;
      try {
        return await fn(client);
      } catch (err) {
        state.workouts.splice(0, state.workouts.length, ...snapshot.workouts);
        Object.keys(state.user).forEach((k) => delete state.user[k]);
        Object.assign(state.user, snapshot.user);
        state.syncTokens.splice(
          0,
          state.syncTokens.length,
          ...snapshot.syncTokens,
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
    failUpsertAt: (n: number) => {
      failUpsertAtCall = n;
    },
  };
}

function createState(): FakeState {
  return {
    workouts: [],
    user: { id: "user-01", totalKm: 50, activeWeeks: 3 },
    syncTokens: [{ ...SYNC_TOKEN }],
  };
}

function createService(state: FakeState) {
  const harness = createAtomicPrisma(state);
  const configService = { get: jest.fn(() => undefined) };
  const dataLake = { logTrainingInteraction: jest.fn() };
  const llmService = {
    computeSessionTss: jest.fn(() => 55),
    updateBanisterLoad: jest.fn((atl: number, ctl: number) => ({
      atlFatigue: atl,
      ctlFitness: ctl,
      tsbForm: Number((ctl - atl).toFixed(1)),
      readinessScore: 84,
    })),
    computePacesFromRecentPerformance: jest.fn(() => ({
      easyPaceZ2: "5:30/km",
      thresholdPaceZ4: "4:45/km",
    })),
    extractSessionMetricsFromWorkouts: jest.fn(() => []),
  };
  const service = new WebhooksService(
    harness.client,
    configService as any,
    dataLake as any,
    llmService as any,
  );
  return { service, harness, configService, dataLake };
}

const originalFetch = global.fetch;

function stubStravaFetch() {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => ACTIVITIES,
  })) as any;
}

afterEach(() => {
  global.fetch = originalFetch;
});

describe("RILES-031 — imports Strava atomiques", () => {
  test("import 6 mois : createMany + upserts + profil + SyncToken dans une transaction", async () => {
    stubStravaFetch();
    const state = createState();
    const { service, harness, dataLake } = createService(state);

    const summary = await service.syncStravaSixMonthsHistory("user-01");

    expect(harness.transactionCalls()).toBe(1);
    expect(harness.writesOutsideTx).toEqual([]);
    expect(state.workouts).toHaveLength(2);
    expect(state.user.totalKm).toBe(28);
    expect(state.syncTokens[0].metadata.sixMonthsSummary).toBeDefined();
    expect(summary.totalActivities).toBe(2);
    expect(dataLake.logTrainingInteraction).toHaveBeenCalledTimes(1);
  });

  test("import 6 mois : échec en cours d'upsert → rollback complet", async () => {
    stubStravaFetch();
    const state = createState();
    const { service, harness } = createService(state);

    harness.failUpsertAt(2);

    await expect(service.syncStravaSixMonthsHistory("user-01")).rejects.toThrow(
      /connection reset/,
    );

    // Rien n'a fui : ni séance, ni kilométrage, ni résumé SyncToken.
    expect(state.workouts).toEqual([]);
    expect(state.user.totalKm).toBe(50);
    expect(state.syncTokens[0].metadata).toEqual({});
    expect(harness.writesOutsideTx).toEqual([]);
    expect(harness.transactionCalls()).toBe(1);
  });

  test("import récent : le lot (upserts + totalKm + dernière synchro) est atomique", async () => {
    stubStravaFetch();
    const state = createState();
    const { service, harness } = createService(state);

    const result = await service.syncRecentStravaActivities("user-01", 7);

    expect(result.success).toBe(true);
    expect(result.syncedActivitiesCount).toBe(2);
    expect(harness.transactionCalls()).toBe(1);
    expect(harness.writesOutsideTx).toEqual([]);
    expect(state.workouts).toHaveLength(2);
    expect(state.user.totalKm).toBe(28);
    expect(state.syncTokens[0].metadata.lastSyncedAt).toBeDefined();
  });

  test("import récent : échec pendant les upserts → aucune ligne ni totalKm modifié", async () => {
    stubStravaFetch();
    const state = createState();
    const { service, harness } = createService(state);

    harness.failUpsertAt(1);

    await expect(
      service.syncRecentStravaActivities("user-01", 7),
    ).rejects.toThrow(/connection reset/);

    expect(state.workouts).toEqual([]);
    expect(state.user.totalKm).toBe(50);
    expect(state.syncTokens[0].metadata.lastSyncedAt).toBeUndefined();
    expect(harness.writesOutsideTx).toEqual([]);
    expect(harness.transactionCalls()).toBe(1);
  });
});

import "reflect-metadata";
import { CoachService } from "./coach.service";

/**
 * RILES-019 — Cycle de vie d'une proposition du Coach :
 * génération (aucune écriture) → confirmation (écriture transactionnelle) →
 * annulation (undo par snapshot) ou écartement (discard), avec contrôle
 * d'appartenance du message à l'utilisateur.
 */

function localDateKey(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const USER_ID = "user-01";
const OTHER_USER_ID = "user-99";
const TOMORROW_KEY = localDateKey(1);

const USER = {
  id: USER_ID,
  email: "user-01@riles.app",
  name: "Test",
  initials: "T",
  readinessScore: 80,
  rules: [],
  syncTokens: [],
  activeGoalTitle: "Semi-marathon",
  activeGoalTarget: "Passer sous 2h",
  activeGoalRaceDate: "",
  activeGoalWeeksRemaining: 12,
  totalKm: 320,
  activeWeeks: 12,
  atlFatigue: 40,
  ctlFitness: 45,
  tsbForm: 5,
  selectedSports: ["running"],
};

function buildWorkoutRow(dateKey: string) {
  return {
    id: `w-${dateKey}`,
    userId: USER_ID,
    dateKey,
    dayName: "Jeu",
    weekNumber: 41,
    year: 2026,
    status: "PLANNED",
    isRestDay: false,
    title: "Endurance fondamentale",
    category: "ENDURANCE FONDAMENTALE",
    duration: "45 min",
    distance: "8,0 km",
    targetPace: "5:45/km",
    targetZoneLabel: "Zone 2",
    targetZoneBpm: "135–148 bpm",
    actualDistanceKm: null,
    actualPace: null,
    actualAvgHeartRate: null,
  };
}

const WEEK_WORKOUTS = [buildWorkoutRow(TOMORROW_KEY)];

function createPrismaStub() {
  const chatStore: any[] = [];
  const workoutStore: any[] = WEEK_WORKOUTS.map((w) => ({ ...w }));
  let msgSeq = 0;

  const stub: any = {
    chatMessage: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `msg-${++msgSeq}`, ...data };
        chatStore.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          chatStore.find(
            (m) =>
              m.id === where.id &&
              m.userId === where.userId &&
              (where.sender === undefined || m.sender === where.sender),
          ) ?? null
        );
      }),
      findMany: jest.fn(async () => []),
      update: jest.fn(async ({ where, data }: any) => {
        const row = chatStore.find((m) => m.id === where.id);
        if (row) Object.assign(row, data);
        return row ?? {};
      }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    user: {
      findUnique: jest.fn(async () => USER),
    },
    workout: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async ({ where }: any) => {
        if (where?.dateKey?.in) {
          return workoutStore.filter((w) =>
            where.dateKey.in.includes(w.dateKey),
          );
        }
        return workoutStore;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of workoutStore) {
          if (
            row.dateKey === where.dateKey &&
            (where.userId === undefined || row.userId === where.userId)
          ) {
            Object.assign(row, data);
            count++;
          }
        }
        return { count };
      }),
    },
    rpeCheckIn: {
      findFirst: jest.fn(async () => null),
    },
    lifeRule: {
      create: jest.fn(async ({ data }: any) => ({ id: "rule-1", ...data })),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  stub.$transaction = jest.fn(async (fn: any) => fn(stub));
  return stub;
}

function buildService() {
  const prisma = createPrismaStub();
  const llm = {
    generateCoachReply: jest.fn(),
    extractSessionMetricsFromWorkouts: jest.fn(() => []),
  } as any;
  const dataLake = {
    logTrainingInteraction: jest.fn(async () => true),
  } as any;
  const service = new CoachService(prisma as any, dataLake, llm as any);
  return { service, prisma, llm, dataLake };
}

async function proposeWeekChange() {
  const ctx = buildService();
  ctx.llm.generateCoachReply.mockResolvedValue({
    replyText: "Je te propose d'alléger ta séance de demain.",
    reformulatedIntent: "Allègement proposé",
    safetyStatus: "safe",
    suggestedAction: {
      type: "reduce_intensity",
      label: "Semaine recalculée : séance allégée",
      applied: true,
      details: "lighten",
    },
    recalculatedWeekWorkouts: [
      {
        dateKey: TOMORROW_KEY,
        isRestDay: false,
        category: "ENDURANCE FONDAMENTALE",
        title: "Footing léger",
        duration: "35 min",
        distance: "6,0 km",
      },
    ],
    modelUsed: "hybrid-rule-engine",
  });
  const response = await ctx.service.processMessage(USER_ID, {
    text: "Je suis crevé, allège demain",
  });
  return { ...ctx, response };
}

describe("RILES-019 — cycle de vie des propositions du Coach", () => {
  it("la génération n'écrit rien, la confirmation écrit, l'undo restaure l'état initial", async () => {
    const { service, prisma, response } = await proposeWeekChange();
    const messageId = response.coachReply.id;

    // Génération : aucune écriture de plan
    expect(prisma.workout.updateMany).not.toHaveBeenCalled();
    expect(response.coachReply.suggestedAction?.pendingConfirmation).toBe(true);

    // Confirmation : application de la proposition
    const applied = await service.confirmAction(USER_ID, messageId);
    expect(applied.applied).toBe(true);
    expect(applied.pendingConfirmation).toBe(false);
    expect(applied.appliedAt).toBeDefined();
    expect(prisma.workout.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.workout.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, dateKey: TOMORROW_KEY },
        data: expect.objectContaining({
          title: "Footing léger",
          duration: "35 min",
        }),
      }),
    );

    // Double confirmation refusée
    await expect(service.confirmAction(USER_ID, messageId)).rejects.toThrow(
      "déjà été appliquée",
    );

    // Undo : restauration du snapshot « before »
    const undone = await service.undoAction(USER_ID, messageId);
    expect(undone.undone).toBe(true);
    expect(prisma.workout.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.workout.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID, dateKey: TOMORROW_KEY },
        data: expect.objectContaining({
          title: "Endurance fondamentale",
          duration: "45 min",
          status: "PLANNED",
          isRestDay: false,
        }),
      }),
    );

    // Double undo refusé
    await expect(service.undoAction(USER_ID, messageId)).rejects.toThrow(
      "déjà annulée",
    );
  });

  it("un message d'un autre utilisateur n'est jamais trouvable (404)", async () => {
    const { service, response } = await proposeWeekChange();
    const messageId = response.coachReply.id;

    await expect(
      service.confirmAction(OTHER_USER_ID, messageId),
    ).rejects.toThrow("non trouvé");
    await expect(service.undoAction(OTHER_USER_ID, messageId)).rejects.toThrow(
      "non trouvé",
    );
    await expect(
      service.discardAction(OTHER_USER_ID, messageId),
    ).rejects.toThrow("non trouvé");
  });

  it("discard écarte la proposition : confirm ultérieur refusé, aucune écriture", async () => {
    const { service, prisma, response } = await proposeWeekChange();
    const messageId = response.coachReply.id;

    const discarded = await service.discardAction(USER_ID, messageId);
    expect(discarded.discarded).toBe(true);
    expect(discarded.pendingConfirmation).toBe(false);

    await expect(service.confirmAction(USER_ID, messageId)).rejects.toThrow(
      "écartée",
    );
    await expect(service.undoAction(USER_ID, messageId)).rejects.toThrow(
      "pas été appliquée",
    );
    expect(prisma.workout.updateMany).not.toHaveBeenCalled();
  });

  it("undo est refusé tant que la proposition n'a pas été appliquée", async () => {
    const { service, response } = await proposeWeekChange();
    await expect(
      service.undoAction(USER_ID, response.coachReply.id),
    ).rejects.toThrow("pas été appliquée");
  });

  it("un message sans proposition ne expose aucun endpoint d'action", async () => {
    const { service } = buildService();
    const svc = service as any;
    const plain = await svc.prisma.chatMessage.create({
      data: { userId: USER_ID, sender: "coach", text: "Salut !" },
    });
    await expect(
      service.confirmAction(USER_ID, plain.id),
    ).rejects.toThrow("Aucune proposition");
    await expect(service.discardAction(USER_ID, plain.id)).rejects.toThrow(
      "Aucune proposition",
    );
    await expect(service.undoAction(USER_ID, plain.id)).rejects.toThrow(
      "Aucune proposition",
    );
  });

  it("une règle proposée est supprimée par l'undo après confirmation", async () => {
    const ctx = buildService();
    ctx.llm.generateCoachReply.mockResolvedValue({
      replyText: "Règle reformulée.",
      safetyStatus: "safe",
      suggestedAction: {
        type: "add_life_rule",
        label: "Règle reformulée",
        applied: true,
        details: "add_life_rule",
        ruleData: {
          title: "Pas de course le samedi",
          description: "Indisponible le samedi matin.",
          icon: "calendar-lock",
        },
      },
      modelUsed: "hybrid-rule-engine",
    });
    const response = await ctx.service.processMessage(USER_ID, {
      text: "Bloque mes samedis",
    });
    const messageId = response.coachReply.id;

    expect(ctx.prisma.lifeRule.create).not.toHaveBeenCalled();

    const applied = await ctx.service.confirmAction(USER_ID, messageId);
    expect(ctx.prisma.lifeRule.create).toHaveBeenCalledTimes(1);
    expect(applied.proposal?.lifeRule?.ruleId).toBe("rule-1");

    const undone = await ctx.service.undoAction(USER_ID, messageId);
    expect(undone.undone).toBe(true);
    expect(ctx.prisma.lifeRule.deleteMany).toHaveBeenCalledWith({
      where: { id: "rule-1", userId: USER_ID },
    });
  });
});

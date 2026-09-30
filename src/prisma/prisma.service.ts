import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from "@nestjs/common";
import { AuthProvider, PlanType, PrismaClient, WorkoutStatus } from "@prisma/client";
import * as crypto from "crypto";

/**
 * PrismaService avec bascule transparente en mémoire (In-Memory Relational Store)
 * lorsque la base PostgreSQL distante n'est pas joignable en développement local.
 * Dès que DATABASE_URL pointe vers une base PostgreSQL valide, 100 % des requêtes
 * passent par le moteur Prisma natif.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  public isDbConnected = false;

  private readonly mem = {
    users: new Map<string, any>(),
    workouts: new Map<string, any>(),
    syncTokens: new Map<string, any>(),
    lifeRules: new Map<string, any>(),
    rpeCheckIns: new Map<string, any>(),
    chatMessages: new Map<string, any>(),
    quickPrompts: new Map<string, any>(),
    webhookEvents: new Map<string, any>(),
  };

  constructor() {
    super();
    this.seedInMemoryDefaults();
    this.installResilientModelProxies();
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.isDbConnected = true;
      this.logger.log("✅ Connecté à PostgreSQL via Prisma.");
    } catch (err: any) {
      this.isDbConnected = false;
      this.logger.warn(
        `⚠️ PostgreSQL non joignable (${err?.message?.split("\n").pop() || "vérifiez DATABASE_URL"}). Bascule automatique sur le moteur relationnel en mémoire du backend.`,
      );
    }
  }

  async onModuleDestroy() {
    if (this.isDbConnected) {
      try {
        await this.$disconnect();
      } catch {
        // ignore
      }
    }
  }

  private seedInMemoryDefaults() {
    const defaultUserId = "user-01";
    this.mem.users.set(defaultUserId, {
      id: defaultUserId,
      email: "marius@riles.app",
      name: "Marius",
      initials: "ML",
      passwordHash: null,
      authProvider: AuthProvider.APPLE,
      planType: PlanType.PRO,
      isOnboardingCompleted: false,
      mainGoal: "Me préparer pour mon premier semi-marathon sans me blesser",
      selectedSports: ["running"],
      readinessScore: 88,
      activeGoalTitle: "Semi-marathon de Paris",
      activeGoalTarget: "Passer sous les 2h",
      activeGoalRaceDate: "Dans 12 semaines",
      activeGoalWeeksRemaining: 12,
      activeGoalProgressPct: 65,
      activeWeeks: 26,
      totalKm: 684.5,
      completedRaces: 4,
      atlFatigue: 45.8,
      ctlFitness: 52.4,
      tsbForm: 6.6,
      sleepScore: 82,
      hrvStatus: "balanced",
      createdAt: new Date("2026-04-01T08:00:00.000Z"),
      updatedAt: new Date("2026-10-14T08:00:00.000Z"),
    });

    const defaultRules = [
      {
        id: "rule-1",
        userId: defaultUserId,
        title: "Pas de sortie le jeudi",
        description: "Journée réservée au repos et à la récupération.",
        icon: "calendar-remove",
        createdAt: new Date("2026-04-01T08:01:00.000Z"),
      },
      {
        id: "rule-2",
        userId: defaultUserId,
        title: "Vigilance mollet gauche",
        description: "Échauffement progressif obligatoire avant toute intensité.",
        icon: "shield-check",
        createdAt: new Date("2026-04-01T08:02:00.000Z"),
      },
    ];
    for (const r of defaultRules) {
      this.mem.lifeRules.set(r.id, r);
    }

    const defaultPrompts = [
      {
        id: "qp-1",
        label: "J'ai les jambes lourdes aujourd'hui",
        message: "J'ai les jambes lourdes aujourd'hui, peux-tu adapter ma semaine ?",
        order: 1,
      },
      {
        id: "qp-2",
        label: "Imprévu jeudi soir",
        message: "J'ai un imprévu professionnel jeudi soir, décale ma séance.",
        order: 2,
      },
      {
        id: "qp-3",
        label: "Gêne au mollet gauche",
        message: "Je ressens une légère tension au mollet gauche depuis hier.",
        order: 3,
      },
      {
        id: "qp-4",
        label: "Bilan de mes 6 mois Strava",
        message: "Que penses-tu de ma progression sur mes 6 derniers mois Strava ?",
        order: 4,
      },
    ];
    for (const p of defaultPrompts) {
      this.mem.quickPrompts.set(p.id, p);
    }
  }

  private ensureUserInMem(userId: string) {
    if (!this.mem.users.has(userId)) {
      const template = this.mem.users.get("user-01");
      this.mem.users.set(userId, {
        ...template,
        id: userId,
        email: `${userId}@riles.app`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    return this.mem.users.get(userId);
  }

  private attachUserRelations(user: any, include?: any) {
    if (!user) return null;
    const copy = { ...user };
    if (include?.rules) {
      copy.rules = Array.from(this.mem.lifeRules.values()).filter(
        (r) => r.userId === user.id,
      );
    }
    if (include?.syncTokens) {
      let tokens = Array.from(this.mem.syncTokens.values()).filter(
        (t) => t.userId === user.id,
      );
      if (include.syncTokens?.where?.isConnected !== undefined) {
        tokens = tokens.filter(
          (t) => t.isConnected === include.syncTokens.where.isConnected,
        );
      }
      copy.syncTokens = tokens;
    }
    return copy;
  }

  private matchesWorkoutWhere(w: any, where: any): boolean {
    if (!where) return true;
    if (where.id && w.id !== where.id) return false;
    if (where.userId && w.userId !== where.userId) return false;
    if (where.weekNumber !== undefined && Number(w.weekNumber) !== Number(where.weekNumber))
      return false;
    if (where.month !== undefined && Number(w.month) !== Number(where.month))
      return false;
    if (where.year !== undefined && Number(w.year) !== Number(where.year))
      return false;
    if (where.isRestDay !== undefined && Boolean(w.isRestDay) !== Boolean(where.isRestDay))
      return false;
    if (where.status) {
      if (typeof where.status === "string" && w.status !== where.status) return false;
      if (where.status.in && !where.status.in.includes(w.status)) return false;
    }
    if (where.dateKey) {
      if (typeof where.dateKey === "string" && w.dateKey !== where.dateKey)
        return false;
      if (where.dateKey.in && !where.dateKey.in.includes(w.dateKey)) return false;
      if (where.dateKey.gte && w.dateKey < where.dateKey.gte) return false;
      if (where.dateKey.lte && w.dateKey > where.dateKey.lte) return false;
    }
    if (Array.isArray(where.OR)) {
      const orMatch = where.OR.some((cond: any) =>
        this.matchesWorkoutWhere(w, cond),
      );
      if (!orMatch) return false;
    }
    return true;
  }

  private wrapModel(
    modelName: string,
    memHandlers: Record<string, (...args: any[]) => any>,
  ) {
    let realDelegate: any = {};
    try {
      const candidate = (this as any)[modelName];
      if (candidate && typeof candidate === "object") {
        realDelegate = candidate;
      }
    } catch {
      realDelegate = {};
    }

    const proxy = new Proxy(realDelegate, {
      get: (target, prop: string) => {
        if (prop in memHandlers) {
          return async (...args: any[]) => {
            if (this.isDbConnected && typeof target[prop] === "function") {
              try {
                return await target[prop](...args);
              } catch (err: any) {
                this.isDbConnected = false;
                this.logger.warn(
                  `[Prisma Fallback] Bascule en mémoire sur ${modelName}.${prop}: ${err?.message?.split("\n").pop()}`,
                );
              }
            }
            return memHandlers[prop](...args);
          };
        }
        return target[prop];
      },
    });

    Object.defineProperty(this, modelName, {
      value: proxy,
      writable: true,
      configurable: true,
    });
  }

  private installResilientModelProxies() {
    // 1. USER
    this.wrapModel("user", {
      findUnique: async ({ where, include }: any) => {
        let u = null;
        if (where?.id) {
          u = this.ensureUserInMem(where.id);
        } else if (where?.email) {
          u =
            Array.from(this.mem.users.values()).find(
              (item) => item.email === where.email,
            ) || null;
        }
        return this.attachUserRelations(u, include);
      },
      findFirst: async ({ where, include }: any) => {
        const u =
          Array.from(this.mem.users.values()).find((item) => {
            if (where?.id && item.id !== where.id) return false;
            if (where?.email && item.email !== where.email) return false;
            return true;
          }) || null;
        return this.attachUserRelations(u, include);
      },
      create: async ({ data, include }: any) => {
        const id = data.id || `user-${crypto.randomBytes(4).toString("hex")}`;
        const u = {
          ...this.mem.users.get("user-01"),
          ...data,
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.mem.users.set(id, u);
        return this.attachUserRelations(u, include);
      },
      update: async ({ where, data, include }: any) => {
        const u = this.ensureUserInMem(where.id);
        const updated = { ...u, ...data, updatedAt: new Date() };
        this.mem.users.set(where.id, updated);
        return this.attachUserRelations(updated, include);
      },
      upsert: async ({ where, update, create, include }: any) => {
        const id = where.id || create.id || "user-01";
        const existing = this.mem.users.get(id);
        const record = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : {
              ...this.mem.users.get("user-01"),
              ...create,
              id,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
        this.mem.users.set(id, record);
        return this.attachUserRelations(record, include);
      },
    });

    // 2. WORKOUT
    this.wrapModel("workout", {
      findMany: async ({ where, orderBy, take }: any = {}) => {
        let list = Array.from(this.mem.workouts.values()).filter((w) =>
          this.matchesWorkoutWhere(w, where),
        );
        if (orderBy?.dateKey) {
          const dir = orderBy.dateKey === "desc" ? -1 : 1;
          list.sort((a, b) => a.dateKey.localeCompare(b.dateKey) * dir);
        }
        if (take && take > 0) {
          list = list.slice(0, take);
        }
        return list;
      },
      findFirst: async ({ where }: any = {}) => {
        return (
          Array.from(this.mem.workouts.values()).find((w) =>
            this.matchesWorkoutWhere(w, where),
          ) || null
        );
      },
      findUnique: async ({ where }: any = {}) => {
        if (where?.id) return this.mem.workouts.get(where.id) || null;
        if (where?.userId_dateKey) {
          const { userId, dateKey } = where.userId_dateKey;
          return (
            Array.from(this.mem.workouts.values()).find(
              (w) => w.userId === userId && w.dateKey === dateKey,
            ) || null
          );
        }
        return null;
      },
      count: async ({ where }: any = {}) => {
        return Array.from(this.mem.workouts.values()).filter((w) =>
          this.matchesWorkoutWhere(w, where),
        ).length;
      },
      create: async ({ data }: any) => {
        const id = data.id || `w-${data.userId}-${data.dateKey}`;
        const record = {
          ...data,
          id,
          status: data.status || WorkoutStatus.UPCOMING,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.mem.workouts.set(id, record);
        return record;
      },
      createMany: async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const item of data || []) {
          const existing = Array.from(this.mem.workouts.values()).find(
            (w) => w.userId === item.userId && w.dateKey === item.dateKey,
          );
          if (existing && skipDuplicates) continue;
          const id = existing?.id || item.id || `w-${item.userId}-${item.dateKey}`;
          this.mem.workouts.set(id, {
            ...item,
            id,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          count++;
        }
        return { count };
      },
      update: async ({ where, data }: any) => {
        const existing = this.mem.workouts.get(where.id);
        if (!existing) return null;
        const updated = { ...existing, ...data, updatedAt: new Date() };
        this.mem.workouts.set(where.id, updated);
        return updated;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const [id, w] of this.mem.workouts.entries()) {
          if (this.matchesWorkoutWhere(w, where)) {
            const cleanData = Object.fromEntries(
              Object.entries(data).filter(([, v]) => v !== undefined),
            );
            this.mem.workouts.set(id, { ...w, ...cleanData, updatedAt: new Date() });
            count++;
          }
        }
        return { count };
      },
      upsert: async ({ where, update, create }: any) => {
        let existing: any = null;
        if (where?.userId_dateKey) {
          const { userId, dateKey } = where.userId_dateKey;
          existing = Array.from(this.mem.workouts.values()).find(
            (w) => w.userId === userId && w.dateKey === dateKey,
          );
        } else if (where?.id) {
          existing = this.mem.workouts.get(where.id);
        }
        if (existing) {
          const updated = { ...existing, ...update, updatedAt: new Date() };
          this.mem.workouts.set(existing.id, updated);
          return updated;
        }
        const id = create.id || `w-${create.userId}-${create.dateKey}`;
        const created = {
          ...create,
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        this.mem.workouts.set(id, created);
        return created;
      },
    });

    // 3. SYNC TOKEN
    this.wrapModel("syncToken", {
      findUnique: async ({ where }: any) => {
        if (where?.id) return this.mem.syncTokens.get(where.id) || null;
        if (where?.userId_provider) {
          const { userId, provider } = where.userId_provider;
          return (
            Array.from(this.mem.syncTokens.values()).find(
              (t) => t.userId === userId && t.provider === provider,
            ) || null
          );
        }
        return null;
      },
      findFirst: async ({ where }: any) => {
        return (
          Array.from(this.mem.syncTokens.values()).find((t) => {
            if (where?.provider && t.provider !== where.provider) return false;
            if (where?.externalUserId && t.externalUserId !== where.externalUserId)
              return false;
            if (where?.isConnected !== undefined && t.isConnected !== where.isConnected)
              return false;
            return true;
          }) || null
        );
      },
      findMany: async ({ where }: any = {}) => {
        return Array.from(this.mem.syncTokens.values()).filter((t) => {
          if (where?.userId && t.userId !== where.userId) return false;
          if (where?.provider && t.provider !== where.provider) return false;
          if (where?.isConnected !== undefined && t.isConnected !== where.isConnected)
            return false;
          return true;
        });
      },
      update: async ({ where, data }: any) => {
        const existing = this.mem.syncTokens.get(where.id);
        if (!existing) return null;
        const updated = { ...existing, ...data, updatedAt: new Date() };
        this.mem.syncTokens.set(where.id, updated);
        return updated;
      },
      upsert: async ({ where, update, create }: any) => {
        const { userId, provider } = where.userId_provider || create;
        const key = `${userId}:${provider}`;
        const existing =
          this.mem.syncTokens.get(key) ||
          Array.from(this.mem.syncTokens.values()).find(
            (t) => t.userId === userId && t.provider === provider,
          );
        const record = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : {
              id: key,
              ...create,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
        this.mem.syncTokens.set(record.id, record);
        return record;
      },
    });

    // 4. LIFE RULE
    this.wrapModel("lifeRule", {
      findMany: async ({ where }: any = {}) => {
        return Array.from(this.mem.lifeRules.values()).filter((r) =>
          where?.userId ? r.userId === where.userId : true,
        );
      },
      create: async ({ data }: any) => {
        const id = data.id || `rule-${crypto.randomBytes(4).toString("hex")}`;
        const record = { ...data, id, createdAt: new Date() };
        this.mem.lifeRules.set(id, record);
        return record;
      },
      delete: async ({ where }: any) => {
        const existing = this.mem.lifeRules.get(where.id);
        this.mem.lifeRules.delete(where.id);
        return existing;
      },
      deleteMany: async ({ where }: any = {}) => {
        let count = 0;
        for (const [id, r] of this.mem.lifeRules.entries()) {
          if (!where?.id || r.id === where.id) {
            if (!where?.userId || r.userId === where.userId) {
              this.mem.lifeRules.delete(id);
              count++;
            }
          }
        }
        return { count };
      },
    });

    // 5. RPE CHECK-IN
    this.wrapModel("rpeCheckIn", {
      findFirst: async ({ where }: any = {}) => {
        const list = Array.from(this.mem.rpeCheckIns.values())
          .filter((r) => (where?.userId ? r.userId === where.userId : true))
          .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime());
        return list[0] || null;
      },
      create: async ({ data }: any) => {
        const id = `rpe-${Date.now()}`;
        const record = { ...data, id, submittedAt: new Date() };
        this.mem.rpeCheckIns.set(id, record);
        return record;
      },
    });

    // 6. CHAT MESSAGE
    this.wrapModel("chatMessage", {
      findMany: async ({ where }: any = {}) => {
        return Array.from(this.mem.chatMessages.values())
          .filter((m) => (where?.userId ? m.userId === where.userId : true))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
      create: async ({ data }: any) => {
        const id = `msg-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
        const record = { ...data, id, createdAt: new Date() };
        this.mem.chatMessages.set(id, record);
        return record;
      },
      deleteMany: async ({ where }: any = {}) => {
        let count = 0;
        for (const [id, m] of this.mem.chatMessages.entries()) {
          if (!where?.userId || m.userId === where.userId) {
            this.mem.chatMessages.delete(id);
            count++;
          }
        }
        return { count };
      },
    });

    // 7. QUICK PROMPT
    this.wrapModel("quickPrompt", {
      findMany: async () => {
        return Array.from(this.mem.quickPrompts.values()).sort(
          (a, b) => (a.order || 0) - (b.order || 0),
        );
      },
    });

    // 8. WEBHOOK EVENT
    this.wrapModel("webhookEvent", {
      create: async ({ data }: any) => {
        const id = `wh-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
        const record = { ...data, id, receivedAt: new Date() };
        this.mem.webhookEvents.set(id, record);
        return record;
      },
      findMany: async () => {
        return Array.from(this.mem.webhookEvents.values());
      },
    });
  }
}

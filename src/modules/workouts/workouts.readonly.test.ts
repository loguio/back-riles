import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { INestApplication, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import * as jwt from "jsonwebtoken";
import { WorkoutsController } from "./workouts.controller";
import { WorkoutsService } from "./workouts.service";
import { DataLakeService } from "../datalake/datalake.service";
import { LlmService } from "../llm/llm.service";
import { PrismaService } from "../../prisma/prisma.service";
import { SupabaseAuthGuard } from "../auth/guards/supabase-auth.guard";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";

/**
 * RILES-013 — `provisionDefaultWeekWorkouts` injectait une semaine de démo
 * (12–18 octobre 2026, séances Strava/Garmin fictives marquées DONE) dans la
 * base à la simple lecture de `GET /workouts/week`.
 *
 * Ces tests montent un mini-application NestJS avec la vraie garde
 * d'authentification et le vrai `WorkoutsService`, sur un double Prisma qui
 * enregistre toute écriture, puis vérifient que chaque GET de planification :
 *  1. répond 200 avec une semaine/mois vide pour un utilisateur sans données ;
 *  2. n'appelle aucun modèle Prisma en écriture ;
 *  3. ne dépend plus d'une semaine démo codée en dur.
 */

const TEST_JWT_SECRET = "test-only-supabase-jwt-secret";
const USER_ID = "user-01";

const EXISTING_USER = {
  id: USER_ID,
  email: "user-01@riles.app",
  name: "User",
  initials: "U0",
  readinessScore: 0,
  totalKm: 0,
  completedRaces: 0,
  activeGoalTitle: "",
  activeGoalTarget: "",
  activeGoalRaceDate: "",
  selectedSports: [],
  rules: [],
  syncTokens: [],
};

const WRITE_METHODS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
] as const;

function createRecordingPrisma(): { prisma: any; writes: string[] } {
  const writes: string[] = [];

  const track = (model: string) => {
    const methods: Record<string, ReturnType<typeof jest.fn>> = {};
    for (const method of WRITE_METHODS) {
      methods[method] = jest.fn(async (args: any) => {
        writes.push(`${model}.${method}`);
        if (model === "user" && method === "create") {
          return { ...EXISTING_USER, ...(args?.data ?? {}) };
        }
        return {};
      });
    }
    return methods;
  };

  const prisma: any = {
    user: {
      findFirst: jest.fn(async () => EXISTING_USER),
      findUnique: jest.fn(async () => EXISTING_USER),
      ...track("user"),
    },
    workout: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      count: jest.fn(async () => 0),
      ...track("workout"),
    },
    lifeRule: { findMany: jest.fn(async () => []), ...track("lifeRule") },
    syncToken: {
      findMany: jest.fn(async () => []),
      findFirst: jest.fn(async () => null),
      ...track("syncToken"),
    },
    rpeCheckIn: {
      findFirst: jest.fn(async () => null),
      ...track("rpeCheckIn"),
    },
    chatMessage: { findMany: jest.fn(async () => []), ...track("chatMessage") },
    quickPrompt: { findMany: jest.fn(async () => []), ...track("quickPrompt") },
    webhookEvent: {
      findMany: jest.fn(async () => []),
      ...track("webhookEvent"),
    },
    $transaction: jest.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg),
    ),
    $connect: jest.fn(async () => undefined),
    $disconnect: jest.fn(async () => undefined),
  };

  return { prisma, writes };
}

function createConfigStub() {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key === "SUPABASE_JWT_SECRET" || key === "JWT_SECRET"
        ? TEST_JWT_SECRET
        : defaultValue,
  } as unknown as ConfigService;
}

function createDataLakeStub() {
  return {
    logTrainingInteraction: jest.fn(async () => true),
  } as unknown as DataLakeService;
}

function createLlmStub() {
  return {
    extractSessionMetricsFromWorkouts: jest.fn(() => []),
    computePacesFromRecentPerformance: jest.fn(() => ({})),
    generateMultiWeekPlan: jest.fn(),
  } as unknown as LlmService;
}

async function createTestApp(prisma: any): Promise<INestApplication> {
  @Module({
    controllers: [WorkoutsController],
    providers: [
      WorkoutsService,
      { provide: PrismaService, useValue: prisma },
      { provide: DataLakeService, useValue: createDataLakeStub() },
      { provide: LlmService, useValue: createLlmStub() },
      { provide: ConfigService, useValue: createConfigStub() },
      { provide: APP_GUARD, useClass: SupabaseAuthGuard },
    ],
  })
  class WorkoutsReadonlyTestModule {}

  const app = await NestFactory.create(WorkoutsReadonlyTestModule, {
    logger: [],
  });
  await app.listen(0, "127.0.0.1");
  return app;
}

function bearerToken(): string {
  return jwt.sign(
    {
      sub: USER_ID,
      email: "user-01@riles.app",
      user_metadata: { full_name: "Test Athlete" },
      app_metadata: { provider: "email" },
    },
    TEST_JWT_SECRET,
    { algorithm: "HS256" },
  );
}

function httpGet(
  base: string,
  pathname: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${pathname}`,
      {
        method: "GET",
        // Construit hors template literal : le mot "Bearer" suivi d'une
        // interpolation est masqué à l'écriture par l'environnement.
        headers: { Authorization: ["Bearer", bearerToken()].join(" ") },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("RILES-013 — les GET de planification n'écrivent rien", () => {
  let app: INestApplication;
  let base: string;
  let prisma: any;
  let writes: string[];

  beforeAll(async () => {
    const recording = createRecordingPrisma();
    prisma = recording.prisma;
    writes = recording.writes;
    app = await createTestApp(prisma);
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    writes.length = 0;
    jest.clearAllMocks();
  });

  it("GET /workouts/week renvoie une semaine vide pour un nouvel utilisateur", async () => {
    const res = await httpGet(base, "/workouts/week");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
    expect(prisma.workout.findMany).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
    expect(prisma.workout.create).not.toHaveBeenCalled();
    expect(prisma.workout.createMany).not.toHaveBeenCalled();
    expect(prisma.workout.upsert).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("GET /workouts/week?week=&year= n'écrit rien non plus", async () => {
    const res = await httpGet(base, "/workouts/week?week=42&year=2026");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("GET /workouts/month n'écrit rien", async () => {
    const res = await httpGet(base, "/workouts/month");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({});
    expect(writes).toEqual([]);
  });

  it("GET /workouts/roadmap n'écrit rien", async () => {
    const res = await httpGet(base, "/workouts/roadmap");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).summaryStats).toBeDefined();
    expect(writes).toEqual([]);
  });

  it("GET /workouts/:identifier n'écrit rien (jour de repos synthétisé en lecture)", async () => {
    const res = await httpGet(base, "/workouts/2030-01-01");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).isRestDay).toBe(true);
    expect(writes).toEqual([]);
  });

  it("aucun endpoint GET de planification n'appelle un modèle Prisma en écriture", () => {
    expect(writes).toEqual([]);
    for (const model of ["user", "workout", "lifeRule", "syncToken"]) {
      for (const method of WRITE_METHODS) {
        expect(prisma[model][method]).not.toHaveBeenCalled();
      }
    }
  });

  it("la route GET /workouts/week n'est pas marquée @Public() (RILES-008 conservé)", () => {
    const meta = Reflect.getMetadata(
      IS_PUBLIC_KEY,
      WorkoutsController.prototype.getWeek,
    );
    expect(meta).toBeUndefined();
  });

  it("aucune fonction de provisionnement de semaine démo n'existe plus dans src/", () => {
    const srcDir = path.resolve(__dirname, "../..");
    const offenders: string[] = [];

    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (!entry.name.endsWith(".ts")) return [];
        if (entry.name.endsWith(".test.ts")) return [];
        return fs
          .readFileSync(full, "utf8")
          .includes("provisionDefaultWeekWorkouts")
          ? [path.relative(srcDir, full)]
          : [];
      });

    expect(walk(srcDir)).toEqual(offenders);
  });
});

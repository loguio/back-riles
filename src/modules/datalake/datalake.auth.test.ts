import "reflect-metadata";
import * as jwt from "jsonwebtoken";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { INestApplication, Module } from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DataLakeController } from "./datalake.controller";
import { DataLakeService } from "./datalake.service";
import { SupabaseAuthGuard } from "../auth/guards/supabase-auth.guard";
import { PrismaService } from "../../prisma/prisma.service";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import { REQUIRE_TOKEN_KEY } from "../../common/decorators/require-token.decorator";

/**
 * RILES-008 — GET /datalake/logs et GET /datalake/stats exposaient des
 * enregistrements RPE / santé / chat publiquement (@Public()).
 *
 * Ces tests montent un mini-application NestJS avec la vraie garde
 * SupabaseAuthGuard (APP_GUARD) autour du DataLakeController et vérifient :
 *  1. une lecture non authentifiée renvoie 401, y compris en environnement
 *     dev/test où le garde-fou "invité" (user-01 sans jeton) s'applique ;
 *  2. le contenu santé/chat n'est lisible qu'avec un jeton Bearer ;
 *  3. les routes de lecture ne sont plus marquées @Public().
 */

const HEALTH_LOG_RECORDS = [
  {
    id: "rec-1",
    interactionType: "rpe_checkin",
    userId: "user-01",
    interaction: { note: "Douleur au mollet après 12 km, RPE 8/10" },
    timestamp: "2026-10-12T08:00:00.000Z",
  },
  {
    id: "rec-2",
    interactionType: "coach_chat",
    userId: "user-01",
    interaction: { userPrompt: "Je suis fatigué, annule ma semaine" },
    timestamp: "2026-10-12T09:00:00.000Z",
  },
];

const GUEST_USER = {
  id: "user-01",
  email: "user-01@riles.app",
  name: "User",
  initials: "U0",
  rules: [],
  syncTokens: [],
};

const TEST_JWT_SECRET = "test-jwt-secret";

function createDataLakeServiceStub() {
  return {
    getStats: jest.fn(() => ({
      totalBufferedRecords: HEALTH_LOG_RECORDS.length,
      storageMode: "local_jsonl_partitioned",
      countsByInteractionType: { rpe_checkin: 1, coach_chat: 1 },
    })),
    getRecentLogs: jest.fn(() => HEALTH_LOG_RECORDS),
    logTrainingInteraction: jest.fn(async () => true),
  };
}

function createPrismaStub() {
  return {
    user: {
      findUnique: jest.fn(async () => GUEST_USER),
      findFirst: jest.fn(async () => GUEST_USER),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...GUEST_USER,
        ...data,
      })),
    },
  };
}

function createConfigStub(env: Record<string, string | undefined>) {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in env ? env[key] : defaultValue,
  } as unknown as ConfigService;
}

async function createTestApp(
  env: Record<string, string | undefined>,
): Promise<INestApplication> {
  // La garde échoue fermement sans secret JWT (RILES-002) : fournir un secret
  // de test explicite, comme le ferait l'environnement réel.
  const envWithSecret: Record<string, string | undefined> = {
    SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
    ...env,
  };
  @Module({
    controllers: [DataLakeController],
    providers: [
      { provide: DataLakeService, useValue: createDataLakeServiceStub() },
      { provide: ConfigService, useValue: createConfigStub(envWithSecret) },
      { provide: PrismaService, useValue: createPrismaStub() },
      { provide: APP_GUARD, useClass: SupabaseAuthGuard },
    ],
  })
  class DatalakeAuthTestModule {}

  const app = await NestFactory.create(DatalakeAuthTestModule, {
    logger: [],
  });
  await app.listen(0, "127.0.0.1");
  return app;
}

function baseUrlOf(app: INestApplication): string {
  const { port } = app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function httpGet(
  base: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path}`,
      { method: "GET", headers },
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

describe("RILES-008 datalake privacy — lectures publiques verrouillées", () => {
  let devApp: INestApplication;
  let prodApp: INestApplication;
  let devBase: string;
  let prodBase: string;

  beforeAll(async () => {
    // Environnement dev/test : le garde-fou "invité" (user-01 sans jeton)
    // serait actif sans @RequireToken().
    devApp = await createTestApp({ NODE_ENV: "test" });
    devBase = baseUrlOf(devApp);
    prodApp = await createTestApp({ NODE_ENV: "production" });
    prodBase = baseUrlOf(prodApp);
  });

  afterAll(async () => {
    await devApp?.close();
    await prodApp?.close();
  });

  it("GET /datalake/logs sans jeton renvoie 401 en dev/test (aucune fuite de contenu santé/chat)", async () => {
    const res = await httpGet(devBase, "/datalake/logs");

    expect(res.status).toBe(401);
    expect(res.body).not.toContain("records");
    expect(res.body).not.toContain("Douleur");
    expect(res.body).not.toContain("fatigué");
  });

  it("GET /datalake/stats sans jeton renvoie 401 en dev/test", async () => {
    const res = await httpGet(devBase, "/datalake/stats");

    expect(res.status).toBe(401);
    expect(res.body).not.toContain("totalBufferedRecords");
  });

  it("GET /datalake/logs sans jeton renvoie 401 en production", async () => {
    const res = await httpGet(prodBase, "/datalake/logs");

    expect(res.status).toBe(401);
    expect(res.body).not.toContain("records");
  });

  it("les routes de lecture du datalake ne sont plus marquées @Public()", () => {
    const logsMeta = Reflect.getMetadata(
      IS_PUBLIC_KEY,
      DataLakeController.prototype.getRecentLogs,
    );
    const statsMeta = Reflect.getMetadata(
      IS_PUBLIC_KEY,
      DataLakeController.prototype.getStats,
    );

    expect(logsMeta).toBeUndefined();
    expect(statsMeta).toBeUndefined();
  });

  it("les routes de lecture exigent explicitement un jeton (@RequireToken)", () => {
    const logsMeta = Reflect.getMetadata(
      REQUIRE_TOKEN_KEY,
      DataLakeController.prototype.getRecentLogs,
    );
    const statsMeta = Reflect.getMetadata(
      REQUIRE_TOKEN_KEY,
      DataLakeController.prototype.getStats,
    );

    expect(logsMeta).toBe(true);
    expect(statsMeta).toBe(true);
  });

  it("un utilisateur authentifié avec un jeton Bearer lit toujours les logs", async () => {
    // Les tokens démo/dev n'authentifient plus (RILES-003) : signer un vrai
    // JWT HS256 avec le secret de test, comme le ferait Supabase.
    const token = jwt.sign(
      {
        sub: "user-01",
        email: "user-01@riles.app",
        user_metadata: {},
        app_metadata: { provider: "email" },
      },
      TEST_JWT_SECRET,
      { algorithm: "HS256" },
    );
    const res = await httpGet(devBase, "/datalake/logs", {
      Authorization: `Bearer ${token}`,
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain("rpe_checkin");
    expect(res.body).toContain("coach_chat");
  });
});

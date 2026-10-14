import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import * as jwt from "jsonwebtoken";
import { SupabaseAuthGuard } from "./guards/supabase-auth.guard";
import { AuthService } from "./auth.service";

/**
 * RILES-014 — les nouveaux utilisateurs étaient provisionnés avec des
 * statistiques fabriquées (totalKm 328, completedRaces 4, readinessScore 88,
 * objectif « Semi-marathon de Paris », jetons Garmin/Strava connectés).
 *
 * Ces tests verrouillent les trois endroits où une ligne utilisateur naît :
 *  1. la garde Supabase (auto-provisioning) crée un profil strictement zéro,
 *     sans LifeRule ni SyncToken ;
 *  2. `AuthService.register` n'injecte aucune statistique ;
 *  3. les défauts du schéma Prisma (donc toute création ailleurs) sont à l'état
 *     zéro, et la migration correspondante existe — les fixtures de démo, elles,
 *     restent portées par `prisma/seed.ts`.
 */

const TEST_SECRET = "test-only-supabase-jwt-secret";

const ZERO_STATE_FIELDS: Record<string, unknown> = {
  readinessScore: 0,
  totalKm: 0,
  completedRaces: 0,
  activeWeeks: 0,
  activeGoalTitle: "",
  activeGoalTarget: "",
  activeGoalRaceDate: "",
  activeGoalWeeksRemaining: 0,
  activeGoalProgressPercentage: 0,
  isOnboardingCompleted: false,
  selectedSports: [],
  mainGoal: null,
};

function createContext(headers: Record<string, string>): {
  context: any;
  request: any;
} {
  const request: any = { headers };
  const context: any = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  };
  return { context, request };
}

/** En-tête HTTP d'authentification construit à partir d'un jeton signé. */
function buildAuthHeaders(rawJwt: string): Record<string, string> {
  const scheme = "Bearer";
  const value = scheme + " " + rawJwt;
  const headers: Record<string, string> = {};
  headers["authorization"] = value;
  return headers;
}

function signedToken(sub: string, email: string): string {
  return jwt.sign(
    {
      sub,
      email,
      user_metadata: { full_name: "New Bie" },
      app_metadata: { provider: "google" },
    },
    TEST_SECRET,
    { algorithm: "HS256" },
  );
}

describe("RILES-014 — un utilisateur créé par la garde n'a aucune donnée fabriquée", () => {
  function createGuardHarness() {
    const reflector: any = { getAllAndOverride: jest.fn(() => false) };
    const configService: any = {
      get: jest.fn((key: string, defaultValue?: any) =>
        key === "SUPABASE_JWT_SECRET" || key === "JWT_SECRET"
          ? TEST_SECRET
          : defaultValue,
      ),
    };

    const prisma: any = {
      user: {
        findFirst: jest.fn(async () => null),
        findUnique: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({
          ...data,
          rules: [],
          syncTokens: [],
        })),
      },
      lifeRule: {
        create: jest.fn(async () => ({ id: "rule" })),
        createMany: jest.fn(async () => ({ count: 1 })),
      },
      syncToken: {
        create: jest.fn(async () => ({ id: "token" })),
        upsert: jest.fn(async () => ({ id: "token" })),
        createMany: jest.fn(async () => ({ count: 1 })),
      },
    };

    return {
      guard: new SupabaseAuthGuard(reflector, configService, prisma),
      prisma,
    };
  }

  it("crée un profil strictement à zéro (stats, objectif, onboarding)", async () => {
    const { guard, prisma } = createGuardHarness();
    const { context, request } = createContext(
      buildAuthHeaders(signedToken("supabase-new-user", "newbie@riles.app")),
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    const data = prisma.user.create.mock.calls[0][0].data;
    expect(data).toMatchObject(ZERO_STATE_FIELDS);

    // Aucune statistique physiologique n'est même passée : le défaut neutre
    // du schéma (0) s'applique.
    for (const key of [
      "atlFatigue",
      "ctlFitness",
      "tsbForm",
      "sleepScore",
      "hrvStatus",
    ]) {
      expect(data[key]).toBeUndefined();
    }

    // L'utilisateur servi à la requête reflète bien cet état zéro.
    expect(request.user.totalKm).toBe(0);
    expect(request.user.readinessScore).toBe(0);
    expect(request.user.completedRaces).toBe(0);
  });

  it("ne crée ni LifeRule ni SyncToken (pas de règles ni de jetons connectés)", async () => {
    const { guard, prisma } = createGuardHarness();
    const { context } = createContext(
      buildAuthHeaders(signedToken("supabase-new-user", "newbie@riles.app")),
    );

    await guard.canActivate(context);

    expect(prisma.lifeRule.create).not.toHaveBeenCalled();
    expect(prisma.lifeRule.createMany).not.toHaveBeenCalled();
    expect(prisma.syncToken.create).not.toHaveBeenCalled();
    expect(prisma.syncToken.upsert).not.toHaveBeenCalled();
    expect(prisma.syncToken.createMany).not.toHaveBeenCalled();

    // Seule écriture du provisioning : la ligne utilisateur elle-même.
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });
});

describe("RILES-014 — AuthService.register n'injecte aucune statistique", () => {
  function createAuthHarness() {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: any) => ({
          id: "user-new",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        })),
      },
      lifeRule: { create: jest.fn() },
      syncToken: { create: jest.fn(), upsert: jest.fn() },
    };
    const jwtService: any = { sign: jest.fn().mockReturnValue("token") };
    const configService: any = {
      get: jest.fn((key: string, defaultValue?: any) =>
        key === "SUPABASE_JWT_SECRET" || key === "JWT_SECRET"
          ? TEST_SECRET
          : defaultValue,
      ),
    };

    return {
      service: new AuthService(prisma, jwtService, configService),
      prisma,
    };
  }

  it("crée un compte sans totalKm/completedRaces/readinessScore fabriqués", async () => {
    const { service, prisma } = createAuthHarness();

    await service.register({
      email: "newbie@riles.app",
      name: "New Bie",
      password: "correct-horse-battery",
    } as any);

    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    const data = prisma.user.create.mock.calls[0][0].data;

    for (const key of Object.keys(ZERO_STATE_FIELDS)) {
      expect(data[key]).toBeUndefined();
    }
    expect(data.totalKm).toBeUndefined();
    expect(data.completedRaces).toBeUndefined();
    expect(data.readinessScore).toBeUndefined();
    expect(data.activeGoalTitle).toBeUndefined();

    expect(prisma.lifeRule.create).not.toHaveBeenCalled();
    expect(prisma.syncToken.create).not.toHaveBeenCalled();
    expect(prisma.syncToken.upsert).not.toHaveBeenCalled();
  });
});

describe("RILES-014 — les défauts du schéma sont à l'état zéro", () => {
  const schemaPath = path.resolve(__dirname, "../../../prisma/schema.prisma");
  const schema = fs.readFileSync(schemaPath, "utf8");
  const userBlock = schema.slice(
    schema.indexOf("model User {"),
    schema.indexOf("model LifeRule {"),
  );

  it("aucune statistique ni objectif de démo n'est défini par défaut", () => {
    expect(userBlock).toMatch(/readinessScore\s+Int\s+@default\(0\)/);
    expect(userBlock).toMatch(/totalKm\s+Float\s+@default\(0\)/);
    expect(userBlock).toMatch(/completedRaces\s+Int\s+@default\(0\)/);
    expect(userBlock).toMatch(/activeWeeks\s+Int\s+@default\(0\)/);
    expect(userBlock).toMatch(/atlFatigue\s+Float\s+@default\(0\)/);
    expect(userBlock).toMatch(/ctlFitness\s+Float\s+@default\(0\)/);
    expect(userBlock).toMatch(/tsbForm\s+Float\s+@default\(0\)/);
    expect(userBlock).toMatch(/sleepScore\s+Int\s+@default\(0\)/);
    expect(userBlock).toMatch(/hrvStatus\s+String\s+@default\(""\)/);
    expect(userBlock).toMatch(/activeGoalTitle\s+String\s+@default\(""\)/);
    expect(userBlock).toMatch(/activeGoalTarget\s+String\s+@default\(""\)/);
    expect(userBlock).toMatch(/activeGoalRaceDate\s+String\s+@default\(""\)/);
    expect(userBlock).toMatch(/activeGoalWeeksRemaining\s+Int\s+@default\(0\)/);
    expect(userBlock).toMatch(
      /activeGoalProgressPercentage\s+Int\s+@default\(0\)/,
    );
    expect(userBlock).toMatch(
      /isOnboardingCompleted\s+Boolean\s+@default\(false\)/,
    );
    expect(userBlock).toMatch(/selectedSports\s+String\[\]\s+@default\(\[\]\)/);

    expect(userBlock).not.toMatch(
      /@default\(328\.0\)|@default\(88\)|@default\(82\)|@default\(42\.0\)|@default\(48\.0\)|@default\("balanced"\)|Semi-marathon de Paris/,
    );
  });

  it("la migration des défauts à zéro existe et modifie bien les colonnes", () => {
    const migrationsDir = path.resolve(__dirname, "../../../prisma/migrations");
    const folders = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.includes("zero_state_user_defaults"),
      )
      .map((entry) => entry.name);

    expect(folders).toHaveLength(1);

    const sql = fs.readFileSync(
      path.join(migrationsDir, folders[0], "migration.sql"),
      "utf8",
    );
    expect(sql).toContain('ALTER COLUMN "totalKm" SET DEFAULT 0');
    expect(sql).toContain('ALTER COLUMN "completedRaces" SET DEFAULT 0');
    expect(sql).toContain('ALTER COLUMN "readinessScore" SET DEFAULT 0');
    expect(sql).toContain(
      'ALTER COLUMN "isOnboardingCompleted" SET DEFAULT false',
    );
    expect(sql).toContain(
      'ALTER COLUMN "selectedSports" SET DEFAULT ARRAY[]::TEXT[]',
    );
  });

  it("les fixtures de démo restent portées par prisma/seed.ts", () => {
    const seed = fs.readFileSync(
      path.resolve(__dirname, "../../../prisma/seed.ts"),
      "utf8",
    );

    expect(seed).toContain("totalKm: 328.0");
    expect(seed).toContain("completedRaces: 4");
    expect(seed).toContain("readinessScore: 88");
    expect(seed).toContain("Garmin Forerunner 265");
    expect(seed).toContain("isOnboardingCompleted: true");
  });

  it("aucun fichier de src/ ne recrée de données de démo", () => {
    const srcDir = path.resolve(__dirname, "..");
    const offenders: string[] = [];

    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
          return [];
        }
        const content = fs.readFileSync(full, "utf8");
        const hit = [
          "totalKm: 328",
          "completedRaces: 4",
          "Garmin Forerunner 265",
          "mock_garmin_access_token",
          "batteryLevel",
        ].find((token) => content.includes(token));
        return hit ? [`${path.relative(srcDir, full)}: ${hit}`] : [];
      });

    expect(walk(srcDir)).toEqual([]);
  });
});

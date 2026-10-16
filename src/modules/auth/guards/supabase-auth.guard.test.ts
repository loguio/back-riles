import * as fs from "fs";
import * as path from "path";
import { UnauthorizedException } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import { SupabaseAuthGuard } from "./supabase-auth.guard";

const TEST_SECRET = "test-only-supabase-jwt-secret";
const ENVIRONMENTS = ["development", "test", "production"];

/** Builds an Authorization header value (kept in one place on purpose). */
function authHeaderValue(token: string): string {
  return "Bearer " + token;
}

function createHarness(nodeEnv = "development"): {
  guard: SupabaseAuthGuard;
  prisma: any;
} {
  const reflector: any = {
    getAllAndOverride: jest.fn(() => false),
  };

  const configService: any = {
    get: jest.fn((key: string, defaultValue?: any) => {
      if (key === "SUPABASE_JWT_SECRET" || key === "JWT_SECRET") {
        return TEST_SECRET;
      }
      if (key === "NODE_ENV") {
        return nodeEnv;
      }
      // No Supabase credentials: the admin client stays null, so no online
      // validation can mask a local signature failure.
      return defaultValue;
    }),
  };

  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
  };

  return {
    guard: new SupabaseAuthGuard(reflector, configService as any, prisma),
    prisma,
  };
}

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

function bearerContext(
  token: string,
  extraHeaders: Record<string, string> = {},
) {
  return createContext({
    authorization: authHeaderValue(token),
    ...extraHeaders,
  });
}

async function expectUnauthorized(promise: Promise<unknown>): Promise<any> {
  const err = await promise.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(UnauthorizedException);
  expect(err.getStatus()).toBe(401);
  return err;
}

describe("SupabaseAuthGuard (RILES-003: no demo/dev/X-User-Id bypass)", () => {
  it.each(ENVIRONMENTS)(
    "rejects a demo token with an X-User-Id header in %s",
    async (nodeEnv) => {
      const { guard, prisma } = createHarness(nodeEnv);
      const { context, request } = bearerContext("demo-token", {
        "x-user-id": "attacker-chosen-id",
      });

      await expectUnauthorized(guard.canActivate(context));

      expect(request.user).toBeUndefined();
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
    },
  );

  it.each(ENVIRONMENTS)(
    "rejects any dev-token-* bearer in %s",
    async (nodeEnv) => {
      const { guard } = createHarness(nodeEnv);
      const { context } = bearerContext("dev-token-local-1");

      await expectUnauthorized(guard.canActivate(context));
    },
  );

  it("rejects the demo-bearer-token prefix in every environment", async () => {
    for (const nodeEnv of ENVIRONMENTS) {
      const { guard } = createHarness(nodeEnv);
      const { context } = bearerContext("demo-bearer-token-42");

      await expectUnauthorized(guard.canActivate(context));
    }
  });

  it.each(ENVIRONMENTS)(
    "rejects a missing token in %s, even with an X-User-Id header",
    async (nodeEnv) => {
      const { guard, prisma } = createHarness(nodeEnv);
      const { context, request } = createContext({
        "x-user-id": "attacker-chosen-id",
      });

      await expectUnauthorized(guard.canActivate(context));

      expect(request.user).toBeUndefined();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    },
  );

  it("rejects a request with no header at all in development", async () => {
    const { guard } = createHarness("development");
    const { context } = createContext({});

    await expectUnauthorized(guard.canActivate(context));
  });

  it("rejects a forged token in development (no structural decode fallback)", async () => {
    const forged = jwt.sign(
      { sub: "attacker", email: "attacker@evil.example" },
      "some-other-secret",
      { algorithm: "HS256", expiresIn: "1h" },
    );
    const { guard, prisma } = createHarness("development");
    const { context } = bearerContext(forged);

    await expectUnauthorized(guard.canActivate(context));

    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("still accepts a token signed with the configured secret", async () => {
    const existingUser = {
      id: "existing-user-uuid",
      email: "existing@riles.app",
      name: "Existing",
      initials: "EX",
      rules: [],
      syncTokens: [],
    };
    const { guard, prisma } = createHarness("development");
    prisma.user.findFirst.mockResolvedValue(existingUser);

    const token = jwt.sign(
      {
        sub: existingUser.id,
        email: existingUser.email,
        role: "authenticated",
        app_metadata: { provider: "google" },
      },
      TEST_SECRET,
      { algorithm: "HS256", expiresIn: "1h" },
    );
    const { context, request } = bearerContext(token);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toBe(existingUser);
    expect(request.supabaseUser.sub).toBe(existingUser.id);
  });
});

describe("source invariants (RILES-003: bypasses are gone for good)", () => {
  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        sourceFiles(fullPath, found);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !/(\.test|\.spec)\.ts$/.test(entry.name)
      ) {
        found.push(fullPath);
      }
    }
    return found;
  }

  const files = sourceFiles(path.resolve(__dirname, "../../.."));
  const read = (file: string) => fs.readFileSync(file, "utf8");

  it("no source file reads the X-User-Id header", () => {
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((file) =>
      /["']x-user-id["']/i.test(read(file)),
    );

    expect(offenders).toEqual([]);
  });

  it("no source file contains a demo/dev token branch", () => {
    const offenders = files.filter((file) =>
      /demo-token|dev-token-|demo-bearer/i.test(read(file)),
    );

    expect(offenders).toEqual([]);
  });
});

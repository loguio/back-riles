import * as assert from "assert";
import * as jwt from "jsonwebtoken";
import { SupabaseAuthGuard } from "./supabase-auth.guard";
import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";

async function runGuardTests() {
  console.log("▶ [Test Suite] SupabaseAuthGuard Validation");

  const jwtSecret = "super-secret-riles-jwt-key-2026-change-in-prod";

  let isPublicRoute = false;
  const mockReflector: any = {
    getAllAndOverride: (key: string) => {
      if (key === IS_PUBLIC_KEY) return isPublicRoute;
      return false;
    },
  };

  const mockConfigService: any = {
    get: (key: string, defaultValue?: any) => {
      if (key === "SUPABASE_JWT_SECRET" || key === "JWT_SECRET")
        return jwtSecret;
      if (key === "NODE_ENV") return "test";
      return defaultValue;
    },
  };

  let databaseUsers: any[] = [
    {
      id: "existing-user-uuid",
      email: "existing@riles.app",
      name: "Marius Existing",
      initials: "ME",
      planType: "PRO",
    },
  ];

  const mockPrismaService: any = {
    user: {
      findFirst: async ({ where }: any) => {
        const idCond = where.OR?.find((c: any) => c.id)?.id;
        const emailCond = where.OR?.find((c: any) => c.email)?.email;
        return (
          databaseUsers.find(
            (u) =>
              (idCond && u.id === idCond) ||
              (emailCond && u.email === emailCond),
          ) || null
        );
      },
      findUnique: async ({ where }: any) => {
        return databaseUsers.find((u) => u.id === where.id) || null;
      },
      create: async ({ data }: any) => {
        const created = {
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        databaseUsers.push(created);
        return created;
      },
    },
  };

  const guard = new SupabaseAuthGuard(
    mockReflector,
    mockConfigService,
    mockPrismaService,
  );

  function createMockContext(headers: Record<string, string>): {
    context: ExecutionContext;
    request: any;
  } {
    const request: any = { headers };
    const context: any = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };
    return { context, request };
  }

  // 1. Route publique
  isPublicRoute = true;
  const t1 = createMockContext({});
  const res1 = await guard.canActivate(t1.context);
  assert.strictEqual(res1, true, "Public route should pass without token");
  console.log("  ✔ Test 1: @Public() route passes without token");

  // 2. Route protégée sans token
  isPublicRoute = false;
  const t2 = createMockContext({});
  let threwUnauthorized = false;
  try {
    await guard.canActivate(t2.context);
  } catch (e) {
    if (e instanceof UnauthorizedException) {
      threwUnauthorized = true;
    }
  }
  assert.strictEqual(
    threwUnauthorized,
    true,
    "Should reject unauthenticated requests",
  );
  console.log(
    "  ✔ Test 2: Protected route without token throws UnauthorizedException",
  );

  // 3. Token Supabase valide avec utilisateur existant
  const existingToken = jwt.sign(
    {
      sub: "existing-user-uuid",
      email: "existing@riles.app",
      role: "authenticated",
      app_metadata: { provider: "apple" },
      user_metadata: { full_name: "Marius Existing" },
    },
    jwtSecret,
    { algorithm: "HS256", expiresIn: "1h" },
  );
  const t3 = createMockContext({ authorization: `Bearer ${existingToken}` });
  const res3 = await guard.canActivate(t3.context);
  assert.strictEqual(res3, true, "Valid token should be accepted");
  assert.strictEqual(
    t3.request.user?.id,
    "existing-user-uuid",
    "Should resolve existing user",
  );
  console.log("  ✔ Test 3: Valid Supabase JWT attaches existing Prisma user");

  // 4. Token Supabase valide avec premier login (Auto-création en DB)
  const newSub = "supabase-uuid-runner-999";
  const newToken = jwt.sign(
    {
      sub: newSub,
      email: "newbie@riles.app",
      role: "authenticated",
      app_metadata: { provider: "google" },
      user_metadata: { full_name: "Sarah Runner" },
    },
    jwtSecret,
    { algorithm: "HS256", expiresIn: "1h" },
  );
  const t4 = createMockContext({ authorization: `Bearer ${newToken}` });
  const res4 = await guard.canActivate(t4.context);
  assert.strictEqual(res4, true, "First login should be accepted");
  assert.strictEqual(
    t4.request.user?.id,
    newSub,
    "Should assign sub as user id",
  );
  const createdInDb = databaseUsers.find((u) => u.id === newSub);
  assert.ok(createdInDb, "User must be created in Prisma DB");
  assert.strictEqual(
    createdInDb.name,
    "Sarah Runner",
    "User name should match metadata",
  );
  assert.strictEqual(
    createdInDb.authProvider,
    "GOOGLE",
    "AuthProvider should be GOOGLE",
  );
  console.log(
    "  ✔ Test 4: First Supabase login auto-provisions user in Prisma PostgreSQL",
  );

  // 5. Jeton altéré / faux
  const t5 = createMockContext({ authorization: "Bearer false.jwt.signature" });
  let rejectedTampered = false;
  try {
    await guard.canActivate(t5.context);
  } catch (e) {
    if (e instanceof UnauthorizedException) {
      rejectedTampered = true;
    }
  }
  assert.strictEqual(rejectedTampered, true, "Tampered token must be rejected");
  console.log(
    "  ✔ Test 5: Tampered token is rejected with UnauthorizedException",
  );

  console.log("\n✅ All 5 SupabaseAuthGuard tests passed with 100% success!\n");
}

runGuardTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

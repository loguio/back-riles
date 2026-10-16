import { ExecutionContext, HttpException } from "@nestjs/common";
import { RateLimitGuard } from "./rate-limit.guard";
import { ConfigService } from "@nestjs/config";

function makeContext(ip = "1.2.3.4", userId?: string): ExecutionContext {
  const headers: Record<string, string> = {};
  const response = {
    header: (key: string, value: string) => {
      headers[key] = value;
    },
  };
  const request = {
    ip,
    socket: { remoteAddress: ip },
    headers: {},
    user: userId ? { id: userId } : undefined,
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(env: Record<string, string> = {}): RateLimitGuard {
  const config = {
    get: (key: string, def?: string) => env[key] ?? def,
  } as unknown as ConfigService;
  return new RateLimitGuard(config as ConfigService);
}

describe("RateLimitGuard", () => {
  it("lets the first request through and exposes rate headers", async () => {
    const guard = makeGuard();
    const ctx = makeContext();
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("blocks once the bucket is empty and returns 429", async () => {
    // 60 rpm => 1 token per second + 0 burst: after the first call, the bucket
    // is empty and the second call must be rejected.
    const guard = makeGuard({ RATE_LIMIT_RPM: "60", RATE_LIMIT_BURST: "0" });
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    await expect(guard.canActivate(makeContext())).rejects.toBeInstanceOf(HttpException);
  });

  it("scopes limits per user identity when authenticated", async () => {
    const guard = makeGuard({ RATE_LIMIT_RPM: "60", RATE_LIMIT_BURST: "0" });
    await expect(guard.canActivate(makeContext("1.2.3.4", "user-a"))).resolves.toBe(true);
    // Different user, different bucket.
    await expect(guard.canActivate(makeContext("1.2.3.4", "user-b"))).resolves.toBe(true);
  });

  it("can be disabled via env", async () => {
    const guard = makeGuard({ RATE_LIMIT_ENABLED: "false" });
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
    await expect(guard.canActivate(makeContext())).resolves.toBe(true);
  });
});

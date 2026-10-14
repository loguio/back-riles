import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from "@nestjs/common";
import * as argon2 from "argon2";
import { AuthService } from "./auth.service";

const TEST_JWT_SECRET = "unit-test-jwt-secret-not-a-real-secret";

interface Harness {
  service: AuthService;
  prisma: any;
  jwtService: any;
}

function createHarness(): Harness {
  const prisma: any = {
    user: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  };

  const jwtService: any = {
    sign: jest.fn().mockReturnValue("signed-access-token"),
    verify: jest.fn(),
  };

  const configService: any = {
    get: jest.fn((key: string, defaultValue?: any) =>
      key === "SUPABASE_JWT_SECRET" || key === "JWT_SECRET"
        ? TEST_JWT_SECRET
        : defaultValue,
    ),
  };

  return {
    service: new AuthService(prisma, jwtService, configService),
    prisma,
    jwtService,
  };
}

async function captureError(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

function expectUnauthorized(err: any): void {
  expect(err).toBeInstanceOf(UnauthorizedException);
  expect(err.getStatus()).toBe(401);
}

describe("AuthService.login (RILES-001: credentials are actually verified)", () => {
  it("rejects a wrong password on an existing account with 401 and issues no token", async () => {
    const { service, prisma, jwtService } = createHarness();
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      email: "marius@riles.app",
      name: "Marius",
      initials: "MA",
      passwordHash: await argon2.hash("correct-horse"),
    });

    expectUnauthorized(
      await captureError(
        service.login({
          email: "marius@riles.app",
          password: "wrong-password",
        }),
      ),
    );

    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it("rejects an unknown email with 401 instead of silently creating an account", async () => {
    const { service, prisma, jwtService } = createHarness();
    prisma.user.findUnique.mockResolvedValue(null);

    expectUnauthorized(
      await captureError(
        service.login({ email: "nobody@riles.app", password: "whatever" }),
      ),
    );

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it("rejects an account that has no stored password hash (legacy / Supabase-managed)", async () => {
    const { service, prisma, jwtService } = createHarness();
    prisma.user.findUnique.mockResolvedValue({
      id: "user-2",
      email: "legacy@riles.app",
      name: "Legacy",
      initials: "LE",
      passwordHash: null,
    });

    expectUnauthorized(
      await captureError(
        service.login({ email: "legacy@riles.app", password: "anything" }),
      ),
    );

    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it("rejects a missing password without touching the account", async () => {
    const { service, prisma, jwtService } = createHarness();
    prisma.user.findUnique.mockResolvedValue({
      id: "user-3",
      email: "marius@riles.app",
      name: "Marius",
      initials: "MA",
      passwordHash: await argon2.hash("correct-horse"),
    });

    expectUnauthorized(
      await captureError(service.login({ email: "marius@riles.app" })),
    );

    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it("accepts the correct password and signs a token for that user", async () => {
    const { service, prisma, jwtService } = createHarness();
    prisma.user.findUnique.mockResolvedValue({
      id: "user-4",
      email: "marius@riles.app",
      name: "Marius",
      initials: "MA",
      passwordHash: await argon2.hash("correct-horse"),
    });

    const response = await service.login({
      email: "marius@riles.app",
      password: "correct-horse",
    });

    expect(response).toEqual({
      accessToken: "signed-access-token",
      userId: "user-4",
      email: "marius@riles.app",
      name: "Marius",
    });
    expect(jwtService.sign).toHaveBeenCalledWith({
      sub: "user-4",
      email: "marius@riles.app",
    });
  });
});

describe("AuthService.register (RILES-001: duplicate registration)", () => {
  it("returns 409 for an existing email and does not log the caller in as that user", async () => {
    const { service, prisma, jwtService } = createHarness();
    prisma.user.findUnique.mockResolvedValue({
      id: "existing-user",
      email: "taken@riles.app",
      name: "Owner",
      initials: "OW",
      passwordHash: null,
    });

    const err = await captureError(
      service.register({
        email: "taken@riles.app",
        name: "Attacker",
        password: "whatever",
      }),
    );

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(jwtService.sign).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("requires a password to create an account", async () => {
    const { service, prisma, jwtService } = createHarness();

    const err = await captureError(
      service.register({ email: "new@riles.app", name: "New Runner" }),
    );

    expect(err).toBeInstanceOf(BadRequestException);
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it("stores an argon2 hash instead of the plaintext password", async () => {
    const { service, prisma, jwtService } = createHarness();
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockImplementation(async ({ data }: any) => ({
      id: "created-user",
      ...data,
    }));

    const response = await service.register({
      email: "new@riles.app",
      name: "New Runner",
      password: "correct-horse",
    });

    const createdData = prisma.user.create.mock.calls[0][0].data;
    expect(createdData.passwordHash).toMatch(/^\$argon2/);
    expect(createdData.passwordHash).not.toContain("correct-horse");
    expect(await argon2.verify(createdData.passwordHash, "correct-horse")).toBe(
      true,
    );
    expect(response.userId).toBe("created-user");
    expect(jwtService.sign).toHaveBeenCalledTimes(1);
  });
});

describe("AuthService.socialAuth (RILES-001: verified provider id-token)", () => {
  it("rejects a request without an id-token with 401 and issues no token", async () => {
    const { service, jwtService } = createHarness();

    expectUnauthorized(
      await captureError(
        service.socialAuth({ provider: "google", email: "victim@riles.app" }),
      ),
    );

    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it("rejects an id-token that fails verification with 401 and issues no token", async () => {
    const { service, prisma, jwtService } = createHarness();
    jwtService.verify.mockImplementation(() => {
      const err: any = new Error("invalid signature");
      throw err;
    });

    expectUnauthorized(
      await captureError(
        service.socialAuth({
          provider: "google",
          email: "victim@riles.app",
          identityToken: "forged.id.token",
        }),
      ),
    );

    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(jwtService.sign).not.toHaveBeenCalled();
  });

  it("takes identity from the verified token and never from the client-supplied email", async () => {
    const { service, prisma, jwtService } = createHarness();
    jwtService.verify.mockReturnValue({
      sub: "supabase-uuid-1",
      email: "real-owner@riles.app",
      user_metadata: { full_name: "Real Owner" },
      app_metadata: { provider: "google" },
    });
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.user.create.mockImplementation(async ({ data }: any) => ({
      id: "supabase-uuid-1",
      ...data,
    }));

    const response = await service.socialAuth({
      provider: "google",
      email: "attacker@evil.example",
      name: "Attacker",
      identityToken: "valid-google-id-token",
    });

    const createdData = prisma.user.create.mock.calls[0][0].data;
    expect(createdData.email).toBe("real-owner@riles.app");
    expect(createdData.name).toBe("Real Owner");
    expect(createdData.authProvider).toBe("GOOGLE");
    expect(response.userId).toBe("supabase-uuid-1");
    expect(jwtService.sign).toHaveBeenCalledWith({
      sub: "supabase-uuid-1",
      email: "real-owner@riles.app",
    });
  });

  it("reuses the existing account resolved from the verified token", async () => {
    const { service, prisma, jwtService } = createHarness();
    jwtService.verify.mockReturnValue({
      sub: "supabase-uuid-2",
      email: "existing@riles.app",
    });
    prisma.user.findFirst.mockResolvedValue({
      id: "existing-user-uuid",
      email: "existing@riles.app",
      name: "Existing",
      initials: "EX",
    });

    const response = await service.socialAuth({
      provider: "apple",
      identityToken: "valid-apple-id-token",
    });

    expect(response.userId).toBe("existing-user-uuid");
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(jwtService.sign).toHaveBeenCalledTimes(1);
  });
});

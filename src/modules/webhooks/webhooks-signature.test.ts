import { UnauthorizedException } from "@nestjs/common";
import * as crypto from "crypto";
import { WebhooksService } from "./webhooks.service";
import { WebhooksController } from "./webhooks.controller";
import type {
  AppleHealthSyncDto,
  GarminWebhookEventDto,
  StravaEventDto,
} from "./dto/webhook.dto";

/**
 * RILES-005 — vérification des signatures des webhooks fournisseurs.
 *
 * Les tests exercent le vrai contrôleur + le vrai service (Prisma / Config
 * stubbés) pour vérifier qu'une signature absente ou forgée est rejetée en 401
 * AVANT toute écriture, qu'une signature valide est acceptée, et que l'absence
 * de secret configuré ferme la porte (fail-closed).
 */

const STRAVA_SECRET = "test-strava-client-secret";
const GARMIN_SECRET = "test-garmin-webhook-secret";
const APPLE_SECRET = "test-apple-health-secret";

const FULL_ENV: Record<string, string | undefined> = {
  STRAVA_CLIENT_SECRET: STRAVA_SECRET,
  GARMIN_WEBHOOK_SECRET: GARMIN_SECRET,
  APPLE_HEALTH_SECRET: APPLE_SECRET,
  STRAVA_VERIFY_TOKEN: "test-verify-token",
};

function createConfig(
  env: Record<string, string | undefined> = FULL_ENV,
): any {
  return {
    get: (key: string, fallback?: string) =>
      env[key] !== undefined ? env[key] : fallback,
  };
}

function createPrismaStub(): any {
  return {
    webhookEvent: { create: jest.fn().mockResolvedValue({ id: "wh-1" }) },
    syncToken: {
      findFirst: jest.fn().mockResolvedValue({
        id: "st-1",
        userId: "user-A",
        provider: "strava",
        externalUserId: "987654",
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        metadata: {},
      }),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    workout: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "w-1" }),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}

function createHarness(env?: Record<string, string | undefined>) {
  const prisma = createPrismaStub();
  const dataLake = { logTrainingInteraction: jest.fn() };
  const llm = {
    computeSessionTss: jest.fn().mockReturnValue(42),
    updateBanisterLoad: jest.fn(),
  };
  const service = new WebhooksService(
    prisma,
    createConfig(env),
    dataLake as any,
    llm as any,
  );
  const controller = new WebhooksController(service);
  return { controller, service, prisma, dataLake };
}

function stravaEvent(): StravaEventDto {
  return {
    object_type: "activity",
    object_id: 1234567890,
    aspect_type: "create",
    owner_id: 987654,
    event_time: 1760000000,
  };
}

function stravaSignature(rawBody: Buffer, secret = STRAVA_SECRET): string {
  return `sha1=${crypto.createHmac("sha1", secret).update(rawBody).digest("hex")}`;
}

describe("RILES-005: Strava webhook signature verification", () => {
  it("rejects an unsigned Strava webhook with 401 and writes nothing", async () => {
    const { controller, prisma } = createHarness();
    const event = stravaEvent();
    const rawBody = Buffer.from(JSON.stringify(event));

    await expect(
      controller.handleStravaEvent(
        { rawBody, headers: {} } as any,
        event,
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.workout.create).not.toHaveBeenCalled();
  });

  it("rejects a Strava webhook whose signature does not match the raw body", async () => {
    const { controller, prisma } = createHarness();
    const event = stravaEvent();
    // Signature calculée sur un corps différent : la charge a été falsifiée.
    const forgedBody = Buffer.from(JSON.stringify({ ...event, owner_id: 1 }));
    const signature = stravaSignature(Buffer.from(JSON.stringify(event)));

    await expect(
      controller.handleStravaEvent(
        { rawBody: forgedBody, headers: { "x-hub-signature": signature } } as any,
        event,
      ),
    ).rejects.toThrow("Invalid Strava webhook signature");
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.workout.create).not.toHaveBeenCalled();
  });

  it("rejects the webhook fail-closed when STRAVA_CLIENT_SECRET is not configured", async () => {
    const { controller, prisma } = createHarness({
      ...FULL_ENV,
      STRAVA_CLIENT_SECRET: undefined,
    });
    const event = stravaEvent();
    const rawBody = Buffer.from(JSON.stringify(event));

    await expect(
      controller.handleStravaEvent(
        { rawBody, headers: { "x-hub-signature": stravaSignature(rawBody) } } as any,
        event,
      ),
    ).rejects.toThrow("not configured");
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("processes a correctly signed Strava webhook", async () => {
    const { controller, prisma } = createHarness();
    const event = stravaEvent();
    const rawBody = Buffer.from(JSON.stringify(event));

    const result = await controller.handleStravaEvent(
      {
        rawBody,
        headers: { "x-hub-signature": stravaSignature(rawBody) },
      } as any,
      event,
    );

    expect(result.success).toBe(true);
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.workout.create).toHaveBeenCalledTimes(1);
  });
});

describe("RILES-005: Garmin webhook signature verification", () => {
  const event: GarminWebhookEventDto = {
    type: "activities",
    userId: "garmin_usr_12345",
    data: { distanceInMeters: 0, durationInSeconds: 0 },
  };

  function garminSignature(rawBody: Buffer, secret = GARMIN_SECRET): string {
    return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  }

  it("rejects an unsigned Garmin webhook with 401 and writes nothing", async () => {
    const { controller, prisma } = createHarness();
    const rawBody = Buffer.from(JSON.stringify(event));

    await expect(
      controller.handleGarminEvent({ rawBody, headers: {} } as any, event),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a forged Garmin signature with 401 and writes nothing", async () => {
    const { controller, prisma } = createHarness();
    const rawBody = Buffer.from(JSON.stringify(event));

    await expect(
      controller.handleGarminEvent(
        {
          rawBody,
          headers: { "x-garmin-signature": garminSignature(rawBody, "wrong") },
        } as any,
        event,
      ),
    ).rejects.toThrow("Invalid Garmin webhook signature");
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("processes a correctly signed Garmin webhook", async () => {
    const { controller, prisma } = createHarness();
    const rawBody = Buffer.from(JSON.stringify(event));

    const result = await controller.handleGarminEvent(
      {
        rawBody,
        headers: { "x-garmin-signature": garminSignature(rawBody) },
      } as any,
      event,
    );

    expect(result.success).toBe(true);
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
  });
});

describe("RILES-005: Apple Health shared-secret verification", () => {
  const dto: AppleHealthSyncDto = {
    userId: "user-B",
    activityType: "walking",
    distanceMeters: 0,
    durationSeconds: 0,
    startDate: "2026-10-14T18:30:00Z",
  };

  it("rejects an Apple Health sync without the shared secret and writes nothing", async () => {
    const { controller, prisma } = createHarness();

    await expect(
      controller.handleAppleHealthSync({ headers: {} } as any, dto),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a wrong Apple Health shared secret and writes nothing", async () => {
    const { controller, prisma } = createHarness();

    await expect(
      controller.handleAppleHealthSync(
        { headers: { "x-apple-health-secret": "not-the-secret" } } as any,
        dto,
      ),
    ).rejects.toThrow("Invalid Apple Health webhook secret");
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("accepts the correct Apple Health shared secret", async () => {
    const { controller, prisma } = createHarness();

    const result = await controller.handleAppleHealthSync(
      { headers: { "x-apple-health-secret": APPLE_SECRET } } as any,
      dto,
    );

    expect(result.success).toBe(true);
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
  });
});

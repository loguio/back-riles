import { UnauthorizedException } from "@nestjs/common";
import * as crypto from "crypto";
import {
  APPLE_HEALTH_SECRET,
  createWebhookHarness,
  GARMIN_WEBHOOK_SECRET,
  STRAVA_CLIENT_SECRET,
  WEBHOOK_ENV,
} from "./webhooks.harness";
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

function stravaEvent(): StravaEventDto {
  return {
    object_type: "activity",
    object_id: 1234567890,
    aspect_type: "create",
    owner_id: 987654,
    event_time: 1760000000,
  };
}

function stravaSignature(
  rawBody: Buffer,
  secret = STRAVA_CLIENT_SECRET,
): string {
  return `sha1=${crypto.createHmac("sha1", secret).update(rawBody).digest("hex")}`;
}

describe("RILES-005: Strava webhook signature verification", () => {
  it("rejects an unsigned Strava webhook with 401 and writes nothing", async () => {
    const { controller, prisma } = createWebhookHarness();
    const event = stravaEvent();
    const rawBody = Buffer.from(JSON.stringify(event));

    await expect(
      controller.handleStravaEvent({ rawBody, headers: {} } as any, event),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.workout.create).not.toHaveBeenCalled();
  });

  it("rejects a Strava webhook whose signature does not match the raw body", async () => {
    const { controller, prisma } = createWebhookHarness();
    const event = stravaEvent();
    // Signature calculée sur un corps différent : la charge a été falsifiée.
    const forgedBody = Buffer.from(JSON.stringify({ ...event, owner_id: 1 }));
    const signature = stravaSignature(Buffer.from(JSON.stringify(event)));

    await expect(
      controller.handleStravaEvent(
        {
          rawBody: forgedBody,
          headers: { "x-hub-signature": signature },
        } as any,
        event,
      ),
    ).rejects.toThrow("Invalid Strava webhook signature");
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.workout.create).not.toHaveBeenCalled();
  });

  it("rejects the webhook fail-closed when STRAVA_CLIENT_SECRET is not configured", async () => {
    const { controller, prisma } = createWebhookHarness({
      env: { ...WEBHOOK_ENV, STRAVA_CLIENT_SECRET: undefined },
    });
    const event = stravaEvent();
    const rawBody = Buffer.from(JSON.stringify(event));

    await expect(
      controller.handleStravaEvent(
        {
          rawBody,
          headers: { "x-hub-signature": stravaSignature(rawBody) },
        } as any,
        event,
      ),
    ).rejects.toThrow("not configured");
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("processes a correctly signed Strava webhook", async () => {
    const { controller, prisma } = createWebhookHarness();
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

  function garminSignature(
    rawBody: Buffer,
    secret = GARMIN_WEBHOOK_SECRET,
  ): string {
    return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  }

  it("rejects an unsigned Garmin webhook with 401 and writes nothing", async () => {
    const { controller, prisma } = createWebhookHarness();
    const rawBody = Buffer.from(JSON.stringify(event));

    await expect(
      controller.handleGarminEvent({ rawBody, headers: {} } as any, event),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a forged Garmin signature with 401 and writes nothing", async () => {
    const { controller, prisma } = createWebhookHarness();
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
    const { controller, prisma } = createWebhookHarness();
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
    const { controller, prisma } = createWebhookHarness();

    await expect(
      controller.handleAppleHealthSync({ headers: {} } as any, dto),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("rejects a wrong Apple Health shared secret and writes nothing", async () => {
    const { controller, prisma } = createWebhookHarness();

    await expect(
      controller.handleAppleHealthSync(
        { headers: { "x-apple-health-secret": "not-the-secret" } } as any,
        dto,
      ),
    ).rejects.toThrow("Invalid Apple Health webhook secret");
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("accepts the correct Apple Health shared secret", async () => {
    const { controller, prisma } = createWebhookHarness();

    const result = await controller.handleAppleHealthSync(
      { headers: { "x-apple-health-secret": APPLE_HEALTH_SECRET } } as any,
      dto,
    );

    expect(result.success).toBe(true);
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
  });
});

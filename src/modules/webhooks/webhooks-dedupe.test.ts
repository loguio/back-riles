import * as crypto from "crypto";
import {
  createWebhookHarness,
  createWebhookStore,
  STRAVA_CLIENT_SECRET,
} from "./webhooks.harness";
import type {
  AppleHealthSyncDto,
  GarminWebhookEventDto,
  StravaEventDto,
} from "./dto/webhook.dto";

/**
 * RILES-006 — anti-rejeu / idempotence + résolution serveur de l'utilisateur.
 *
 * - Rejeu d'une même livraison : une seule écriture (cache en processus puis
 *   contrainte unique en base, y compris après un redémarrage du service).
 * - L'utilisateur cible provient toujours du mapping SyncToken fournisseur →
 *   utilisateur, jamais du `userId` / `owner_id` du payload.
 */

function stravaActivityEvent(): StravaEventDto {
  return {
    object_type: "activity",
    object_id: 555777888,
    aspect_type: "create",
    owner_id: 987654,
    event_time: 1760000000,
    updates: { distance: 10000, moving_time: 3000 },
  };
}

function signedStravaRequest(event: StravaEventDto) {
  const rawBody = Buffer.from(JSON.stringify(event));
  const signature = `sha1=${crypto.createHmac("sha1", STRAVA_CLIENT_SECRET).update(rawBody).digest("hex")}`;
  return { rawBody, headers: { "x-hub-signature": signature } } as any;
}

describe("RILES-006: webhook replay idempotency", () => {
  it("replaying the same delivery twice creates one record", async () => {
    const { controller, prisma, store } = createWebhookHarness();
    const event = stravaActivityEvent();

    const first = await controller.handleStravaEvent(
      signedStravaRequest(event),
      event,
    );
    const replay = await controller.handleStravaEvent(
      signedStravaRequest(event),
      event,
    );

    expect(first.success).toBe(true);
    expect(replay.success).toBe(false);
    expect(replay.message).toContain("Duplicate");
    // Une seule ligne webhook ET une seule séance écrite.
    expect(store.webhookRows).toHaveLength(1);
    expect(prisma.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.workout.create).toHaveBeenCalledTimes(1);
  });

  it("a replay after a service restart is dropped by the DB unique constraint", async () => {
    const store = createWebhookStore();
    const event = stravaActivityEvent();

    const before = createWebhookHarness({ store });
    const first = await before.controller.handleStravaEvent(
      signedStravaRequest(event),
      event,
    );
    expect(first.success).toBe(true);
    expect(store.webhookRows).toHaveLength(1);

    // Nouvelle instance de service : cache en processus vide, la contrainte
    // unique (provider, eventType, objectId) fait foi.
    const afterRestart = createWebhookHarness({ store });
    const replay = await afterRestart.controller.handleStravaEvent(
      signedStravaRequest(event),
      event,
    );

    expect(replay.success).toBe(false);
    expect(replay.message).toContain("Duplicate");
    expect(store.webhookRows).toHaveLength(1);
    expect(afterRestart.prisma.workout.create).not.toHaveBeenCalled();
  });

  it("deduplicates replays that carry no provider object id via payload fingerprint", async () => {
    const { service, store } = createWebhookHarness({
      syncToken: null,
    });
    const dto: AppleHealthSyncDto = {
      userId: "apple-athlete-77",
      activityType: "walking",
      distanceMeters: 0,
      durationSeconds: 0,
      startDate: "2026-10-14T18:30:00Z",
    };

    const first = await service.handleAppleHealthSync(dto);
    const replay = await service.handleAppleHealthSync(dto);

    // Rejeu intercepté AVANT toute écriture (même sans mapping utilisateur).
    expect(replay.message).toContain("Duplicate");
    expect(first.message).toContain("no linked");
    expect(store.webhookRows).toHaveLength(1);
  });
});

describe("RILES-006: user binding comes from the SyncToken mapping", () => {
  it("writes a Garmin event under the mapped user, never the payload userId", async () => {
    const { service, prisma } = createWebhookHarness({
      syncToken: {
        id: "st-garmin",
        userId: "user-A",
        provider: "garmin",
        externalUserId: "garmin_usr_12345",
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        metadata: {},
      },
    });
    const event: GarminWebhookEventDto = {
      type: "activities",
      userId: "garmin_usr_12345",
      data: {
        distanceInMeters: 5000,
        durationInSeconds: 1800,
        startTimeInSeconds: 1760000000,
      },
    };

    const result = await service.handleGarminEvent(event);

    expect(result.success).toBe(true);
    expect(prisma.workout.create).toHaveBeenCalledTimes(1);
    const written = prisma.workout.create.mock.calls[0][0].data;
    expect(written.userId).toBe("user-A");
    expect(written.userId).not.toBe(event.userId);
  });

  it("drops a Strava event whose athlete has no linked account instead of falling back to a default user", async () => {
    const { controller, prisma } = createWebhookHarness({
      syncToken: {
        id: "st-1",
        userId: "user-A",
        provider: "strava",
        externalUserId: "987654",
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        metadata: {},
      },
    });
    // owner_id inconnu du mapping serveur → aucun utilisateur de fallback.
    const event: StravaEventDto = {
      object_type: "activity",
      object_id: 424242,
      aspect_type: "create",
      owner_id: 111111,
      event_time: 1760000000,
    };

    const result = await controller.handleStravaEvent(
      signedStravaRequest(event),
      event,
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain("no linked Strava account");
    expect(prisma.workout.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("drops an Apple Health sync claiming another user's id when no mapping matches", async () => {
    const { service, prisma } = createWebhookHarness({
      syncToken: {
        id: "st-apple",
        userId: "user-A",
        provider: "apple_health",
        externalUserId: "apple-athlete-77",
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        metadata: {},
      },
    });
    // Le payload prétend appartenir à user-B : sans mapping correspondant,
    // rien n'est écrit pour user-B.
    const dto: AppleHealthSyncDto = {
      userId: "user-B",
      activityType: "running",
      distanceMeters: 8000,
      durationSeconds: 2400,
      startDate: "2026-10-14T18:30:00Z",
    };

    const result = await service.handleAppleHealthSync(dto);

    expect(result.success).toBe(false);
    expect(result.message).toContain("no linked Apple Health account");
    expect(prisma.workout.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("writes an Apple Health sync under the mapped user when the provider identity matches", async () => {
    const { service, prisma } = createWebhookHarness({
      syncToken: {
        id: "st-apple",
        userId: "user-A",
        provider: "apple_health",
        externalUserId: "apple-athlete-77",
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        metadata: {},
      },
    });
    const dto: AppleHealthSyncDto = {
      userId: "apple-athlete-77",
      activityType: "running",
      distanceMeters: 8000,
      durationSeconds: 2400,
      startDate: "2026-10-14T18:30:00Z",
      metadata: { workoutUuid: "uuid-1234" },
    };

    const result = await service.handleAppleHealthSync(dto);

    expect(result.success).toBe(true);
    expect(prisma.workout.create).toHaveBeenCalledTimes(1);
    expect(prisma.workout.create.mock.calls[0][0].data.userId).toBe("user-A");
  });
});

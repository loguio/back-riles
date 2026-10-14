import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  createWebhookHarness,
  STRAVA_VERIFY_TOKEN,
  WEBHOOK_ENV,
} from "./webhooks.harness";
import { WebhooksController } from "./webhooks.controller";
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";
import { SupabaseAuthGuard } from "../auth/guards/supabase-auth.guard";

/**
 * RILES-007 — souscriptions Strava authentifiées + state OAuth (anti CSRF).
 *
 * - Les routes de gestion de la souscription ne sont plus @Public() : sans
 *   jeton, le SupabaseAuthGuard répond 401 (testé ici tel quel).
 * - Le state OAuth est un nonce aléatoire lié à l'utilisateur appelant,
 *   à usage unique ; toute correspondance échouée est rejetée avant tout
 *   travail de synchronisation.
 */

function guardContext(handler: unknown) {
  return {
    getHandler: () => handler,
    getClass: () => WebhooksController,
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
  } as any;
}

function createProductionGuard(): SupabaseAuthGuard {
  const config = {
    get: (key: string, fallback?: string) =>
      key === "NODE_ENV" ? "production" : fallback,
  };
  return new SupabaseAuthGuard(new Reflector(), config as any, {} as any);
}

describe("RILES-007: Strava subscription endpoints require authentication", () => {
  it("rejects an unauthenticated subscription call with 401", async () => {
    const guard = createProductionGuard();

    await expect(
      guard.canActivate(
        guardContext(WebhooksController.prototype.getStravaSubscription),
      ),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      guard.canActivate(
        guardContext(WebhooksController.prototype.createStravaSubscription),
      ),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      guard.canActivate(
        guardContext(WebhooksController.prototype.deleteStravaSubscription),
      ),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      guard.canActivate(
        guardContext(WebhooksController.prototype.syncRecentActivities),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("keeps only signature-verified receivers, challenge and OAuth callback public", () => {
    const reflector = new Reflector();
    const isPublic = (method: keyof WebhooksController) =>
      reflector.get(IS_PUBLIC_KEY, WebhooksController.prototype[method]);

    // Routes devant rester publiques (fournisseurs / navigateur Strava).
    expect(isPublic("verifyStravaSubscription")).toBe(true);
    expect(isPublic("handleStravaEvent")).toBe(true);
    expect(isPublic("handleGarminEvent")).toBe(true);
    expect(isPublic("handleAppleHealthSync")).toBe(true);
    expect(isPublic("handleStravaOAuthCallback")).toBe(true);

    // Routes de gestion : authentification exigée.
    expect(isPublic("getStravaSubscription")).toBeUndefined();
    expect(isPublic("createStravaSubscription")).toBeUndefined();
    expect(isPublic("deleteStravaSubscription")).toBeUndefined();
    expect(isPublic("syncRecentActivities")).toBeUndefined();
    expect(isPublic("getStravaOAuthUrl")).toBeUndefined();
  });

  it("lets the guard through for a public webhook receiver", async () => {
    const guard = createProductionGuard();

    await expect(
      guard.canActivate(
        guardContext(WebhooksController.prototype.handleStravaEvent),
      ),
    ).resolves.toBe(true);
  });
});

describe("RILES-007: subscription verification token is fail-closed", () => {
  it("rejects the challenge verification when STRAVA_VERIFY_TOKEN is not configured", () => {
    const { service } = createWebhookHarness({
      env: { ...WEBHOOK_ENV, STRAVA_VERIFY_TOKEN: undefined },
    });

    expect(() =>
      service.verifyStravaSubscription("subscribe", "anything", "challenge"),
    ).toThrow(UnauthorizedException);
  });

  it("rejects a wrong verify token and echoes the challenge for the correct one", () => {
    const { service } = createWebhookHarness();

    expect(() =>
      service.verifyStravaSubscription("subscribe", "wrong-token", "c15"),
    ).toThrow("Invalid Strava verification token");
    expect(
      service.verifyStravaSubscription(
        "subscribe",
        STRAVA_VERIFY_TOKEN,
        "c15f7d8a",
      ),
    ).toEqual({ "hub.challenge": "c15f7d8a" });
  });
});

describe("RILES-007: OAuth state is a server-bound nonce (anti login-CSRF)", () => {
  it("issues a state bound to the caller instead of the raw userId", () => {
    const { service } = createWebhookHarness();

    const url = service.getStravaOAuthAuthorizeUrl(undefined, "user-A");
    const state = new URL(url.authorizeUrl).searchParams.get("state");

    expect(state).not.toBe("user-A");
    expect(state).toMatch(/^user-A\.[0-9a-f]{64}$/);
    expect(service.verifyOAuthState(state ?? undefined)).toBe("user-A");
  });

  it("rejects a state that does not match the issued one (mismatched state)", () => {
    const { service } = createWebhookHarness();

    const state = service.issueOAuthState("user-A");
    const nonce = state.slice(state.lastIndexOf(".") + 1);

    // userId altéré → rejet.
    expect(() => service.verifyOAuthState(`user-B.${nonce}`)).toThrow(
      BadRequestException,
    );
    // Nonce inconnu (state forgé de toutes pièces) → rejet.
    expect(() => service.verifyOAuthState(`user-A.${"f".repeat(64)}`)).toThrow(
      BadRequestException,
    );
    // State absent ou malformé → rejet.
    expect(() => service.verifyOAuthState(undefined)).toThrow(
      BadRequestException,
    );
    expect(() => service.verifyOAuthState("user-A")).toThrow(
      BadRequestException,
    );
  });

  it("rejects a replayed state (nonce single-use)", () => {
    const { service } = createWebhookHarness();

    const state = service.issueOAuthState("user-A");
    expect(service.verifyOAuthState(state)).toBe("user-A");
    expect(() => service.verifyOAuthState(state)).toThrow(BadRequestException);
  });

  it("rejects the OAuth callback on a mismatched state before any sync work", async () => {
    const { controller, service } = createWebhookHarness();
    const syncSpy = jest.spyOn(service, "syncStravaSixMonthsHistory");
    const issued = service.issueOAuthState("user-A");
    const nonce = issued.slice(issued.lastIndexOf(".") + 1);
    const tamperedState = `someone-else.${nonce}`;

    await expect(
      controller.handleStravaOAuthCallback("code", tamperedState, undefined),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.handleStravaOAuthCallback("code", undefined, undefined),
    ).rejects.toThrow(BadRequestException);

    expect(syncSpy).not.toHaveBeenCalled();
  });
});

describe("RILES-007: sync-recent only syncs the caller's own data", () => {
  it("returns 403 when another user id is requested", async () => {
    const { controller, service } = createWebhookHarness();
    const syncSpy = jest.spyOn(service, "syncRecentStravaActivities");

    await expect(
      controller.syncRecentActivities(
        "user-A",
        { userId: "user-B" },
        undefined,
        undefined,
      ),
    ).rejects.toThrow("You can only synchronize your own activities");
    await expect(
      controller.syncRecentActivities("user-A", undefined, "user-B", undefined),
    ).rejects.toThrow("You can only synchronize your own activities");
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it("defaults to the authenticated caller's own id (no hardcoded user)", async () => {
    const { controller, service } = createWebhookHarness();
    const syncSpy = jest
      .spyOn(service, "syncRecentStravaActivities")
      .mockResolvedValue({} as any);

    await controller.syncRecentActivities(
      "user-A",
      { daysLookback: 7 },
      undefined,
      undefined,
    );

    expect(syncSpy).toHaveBeenCalledWith("user-A", 7);
  });

  it("accepts an explicit request for the caller's own id", async () => {
    const { controller, service } = createWebhookHarness();
    const syncSpy = jest
      .spyOn(service, "syncRecentStravaActivities")
      .mockResolvedValue({} as any);

    await controller.syncRecentActivities(
      "user-A",
      { userId: "user-A" },
      undefined,
      undefined,
    );

    expect(syncSpy).toHaveBeenCalledWith("user-A", 7);
  });
});

describe("RILES-007: post-callback redirect comes from the environment", () => {
  it("uses FRONTEND_OAUTH_REDIRECT_URI when configured", () => {
    const { service } = createWebhookHarness({
      env: {
        ...WEBHOOK_ENV,
        FRONTEND_OAUTH_REDIRECT_URI: "https://app.example/onboarding",
      },
    });

    expect(service.getOAuthSuccessRedirect()).toBe(
      "https://app.example/onboarding",
    );
  });

  it("keeps a localhost fallback in development", () => {
    const { service } = createWebhookHarness();

    expect(service.getOAuthSuccessRedirect()).toContain("localhost:8081");
  });
});

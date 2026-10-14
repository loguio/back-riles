import { WebhooksService } from "./webhooks.service";
import { WebhooksController } from "./webhooks.controller";

/**
 * Harnais de test des webhooks : instancie le vrai contrôleur + le vrai
 * service avec Prisma / Config / DataLake / LLM stubbés, sans réseau ni base.
 *
 * Le stub `webhookEvent.create` respecte la contrainte unique
 * (provider, eventType, objectId) et lève une erreur `P2002` sur doublon,
 * comme le ferait PostgreSQL.
 */

export const STRAVA_CLIENT_SECRET = "test-strava-client-secret";
export const GARMIN_WEBHOOK_SECRET = "test-garmin-webhook-secret";
export const APPLE_HEALTH_SECRET = "test-apple-health-secret";
export const STRAVA_VERIFY_TOKEN = "test-verify-token";

export const WEBHOOK_ENV: Record<string, string | undefined> = {
  STRAVA_CLIENT_SECRET,
  GARMIN_WEBHOOK_SECRET,
  APPLE_HEALTH_SECRET,
  STRAVA_VERIFY_TOKEN,
};

export interface WebhookTestStore {
  webhookRows: any[];
}

export function createWebhookStore(): WebhookTestStore {
  return { webhookRows: [] };
}

// Mapping par défaut volontairement sans contrainte provider/externalUserId :
// les tests de signature (RILES-005) passent par plusieurs fournisseurs.
// Les tests de liaison utilisateur (RILES-006) passent leur propre mapping.
const DEFAULT_SYNC_TOKEN = {
  id: "st-1",
  userId: "user-A",
  accessToken: null,
  refreshToken: null,
  expiresAt: null,
  metadata: {},
};

export function createWebhookHarness(
  options: {
    env?: Record<string, string | undefined>;
    syncToken?: any;
    store?: WebhookTestStore;
  } = {},
): {
  controller: WebhooksController;
  service: WebhooksService;
  prisma: any;
  store: WebhookTestStore;
  dataLake: { logTrainingInteraction: jest.Mock };
} {
  const store = options.store ?? createWebhookStore();
  const syncToken =
    options.syncToken !== undefined ? options.syncToken : DEFAULT_SYNC_TOKEN;

  const prisma: any = {
    webhookEvent: {
      create: jest.fn(async ({ data }: any) => {
        const duplicate = store.webhookRows.some(
          (row) =>
            row.provider === data.provider &&
            row.eventType === data.eventType &&
            row.objectId === data.objectId,
        );
        if (duplicate) {
          const err: any = new Error(
            "Unique constraint failed on the fields: (`provider`,`eventType`,`objectId`)",
          );
          err.code = "P2002";
          err.meta = { target: ["provider", "eventType", "objectId"] };
          throw err;
        }
        const row = { id: `wh-${store.webhookRows.length + 1}`, ...data };
        store.webhookRows.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        return (
          store.webhookRows.find(
            (row) =>
              row.provider === where?.provider &&
              row.eventType === where?.eventType &&
              row.objectId === where?.objectId,
          ) ?? null
        );
      }),
      findMany: jest.fn(async () => store.webhookRows),
    },
    syncToken: {
      // Honore where.externalUserId : la résolution utilisateur dépend du
      // mapping fournisseur → utilisateur, jamais du payload (RILES-006).
      findFirst: jest.fn(async ({ where }: any) => {
        if (!syncToken) return null;
        if (
          where?.externalUserId !== undefined &&
          syncToken.externalUserId !== undefined &&
          String(where.externalUserId) !== String(syncToken.externalUserId)
        ) {
          return null;
        }
        if (where?.provider !== undefined && syncToken.provider !== undefined) {
          return where.provider === syncToken.provider ? syncToken : null;
        }
        return syncToken;
      }),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
    },
    workout: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: "w-1" })),
      update: jest.fn(async () => ({})),
    },
    user: {
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({})),
    },
  };

  const config = {
    get: (key: string, fallback?: string) =>
      (options.env ?? WEBHOOK_ENV)[key] !== undefined
        ? (options.env ?? WEBHOOK_ENV)[key]
        : fallback,
  };
  const dataLake = { logTrainingInteraction: jest.fn() };
  const llm = {
    computeSessionTss: jest.fn().mockReturnValue(42),
    updateBanisterLoad: jest.fn(),
  };

  const service = new WebhooksService(
    prisma,
    config as any,
    dataLake as any,
    llm as any,
  );
  const controller = new WebhooksController(service);

  return { controller, service, prisma, store, dataLake };
}

import * as crypto from "crypto";
import { BillingService } from "./billing.service";
import { BillingController } from "./billing.controller";
import {
  FAKE_BILLING_WEBHOOK_SECRET,
  FakeBillingProvider,
} from "./fake-billing.provider";

/**
 * Harnais de test du module de facturation : instancie le vrai contrôleur + le
 * vrai service avec Prisma stubbé et le `FakeBillingProvider` (aucun réseau,
 * aucune base). Le stub `webhookEvent.create` respecte la contrainte unique
 * `(provider, eventType, objectId)` et lève un `P2002` sur doublon, comme
 * PostgreSQL.
 */

export const BILLING_SECRET = FAKE_BILLING_WEBHOOK_SECRET;

export interface BillingTestStore {
  webhookRows: any[];
  users: Map<string, any>;
}

export function createBillingStore(
  users: Array<{ id: string }> = [{ id: "user-A" }],
): BillingTestStore {
  return {
    webhookRows: [],
    users: new Map(users.map((u) => [u.id, { planType: "PRO", ...u }])),
  };
}

/** Signe un corps brut comme le ferait le provider. */
export function signBillingBody(
  body: Buffer | string,
  secret: string = BILLING_SECRET,
): string {
  const hmac = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hmac}`;
}

/** Signature d'un payload JSON (corps brut = JSON.stringify(payload)). */
export function signBillingPayload(
  payload: unknown,
  secret: string = BILLING_SECRET,
): { rawBody: Buffer; signature: string } {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return { rawBody, signature: signBillingBody(rawBody, secret) };
}

export function createBillingHarness(
  options: {
    store?: BillingTestStore;
    secret?: string;
  } = {},
): {
  controller: BillingController;
  service: BillingService;
  provider: FakeBillingProvider;
  prisma: any;
  store: BillingTestStore;
} {
  const store = options.store ?? createBillingStore();

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
    },
    user: {
      findUnique: jest.fn(async ({ where }: any) => {
        const user = store.users.get(where?.id);
        return user ? { id: user.id } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const user = store.users.get(where?.id);
        if (user) {
          Object.assign(user, data);
        }
        return user ?? {};
      }),
    },
  };

  const provider = new FakeBillingProvider(options.secret ?? BILLING_SECRET);
  const service = new BillingService(prisma, provider);
  const controller = new BillingController(service);

  return { controller, service, provider, prisma, store };
}

import { Prisma } from "@prisma/client";

/**
 * Exécution atomique des écritures multiples (RILES-031).
 *
 * `PrismaService` bascule sur son stockage relationnel en mémoire quand
 * PostgreSQL n'est pas joignable : dans ce mode — comme dans les doubles de
 * test qui n'exposent pas `$transaction` — il n'y a pas de transaction à
 * ouvrir, le callback est simplement exécuté tel quel.
 *
 * En base réelle, tout le callback passe dans `prisma.$transaction` : le
 * moindre échec annule l'intégralité des écritures (rollback), on ne laisse
 * jamais de lignes partielles.
 */
export type TransactionClient = Prisma.TransactionClient;

export interface MaybeTransactionalClient {
  $transaction?: <T>(fn: (tx: TransactionClient) => Promise<T>) => Promise<T>;
  isDbConnected?: boolean;
}

export async function runInTransaction<T>(
  client: MaybeTransactionalClient,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  if (
    !client ||
    typeof client.$transaction !== "function" ||
    client.isDbConnected === false
  ) {
    return fn(client as unknown as TransactionClient);
  }

  return client.$transaction(fn);
}

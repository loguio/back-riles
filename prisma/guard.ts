import * as fs from "fs";
import * as path from "path";

/**
 * RILES-033 — garde-fou des scripts destructeurs (`seed.ts`, `clean.ts`).
 *
 * Ces deux scripts suppriment TOUTES les tables, utilisateurs compris. Ils ne
 * s'exécutent donc que si les trois conditions suivantes sont réunies :
 *
 *  1. le drapeau explicite `--force` est passé (refus explicite sinon) ;
 *  2. `NODE_ENV` n'est pas `production` ;
 *  3. `DATABASE_URL` pointe vers une base locale de développement
 *     (localhost / 127.0.0.1 / ::1 / socket unix) et est bien renseigné.
 *
 * Chaque refus est une phrase complète et compréhensible, envoyée telle quelle
 * sur la sortie d'erreur avant tout accès à la base.
 */

export const FORCE_FLAG = "--force";

export class DestructiveRunRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestructiveRunRefused";
  }
}

export function isDestructiveRunRefusal(
  error: unknown,
): error is DestructiveRunRefused {
  return (
    error instanceof DestructiveRunRefused ||
    (error instanceof Error && error.name === "DestructiveRunRefused")
  );
}

export interface DestructiveRunContext {
  argv?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
]);

/** Lit `.env` sans dépendance externe, pour que la garde voie la même base que Prisma. */
function readDotEnv(cwd: string): Record<string, string> {
  const values: Record<string, string> = {};
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) return values;

  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

/** DATABASE_URL vu par le script : variable d'abord, puis fichier `.env`. */
export function resolveDatabaseUrl(
  env: Record<string, string | undefined>,
  cwd: string,
): string | undefined {
  const fromEnv = env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;
  return readDotEnv(cwd).DATABASE_URL?.trim() || undefined;
}

/** Une base est « locale de développement » seulement si son hôte l'est. */
export function isLocalDatabaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    return false;
  }
  // Socket unix (`postgresql:///base`) : pas d'hôte distant, donc local.
  if (parsed.hostname === "") return true;
  return LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase());
}

/**
 * Vérifie que le script destructeur demandé a le droit de tourner.
 * Lance `DestructiveRunRefused` (phrase complète) dans le cas contraire.
 */
export function assertDestructiveRunAllowed(
  scriptLabel: string,
  ctx: DestructiveRunContext = {},
): void {
  const argv = ctx.argv ?? process.argv.slice(2);
  const env = ctx.env ?? process.env;
  const cwd = ctx.cwd ?? process.cwd();

  // 1. Confirmation explicite : sans --force, on n'y va pas.
  if (!argv.includes(FORCE_FLAG)) {
    throw new DestructiveRunRefused(
      `Refus de lancer ${scriptLabel} : le drapeau ${FORCE_FLAG} est obligatoire, ` +
        `car ce script supprime toutes les tables de la base, utilisateurs compris. ` +
        `Relancez avec ${FORCE_FLAG} si (et seulement si) vous voulez vraiment tout effacer ` +
        `(par exemple : npm run db:wipe -- ${FORCE_FLAG}).`,
    );
  }

  // 2. Jamais en production, quelle que soit la base visée.
  if ((env.NODE_ENV || "").toLowerCase() === "production") {
    throw new DestructiveRunRefused(
      `Refus de lancer ${scriptLabel} : NODE_ENV vaut « production », or ce script ` +
        `supprime toutes les tables de la base, utilisateurs compris. ` +
        `Cette opération est interdite en production.`,
    );
  }

  // 3. Base ciblée : uniquement une base de développement locale.
  const databaseUrl = resolveDatabaseUrl(env, cwd);
  if (!databaseUrl) {
    throw new DestructiveRunRefused(
      `Refus de lancer ${scriptLabel} : la variable DATABASE_URL est introuvable, ` +
        `je ne peux donc pas vérifier que la base visée est bien une base de ` +
        `développement locale. Renseignez DATABASE_URL (cf. .env.example) avant ` +
        `de relancer ce script destructeur.`,
    );
  }
  if (!isLocalDatabaseUrl(databaseUrl)) {
    let hostname = "non locale";
    try {
      hostname = new URL(databaseUrl).hostname || "non locale";
    } catch {
      // URL illisible : on garde le libellé générique.
    }
    throw new DestructiveRunRefused(
      `Refus de lancer ${scriptLabel} : DATABASE_URL pointe vers « ${hostname} », ` +
        `qui n'est pas une base locale de développement. Ce script supprime toutes ` +
        `les tables, utilisateurs compris ; il ne s'exécute que contre une base ` +
        `locale (localhost).`,
    );
  }
}

import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  assertDestructiveRunAllowed,
  isDestructiveRunRefusal,
  isLocalDatabaseUrl,
  resolveDatabaseUrl,
  DestructiveRunRefused,
} from "../../prisma/guard";

/**
 * RILES-033 — `seed.ts` et `clean.ts` ne peuvent plus raser la production.
 *
 * Deux niveaux de vérification :
 *  - la fonction de garde, testée ici en unitaire pour toutes les combinaisons
 *    (drapeau, NODE_ENV, hôte de DATABASE_URL) ;
 *  - les vrais scripts lancés en sous-processus, pour prouver que le refus est
 *    bien propagé (code de sortie 1, message clairement affiché).
 */

jest.setTimeout(120_000);

const repoRoot = path.resolve(__dirname, "..", "..");

const LOCAL_URL = "postgresql://postgres:postgres@127.0.0.1:5432/riles_dev";
const REMOTE_URL =
  "postgresql://postgres.bjktawrigqjshmayutac:secret@aws-1-eu-west-1.pooler.supabase.com:5432/postgres";

describe("RILES-033 — garde des scripts destructeurs (unitaire)", () => {
  test("accepte une base locale avec --force", () => {
    expect(() =>
      assertDestructiveRunAllowed("clean.ts", {
        argv: ["--force"],
        env: { DATABASE_URL: LOCAL_URL, NODE_ENV: "development" },
        cwd: repoRoot,
      }),
    ).not.toThrow();
  });

  test("refuse sans --force, même sur une base locale", () => {
    let thrown: unknown;
    try {
      assertDestructiveRunAllowed("clean.ts", {
        argv: [],
        env: { DATABASE_URL: LOCAL_URL, NODE_ENV: "development" },
        cwd: repoRoot,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isDestructiveRunRefusal(thrown)).toBe(true);
    expect((thrown as DestructiveRunRefused).message).toContain("--force");
    expect((thrown as DestructiveRunRefused).message.toLowerCase()).toContain(
      "supprime toutes les tables",
    );
  });

  test("refuse NODE_ENV=production même avec --force", () => {
    expect(() =>
      assertDestructiveRunAllowed("clean.ts", {
        argv: ["--force"],
        env: { DATABASE_URL: LOCAL_URL, NODE_ENV: "production" },
        cwd: repoRoot,
      }),
    ).toThrow(/production/);
  });

  test("refuse une base distante (type Supabase) même avec --force", () => {
    let thrown: unknown;
    try {
      assertDestructiveRunAllowed("clean.ts", {
        argv: ["--force"],
        env: { DATABASE_URL: REMOTE_URL, NODE_ENV: "development" },
        cwd: repoRoot,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isDestructiveRunRefusal(thrown)).toBe(true);
    expect((thrown as DestructiveRunRefused).message).toContain(
      "pooler.supabase.com",
    );
  });

  test("refuse quand DATABASE_URL est introuvable", () => {
    expect(() =>
      assertDestructiveRunAllowed("seed.ts", {
        argv: ["--force"],
        env: { NODE_ENV: "development" },
        cwd: repoRoot,
      }),
    ).toThrow(/DATABASE_URL/);
  });

  test("refuse une URL illisible comme non locale", () => {
    expect(isLocalDatabaseUrl("pas une url")).toBe(false);
    expect(isLocalDatabaseUrl("file:./dev.db")).toBe(false);
    expect(isLocalDatabaseUrl(LOCAL_URL)).toBe(true);
    expect(
      isLocalDatabaseUrl("postgresql://user@localhost/riles?pgbouncer=true"),
    ).toBe(true);
    expect(isLocalDatabaseUrl("postgresql:///riles_socket")).toBe(true);
  });

  test("resolveDatabaseUrl retombe sur le fichier .env du projet", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "riles-guard-"));
    try {
      fs.writeFileSync(
        path.join(dir, ".env"),
        [
          "# commentaire",
          'DATABASE_URL="postgresql://user:pw@127.0.0.1:5432/dev"',
          "OTHER=1",
        ].join("\n"),
      );
      expect(resolveDatabaseUrl({}, dir)).toBe(
        "postgresql://user:pw@127.0.0.1:5432/dev",
      );
      // La variable d'environnement reste prioritaire.
      expect(resolveDatabaseUrl({ DATABASE_URL: LOCAL_URL }, dir)).toBe(
        LOCAL_URL,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("l'erreur de refus est bien typée DestructiveRunRefused", () => {
    const error = new DestructiveRunRefused("refus");
    expect(isDestructiveRunRefusal(error)).toBe(true);
    expect(isDestructiveRunRefusal(new Error("autre"))).toBe(false);
  });

  test("npm run db:wipe reste sans --force, db:wipe:dev l'apporte", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
    );
    expect(pkg.scripts["db:wipe"]).toBe("ts-node prisma/clean.ts");
    expect(pkg.scripts["db:wipe:dev"]).toContain("--force");
    expect(pkg.scripts["prisma:seed"]).toBe("ts-node prisma/seed.ts");
    expect(pkg.scripts["prisma:seed:dev"]).toContain("--force");
  });
});

describe("RILES-033 — les vrais scripts refusent (sous-processus)", () => {
  function runScript(
    script: "clean.ts" | "seed.ts",
    args: string[],
    env: Record<string, string | undefined>,
  ) {
    return spawnSync(
      process.execPath,
      // `transpile-only` : inutile de re-vérifier les types dans l'enfant,
      // `npm run type-check` le fait déjà sur tout le projet.
      ["-r", "ts-node/register/transpile-only", `prisma/${script}`, ...args],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        env: { ...process.env, ...env },
      },
    );
  }

  test("clean.ts sans --force s'arrête avec un message explicite", () => {
    const result = runScript("clean.ts", [], {
      DATABASE_URL: LOCAL_URL,
      NODE_ENV: "test",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("--force");
    expect(output).not.toContain("Vidage complet");
  });

  test("clean.ts --force refuse une base Supabase distante", () => {
    const result = runScript("clean.ts", ["--force"], {
      DATABASE_URL: REMOTE_URL,
      NODE_ENV: "test",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("pooler.supabase.com");
    expect(output).toContain("pas une base locale");
    expect(output).not.toContain("Vidage complet");
  });

  test("seed.ts sans --force s'arrête avant toute suppression", () => {
    const result = runScript("seed.ts", [], {
      DATABASE_URL: LOCAL_URL,
      NODE_ENV: "test",
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(1);
    expect(output).toContain("--force");
    expect(output).not.toContain("Démarrage du seed");
  });
});

import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Prisma } from "@prisma/client";
import {
  AllExceptionsFilter,
  isDatabaseUnavailableError,
} from "../common/filters/http-exception.filter";
import { PrismaService } from "./prisma.service";

/**
 * RILES-012 — `PrismaService` ne doit plus jamais basculer sur un magasin
 * mémoire « de secours » quand PostgreSQL est injoignable ou qu'une requête
 * échoue.
 *
 * Ces tests vérifient les trois acceptations de l'issue :
 *  1. plus aucune trace de repli en mémoire dans `src/` ;
 *  2. une base injoignable fait échouer la requête (aucune donnée fictive) ;
 *  3. l'application répond 503, pas un 200 avec des données inventées.
 */

const SRC_DIR = path.resolve(__dirname, "..");

/** URL vers un port fermé : la connexion échoue immédiatement, sans réseau distant. */
const UNREACHABLE_DATABASE_URL =
  "postgresql://riles:invalid@127.0.0.1:59999/riles_unreachable?connect_timeout=1&connection_limit=1";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

function withUnreachableDatabase<T>(fn: () => Promise<T>): Promise<T> {
  process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
  return fn().finally(() => {
    if (ORIGINAL_DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    }
  });
}

function listTsFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function createUnreachablePrisma(): PrismaService {
  return new PrismaService();
}

function httpGet(
  base: string,
  pathname: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${pathname}`, { method: "GET" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("RILES-012 — plus aucun repli en mémoire dans PrismaService", () => {
  it("aucun fichier de production de src/ n'installe plus de proxy/magasin de substitution", () => {
    const forbidden = [
      "installResilientModelProxies",
      "seedInMemoryDefaults",
      "ensureUserInMem",
      "wrapModel",
      "In-Memory Relational Store",
      "Prisma Fallback",
    ];
    const offenders: string[] = [];

    for (const file of listTsFiles(SRC_DIR)) {
      // Les suites de tests citent ces identifiants pour prouver leur absence.
      if (file.endsWith(".test.ts")) continue;
      const content = fs.readFileSync(file, "utf8");
      for (const token of forbidden) {
        if (content.includes(token)) {
          offenders.push(`${path.relative(SRC_DIR, file)}: ${token}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("PrismaService ne contient plus aucun magasin de données de remplacement", () => {
    const content = fs.readFileSync(
      path.join(__dirname, "prisma.service.ts"),
      "utf8",
    );

    expect(content).not.toContain("this.mem");
    expect(content).not.toMatch(/private readonly mem\b/);
    expect(content).not.toContain("bascule");
  });

  it("une base injoignable fait échouer la requête au lieu de renvoyer des données factices", async () => {
    const outcome = await withUnreachableDatabase(async () => {
      const prisma = createUnreachablePrisma();
      try {
        await prisma.onModuleInit();
        expect(prisma.isDbConnected).toBe(false);

        // Avant RILES-012, ce appel renvoyait silencieusement des lignes
        // mémoire. Il doit désormais être rejeté.
        return await prisma.user.findMany().then(
          (rows) => ({ kind: "rows" as const, rows }),
          (err) => ({ kind: "error" as const, err }),
        );
      } finally {
        await prisma.$disconnect();
      }
    });

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(isDatabaseUnavailableError(outcome.err)).toBe(true);
  });

  it("les erreurs de base non critiques restent des erreurs internes (pas de 503 abusif)", () => {
    const validationError = new Prisma.PrismaClientValidationError(
      "Argument userId: Invalid value provided.",
      { clientVersion: "5.22.0" },
    );
    expect(isDatabaseUnavailableError(validationError)).toBe(false);
    expect(isDatabaseUnavailableError(new Error("anything else"))).toBe(false);
  });
});

describe("RILES-012 — une application réelle répond 503 quand la base est coupée", () => {
  @Controller("probe")
  class ProbeController {
    constructor(private readonly prisma: PrismaService) {}

    @Get("users")
    async users() {
      return this.prisma.user.findMany();
    }
  }

  @Module({
    controllers: [ProbeController],
    providers: [PrismaService],
  })
  class ProbeModule {}

  let app: INestApplication;
  let base: string;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.DATABASE_URL = UNREACHABLE_DATABASE_URL;
    app = await NestFactory.create(ProbeModule, { logger: [] });
    // Même wiring que src/main.ts : le filtre global est celui qui traduit
    // les erreurs Prisma en réponses HTTP.
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0, "127.0.0.1");
    prisma = app.get(PrismaService);
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    if (ORIGINAL_DATABASE_URL === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
    }
  });

  it("GET /probe/users renvoie 503 (et non un 200 de données inventées)", async () => {
    const res = await httpGet(base, "/probe/users");

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).statusCode).toBe(503);
    // Aucune ligne de substitution ne doit apparaître dans la réponse.
    expect(res.body).not.toContain("riles.app");
    expect(res.body).not.toContain("Athlète");
  });
});

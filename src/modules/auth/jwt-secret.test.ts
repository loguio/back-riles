import * as fs from "fs";
import * as path from "path";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AuthModule } from "./auth.module";
import { PrismaModule } from "../../prisma/prisma.module";
import {
  MissingJwtSecretError,
  readJwtSecret,
  requireJwtSecret,
  validateEnv,
} from "./jwt-secret";

/**
 * Mirrors AppModule's wiring, minus the untracked .env file.
 *
 * Built by a factory instead of a module-scope decorator: `ConfigModule.forRoot()`
 * validates the environment eagerly, at call time, so the harness has to be
 * created *after* the test manipulated `process.env`.
 */
function createBootHarness(): any {
  @Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        validate: validateEnv,
      }),
      PrismaModule,
      AuthModule,
    ],
  })
  class BootHarnessModule {}

  return BootHarnessModule;
}

const SECRET_KEYS = ["SUPABASE_JWT_SECRET", "JWT_SECRET"] as const;

function withClearedSecrets<T>(run: () => Promise<T> | T): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of SECRET_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  const restore = () => {
    for (const key of SECRET_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  };

  return Promise.resolve().then(run).finally(restore);
}

describe("JWT secret resolution (RILES-002: no fallback secret)", () => {
  it("prefers SUPABASE_JWT_SECRET and falls back to JWT_SECRET", () => {
    expect(
      readJwtSecret((key) =>
        key === "SUPABASE_JWT_SECRET" ? "supabase-secret" : "jwt-secret",
      ),
    ).toBe("supabase-secret");

    expect(
      readJwtSecret((key) =>
        key === "SUPABASE_JWT_SECRET" ? undefined : "jwt-secret",
      ),
    ).toBe("jwt-secret");
  });

  it("ignores blank values instead of accepting them as a secret", () => {
    expect(
      readJwtSecret((key) =>
        key === "SUPABASE_JWT_SECRET" ? "   " : undefined,
      ),
    ).toBeUndefined();
  });

  it("throws a clear error when no secret is configured", () => {
    expect(() => requireJwtSecret(() => undefined)).toThrow(
      MissingJwtSecretError,
    );
    expect(() => requireJwtSecret(() => undefined)).toThrow(
      /SUPABASE_JWT_SECRET/,
    );
    expect(() => requireJwtSecret(() => undefined)).toThrow(/JWT_SECRET/);
    expect(() => requireJwtSecret(() => undefined)).toThrow(/refuses to boot/);
  });

  it("validateEnv rejects a config without a secret and passes one with it", () => {
    expect(() => validateEnv({ NODE_ENV: "production" })).toThrow(
      MissingJwtSecretError,
    );

    const config = { JWT_SECRET: "a-real-secret" };
    expect(validateEnv(config)).toBe(config);
  });
});

describe("boot without a JWT secret (RILES-002: server refuses to start)", () => {
  it("rejects Nest application creation with a clear message", async () => {
    await withClearedSecrets(async () => {
      // abortOnError: false rethrows instead of Nest's process.exit(1); the
      // real entrypoint keeps the default, i.e. it exits non-zero at boot.
      await expect(
        NestFactory.createApplicationContext(createBootHarness(), {
          logger: false,
          abortOnError: false,
        }),
      ).rejects.toThrow(MissingJwtSecretError);

      await expect(
        NestFactory.createApplicationContext(createBootHarness(), {
          logger: false,
          abortOnError: false,
        }),
      ).rejects.toThrow(/refuses to boot/);
    });
  });

  it("boots when a secret is provided", async () => {
    await withClearedSecrets(async () => {
      process.env.JWT_SECRET = "configured-for-this-test";
      const app = await NestFactory.createApplicationContext(
        createBootHarness(),
        { logger: false, abortOnError: false },
      );
      await app.close();
    });
  });
});

describe("repository invariant (RILES-002: no hardcoded secret shipped)", () => {
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
  ]);

  function walk(dir: string, files: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(path.join(dir, entry.name), files);
        }
      } else if (entry.isFile()) {
        files.push(path.join(dir, entry.name));
      }
    }
    return files;
  }

  it("contains no copy of the previously hardcoded JWT secret", () => {
    // Assembled from parts so this file itself never contains the banned
    // literal (`grep -r` on the working tree must come back empty).
    const banned = ["super", "secret", "riles"].join("-");
    const root = path.resolve(__dirname, "../../..");
    const offenders = walk(root).filter((file) =>
      fs.readFileSync(file, "utf8").includes(banned),
    );

    expect(offenders).toEqual([]);
  });

  it("ships .env.example with placeholder names only, no secret values", () => {
    const root = path.resolve(__dirname, "../../..");
    const lines = fs
      .readFileSync(path.join(root, ".env.example"), "utf8")
      .split("\n")
      .filter((line) => /^(JWT_SECRET|SUPABASE_JWT_SECRET)=/.test(line));

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.slice(line.indexOf("=") + 1).trim()).toBe("");
    }
  });
});

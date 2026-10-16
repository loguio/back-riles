import * as fs from "fs";
import * as path from "path";

/**
 * RILES-032 — contraintes et index d'intégrité de la base.
 *
 * Verrouille à la fois `prisma/schema.prisma` ET les migrations versionnées :
 * une contrainte qui existerait seulement dans le schéma ne protège rien tant
 * qu'elle n'est pas appliquée par une migration.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const schema = fs.readFileSync(
  path.join(repoRoot, "prisma", "schema.prisma"),
  "utf-8",
);

function modelBlock(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = schema.indexOf("\n}", start);
  return schema.slice(start, end);
}

function allMigrationSql(): string {
  const dir = path.join(repoRoot, "prisma", "migrations");
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      fs.readFileSync(path.join(dir, entry.name, "migration.sql"), "utf-8"),
    )
    .join("\n");
}

describe("RILES-032 — contraintes d'intégrité du schéma", () => {
  test("Workout.externalActivityId est unique (anti double-write webhook)", () => {
    expect(modelBlock("Workout")).toMatch(
      /externalActivityId\s+String\?\s+@unique/,
    );
  });

  test("WebhookEvent porte sa clé de dédoublonnage unique", () => {
    expect(modelBlock("WebhookEvent")).toContain(
      "@@unique([provider, eventType, objectId])",
    );
  });

  test("RpeCheckIn a ses index d'accès (workoutId, userId+submittedAt)", () => {
    const block = modelBlock("RpeCheckIn");
    expect(block).toContain("@@index([workoutId])");
    expect(block).toContain("@@index([userId, submittedAt])");
  });

  test("ChatMessage est trié par (userId, createdAt)", () => {
    expect(modelBlock("ChatMessage")).toContain("@@index([userId, createdAt])");
  });
});

describe("RILES-032 — les contraintes existent aussi dans les migrations", () => {
  const sql = allMigrationSql();

  test("les index uniques webhook/activity sont bien versionnés", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "workouts_externalActivityId_key"',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "webhook_events_provider_eventType_objectId_key"',
    );
    expect(sql).toMatch(
      /ALTER TABLE "webhook_events" ADD COLUMN\s+"objectId" TEXT/,
    );
  });

  test("les nouveaux index d'accès sont bien versionnés", () => {
    expect(sql).toContain('CREATE INDEX "rpe_checkins_workoutId_idx"');
    expect(sql).toContain('CREATE INDEX "rpe_checkins_userId_submittedAt_idx"');
    expect(sql).toContain('CREATE INDEX "chat_messages_userId_createdAt_idx"');
  });
});

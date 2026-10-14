import * as fs from "fs";
import * as path from "path";

/**
 * RILES-030 — garde-fous du workflow de migrations Prisma.
 *
 * Ces tests empêchent la régression la plus coûteuse : revenir à un
 * `prisma db push` sans historique (aucun rollback, push destructrice dès que
 * de vraies données existent) alors que `prisma/migrations/` existe et
 * s'applique sur une base vide.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const migrationsDir = path.join(repoRoot, "prisma", "migrations");

function readPackageScripts(): Record<string, string> {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
  );
  return pkg.scripts ?? {};
}

function workflowFiles(): string[] {
  const dir = path.join(repoRoot, ".github", "workflows");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => fs.readFileSync(path.join(dir, f), "utf-8"));
}

describe("RILES-030 — workflow de migrations", () => {
  test("prisma/migrations/ existe et contient des migrations applicables", () => {
    expect(fs.existsSync(migrationsDir)).toBe(true);

    const entries = fs
      .readdirSync(migrationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());

    expect(entries.length).toBeGreaterThanOrEqual(1);

    for (const entry of entries) {
      const sqlFile = path.join(migrationsDir, entry.name, "migration.sql");
      expect(fs.existsSync(sqlFile)).toBe(true);
      expect(fs.statSync(sqlFile).size).toBeGreaterThan(0);
    }

    const lock = fs.readFileSync(
      path.join(migrationsDir, "migration_lock.toml"),
      "utf-8",
    );
    expect(lock).toContain('provider = "postgresql"');
  });

  test("aucun script npm ne repousse le schéma via `prisma db push`", () => {
    const scripts = readPackageScripts();
    const offenders = Object.entries(scripts)
      .filter(([, command]) => /prisma\s+db\s+push/.test(command))
      .map(([name]) => name);

    expect(offenders).toEqual([]);
    expect(scripts["prisma:deploy"]).toContain("migrate deploy");
  });

  test("le CI déploie les migrations et ne utilise jamais `db push`", () => {
    const workflows = workflowFiles();
    expect(workflows.length).toBeGreaterThan(0);

    for (const content of workflows) {
      expect(/prisma\s+db\s+push/.test(content)).toBe(false);
    }

    const combined = workflows.join("\n");
    expect(combined).toContain("prisma migrate deploy");
  });

  test("le README documente `migrate deploy` pour la production", () => {
    const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf-8");

    expect(readme).toContain("prisma migrate deploy");
    expect(readme.toLowerCase()).toContain("production");
    // `db push` n'est documenté que comme outil de prototypage local.
    expect(readme).toMatch(/prototypage local/);
  });
});

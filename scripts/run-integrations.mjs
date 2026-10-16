/**
 * Test runner: executes the repository's integration test scripts sequentially.
 * Exits non-zero if any suite fails.
 */
import { spawnSync } from "node:child_process";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const suites = [
  "src/modules/auth/guards/supabase-auth.guard.integration.ts",
  "src/modules/datalake/datalake.integration.ts",
];

let failed = false;
for (const suite of suites) {
  process.stdout.write(`\n▶ ${suite}\n`);
  const result = spawnSync(
    "npx",
    ["ts-node", "--transpile-only", "--compiler-options", '{"module":"commonjs"}', suite],
    { cwd: root, stdio: "inherit", shell: process.platform === "win32", env: { ...process.env, DATALAKE_LOCAL_DIR: process.env.DATALAKE_LOCAL_DIR || os.tmpdir() + "/riles-datalake", NODE_ENV: "test" } },
  );
  if (result.status !== 0) failed = true;
}

if (failed) {
  console.error("\n✖ One or more suites failed");
  process.exit(1);
}
console.log("\n✔ All suites passed");

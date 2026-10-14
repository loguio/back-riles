/** @type {import('jest').Config} */
export default {
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  // Only Jest suites (`*.test.ts`). The legacy `*.spec.ts` files in this repo
  // are self-executing assertion scripts, not Jest suites.
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  moduleFileExtensions: ["ts", "js", "json"],
  clearMocks: true,
};

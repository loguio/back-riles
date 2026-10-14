// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "build/**",
      "coverage/**",
      "node_modules/**",
      "prisma/**/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Tuned to the current codebase: the app relies heavily on loosely typed
      // Prisma / LLM payloads. Type-aware linting stays out of scope for P0.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-function-type": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-wrapper-object-types": "off",
      // Unused locals are reported by `npm run type-check` candidates later;
      // keep the signal but allow the conventional `_`-prefixed escape hatch.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // Empty catch / empty blocks exist as deliberate no-ops in the current code.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // Regex-heavy domain code (French copy, pace strings) trips these
      // false-positive-prone rules; they add no real safety here.
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "no-async-promise-executor": "off",
      // Flags pre-assigned defaults that every branch overwrites; removing them
      // would mean restructuring existing logic, which is out of scope for P0.
      "no-useless-assignment": "off",
      "no-inner-declarations": "off",
      "no-cond-assign": "off",
      "no-prototype-builtins": "off",
    },
  },
  {
    // Test files (Jest suites and the legacy standalone spec scripts).
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-unused-expressions": "off",
    },
  },
  {
    files: ["*.mjs", "*.js", "*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);

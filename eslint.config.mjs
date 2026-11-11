// @ts-check
import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * One flat config for the whole monorepo. Every package runs `eslint .` from its own folder
 * and picks this file up; do not add per-package ESLint configs.
 */
export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/dist/**",
      "**/coverage/**",
      "**/next-env.d.ts",
      "**/drizzle/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/public/**",
    ],
  },

  js.configs.recommended,

  // TypeScript: type-aware rules everywhere.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.recommendedTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // Lost promises are lost work on serverless: every promise is awaited or explicitly voided.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "off",

      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: true },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/dot-notation": "off",
      "@typescript-eslint/no-empty-function": "off",

      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["error", { allow: ["warn", "error"] }],

      // Package boundaries: import a package through its public entry points only.
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@repo/*/src", "@repo/*/src/*", "**/packages/*/src/*"],
              message: "Import from the package's public entry point (@repo/<name>), not its src.",
            },
          ],
        },
      ],
    },
  },

  // Browser-safe packages: no Node built-ins. (@repo/core/env is the server-only entry point.)
  {
    files: ["packages/core/src/**/*.ts", "packages/widget-embed/src/**/*.{ts,tsx}"],
    ignores: ["packages/core/src/env/**", "**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["fs", "path", "crypto", "os", "child_process", "buffer", "stream", "util"].map(
            (name) => ({ name, message: "This package must run in a browser: no Node built-ins." }),
          ),
          patterns: [
            {
              group: ["node:*"],
              message: "This package must run in a browser: no Node built-ins.",
            },
            {
              group: ["@repo/*/src", "@repo/*/src/*", "**/packages/*/src/*"],
              message: "Import from the package's public entry point (@repo/<name>), not its src.",
            },
          ],
        },
      ],
    },
  },

  // @repo/settings: the main entry point is imported by the admin panel in the browser, so
  // only src/server may touch the database, the environment or Node built-ins.
  {
    files: ["packages/settings/src/**/*.ts"],
    ignores: ["packages/settings/src/server/**", "**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            ...["fs", "path", "crypto", "os", "child_process", "buffer", "stream", "util"].map(
              (name) => ({ name, message: "This entry point must run in a browser." }),
            ),
            {
              name: "@repo/db",
              message: "Database code belongs in packages/settings/src/server.",
            },
            {
              name: "@repo/core/env",
              message: "Environment access belongs in packages/settings/src/server.",
            },
          ],
          patterns: [
            { group: ["node:*"], message: "This entry point must run in a browser." },
            {
              group: ["@repo/db/*", "./server", "./server/*", "../server", "../server/*"],
              message: "Only @repo/settings/server may import server code.",
            },
            {
              group: ["@repo/*/src", "@repo/*/src/*", "**/packages/*/src/*"],
              message: "Import from the package's public entry point (@repo/<name>), not its src.",
            },
          ],
        },
      ],
    },
  },

  // Configuration is read through @repo/core/env so it is validated and documented once.
  {
    files: ["packages/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}"],
    ignores: [
      "packages/core/src/env/**",
      "packages/core/src/logger.ts",
      "**/*.test.{ts,tsx}",
      "**/*.config.{ts,mts}",
      "**/scripts/**",
      "**/e2e/**",
      "apps/web/src/env.public.ts",
    ],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read configuration with getEnv()/requireEnv() from @repo/core/env (NEXT_PUBLIC_* in apps/web/src/env.public.ts).",
        },
      ],
    },
  },

  // Tests, scripts and config files may log and use looser types.
  {
    files: [
      "**/*.test.{ts,tsx}",
      "**/test/**/*.{ts,tsx}",
      "**/scripts/**/*.{ts,mts}",
      "**/*.config.{ts,mts}",
      "packages/core/src/env/write-example.ts",
    ],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },

  // The structured logger is the one place that writes to the console.
  {
    files: ["packages/core/src/logger.ts"],
    rules: { "no-console": "off" },
  },

  // Next.js app: React hooks and Next rules.
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "@next/next": nextPlugin },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    settings: { next: { rootDir: "apps/web" } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      // App Router only: there is no pages directory for this rule to inspect.
      "@next/next/no-html-link-for-pages": "off",
    },
  },

  // Plain JavaScript: Node scripts and config files.
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.node } },
  },

  prettier,
);

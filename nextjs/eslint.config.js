// Lint profile for the Next.js rewrite. The root eslint.config.js targets the Rails frontend in
// app/javascript and ignores nextjs/. This reuses the same prettier settings (root .prettierrc) and
// general-quality rules, resolving packages from the root node_modules, but with a Node/server
// profile: node globals, automatic JSX runtime, `@/` as an internal import alias, and no
// Rails-frontend-only rules (Routes globals, assertionStyle: "never").
import { fileURLToPath } from "node:url";

import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import importPlugin from "eslint-plugin-import";
import prettierRecommended from "eslint-plugin-prettier/recommended";
import reactJsxRuntime from "eslint-plugin-react/configs/jsx-runtime.js";
import reactRecommended from "eslint-plugin-react/configs/recommended.js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typeChecked = !process.env.DISABLE_TYPE_CHECKED;

const baseConfig = {
  plugins: { import: importPlugin },
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    globals: { ...globals.node, ...globals.browser },
  },
  linterOptions: { reportUnusedDisableDirectives: typeChecked ? "error" : "off" },
  rules: {
    "arrow-body-style": "error",
    eqeqeq: ["error", "smart"],
    "logical-assignment-operators": "error",
    "no-console": ["error", { allow: ["warn", "error"] }],
    "no-else-return": "error",
    "no-empty": ["error", { allowEmptyCatch: true }],
    "no-lonely-if": "error",
    "no-var": "error",
    "no-unneeded-ternary": "error",
    "no-useless-concat": "error",
    "no-useless-return": "error",
    "object-shorthand": "error",
    "operator-assignment": "error",
    "prefer-arrow-callback": "error",
    "prefer-const": "error",
    "prefer-object-spread": "error",
    "prefer-promise-reject-errors": "error",
    "prefer-regex-literals": "error",
    "prefer-template": "error",
    radix: "error",
    "require-await": "error",
    "require-unicode-regexp": "error",
    yoda: "error",
    "import/no-duplicates": "error",
    "import/order": [
      "error",
      {
        "newlines-between": "always",
        alphabetize: { order: "asc", caseInsensitive: true },
        groups: ["builtin", "external", "internal", "parent", ["sibling", "index"]],
        pathGroups: [
          { pattern: "@/**", group: "internal" },
          { pattern: "$app/components/**", group: "internal", position: "after" },
          { pattern: "$app/**", group: "internal" },
        ],
        pathGroupsExcludedImportTypes: ["builtin"],
      },
    ],
  },
};

const tsConfig = tseslint.config({
  files: ["**/*.ts", "**/*.tsx"],
  extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
  rules: {
    // Prisma rows, JSON bodies and `as const` tables make `as` routine on the server.
    "@typescript-eslint/consistent-type-assertions": [
      "error",
      { assertionStyle: "as", objectLiteralTypeAssertions: "allow" },
    ],
    "@typescript-eslint/consistent-type-definitions": "off",
    "@typescript-eslint/no-confusing-void-expression": "off",
    "@typescript-eslint/no-empty-function": "off",
    // `noUncheckedIndexedAccess` is on in tsconfig, so `arr[i]!` after a bounds check is the idiom.
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/no-require-imports": "error",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        args: "all",
        argsIgnorePattern: "^_",
        caughtErrors: "all",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        ignoreRestSiblings: true,
        reportUsedIgnorePattern: true,
      },
    ],
    "@typescript-eslint/prefer-nullish-coalescing": "off",
    "@typescript-eslint/require-array-sort-compare": ["error", { ignoreStringArrays: true }],
    "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    "@typescript-eslint/switch-exhaustiveness-check": "error",
  },
  languageOptions: {
    parserOptions: { project: true, tsconfigRootDir: import.meta.dirname },
  },
});

const tsxConfig = tseslint.config({
  files: ["**/*.tsx"],
  extends: [reactRecommended, reactJsxRuntime],
  rules: {
    "react/jsx-boolean-value": "error",
    "react/jsx-curly-brace-presence": ["error", { props: "never", children: "never", propElementValues: "always" }],
    "react/jsx-fragments": "error",
    "react/jsx-no-useless-fragment": "error",
    "react/no-unescaped-entities": "off",
    "react/prop-types": "off",
  },
  settings: { react: { version: "detect" } },
});

export default [
  includeIgnoreFile(fileURLToPath(import.meta.resolve("../.gitignore"))),
  includeIgnoreFile(fileURLToPath(import.meta.resolve("./.gitignore"))),
  prettierRecommended,
  js.configs.recommended,
  baseConfig,
  ...tsConfig,
  ...tsxConfig,
  prettierConfig,
  typeChecked ? {} : tseslint.configs.disableTypeChecked,
];

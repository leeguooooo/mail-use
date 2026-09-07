// Deliberately narrow: rules that catch bugs, not rules that pick style fights.
//
// This exists because a repo-wide rename silently produced `client.mail-use`
// (invalid syntax) and `the right mail-use` in prose, and nothing caught the
// first one until a test run. Parse errors and undefined/unused identifiers are
// exactly what a linter should be holding, so that is what is switched on here.
// Formatting is left alone on purpose — there is no formatter in this repo and
// adding one would bury real findings under thousands of whitespace diffs.

import js from "@eslint/js";

const nodeGlobals = {
  require: "readonly",
  module: "writable",
  exports: "writable",
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  URL: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  fetch: "readonly",
};

const shared = {
  ...js.configs.recommended.rules,

  // Unused code is either a leftover or a bug (a variable you meant to use).
  // Args are the common false positive, so only flag ones after the last used
  // parameter, and let a leading _ opt out.
  "no-unused-vars": [
    "error",
    { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
  ],

  // Real-bug rules that cost nothing to keep green.
  eqeqeq: ["error", "always", { null: "ignore" }], // == null is the idiomatic nullish check here
  "no-var": "error",
  "prefer-const": ["error", { destructuring: "all" }],
  "no-return-await": "error",
  "no-constant-binary-expression": "error",
  "no-self-compare": "error",
  "no-template-curly-in-string": "error", // "${x}" in a normal quoted string is always a mistake
  // Off: it cannot see mutation from event handlers / async callbacks, which is
  // exactly how the IDLE watcher's `stopped` flag is set. Pure false positives here.
  "no-unmodified-loop-condition": "off",
  // Off: fires on defensive `let x = ""` before a try/catch that assigns in both
  // branches. That initialization is intentional, not dead.
  "no-useless-assignment": "off",
  "no-promise-executor-return": "error",
  "require-atomic-updates": "off", // too noisy on legitimate async accumulator patterns
  "no-empty": ["error", { allowEmptyCatch: true }], // `catch { /* ignore */ }` is idiomatic here
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "dist/**",
      "**/.tmp/**",
      "docs/**",
      "config_templates/**",
    ],
  },
  // Production + script sources: CommonJS.
  {
    files: ["packages/*/src/**/*.js", "packages/*/bin/*.js", "scripts/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: nodeGlobals,
    },
    rules: shared,
  },
  // Tests: ESM, plus the vitest globals they import explicitly (so no extra
  // globals needed) and node: builtins.
  {
    files: ["packages/*/test/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      ...shared,
      // Fixtures routinely build values they only assert on later.
      "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }],
    },
  },
  // This config file itself.
  {
    files: ["eslint.config.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module" },
    rules: shared,
  },
];

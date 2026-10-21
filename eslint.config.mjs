// ESLint flat config: @eslint/js + typescript-eslint recommended (not type-checked),
// plus the WP-0.6 guardrails:
//   1. child_process may be imported only in src/cli/** (D1: one process boundary).
//   2. An object property `shell` other than the literal `false` is banned in src/** and test/**.
//   3. The literals 'credentials.json' and '.contexo/.sync' are banned in src/**
//      (the E28 watcher glob '.contexo/*.json' passes).
//   4. Importing 'vscode' is banned in test/unit/** (unit tests run in plain mocha; the src
//      modules they load get test/helpers/vscodeStub.ts, registered by test:unit).
//   5. Any vscode.proposed.*.d.ts file is an error (stable API only).
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const EXT = "{ts,mts,cts,js,mjs,cjs}";

// The `globals` package is not a devDependency: the Node globals our .mjs/.cjs files use.
const NODE_GLOBALS = Object.fromEntries(
  [
    "AbortController", "AbortSignal", "Buffer", "TextDecoder", "TextEncoder", "URL",
    "URLSearchParams", "clearImmediate", "clearInterval", "clearTimeout", "console", "fetch",
    "global", "performance", "process", "queueMicrotask", "setImmediate", "setInterval",
    "setTimeout", "structuredClone",
  ].map((name) => [name, "readonly"]),
);
const COMMONJS_GLOBALS = Object.fromEntries(
  ["__dirname", "__filename", "exports", "module", "require"].map((name) => [name, "readonly"]),
);

const CHILD_PROCESS_MESSAGE =
  "child_process is allowed only in src/cli/** (the ctx process boundary); go through services.cli.";
const CHILD_PROCESS_RE = "/^(node:)?child_process$/";
const childProcessSyntax = [
  {
    selector: `CallExpression[callee.name='require'][arguments.0.value=${CHILD_PROCESS_RE}]`,
    message: CHILD_PROCESS_MESSAGE,
  },
  { selector: `ImportExpression[source.value=${CHILD_PROCESS_RE}]`, message: CHILD_PROCESS_MESSAGE },
  {
    selector: `TSExternalModuleReference[expression.value=${CHILD_PROCESS_RE}]`,
    message: CHILD_PROCESS_MESSAGE,
  },
];

const SHELL_MESSAGE =
  "Never run through a shell: omit `shell` or set it to the literal false (shell: true is banned, E26).";
const shellSyntax = [
  { selector: "ObjectExpression > Property[key.name='shell']:not([value.value=false])", message: SHELL_MESSAGE },
  { selector: "ObjectExpression > Property[key.value='shell']:not([value.value=false])", message: SHELL_MESSAGE },
  {
    selector: "AssignmentExpression[left.property.name='shell']:not([right.value=false])",
    message: SHELL_MESSAGE,
  },
];

const CREDENTIALS_MESSAGE = "The extension never reads or names credentials.json; ctx owns credentials.";
const SYNC_MESSAGE = "The extension never touches .contexo/.sync (ctx-private state); watch '.contexo/*.json' only.";
// esquery regexes cannot contain '/', so \x2F stands for it.
const CREDENTIALS_RE = String.raw`/credentials\.json/i`;
const SYNC_RE = String.raw`/\.contexo[\\\x2F]\.sync/i`;
const sensitiveLiteralSyntax = [
  { selector: `Literal[value=${CREDENTIALS_RE}]`, message: CREDENTIALS_MESSAGE },
  { selector: `TemplateElement[value.cooked=${CREDENTIALS_RE}]`, message: CREDENTIALS_MESSAGE },
  { selector: `Literal[value=${SYNC_RE}]`, message: SYNC_MESSAGE },
  { selector: `TemplateElement[value.cooked=${SYNC_RE}]`, message: SYNC_MESSAGE },
];

const VSCODE_MESSAGE =
  "Unit tests run in plain mocha without VS Code: do not import 'vscode' here (use vscode-uri or test/helpers; src modules load against test/helpers/vscodeStub.ts).";
const vscodeRuntimeSyntax = [
  { selector: "CallExpression[callee.name='require'][arguments.0.value='vscode']", message: VSCODE_MESSAGE },
  { selector: "ImportExpression[source.value='vscode']", message: VSCODE_MESSAGE },
  { selector: "TSExternalModuleReference[expression.value='vscode']", message: VSCODE_MESSAGE },
];

export default defineConfig(
  globalIgnores([
    "dist/**",
    "out/**",
    "node_modules/**",
    ".vscode-test/**",
    // Fixture contents are data, not code; but a proposed-API typings file is caught even there
    // (re-include the directories, then only that file name).
    "test/fixtures/**/*",
    "!test/fixtures/**/",
    "!test/fixtures/**/vscode.proposed.*.d.ts",
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    name: "contexo/base-rules",
    rules: {
      // 'warn', not 'error': the plan's guardrail self-test lints the unused
      // `const g = '.contexo/*.json';` from stdin and requires exit 0.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // A `let` read by a closure before its single assignment (extension.ts activate) stays `let`.
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
    },
  },
  {
    name: "contexo/node-globals",
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: NODE_GLOBALS },
  },
  {
    name: "contexo/commonjs-globals",
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: COMMONJS_GLOBALS },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    name: "contexo/src",
    files: [`src/**/*.${EXT}`],
    ignores: ["src/cli/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "child_process", message: CHILD_PROCESS_MESSAGE },
            { name: "node:child_process", message: CHILD_PROCESS_MESSAGE },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...childProcessSyntax, ...shellSyntax, ...sensitiveLiteralSyntax],
    },
  },
  {
    name: "contexo/src-cli",
    files: [`src/cli/**/*.${EXT}`],
    rules: {
      "no-restricted-syntax": ["error", ...shellSyntax, ...sensitiveLiteralSyntax],
    },
  },
  {
    name: "contexo/test",
    files: [`test/**/*.${EXT}`],
    ignores: ["test/unit/**"],
    rules: {
      "no-restricted-syntax": ["error", ...shellSyntax],
    },
  },
  {
    name: "contexo/test-unit",
    files: [`test/unit/**/*.${EXT}`],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "vscode", message: VSCODE_MESSAGE }] }],
      "no-restricted-syntax": ["error", ...shellSyntax, ...vscodeRuntimeSyntax],
    },
  },
  {
    // Last, so it wins for these files: proposed API typings are never allowed.
    name: "contexo/no-proposed-api",
    files: ["**/vscode.proposed.*.d.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Program",
          message: "vscode.proposed.*.d.ts is banned: the extension uses stable VS Code API only (no enabledApiProposals).",
        },
      ],
    },
  },
);
